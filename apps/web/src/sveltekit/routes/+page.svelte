<script lang="ts">
  import { onMount } from 'svelte';
  import type { MetricsSnapshot } from '@bt-servant-telemetry/shared';
  import { fetchSnapshot } from '$lib/api';
  import FlipCounter from '$lib/components/FlipCounter.svelte';

  type Window = 'all_time' | 'd30' | 'fixed';

  const WINDOW_LABELS: Record<Window, string> = {
    all_time: 'distinct users · all-time',
    d30: 'distinct users · last 30 days',
    fixed: 'distinct users · since epoch',
  };

  let snapshot = $state<MetricsSnapshot | null>(null);
  let window = $state<Window>('all_time');
  let loadError = $state<string | null>(null);

  function heroValue(snap: MetricsSnapshot | null, w: Window): number {
    if (!snap) return 0;
    if (w === 'all_time') return snap.distinct_users_all_time;
    if (w === 'd30') return snap.distinct_users_30d;
    return snap.distinct_users_fixed_epoch;
  }

  // Start at 2 digits; only grow to 3, 4, ... as the value forces it.
  // The library doesn't dynamically extend the panel set on value-only
  // changes, so the parent re-keys the FlipCounter when digit width
  // changes (see the {#key} in the template). Re-keying is cheap — the
  // hero is a single component and re-init is imperceptible at this scale.
  function heroDigits(value: number): number {
    return Math.max(3, String(Math.max(0, Math.floor(value))).length);
  }

  onMount(async () => {
    try {
      snapshot = await fetchSnapshot();
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    }
  });
</script>

<div class="mx-auto max-w-7xl px-6 py-12 lg:px-10 lg:py-16">
  <header class="mb-16 flex items-center justify-between">
    <div class="flex items-baseline gap-3">
      <span class="text-fg text-sm font-semibold tracking-wide uppercase">bt-servant</span>
      <span class="text-fg-subtle text-xs tracking-widest uppercase">telemetry</span>
    </div>
    <div
      class="border-border bg-bg-card flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs"
    >
      <span class="bg-status-up status-pulse h-1.5 w-1.5 rounded-full"></span>
      <span class="text-fg-muted tabular tracking-wider uppercase">up</span>
      <span class="text-fg-subtle">·</span>
      <span class="text-fg-subtle tabular">last event 3s ago</span>
    </div>
  </header>

  <!-- Hero stack: vertical rhythm declared as a single flex column with
       explicit gaps rather than scattered margin tokens on each child.
       gap-4 (eyebrow → counter) keeps the descriptor close to its number;
       gap-10 (counter → pills) opens a clear functional break before the
       interactive controls. Centered horizontally — the hero is the
       page's focal point, not a left-column metric. -->
  <section class="mb-20 flex flex-col items-center gap-10">
    <div class="flex flex-col items-center gap-4">
      <p class="text-fg-subtle text-xs tracking-[0.18em] uppercase">{WINDOW_LABELS[window]}</p>

      {#key heroDigits(heroValue(snapshot, window))}
        <FlipCounter
          value={heroValue(snapshot, window)}
          digits={heroDigits(heroValue(snapshot, window))}
        />
      {/key}
    </div>

    <div
      class="border-border bg-bg-card inline-flex rounded-full border p-1 text-xs tracking-wider uppercase"
      role="tablist"
      aria-label="Hero counter window"
    >
      <button
        type="button"
        role="tab"
        aria-selected={window === 'all_time'}
        class="rounded-full px-4 py-1.5 transition {window === 'all_time'
          ? 'bg-bg-elev text-fg ring-accent/30 ring-1 ring-inset'
          : 'text-fg-muted hover:text-fg'}"
        onclick={() => (window = 'all_time')}
      >
        All-time
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={window === 'd30'}
        class="rounded-full px-4 py-1.5 transition {window === 'd30'
          ? 'bg-bg-elev text-fg ring-accent/30 ring-1 ring-inset'
          : 'text-fg-muted hover:text-fg'}"
        onclick={() => (window = 'd30')}
      >
        Last 30 days
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={window === 'fixed'}
        class="rounded-full px-4 py-1.5 transition {window === 'fixed'
          ? 'bg-bg-elev text-fg ring-accent/30 ring-1 ring-inset'
          : 'text-fg-muted hover:text-fg'}"
        onclick={() => (window = 'fixed')}
      >
        Fixed from epoch
      </button>
    </div>

    {#if loadError}
      <p class="text-status-down text-xs tracking-wider uppercase">
        snapshot unavailable · {loadError}
      </p>
    {/if}
  </section>

  <hr class="hairline mb-12" />

  <!-- KPI grid still placeholder — wired in task #11 with KpiBarChart cards. -->
  <section class="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
    {#each [['returning', snapshot?.returning_users], ['logins', snapshot?.login_count], ['p50 chat', snapshot?.chat_total_ms_p50], ['p95 chat', snapshot?.chat_total_ms_p95], ['error rate', snapshot?.error_rate_1h_pct]] as [label, value]}
      <div class="border-border bg-bg-card rounded-2xl border p-5">
        <p class="text-fg-subtle mb-3 text-[0.65rem] tracking-widest uppercase">{label}</p>
        <p class="text-fg tabular text-2xl font-light">
          {value ?? '—'}
        </p>
      </div>
    {/each}
  </section>

  <p class="text-fg-subtle mt-16 text-center text-[0.65rem] tracking-widest uppercase">
    phase 5 · hero wired · charts next
  </p>
</div>
