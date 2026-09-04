/**
 * Conversation-text scrubber (ingest/scrub.ts).
 *
 * Layer 1 is pinned exactly: what a regex must catch and — just as important
 * in a Bible-study corpus — what it must leave alone. Layer 2 runs the REAL
 * Anthropic SDK against a stubbed `fetch`, so the request shape (model,
 * structured output, tagged sections) and every fail-closed branch are
 * exercised without network.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DEFAULT_SCRUB_MODEL,
  isPlausibleRewrite,
  scrubConversation,
  scrubPatterns,
} from '../../src/ingest/scrub.js';

const ANTHROPIC = 'https://api.anthropic.com';
type Seen = { body: Record<string, unknown> };
type StubOptions = { status?: number; stopReason?: string };

/** Answer every Anthropic call with a Messages API message whose text is `reply(request)`, or an error. */
function stubAnthropic(
  reply: (req: Record<string, unknown>) => string,
  opts: StubOptions = {}
): Seen[] {
  const seen: Seen[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith(ANTHROPIC)) throw new Error(`unexpected fetch: ${url}`);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    seen.push({ body });
    const headers = { 'content-type': 'application/json' };
    if (opts.status !== undefined && opts.status >= 400) {
      const error = { type: 'error', error: { type: 'invalid_request_error', message: 'nope' } };
      return new Response(JSON.stringify(error), { status: opts.status, headers });
    }
    const message = {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: DEFAULT_SCRUB_MODEL,
      content: [{ type: 'text', text: reply(body) }],
      stop_reason: opts.stopReason ?? 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    return new Response(JSON.stringify(message), { status: 200, headers });
  });
  return seen;
}

/** The section the scrubber sent under one tag, as the model would read it. */
function section(body: Record<string, unknown>, tag: string): string {
  const content = (body.messages as Array<{ content: string }>)[0]?.content ?? '';
  return new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(content)?.[1] ?? '';
}

/** A well-behaved model: swaps "Bob" for [name] and touches nothing else. */
const swapBob = (body: Record<string, unknown>): string =>
  JSON.stringify({
    user_message: section(body, 'user_message').replace(/Bob/g, '[name]'),
    assistant_reply: section(body, 'assistant_reply').replace(/Bob/g, '[name]'),
  });

const ENV = { ANTHROPIC_API_KEY: 'sk-ant-test' };
const INPUT = {
  userMessage:
    'My pastor Bob said to call him at +1 (555) 010-9999 or bob@church.org. What does John 3:16 mean?',
  assistantReply:
    "Bob may be thinking of John 3:16, where Jesus speaks of God's love for the world.",
};

afterEach(() => vi.restoreAllMocks());

describe('scrubPatterns, layer 1', () => {
  it.each([
    ['email', 'write to bob@church.org today', 'write to [email] today'],
    [
      'link',
      'see https://door43.org/u/unfoldingWord/en_ult?x=1 for the text',
      'see [link] for the text',
    ],
    ['handle', 'ping @bob_smith about it', 'ping [handle] about it'],
    ['formatted phone', 'call +1 (555) 010-9999 now', 'call [phone] now'],
    ['plain digit run', 'my number is 08012345678', 'my number is [phone]'],
  ])('replaces a %s', (_label, input, expected) => {
    expect(scrubPatterns(input)).toBe(expected);
  });

  it.each([
    'What does John 3:16 mean?',
    'Read 1 Corinthians 13:4-7 and Psalm 119:105.',
    'Genesis 1-11 covers creation to Babel.',
    'We met on 2026-09-04 at 12:30.',
    'There were 5,000 men plus women and children (Matthew 14:21).',
    'Jesus said it in Matthew 5:3-12, the Beatitudes.',
  ])('leaves scripture references, dates and counts alone: %s', (text) => {
    expect(scrubPatterns(text)).toBe(text);
  });

  it('keeps every other character exactly, including line breaks', () => {
    const text = 'Line one.\n\nLine two with an email x@y.org.\nLine three.';
    expect(scrubPatterns(text)).toBe('Line one.\n\nLine two with an email [email].\nLine three.');
  });
});

describe('isPlausibleRewrite', () => {
  it('accepts name swaps in short and long text', () => {
    expect(isPlausibleRewrite('Hi Bob', 'Hi [name]')).toBe(true);
    expect(isPlausibleRewrite('Bob', '[name]')).toBe(true);
    const long = 'word '.repeat(200);
    expect(isPlausibleRewrite(long, long.replace(/word/g, '[name]'))).toBe(true);
  });

  it('rejects a summary, a blank, or a runaway rewrite', () => {
    const long = 'word '.repeat(200);
    expect(isPlausibleRewrite(long, 'A short summary.')).toBe(false);
    expect(isPlausibleRewrite(long, '')).toBe(false);
    expect(isPlausibleRewrite(long, long + long)).toBe(false);
  });
});

describe('scrubConversation, layer 2 over the real SDK', () => {
  it('returns both texts with names swapped, after the patterns already ran', async () => {
    const seen = stubAnthropic(swapBob);
    const result = await scrubConversation(INPUT, ENV);
    expect(result).toEqual({
      ok: true,
      userMessage:
        'My pastor [name] said to call him at [phone] or [email]. What does John 3:16 mean?',
      assistantReply:
        "[name] may be thinking of John 3:16, where Jesus speaks of God's love for the world.",
    });
    // The model never saw the raw phone number or email: patterns ran first.
    const sent = JSON.stringify(seen[0]?.body);
    expect(sent).not.toContain('010-9999');
    expect(sent).not.toContain('bob@church.org');
    expect(sent).toContain('[phone]');
  });

  it('asks the default Haiku model for structured output at temperature 0', async () => {
    const seen = stubAnthropic(swapBob);
    await scrubConversation(INPUT, ENV);
    const body = seen[0]?.body as Record<string, unknown>;
    expect(body.model).toBe(DEFAULT_SCRUB_MODEL);
    expect(body.temperature).toBe(0);
    expect(body.output_config).toMatchObject({ format: { type: 'json_schema' } });
    expect(typeof body.system).toBe('string');
  });

  it('honours SCRUB_MODEL', async () => {
    const seen = stubAnthropic(swapBob);
    await scrubConversation(INPUT, { ...ENV, SCRUB_MODEL: 'claude-sonnet-5' });
    expect((seen[0]?.body as Record<string, unknown>).model).toBe('claude-sonnet-5');
  });

  it('fails closed without a key, and never calls out', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await scrubConversation(INPUT, {})).toEqual({ ok: false, reason: 'no_api_key' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails closed on an API error', async () => {
    stubAnthropic(swapBob, { status: 400 });
    const result = await scrubConversation(INPUT, ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('api_error');
  });

  it('fails closed when the model summarizes instead of scrubbing', async () => {
    stubAnthropic(() =>
      JSON.stringify({ user_message: 'A question about John 3:16.', assistant_reply: '' })
    );
    expect(await scrubConversation(INPUT, ENV)).toEqual({ ok: false, reason: 'implausible' });
  });

  it('fails closed when the output was cut short', async () => {
    stubAnthropic(swapBob, { stopReason: 'max_tokens' });
    expect(await scrubConversation(INPUT, ENV)).toEqual({ ok: false, reason: 'truncated' });
  });

  it('fails closed when the output is not the expected JSON', async () => {
    stubAnthropic(() => 'Sure! Here is the scrubbed text: ...');
    const result = await scrubConversation(INPUT, ENV);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unparseable');
  });
});
