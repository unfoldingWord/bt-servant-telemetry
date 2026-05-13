import type { CleanEvent } from '@bt-servant-telemetry/shared';

/**
 * Dev seed — generates synthetic telemetry that exercises every metric
 * the dashboard shows. NOT for use against staging or production D1.
 *
 * Usage:
 *   pnpm seed       # runs wrangler dev on this script (port 8788)
 *   curl -X POST 'http://localhost:8788/?days=30&users=250'
 *
 * Then start the main dev worker:
 *   pnpm dev        # port 8787, serves /api/* and the dashboard
 *
 * Re-running clears the local DB tables first so seeding is idempotent.
 */

type SeedEnv = {
  DB: D1Database;
};

type Org = 'unfoldingWord' | 'wordcollective';
const CLIENT_BY_ORG: Record<Org, string> = {
  unfoldingWord: 'web',
  wordcollective: 'whatsapp',
};

// Deterministic RNG so re-seeds produce stable visuals.
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function hexHash(rand: () => number): string {
  let out = '';
  for (let i = 0; i < 64; i++) {
    out += Math.floor(rand() * 16).toString(16);
  }
  return out;
}

function pickOrg(rand: () => number): Org {
  // ~80/20 split.
  return rand() < 0.8 ? 'unfoldingWord' : 'wordcollective';
}

type SeedUser = { user_hash: string; org: Org; client_id: string };

function buildUserPool(rand: () => number, count: number): SeedUser[] {
  const users: SeedUser[] = [];
  for (let i = 0; i < count; i++) {
    const org = pickOrg(rand);
    users.push({ user_hash: hexHash(rand), org, client_id: CLIENT_BY_ORG[org] });
  }
  return users;
}

type DayPlan = {
  dayStartMs: number;
  activeUsers: number;
  chatVolume: number;
  errorCount: number;
  busyRejects: number;
};

type SeedShape = 'normal' | 'trouble';

function planDays(rand: () => number, days: number, shape: SeedShape): DayPlan[] {
  const plans: DayPlan[] = [];
  const today = new Date();
  const todayStartMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  for (let i = days - 1; i >= 0; i--) {
    const dayStartMs = todayStartMs - i * 86_400_000;
    const dayIndex = days - i - 1; // 0..days-1, oldest first
    const progress = days <= 1 ? 1 : dayIndex / (days - 1); // 0 (oldest) → 1 (newest)
    const jitter = 0.7 + rand() * 0.6;

    let activeUsers: number;
    let errorRate: number;
    if (shape === 'trouble') {
      // Declining engagement: ramp DOWN from 1.6x → 0.5x.
      activeUsers = Math.round(40 * (1.6 - progress * 1.1) * jitter);
      // Rising error rate: 0.5% → ~9% across the window, exponential
      // so the recent days are dramatically worse than the early ones.
      errorRate = 0.005 + 0.08 * progress ** 2 + rand() * 0.01;
    } else {
      // Gentle upward ramp + light jitter, baseline error rate.
      activeUsers = Math.round(40 * (0.6 + progress) * jitter);
      errorRate = 0.005 + rand() * 0.02;
    }
    const chatVolume = Math.round(activeUsers * (4 + rand() * 4));
    const errorCount = Math.round(chatVolume * errorRate);
    const busyRejects = Math.round(rand() * 3);
    plans.push({ dayStartMs, activeUsers, chatVolume, errorCount, busyRejects });
  }
  return plans;
}

function pickActiveUsers(rand: () => number, pool: SeedUser[], count: number): SeedUser[] {
  const picked: SeedUser[] = [];
  const seen = new Set<number>();
  const target = Math.min(count, pool.length);
  while (picked.length < target) {
    const idx = Math.floor(rand() * pool.length);
    if (seen.has(idx)) continue;
    seen.add(idx);
    const candidate = pool[idx];
    if (candidate) picked.push(candidate);
  }
  return picked;
}

function newRequestId(rand: () => number): string {
  return `req-${Math.floor(rand() * 1e12).toString(36)}`;
}

function jitterMs(rand: () => number, dayStartMs: number): number {
  return dayStartMs + Math.floor(rand() * 86_400_000);
}

