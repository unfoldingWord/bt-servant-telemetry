<script lang="ts">
  import { Chart } from 'svelte-echarts';
  import { init, type EChartsOption } from 'echarts';
  import { chartColor } from '$lib/theme';

  type Props = {
    /** Oldest-first numeric series. Nulls or NaN are treated as gaps. */
    data: number[] | null;
    /** Use the accent color (electric green) instead of muted fg. */
    accent?: boolean;
    /** Height in pixels — sparklines fill their container width. */
    height?: number;
  };

  let { data, accent = false, height = 36 }: Props = $props();

  const lineColor = $derived(accent ? chartColor.accent : chartColor.fgMuted);
  const fillColor = $derived(accent ? chartColor.accentTint : chartColor.border);

  const options: EChartsOption = $derived({
    animation: false,
    grid: { left: 0, right: 0, top: 2, bottom: 2, containLabel: false },
    xAxis: {
      type: 'category',
      show: false,
      boundaryGap: false,
      data: (data ?? []).map((_, i) => String(i)),
    },
    yAxis: { type: 'value', show: false, scale: true },
    tooltip: { show: false },
    series: [
      {
        type: 'line',
        data: data ?? [],
        showSymbol: false,
        smooth: 0.35,
        silent: true,
        lineStyle: { width: 1.5, color: lineColor },
        areaStyle: { color: fillColor },
      },
    ],
  });
</script>

{#if data && data.length > 1}
  <div class="sparkline" style="height: {height}px">
    <Chart {init} {options} />
  </div>
{:else}
  <!-- Empty/single-point state: render a faint baseline so the card's
       footer row doesn't collapse and disturb the grid rhythm. -->
  <div class="sparkline-empty" style="height: {height}px" aria-hidden="true"></div>
{/if}

<style>
  .sparkline {
    width: 100%;
  }
  .sparkline-empty {
    width: 100%;
    border-top: 1px dashed var(--color-border);
    margin-top: auto;
    opacity: 0.5;
  }
</style>
