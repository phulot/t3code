export const READABLE_DIFF_OPTIONS = {
  diffIndicators: "bars",
  lineDiffType: "word-alt",
  maxLineDiffLength: 1_000,
} as const;

export const READABLE_DIFF_UNSAFE_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-header-font-family: var(--font-sans) !important;
  --diffs-font-family: var(--font-mono) !important;
  --diffs-font-size: 13px;
  --diffs-line-height: 21px;
  --diffs-font-features: "calt" 1, "liga" 1;
  --diffs-bg: color-mix(in srgb, var(--card) 82%, var(--background)) !important;
  --diffs-light-bg: color-mix(in srgb, var(--card) 82%, var(--background)) !important;
  --diffs-dark-bg: color-mix(in srgb, var(--card) 82%, var(--background)) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  --diffs-bg-context-override: color-mix(in srgb, var(--background) 94%, var(--foreground));
  --diffs-bg-hover-override: var(--foreground);
  --diffs-bg-separator-override: color-mix(in srgb, var(--background) 84%, var(--foreground));
  --diffs-bg-buffer-override: color-mix(in srgb, var(--background) 88%, var(--foreground));

  /*
   * Pierre treats these overrides as mix targets, not final backgrounds.
   * Supplying the semantic colors directly keeps changed rows unmistakable
   * after the renderer applies its light/dark blending.
   */
  --diffs-bg-addition-override: var(--success);
  --diffs-bg-addition-number-override: var(--success);
  --diffs-bg-addition-hover-override: var(--success);
  --diffs-bg-addition-emphasis-override: color-mix(
    in srgb,
    var(--background) 48%,
    var(--success)
  );

  --diffs-bg-deletion-override: var(--destructive);
  --diffs-bg-deletion-number-override: var(--destructive);
  --diffs-bg-deletion-hover-override: var(--destructive);
  --diffs-bg-deletion-emphasis-override: color-mix(
    in srgb,
    var(--background) 48%,
    var(--destructive)
  );

  background-color: var(--diffs-bg) !important;
}

[data-background] [data-line-type="change-addition"],
[data-background] [data-line-type="change-deletion"] {
  --mix-light: 78% !important;
  --mix-dark: 68% !important;
}

[data-background] [data-column-number][data-line-type="change-addition"],
[data-background] [data-column-number][data-line-type="change-deletion"],
[data-background] [data-gutter-buffer][data-line-type="change-addition"],
[data-background] [data-gutter-buffer][data-line-type="change-deletion"] {
  --mix-light: 72% !important;
  --mix-dark: 60% !important;
}

[data-line-type="change-addition"] [data-diff-span],
[data-line-type="change-deletion"] [data-diff-span] {
  box-shadow: inset 0 -1px color-mix(in srgb, currentColor 38%, transparent);
  font-weight: 600;
}

[data-column-number] {
  border-inline-end: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
  font-variant-numeric: tabular-nums;
}

[data-separator] {
  color: color-mix(in srgb, var(--foreground) 62%, var(--muted-foreground)) !important;
}

[data-separator-wrapper] {
  border-block: 1px solid color-mix(in srgb, var(--border) 78%, transparent);
}

[data-file-info] {
  background-color: color-mix(in srgb, var(--card) 88%, var(--foreground)) !important;
  border-block-color: var(--border) !important;
  color: var(--foreground) !important;
}

[data-diffs-header] {
  position: sticky !important;
  top: 0;
  z-index: 4;
  min-height: 36px !important;
  align-items: center !important;
  border-bottom: 1px solid var(--border) !important;
  background-color: color-mix(in srgb, var(--card) 88%, var(--foreground)) !important;
  padding-block: 7px !important;
  font-family: var(--font-sans) !important;
  font-size: 12px !important;
  line-height: 1 !important;
}

[data-diffs-header] [data-header-content],
[data-diffs-header] [data-metadata] {
  align-items: center !important;
  line-height: 1 !important;
}

[data-diffs-header] [data-metadata] {
  font-variant-numeric: tabular-nums;
}

[data-diffs-header] [data-additions-count],
[data-diffs-header] [data-deletions-count] {
  font-family: var(--font-mono) !important;
  font-size: 11px !important;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1 !important;
}

[data-diffs-header] [data-change-icon],
[data-diffs-header] [data-rename-icon] {
  display: block;
  flex-shrink: 0;
}

[data-title] {
  cursor: pointer;
  transition:
    color 120ms ease,
    text-decoration-color 120ms ease;
  text-decoration: underline;
  text-decoration-color: transparent;
  text-underline-offset: 2px;
  font-family: var(--font-sans) !important;
  font-weight: 600;
}

[data-title]:hover {
  color: color-mix(in srgb, var(--foreground) 84%, var(--primary)) !important;
  text-decoration-color: currentColor;
}
`;
