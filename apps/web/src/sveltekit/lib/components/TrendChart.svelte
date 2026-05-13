<script lang="ts">
  import { Chart } from 'svelte-echarts';
  import { init, type EChartsOption } from 'echarts';
  import type { TrendSeries } from '@bt-servant-telemetry/shared';
  import { formatMetric, type MetricFormat } from '$lib/format';
  import { chartColor } from '$lib/theme';

  type Props = {
    label: string;
    series: TrendSeries | null;
    /** Bar for discrete daily counts; line for continuous rates / latency. */
    kind: 'bar' | 'line';
    /** Y-axis + tooltip value formatting. */
    format: MetricFormat;
    /** Top-right meta line — e.g. "last 30 days". */
    caption?: string;
    /** Optional horizontal reference line at this y-value (e.g. 2% degraded). */
    threshold?: number;
    /** Card-internal chart height in pixels. */
    height?: number;
    /** Use the accent color (line/bars + area fill on line). */
    accent?: boolean;
  };

  let {
    label,
    series,
    kind,
    format,
    caption,
    threshold,
    height = 200,
    accent = false,
  }: Props = $props();

  function formatDay(dayKey: number): string {
    const y = Math.floor(dayKey / 10000);
    const m = Math.floor((dayKey % 10000) / 100) - 1;
    const d = dayKey % 100;
    return new Date(Date.UTC(y, m, d)).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  }

  const dayLabels = $derived(series?.points.map((p) => formatDay(p.day)) ?? []);
  const dataValues = $derived(series?.points.map((p) => p.value) ?? []);
  const seriesColor = $derived(accent ? chartColor.accent : chartColor.fgMuted);

  const options: EChartsOption = $derived({
    animation: false,
    grid: { left: 44, right: 16, top: 12, bottom: 28, containLabel: false },
    xAxis: {
      type: 'category',
      data: dayLabels,
      boundaryGap: kind === 'bar',
      axisLine: { lineStyle: { color: chartColor.border } },
      axisLabel: {
        color: chartColor.fgSubtle,
        fontSize: 10,
        interval: 'auto',
        hideOverlap: true,
      },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: chartColor.border, opacity: 0.5 } },
      axisLabel: {
        color: chartColor.fgSubtle,
        fontSize: 10,
        formatter: (val: number) => formatMetric(val, format),
      },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: chartColor.bgCard,
      borderColor: chartColor.border,
      borderWidth: 1,
      padding: [6, 10],
      textStyle: { color: chartColor.fgMuted, fontSize: 11 },
      formatter: (raw: unknown) => {
        const params = Array.isArray(raw) ? raw : [raw];
        const p = params[0] as { axisValue: string; value: number | null };
        return `<div style="opacity:0.7">${p.axisValue}</div><div style="font-variant-numeric:tabular-nums">${formatMetric(p.value, format)}</div>`;
      },
      axisPointer: {
        type: 'line',
        lineStyle: { color: chartColor.border, type: 'solid', width: 1 },
      },
    },
    series: [
      kind === 'bar'
        ? {
            type: 'bar',
            data: dataValues,
            itemStyle: { color: seriesColor, borderRadius: [2, 2, 0, 0] },
            barMaxWidth: 18,
          }
        : {
            type: 'line',
            data: dataValues,
            smooth: 0.3,
            showSymbol: false,
            lineStyle: { width: 1.75, color: seriesColor },
            areaStyle: accent ? { color: chartColor.accentTint } : undefined,
            markLine:
              threshold === undefined
                ? undefined
                : {
                    silent: true,
                    symbol: 'none',
                    lineStyle: {
                      type: 'dashed',
                      color: chartColor.statusDegraded,
                      width: 1,
                      opacity: 0.7,
                    },
                    label: {
                      color: chartColor.statusDegraded,
                      fontSize: 10,
                      formatter: () => formatMetric(threshold, format),
                      position: 'insideEndTop',
                    },
                    data: [{ yAxis: threshold }],
                  },
          },
    ],
  });
</script>

<div class="border-border bg-bg-card flex flex-col gap-3 rounded-2xl border p-5">
  <div class="flex items-baseline justify-between">
    <p class="text-fg-subtle text-[0.65rem] tracking-widest uppercase">{label}</p>
    {#if caption}
      <p class="text-fg-subtle/70 text-[0.6rem] tracking-wider lowercase">{caption}</p>
    {/if}
  </div>
  <div style="height: {height}px">
    <Chart {init} {options} />
  </div>
</div>
