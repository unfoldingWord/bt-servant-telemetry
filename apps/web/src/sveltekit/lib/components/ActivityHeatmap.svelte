<script lang="ts">
  import { Chart } from 'svelte-echarts';
  import { init, type EChartsOption } from 'echarts';
  import type { EventHeatmapPayload } from '@bt-servant-telemetry/shared';
  import { chartColor } from '$lib/theme';

  type Props = {
    label: string;
    caption?: string;
    payload: EventHeatmapPayload | null;
    height?: number;
  };

  let { label, caption, payload, height = 200 }: Props = $props();

  // Display order: Mon-first. SQLite's strftime('%w') returns
  // 0=Sun..6=Sat; remap so Monday sits at the top of the y-axis. ECharts
  // category axes render top-to-bottom in array order — to read top→bottom
  // as Mon→Sun, we put Sun last.
  const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const HOUR_LABELS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));

  function sqliteDowToYIndex(sqliteDow: number): number {
    // SQLite: 0=Sun..6=Sat. Display: 0=Mon..6=Sun.
    return (sqliteDow + 6) % 7;
  }

  type Cell = [hour: number, yIndex: number, count: number];

  const cells = $derived<Cell[]>(
    (payload?.buckets ?? []).map((b) => [b.hour, sqliteDowToYIndex(b.dow), b.count])
  );
  const maxCount = $derived(cells.reduce((m, c) => Math.max(m, c[2]), 0));

  const options: EChartsOption = $derived({
    animation: false,
    grid: { left: 48, right: 24, top: 12, bottom: 32, containLabel: false },
    xAxis: {
      type: 'category',
      data: HOUR_LABELS,
      axisLine: { lineStyle: { color: chartColor.border } },
      axisLabel: {
        color: chartColor.fgSubtle,
        fontSize: 10,
        interval: 3,
        formatter: (v: string) => `${v}h`,
      },
      axisTick: { show: false },
      splitArea: { show: false },
    },
    yAxis: {
      type: 'category',
      data: DOW_LABELS,
      // ECharts renders the first array element at the BOTTOM by default.
      // Invert so Mon sits at the top, matching how operators read a week.
      inverse: true,
      axisLine: { lineStyle: { color: chartColor.border } },
      axisLabel: { color: chartColor.fgSubtle, fontSize: 10 },
      axisTick: { show: false },
      splitArea: { show: false },
    },
    visualMap: {
      type: 'continuous',
      min: 0,
      max: maxCount > 0 ? maxCount : 1,
      show: false,
      inRange: { color: [chartColor.bgCard, chartColor.accentDim, chartColor.accent] },
    },
    tooltip: {
      trigger: 'item',
      backgroundColor: chartColor.bgCard,
      borderColor: chartColor.border,
      borderWidth: 1,
      padding: [6, 10],
      textStyle: { color: chartColor.fgMuted, fontSize: 11 },
      formatter: (raw: unknown) => {
        const p = raw as { value: Cell; name: string };
        const [hour, yIndex, count] = p.value;
        const dow = DOW_LABELS[yIndex] ?? '';
        return `<div style="opacity:0.7">${dow} · ${String(hour).padStart(2, '0')}:00</div><div style="font-variant-numeric:tabular-nums">${count.toLocaleString('en-US')} events</div>`;
      },
    },
    series: [
      {
        type: 'heatmap',
        data: cells,
        itemStyle: { borderRadius: 2, borderColor: chartColor.bgCard, borderWidth: 1 },
        emphasis: { itemStyle: { borderColor: chartColor.accent, borderWidth: 1 } },
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
