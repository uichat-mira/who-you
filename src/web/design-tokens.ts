// Web design source of truth. See DESIGN.md for design intent.
// Brand primitives: supplied Who-You Web kit, 2026-11-26.
// Remaining values are semantic design choices, not sampled logo colors.
export const designTokensCss = `:root {
  color-scheme: light;
  --who-you-navy: #071939;
  --who-you-orange: #ff7900;
  --who-you-red: #f32b0d;
  --who-you-ivory: #fff9f0;

  --background: var(--who-you-ivory);
  --surface: #ffffff;
  --surface-subtle: #f5f1eb;
  --foreground: var(--who-you-navy);
  --foreground-secondary: #414b5b;
  --foreground-muted: #596373;
  --border: #e4ded5;
  --border-strong: #8a8580;
  --primary: var(--who-you-orange);
  --primary-foreground: var(--who-you-navy);
  --primary-outline: var(--who-you-navy);
  --ink-outline: var(--who-you-navy);
  --on-dark: var(--who-you-ivory);
  --on-dark-muted: #d3dbe7;
  --primary-hover: #ef6e00;
  --primary-soft: #fff0df;
  --primary-border: #eac6a2;
  --link: #963b06;
  --focus-ring: #963b06;
  --disabled-bg: #e8e4df;
  --disabled-fg: #65615c;

  --success: #246044;
  --success-bg: #edf6ef;
  --success-border: #c9e1d0;
  --warning: #805000;
  --warning-bg: #fff3d9;
  --warning-border: #ead5a6;
  --danger: #a32d28;
  --danger-bg: #fff0ed;
  --danger-border: #eac4bf;

  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Consolas, monospace;
  --text-xs: 0.75rem;
  --text-sm: 0.8125rem;
  --text-base: 0.9375rem;
  --text-lead: 1rem;
  --text-section: 1.125rem;
  --text-brand: 1.5rem;
  --text-title: 1.75rem;
  --text-display: clamp(2.5rem, 5.5vw, 4.75rem);
  --text-hero-lead: clamp(1.05rem, 1.6vw, 1.25rem);
  --weight-normal: 400;
  --weight-medium: 500;
  --weight-semibold: 600;
  --weight-bold: 700;
  --leading-tight: 1.25;
  --leading-normal: 1.65;

  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-7: 28px;
  --space-8: 32px;
  --space-10: 40px;
  --space-12: 48px;
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-xl: 16px;
  --radius-pill: 999px;
  --stroke-control: 2px;
  --shadow-control: 4px 4px 0 var(--ink-outline);
  --shadow-control-hover: 2px 2px 0 var(--ink-outline);
  --shadow-poster: 8px 8px 0 var(--who-you-orange);
  --shadow-surface: 0 10px 34px rgb(7 25 57 / 5%);
  --control-height: 44px;
  --brand-logo-height: 44px;
  --reading-width: 640px;
  --workspace-width: 1040px;
  --site-width: 1200px;
  --gutter: clamp(20px, 4vw, 48px);
  --section-space: clamp(48px, 7vw, 88px);
}`;
