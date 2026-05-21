<script lang="ts">
  import Sparkline from './Sparkline.svelte';
  import DeltaBadge from './DeltaBadge.svelte';
  import { formatMetric } from '$lib/format';

  type Props = {
    label: string;
    p50: number | null;
    p95: number | null;
    sparkline?: number[] | null;
    caption?: string | null;
  };

  let { label, p50, p95, sparkline, caption }: Props = $props();

  // Spread bar: visualizes p95 relative to p50 as a thin horizontal bar.
  // The bar's filled segment goes from 0% to (p50/p95) of width; the open
  // segment from there to 100% represents the tail. Both values present
  // and p95 > 0 required, otherwise the spread bar hides cleanly.
  const spreadPct = $derived(
    p50 !== null && p95 !== null && p95 > 0 ? Math.max(0, Math.min(100, (p50 / p95) * 100)) : null
  );
</script>

<div class="border-border bg-bg-card flex flex-col gap-3 rounded-2xl border p-5">
  <div class="flex items-center justify-between gap-2">
    <p class="text-fg-subtle text-[0.65rem] tracking-widest uppercase">{label}</p>
    <div class="flex items-center gap-2">
      {#if caption}
        <p class="text-fg-subtle/70 text-[0.6rem] tracking-wider lowercase">{caption}</p>
      {/if}
      <DeltaBadge series={sparkline} direction="lower_is_better" />
    </div>
  </div>

  <!-- Dual-value row: p50 (muted) and p95 (bright) with a thin spread bar
       between them. The spread reads as the latency distribution
       footprint without needing a full histogram. -->
  <div class="flex items-baseline gap-3">
    <span class="text-fg-muted tabular whitespace-nowrap text-lg font-light leading-none">
      {formatMetric(p50, 'duration_ms')}
    </span>
    {#if spreadPct !== null}
      <span class="relative min-w-0 flex-1">
        <span class="bg-border block h-px w-full"></span>
        <span
          class="bg-fg-muted absolute top-1/2 left-0 block h-px -translate-y-1/2"
          style="width: {spreadPct}%"
        ></span>
      </span>
    {/if}
    <span class="text-fg tabular whitespace-nowrap text-2xl font-light leading-none">
      {formatMetric(p95, 'duration_ms')}
    </span>
  </div>

  <div
    class="text-fg-subtle/80 flex items-baseline justify-between text-[0.55rem] tracking-widest uppercase"
  >
    <span>p50</span>
    <span>p95</span>
  </div>

  <div class="mt-auto">
    <Sparkline data={sparkline ?? null} height={32} />
  </div>
</div>