function makeChatComplete(rand: () => number, user: SeedUser, dayStartMs: number): CleanEvent[] {
  const ts = jitterMs(rand, dayStartMs);
  const request_id = newRequestId(rand);
  // Latency distribution: log-normal-ish around 2-3s, long tail.
  const base = 1200 + rand() * 1800;
  const tailKick = rand() < 0.1 ? rand() * 6000 : 0;
  const totalMs = Math.round(base + tailKick);
  return [
    eventOf({ user, ts, request_id, event: 'request_received' }),
    eventOf({ user, ts: ts + 5, request_id, event: 'process_chat_complete', total_ms: totalMs }),
  ];
}

function makeError(rand: () => number, user: SeedUser, dayStartMs: number): CleanEvent[] {
  const ts = jitterMs(rand, dayStartMs);
  const request_id = newRequestId(rand);
  return [
    eventOf({ user, ts, request_id, event: 'request_received' }),
    eventOf({ user, ts: ts + 5, request_id, event: 'request_error', level: 'error' }),
  ];
}

function makeBusyReject(rand: () => number, user: SeedUser, dayStartMs: number): CleanEvent[] {
  const ts = jitterMs(rand, dayStartMs);
  const request_id = newRequestId(rand);
  return [
    eventOf({ user, ts, request_id, event: 'request_received' }),
    eventOf({ user, ts: ts + 5, request_id, event: 'chat_busy_final_reject' }),
  ];
}

type EventOpts = {
  user: SeedUser;
  ts: number;
  request_id: string;
  event: string;
  level?: string | null;
  total_ms?: number | null;
};

function eventOf(opts: EventOpts): CleanEvent {
  return {
    event: opts.event,
    ts: opts.ts,
    level: opts.level ?? null,
    org: opts.user.org,
    user_hash: opts.user.user_hash,
    client_id: opts.user.client_id,
    request_id: opts.request_id,
    total_ms: opts.total_ms ?? null,
    duration_ms: null,
    chat_type: null,
    transport: null,
    tool_name: null,
    server_id: null,
    first_interaction: null,
  };
}

function generateEvents(rand: () => number, pool: SeedUser[], plans: DayPlan[]): CleanEvent[] {
  const events: CleanEvent[] = [];
  for (const day of plans) {
    const todaysUsers = pickActiveUsers(rand, pool, day.activeUsers);
    // Mark each user's first interaction in the seed window for snapshot
    // returning-users math.
    for (const u of todaysUsers) {
      events.push(
        eventOf({
          user: u,
          ts: day.dayStartMs + 100,
          request_id: newRequestId(rand),
          event: 'request_received',
        })
      );
    }
    for (let i = 0; i < day.chatVolume; i++) {
      const u = todaysUsers[Math.floor(rand() * todaysUsers.length)];
      if (!u) continue;
      events.push(...makeChatComplete(rand, u, day.dayStartMs));
    }
    for (let i = 0; i < day.errorCount; i++) {
      const u = todaysUsers[Math.floor(rand() * todaysUsers.length)];
      if (!u) continue;
      events.push(...makeError(rand, u, day.dayStartMs));
    }
    for (let i = 0; i < day.busyRejects; i++) {
      const u = todaysUsers[Math.floor(rand() * todaysUsers.length)];
      if (!u) continue;
      events.push(...makeBusyReject(rand, u, day.dayStartMs));
    }
  }
  return events;
}

async function clearTables(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM events'),
    db.prepare('DELETE FROM users'),
    db.prepare('DELETE FROM user_active_days'),
  ]);
}

