<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    EventHeatmapPayload,
    MetricsSnapshot,
    SparklinesPayload,
    TrendSeries,
  } from '@bt-servant-telemetry/shared';
  import { fetchEventHeatmap, fetchSnapshot, fetchSparklines, fetchTrend } from '$lib/api';
  import ActivityHeatmap from '$lib/components/ActivityHeatmap.svelte';
  import FlipCounter from '$lib/components/FlipCounter.svelte';
  import KpiTile from '$lib/components/KpiTile.svelte';
  import LatencyTile from '$lib/components/LatencyTile.svelte';
  import TrendChart from '$lib/components/TrendChart.svelte';

  type Window = 'all_time' | 'd30' | 'fixed';

  const WINDOW_LABELS: Record<Window, string> = {
    all_time: 'distinct users · all-time',
    d30: 'distinct users · last 30 days',
    fixed: 'distinct users · since epoch',
  };

  let snapshot = $state<MetricsSnapshot | null>(null);
  let sparklines = $state<SparklinesPayload | null>(null);
  let trendDistinctUsers = $state<TrendSeries | null>(null);
  let trendErrorRate = $state<TrendSeries | null>(null);
  let trendP95 = $state<TrendSeries | null>(null);
  let eventHeatmap = $state<EventHeatmapPayload | null>(null);
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
    // All payloads fire in parallel — none share dependencies and the page
    // is faster if they all start immediately rather than chained.
    const [snap, spk, td, te, tp, eh] = await Promise.allSettled([
      fetchSnapshot(),
      fetchSparklines(30),
      fetchTrend('distinct_users', 30),
      fetchTrend('error_rate', 30),
      fetchTrend('p95_latency', 30),
      fetchEventHeatmap(30),
    ]);
    if (snap.status === 'fulfilled') snapshot = snap.value;
    else loadError = snap.reason instanceof Error ? snap.reason.message : String(snap.reason);
    if (spk.status === 'fulfilled') sparklines = spk.value;
    if (td.status === 'fulfilled') trendDistinctUsers = td.value;
    if (te.status === 'fulfilled') trendErrorRate = te.value;
    if (tp.status === 'fulfilled') trendP95 = tp.value;
    if (eh.status === 'fulfilled') eventHeatmap = eh.value;
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

  <!-- Mission verse. Lives as a quiet band between the loud hero and the
       data tiles — Source Serif italic, centered, citation underneath in
       small-caps. Reads as a deliberate pause before operational data. -->
  <aside class="mb-12 flex flex-col items-center gap-3 text-center">
    <blockquote
      class="text-fg-muted max-w-2xl text-xl leading-snug italic"
      style="font-family: var(--font-serif); font-optical-sizing: auto;"
    >
      &ldquo;The unfolding of your words gives light.&rdquo;
    </blockquote>
    <cite
      class="text-fg-subtle text-[0.65rem] tracking-[0.18em] uppercase not-italic"
      style="font-family: var(--font-serif);"
    >
      Psalm 119:130
    </cite>
  </aside>

  <hr class="hairline mb-12" />

  <!-- KPI grid. Tile order from left to right is intentional:
       returning → curious → faithful escalates user loyalty; chat
       latency is operational; error rate is the alarm signal and sits
       on the far right so the eye sweeps from "engagement" to "danger". -->
  <section class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-5">
    <KpiTile
      label="returning users"
      value={snapshot?.returning_users ?? null}
      format="integer"
      caption="≥ 2 active days"
      sparkline={sparklines?.returning_users ?? null}
      direction="higher_is_better"
    />

    <KpiTile
      label="curious users"
      value={snapshot?.curious_users ?? null}
      format="integer"
      caption="≥ 5 active days"
      sparkline={sparklines?.curious_users ?? null}
      direction="higher_is_better"
    />

    <KpiTile
      label="faithful users"
      value={snapshot?.faithful_users ?? null}
      format="integer"
      caption="≥ 10 active days"
      sparkline={sparklines?.faithful_users ?? null}
      direction="higher_is_better"
    />

    <LatencyTile
      label="chat latency"
      p50={snapshot?.chat_total_ms_p50 ?? null}
      p95={snapshot?.chat_total_ms_p95 ?? null}
      sparkline={sparklines?.chat_p95 ?? null}
      caption="trailing 1h"
    />

    <KpiTile
      label="error rate"
      value={snapshot?.error_rate_1h_pct ?? null}
      format="percent"
      caption="trailing 1h"
      sparkline={sparklines?.error_rate ?? null}
      direction="lower_is_better"
      accent
    />
  </section>

  <!-- Trend section. 2-up grid at lg+ so the four charts read as tiles
       rather than a long stack. Each chart drills into one metric:
         • distinct users / day → bar (discrete daily count)
         • error rate / day    → line + 2% threshold ref
         • p95 latency / day   → line (continuous trend)
         • activity rhythm     → hour-of-week heatmap (operational pattern)
       Heights normalized so the 2x2 grid lines up cleanly. -->
  <section class="mt-16 grid grid-cols-1 gap-4 lg:grid-cols-2">
    <TrendChart
      label="distinct users per day"
      caption="last 30 days"
      series={trendDistinctUsers}
      kind="bar"
      format="integer"
      height={220}
    />
    <TrendChart
      label="error rate per day"
      caption="last 30 days · 2% degraded"
      series={trendErrorRate}
      kind="line"
      format="percent"
      threshold={2}
      height={220}
      accent
    />
    <TrendChart
      label="p95 chat latency per day"
      caption="last 30 days"
      series={trendP95}
      kind="line"
      format="duration_ms"
      height={220}
    />

    <ActivityHeatmap
      label="activity rhythm"
      caption="events by hour-of-week · last 30 days"
      payload={eventHeatmap}
      height={220}
    />
  </section>

  <p class="text-fg-subtle mt-16 text-center text-[0.65rem] tracking-widest uppercase">
    phase 5 · charts + heatmap wired · health pill next
  </p>
</div>
