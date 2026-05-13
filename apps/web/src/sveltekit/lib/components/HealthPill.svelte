<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { HealthSnapshot } from '@bt-servant-telemetry/shared';

  type Props = {
    health: HealthSnapshot | null;
  };

  let { health }: Props = $props();

  // Tick a counter every second so the "last event Ns ago" relative
  // string refreshes between health polls — otherwise the timestamp
  // would visibly stall for 15s at a stretch.
  let nowMs = $state(Date.now());
  let tickInterval: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    tickInterval = setInterval(() => {
      nowMs = Date.now();
    }, 1000);
  });

  onDestroy(() => {
    if (tickInterval !== null) clearInterval(tickInterval);
  });

  const status = $derived(health?.status ?? null);

  const dotClass = $derived(
    status === 'up'
      ? 'bg-status-up status-pulse'
      : status === 'degraded'
        ? 'bg-status-degraded'
        : status === 'down'
          ? 'bg-status-down'
          : 'bg-fg-subtle'
  );

  const statusLabel = $derived(status ?? 'loading');

  function relativeTime(ms: number | null, now: number): string {
    if (ms === null) return '—';
    const diff = Math.max(0, now - ms);
    if (diff < 5000) return 'just now';
    if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    return `${Math.floor(diff / 3_600_000)}h ago`;
  }

  const lastEventLabel = $derived(
    health ? `last event ${relativeTime(health.last_event_ts, nowMs)}` : 'waiting for signal'
  );
</script>

<div
  class="border-border bg-bg-card flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs"
  role="status"
  aria-live="polite"
  aria-label={`telemetry status ${statusLabel}; ${lastEventLabel}`}
>
  <span class="{dotClass} h-1.5 w-1.5 rounded-full" aria-hidden="true"></span>
  <span class="text-fg-muted tabular tracking-wider uppercase">{statusLabel}</span>
  <span class="text-fg-subtle" aria-hidden="true">·</span>
  <span class="text-fg-subtle tabular">{lastEventLabel}</span>
</div>
