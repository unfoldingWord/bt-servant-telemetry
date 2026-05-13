<script lang="ts">
  import Sparkline from './Sparkline.svelte';
  import DeltaBadge from './DeltaBadge.svelte';
  import { formatMetric, type MetricFormat } from '$lib/format';
  import type { MetricDirection } from '$lib/delta';

  type Props = {
    label: string;
    value: number | null;
    format: MetricFormat;
    /** Oldest-first series for the sparkline at the bottom of the tile. */
    sparkline?: number[] | null;
    /** Optional second-line caption — e.g. "trailing 1h" / "≥ 2 active days". */
    caption?: string | null;
    /** When true, the sparkline draws in the accent color. Use sparingly
        — reserve for the metric most worth eye-catching attention. */
    accent?: boolean;
    /** Determines whether ▲ in the delta badge is good (engagement up)
        or bad (error rate up). Defaults to higher-is-better. */
    direction?: MetricDirection;
    /** Whether to render the delta-momentum badge next to the value.
        Set false when the sparkline does NOT represent the headline
        metric — e.g. cohort tiles where the sparkline is overall daily
        activity but the headline is a cumulative cohort count. A delta
        derived from a different series would silently contradict the
        headline number. */
    showDelta?: boolean;
  };

  let {
    label,
    value,
    format,
    sparkline,
    caption,
    accent = false,
    direction = 'higher_is_better',
    showDelta = true,
  }: Props = $props();

  const display = $derived(formatMetric(value, format));
</script>

<div class="border-border bg-bg-card flex flex-col gap-3 rounded-2xl border p-5">
  <div class="flex items-baseline justify-between">
    <p class="text-fg-subtle text-[0.65rem] tracking-widest uppercase">{label}</p>
    {#if caption}
      <p class="text-fg-subtle/70 text-[0.6rem] tracking-wider lowercase">{caption}</p>
    {/if}
  </div>

  <div class="flex items-baseline gap-2">
    <p class="text-fg tabular text-3xl font-light leading-none">{display}</p>
    {#if showDelta}
      <DeltaBadge series={sparkline} {direction} />
    {/if}
  </div>

  <div class="mt-auto">
    <Sparkline data={sparkline ?? null} {accent} height={36} />
  </div>
</div>
