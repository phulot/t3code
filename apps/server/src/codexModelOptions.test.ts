import { assert, it } from "@effect/vitest";

import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { getCodexServiceTierOptionValue } from "./codexModelOptions.ts";

it("returns the selected Codex service tier id", () => {
  const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.5", [
    { id: "serviceTier", value: "flex" },
  ]);

  assert.equal(getCodexServiceTierOptionValue(selection), "flex");
});

it("never forwards the forbidden fast service tier", () => {
  const legacyFastMode = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
    { id: "fastMode", value: true },
  ]);
  assert.equal(getCodexServiceTierOptionValue(legacyFastMode), undefined);

  const legacyFastTier = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
    { id: "serviceTier", value: "fast" },
  ]);
  assert.equal(getCodexServiceTierOptionValue(legacyFastTier), undefined);

  // "priority" is the real catalog id of the fast tier (display name "Fast"); a
  // persisted selection made before the ban stored this raw id and must be blocked.
  const persistedPriorityTier = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
    { id: "serviceTier", value: "priority" },
  ]);
  assert.equal(getCodexServiceTierOptionValue(persistedPriorityTier), undefined);
});
