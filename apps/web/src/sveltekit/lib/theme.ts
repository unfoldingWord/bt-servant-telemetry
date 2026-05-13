/**
 * Hardcoded chart colors that mirror the CSS theme tokens in app.css.
 *
 * Why hardcoded: ECharts renders to canvas and won't resolve CSS custom
 * properties at draw time. The values here are the sRGB approximations
 * of our oklch theme tokens — keep them in sync if app.css changes:
 *
 * - chart.fgMuted   ↔ --color-fg-muted    (≈ oklch 0.72 0 0)
 * - chart.fgSubtle  ↔ --color-fg-subtle   (≈ oklch 0.52 0 0)
 * - chart.bgCard    ↔ --color-bg-card     (≈ oklch 0.205 0.007 250)
 * - chart.accent    ↔ --color-accent      (≈ oklch 0.82 0.21 142)
 * - chart.border    ↔ --color-border      (≈ oklch 0.28 0.004 250)
 * - chart.areaTint  ↔ subtle accent overlay for area fills
 */
export const chartColor = {
  fgMuted: 'rgba(255, 255, 255, 0.42)',
  fgSubtle: 'rgba(255, 255, 255, 0.22)',
  bgCard: 'rgb(36, 38, 44)',
  accent: '#5DD89F',
  accentDim: 'rgba(93, 216, 159, 0.4)',
  accentTint: 'rgba(93, 216, 159, 0.08)',
  border: 'rgba(255, 255, 255, 0.08)',
  statusUp: '#5DC18C',
  statusDegraded: '#D8B05D',
  statusDown: '#E26A6A',
} as const;
