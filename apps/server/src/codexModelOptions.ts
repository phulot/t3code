import type { ModelSelection } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

export function getCodexServiceTierOptionValue(
  modelSelection: ModelSelection | null | undefined,
): string | undefined {
  const serviceTier = getModelSelectionStringOptionValue(modelSelection, "serviceTier");
  // The fast service tier is forbidden: never forward it to Codex, even if a
  // legacy or hand-crafted persisted selection still carries it. Codex exposes it
  // under the id "fast" (legacy) and "priority" (its real catalog id, display name
  // "Fast"), so both must be blocked here — this gateway is the only runtime guard
  // for persisted values, which bypass the catalog descriptor filter entirely.
  const normalized = serviceTier?.toLowerCase();
  return normalized === "fast" || normalized === "priority" ? undefined : serviceTier;
}
