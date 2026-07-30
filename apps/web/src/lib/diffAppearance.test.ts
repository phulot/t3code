import { describe, expect, it } from "vite-plus/test";

import { READABLE_DIFF_OPTIONS, READABLE_DIFF_UNSAFE_CSS } from "./diffAppearance";

describe("readable diff appearance", () => {
  it("keeps structural and intra-line changes visible", () => {
    expect(READABLE_DIFF_OPTIONS).toEqual({
      diffIndicators: "bars",
      lineDiffType: "word-alt",
      maxLineDiffLength: 1_000,
    });
  });

  it("passes semantic colors to the renderer as blend targets", () => {
    expect(READABLE_DIFF_UNSAFE_CSS).toContain("--diffs-bg-addition-override: var(--success)");
    expect(READABLE_DIFF_UNSAFE_CSS).toContain("--diffs-bg-deletion-override: var(--destructive)");
    expect(READABLE_DIFF_UNSAFE_CSS).toContain("--mix-dark: 68% !important");
  });
});