function utcDayKey(ts: number): number {
  const d = new Date(ts);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

/**
 * Bulk-write events directly via D1.batch — bypasses ingestBatch's
 * one-statement-at-a-time loop, which would hit the worker CPU budget
 * at this volume. The seed is dev-only and trusted input, so we can
 * skip the order-independent dedupe logic in upsertUser and instead
 * compute days_active_count up front from user_active_days.
 */
async function bulkWrite(db: D1Database, events: CleanEvent[]): Promise<void> {
  if (events.length === 0) return;
  const evtStmt = db.prepare(
    `INSERT OR IGNORE INTO events
       (request_id, event, ts, level, org, user_hash, client_id, total_ms,
        duration_ms, chat_type, transport, tool_name, server_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const dayStmt = db.prepare(
    `INSERT OR IGNORE INTO user_active_days (user_hash, org, day) VALUES (?, ?, ?)`
  );
  const eventBatch = events.map((e) =>
    evtStmt.bind(
      e.request_id,
      e.event,
      e.ts,
      e.level,
      e.org,
      e.user_hash,
      e.client_id,
      e.total_ms,
      e.duration_ms,
      e.chat_type,
      e.transport,
      e.tool_name,
      e.server_id
    )
  );
  const dayBatch: D1PreparedStatement[] = [];
  const seenDays = new Set<string>();
  for (const e of events) {
    if (!e.user_hash || !e.org) continue;
    const day = utcDayKey(e.ts);
    const key = `${e.user_hash}|${e.org}|${day}`;
    if (seenDays.has(key)) continue;
    seenDays.add(key);
    dayBatch.push(dayStmt.bind(e.user_hash, e.org, day));
  }
  // D1.batch caps at 1000 statements per call; chunk defensively.
  const CHUNK = 500;
  const everything = [...eventBatch, ...dayBatch];
  for (let i = 0; i < everything.length; i += CHUNK) {
    await db.batch(everything.slice(i, i + CHUNK));
  }
}

async function recomputeUsers(db: D1Database): Promise<void> {
  // Derive users from user_active_days + events. first_seen_ts =
  // earliest event ts per (user_hash, org), days_active_count = COUNT
  // from user_active_days.
  await db
    .prepare(
      `INSERT OR REPLACE INTO users
         (user_hash, org, client_id, first_seen_ts, last_seen_ts,
          days_active_count, last_active_day, first_interaction_transition_ts)
       SELECT
         e.user_hash,
         e.org,
         MAX(e.client_id) AS client_id,
         MIN(e.ts) AS first_seen_ts,
         MAX(e.ts) AS last_seen_ts,
         (SELECT COUNT(*) FROM user_active_days uad
           WHERE uad.user_hash = e.user_hash AND uad.org = e.org) AS days_active_count,
         (SELECT MAX(day) FROM user_active_days uad
           WHERE uad.user_hash = e.user_hash AND uad.org = e.org) AS last_active_day,
         NULL AS first_interaction_transition_ts
       FROM events e
       WHERE e.user_hash IS NOT NULL AND e.org IS NOT NULL
       GROUP BY e.user_hash, e.org`
    )
    .run();
}

async function runSeed(
  env: SeedEnv,
  opts: { days: number; users: number; seed: number; shape: SeedShape }
): Promise<{ events: number; days: number; users: number; shape: SeedShape }> {
  const rand = rng(opts.seed);
  await clearTables(env.DB);
  const pool = buildUserPool(rand, opts.users);
  const plans = planDays(rand, opts.days, opts.shape);
  const events = generateEvents(rand, pool, plans);
  await bulkWrite(env.DB, events);
  await recomputeUsers(env.DB);
  return { events: events.length, days: opts.days, users: opts.users, shape: opts.shape };
}

function parseNonneg(input: string | null, fallback: number, max: number): number {
  if (!input) return fallback;
  const n = Number(input);
  if (!Number.isFinite(n) || n < 1 || n > max) return fallback;
  return Math.floor(n);
}

const handler: ExportedHandler<SeedEnv> = {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response(
        'POST /?days=30&users=250&seed=42 — seeds local dev D1 with synthetic telemetry',
        { status: 405 }
      );
    }
    try {
      const url = new URL(request.url);
      const days = parseNonneg(url.searchParams.get('days'), 30, 120);
      const users = parseNonneg(url.searchParams.get('users'), 250, 5000);
      const seed = parseNonneg(url.searchParams.get('seed'), 42, 1_000_000);
      const shape: SeedShape = url.searchParams.get('shape') === 'trouble' ? 'trouble' : 'normal';
      const summary = await runSeed(env, { days, users, seed, shape });
      return Response.json(summary);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  },
};

export default handler;
