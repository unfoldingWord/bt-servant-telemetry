<script lang="ts">
  import { onDestroy, onMount } from 'svelte';

  type Props = {
    value: number;
    digits?: number;
  };

  // Hero counter wrapping @pqina/flip. The library is client-only (it
  // mutates the DOM and reads computed styles), so we lazy-import inside
  // onMount — adapter-static prerenders this page at build time and would
  // otherwise SSR-crash on `window`.
  let { value, digits = 6 }: Props = $props();

  let root: HTMLDivElement;
  // Library has no shipped types; the `unknown` is intentional — we
  // only mutate `.value` via the helper below.
  let tick: { value: string | number; root: HTMLElement } | null = null;
  let TickRef: {
    DOM: { create: (el: HTMLElement) => typeof tick; destroy: (el: HTMLElement) => void };
  } | null = null;

  function pad(n: number): string {
    return String(Math.max(0, Math.floor(n))).padStart(digits, '0');
  }

  onMount(async () => {
    const mod = await import('@pqina/flip');
    await import('@pqina/flip/dist/flip.css');
    TickRef = mod.default;
    if (!TickRef) return;
    tick = TickRef.DOM.create(root);
    if (tick) {
      tick.value = pad(value);
      tick.root.setAttribute('aria-label', String(value));
    }
  });

  onDestroy(() => {
    if (TickRef && root) {
      try {
        TickRef.DOM.destroy(root);
      } catch {
        // best-effort cleanup; the lib occasionally throws on already-torn-down nodes
      }
    }
  });

  $effect(() => {
    const padded = pad(value);
    if (tick) {
      tick.value = padded;
      tick.root.setAttribute('aria-label', String(value));
    }
  });
</script>

<div
  bind:this={root}
  class="tick flip-counter"
  data-value={pad(value)}
  aria-label={String(value)}
  role="status"
>
  <div data-repeat="true" aria-hidden="true">
    <span data-view="flip"></span>
  </div>
</div>

<style>
  /* Hero scale — clamp tied to viewport so the counter remains the
     visual anchor across breakpoints without breaking the tile geometry. */
  .flip-counter {
    font-size: clamp(4rem, 14vw, 11rem);
    line-height: 1;
    display: inline-block;
    /* inline-block elements sit on the baseline by default, which leaves
       a phantom descender of leading. Top-align so the counter lines up
       cleanly with the eyebrow label above it. */
    vertical-align: top;
  }

  /* Neutralize @pqina/flip's intrinsic margin scheme. The library sets
     `margin: -.25em` on the panel row's `[data-layout~='pad']` container
     to compensate for `margin: .25em` on each panel. That negative outer
     margin pulls the leftmost digit ~0.25em LEFT of our wrapper, breaking
     left-edge alignment with the eyebrow and toggle pills. We zero both
     and use an explicit `gap` so the inter-panel rhythm is deliberate
     rather than a side effect of competing margins. */
  .flip-counter :global([data-layout~='pad']) {
    margin: 0;
  }
  .flip-counter :global([data-layout~='pad'] > *) {
    margin: 0;
  }
  .flip-counter :global([data-layout~='horizontal']) {
    gap: 0.12em;
    justify-content: flex-start;
  }

  /* @pqina/flip injects a `.tick-credits` link back to pqina.nl in the
     bottom-right of every counter. MIT license permits removal — hide it
     so the hero reads as our UI, not a third-party widget. */
  .flip-counter :global(.tick-credits) {
    display: none !important;
  }

  /* Re-skin the default flip panels to the bt-servant palette:
     electric-green digits on the card surface, no off-white. */
  .flip-counter :global(.tick-flip-panel) {
    color: var(--color-accent);
    background-color: var(--color-bg-card);
  }
  .flip-counter :global(.tick-flip-panel-text-wrapper) {
    font-family: var(--font-mono);
    font-weight: 300;
    font-variant-numeric: tabular-nums;
  }
  /* Soften the default deep-shadow seam between panels so it reads as
     "split-flap" rather than "skeuomorphic plastic." */
  .flip-counter :global(.tick-flip-panel-back),
  .flip-counter :global(.tick-flip-panel-front) {
    background-color: var(--color-bg-card);
  }
  .flip-counter :global(.tick-flip-spacer) {
    background-color: var(--color-bg);
  }
</style>
