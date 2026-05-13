<script lang="ts">
  import { computeDelta, deltaQuality, type MetricDirection } from '$lib/delta';

  type Props = {
    /** Sparkline series the delta is computed from. */
    series: number[] | null | undefined;
    /** Higher is good for users; lower is good for error rate / latency. */
    direction: MetricDirection;
  };

  let { series, direction }: Props = $props();

  const signal = $derived(computeDelta(series));
  const quality = $derived(signal ? deltaQuality(signal, direction) : null);

  function fmt(pct: number): string {
    const abs = Math.abs(pct);
    if (abs >= 100) return `${Math.round(abs)}%`;
    if (abs >= 10) return `${abs.toFixed(0)}%`;
    return `${abs.toFixed(1)}%`;
  }
</script>

{#if signal && quality}
  <span
    class="tabular inline-flex items-center gap-0.5 text-[0.65rem] tracking-wider tabular-nums"
    class:text-status-up={quality === 'good'}
    class:text-status-down={quality === 'bad'}
    class:text-fg-subtle={quality === 'flat'}
    aria-label={`${signal.pctChange > 0 ? 'up' : signal.pctChange < 0 ? 'down' : 'flat'} ${fmt(signal.pctChange)} vs prior window`}
  >
    {#if signal.arrow === 'up'}
      <span aria-hidden="true">▲</span>{fmt(signal.pctChange)}
    {:else if signal.arrow === 'down'}
      <span aria-hidden="true">▼</span>{fmt(signal.pctChange)}
    {:else}
      <span aria-hidden="true">—</span>
    {/if}
  </span>
{/if}
