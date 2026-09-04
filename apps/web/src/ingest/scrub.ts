import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
// The SDK's zod helper is typed against zod v4, which zod 3.25+ ships under this entry point.
import { z } from 'zod/v4';

/**
 * Two-layer scrubber for conversation text. Runs at tail ingest BEFORE the
 * text is spooled (ingest/text.ts), so nothing downstream of this module —
 * not D1, not PostHog — ever sees the unscrubbed words.
 *
 * Layer 1 — patterns. Contact details and identifiers a regex finds reliably:
 * links, emails, @handles, phone numbers. Runs first, so those raw values
 * never even reach the model in layer 2.
 *
 * Layer 2 — names. A small model rewrites both texts with the names of real,
 * private individuals replaced by [name], leaving biblical, historical and
 * public names alone — a regex cannot tell a user's pastor from the apostle
 * Paul, and these conversations are full of both. The text already goes to
 * Anthropic to be answered, so this adds no new data recipient. Structured
 * output pins the shape, and a plausibility check rejects a rewrite whose
 * length moved more than name swaps could explain, so a model that summarized
 * or translated cannot pass as a scrub.
 *
 * FAIL CLOSED. Any failure — no key, API error, malformed or implausible
 * output — returns `{ ok: false }` and the caller withholds the text for that
 * turn. The turn's metadata still reaches PostHog; only its words are held back.
 */

export type ScrubEnv = {
  /** Secret: `wrangler secret put ANTHROPIC_API_KEY --env <env>`. Absent ⇒ text is never sent. */
  ANTHROPIC_API_KEY?: string;
  /** Model for layer 2. Defaults to the current Haiku. */
  SCRUB_MODEL?: string;
};

export const DEFAULT_SCRUB_MODEL = 'claude-haiku-4-5';

export type ScrubInput = { userMessage: string; assistantReply: string };
export type ScrubFailure = 'no_api_key' | 'api_error' | 'truncated' | 'unparseable' | 'implausible';
export type ScrubResult =
  | { ok: true; userMessage: string; assistantReply: string }
  | { ok: false; reason: ScrubFailure; detail?: string };

// ── Layer 1: patterns ────────────────────────────────────────────────────────
// Order matters: links before phones (a URL can carry digit runs), emails
// before handles (an email contains '@').
const LINK = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const HANDLE = /(?<![\w@])@[A-Za-z0-9_.]{2,}/g;
/** Phone-shaped runs — digits with the usual separators. Kept only when long enough. */
const PHONE_CANDIDATE = /\+?\d[\d\s().-]{6,}\d/g;
/**
 * Nine or more digits. Scripture references never come close ("Psalm 119:105"
 * has six, "1 Corinthians 13:4-7" four) and an ISO date has exactly eight,
 * while real phone numbers carry ten to fifteen.
 */
const MIN_PHONE_DIGITS = 9;

/** Deterministic pass: contact details and identifiers become bracketed placeholders. */
export function scrubPatterns(text: string): string {
  return text
    .replace(LINK, '[link]')
    .replace(EMAIL, '[email]')
    .replace(HANDLE, '[handle]')
    .replace(PHONE_CANDIDATE, (m) =>
      m.replace(/\D/g, '').length >= MIN_PHONE_DIGITS ? '[phone]' : m
    );
}

// ── Layer 2: names ───────────────────────────────────────────────────────────
const Scrubbed = z.object({
  user_message: z.string(),
  assistant_reply: z.string(),
});

const SYSTEM = `You are a privacy filter for a Bible-study chat log. You receive a user message and an assistant reply and return both with the names of private individuals removed.

Rules:
1. Replace the name of any real, private individual — the user, their family, friends, colleagues, pastors, teammates, neighbours, local church or community members, or anyone else who is not a public figure — with [name]. This includes first names, surnames, nicknames and initials used as names.
2. Keep every other name exactly as written: people and places in the Bible, historical and public figures, authors and titles of published works, organizations and denominations, languages, people groups, and the names of the books of the Bible.
3. Change nothing else. Do not translate, summarize, correct, reformat or shorten. Keep every line break, every other word and all punctuation. Placeholders already present, such as [phone], [email], [link] or [handle], stay exactly as they are.
4. The texts may be in any language. Apply the same rules in that language.

If a text contains no private names, return it unchanged.`;

/** Output mirrors input, so ~2 chars per token is a safe ceiling across scripts. */
function maxTokensFor(chars: number): number {
  return Math.min(16_000, Math.ceil(chars / 2) + 512);
}

/**
 * A scrub only swaps names for [name], so its length barely moves. Anything
 * further off — a summary, a translation, an empty string — is not a scrub.
 */
export function isPlausibleRewrite(input: string, output: string): boolean {
  const slack = Math.max(24, Math.ceil(input.length * 0.5));
  return Math.abs(output.length - input.length) <= slack;
}

function describeError(error: unknown): string {
  if (error instanceof Anthropic.APIError) return `${error.name} ${error.status ?? ''}`.trim();
  return error instanceof Error ? error.name : 'unknown';
}

/**
 * Scrub both halves of a turn. Never throws; see ScrubResult.
 *
 * The user message and reply travel in ONE request as tagged sections and
 * come back as one structured object, so the model sees the whole exchange
 * (a name introduced in the question is recognized in the answer).
 */
export async function scrubConversation(input: ScrubInput, env: ScrubEnv): Promise<ScrubResult> {
  if (!env.ANTHROPIC_API_KEY) return { ok: false, reason: 'no_api_key' };
  const user = scrubPatterns(input.userMessage);
  const assistant = scrubPatterns(input.assistantReply);
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 30_000 });
  try {
    const response = await client.messages.parse({
      model: env.SCRUB_MODEL ?? DEFAULT_SCRUB_MODEL,
      max_tokens: maxTokensFor(user.length + assistant.length),
      temperature: 0,
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: `<user_message>\n${user}\n</user_message>\n<assistant_reply>\n${assistant}\n</assistant_reply>`,
        },
      ],
      output_config: { format: zodOutputFormat(Scrubbed) },
    });
    if (response.stop_reason === 'max_tokens') return { ok: false, reason: 'truncated' };
    const parsed = response.parsed_output;
    if (!parsed) return { ok: false, reason: 'unparseable' };
    if (
      !isPlausibleRewrite(user, parsed.user_message) ||
      !isPlausibleRewrite(assistant, parsed.assistant_reply)
    ) {
      return { ok: false, reason: 'implausible' };
    }
    return { ok: true, userMessage: parsed.user_message, assistantReply: parsed.assistant_reply };
  } catch (error) {
    // The SDK throws its typed APIError for transport/HTTP failures and a plain
    // error when the structured output cannot be parsed. Neither carries our text.
    const reason: ScrubFailure = error instanceof Anthropic.APIError ? 'api_error' : 'unparseable';
    return { ok: false, reason, detail: describeError(error) };
  }
}
