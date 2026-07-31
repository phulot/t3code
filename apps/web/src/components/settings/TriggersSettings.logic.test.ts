import { describe, expect, it } from "vite-plus/test";

import type { OrchestrationTrigger, ProjectId, TriggerId } from "@t3tools/contracts";

import {
  type AtomLeafForm,
  buildAtomLeafCondition,
  buildAtomRef,
  buildCompositeCondition,
  buildCreateTriggerInput,
  buildTriggerAction,
  buildTriggerCondition,
  describeLastFire,
  describeSchedule,
  emptyAtomLeaf,
  emptyTriggerForm,
  optionalDurationMs,
  type TriggerFormValues,
} from "./TriggersSettings.logic";

const projectId = "project-1" as ProjectId;
const triggerId = "trigger-1" as TriggerId;

const form = (overrides: Partial<TriggerFormValues> = {}): TriggerFormValues => ({
  ...emptyTriggerForm(),
  ...overrides,
});

describe("buildTriggerCondition", () => {
  it("maps an interval of N minutes to everyMs", () => {
    const result = buildTriggerCondition(
      form({ scheduleKind: "interval", intervalEvery: 5, intervalUnit: "minutes" }),
    );
    expect(result).toEqual({
      ok: true,
      value: { kind: "temporal", schedule: { kind: "interval", everyMs: 300_000 } },
    });
  });

  it("maps an interval of N seconds to everyMs", () => {
    const result = buildTriggerCondition(
      form({ scheduleKind: "interval", intervalEvery: 30, intervalUnit: "seconds" }),
    );
    expect(result).toEqual({
      ok: true,
      value: { kind: "temporal", schedule: { kind: "interval", everyMs: 30_000 } },
    });
  });

  it("maps an interval of N hours to everyMs", () => {
    const result = buildTriggerCondition(
      form({ scheduleKind: "interval", intervalEvery: 2, intervalUnit: "hours" }),
    );
    expect(result).toEqual({
      ok: true,
      value: { kind: "temporal", schedule: { kind: "interval", everyMs: 7_200_000 } },
    });
  });

  it("rejects a non-positive interval", () => {
    expect(buildTriggerCondition(form({ scheduleKind: "interval", intervalEvery: 0 })).ok).toBe(
      false,
    );
    expect(buildTriggerCondition(form({ scheduleKind: "interval", intervalEvery: -3 })).ok).toBe(
      false,
    );
  });

  it("maps an `at` datetime to an epoch-ms timestamp", () => {
    const isoLocal = "2026-08-01T09:30";
    const result = buildTriggerCondition(form({ scheduleKind: "at", atDateTimeLocal: isoLocal }));
    expect(result).toEqual({
      ok: true,
      value: { kind: "temporal", schedule: { kind: "at", timestamp: Date.parse(isoLocal) } },
    });
  });

  it("rejects an invalid `at` datetime", () => {
    expect(
      buildTriggerCondition(form({ scheduleKind: "at", atDateTimeLocal: "not-a-date" })).ok,
    ).toBe(false);
  });
});

const atomLeaf = (overrides: Partial<AtomLeafForm> = {}): AtomLeafForm => ({
  ...emptyAtomLeaf(),
  ...overrides,
});

describe("buildAtomRef", () => {
  it("trims and coerces params, dropping optional blanks", () => {
    const result = buildAtomRef(
      atomLeaf({
        domain: "git",
        type: "pr.merged",
        params: { repo: "  acme/app ", pr: " 123 ", branch: "" },
      }),
    );
    expect(result).toEqual({
      ok: true,
      value: { domain: "git", type: "pr.merged", params: { repo: "acme/app", pr: 123 } },
    });
  });

  it("requires a non-optional param", () => {
    const result = buildAtomRef(
      atomLeaf({ domain: "git", type: "ref.merged", params: { worktreePath: "/w", ref: "x" } }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a non-numeric number param", () => {
    const result = buildAtomRef(
      atomLeaf({ domain: "git", type: "pr.merged", params: { repo: "a/b", pr: "abc" } }),
    );
    expect(result.ok).toBe(false);
  });

  it("enforces requireOneOf", () => {
    const result = buildAtomRef(
      atomLeaf({ domain: "git", type: "pr.merged", params: { repo: "a/b" } }),
    );
    expect(result.ok).toBe(false);
  });
});

describe("buildAtomLeafCondition", () => {
  it("wraps a plain atom", () => {
    const result = buildAtomLeafCondition(
      atomLeaf({ domain: "git", type: "pr.merged", params: { repo: "a/b", pr: "1" } }),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        kind: "atom",
        atom: { domain: "git", type: "pr.merged", params: { repo: "a/b", pr: 1 } },
      },
    });
  });

  it("wraps a negated state atom in not", () => {
    const result = buildAtomLeafCondition(
      atomLeaf({
        domain: "git",
        type: "ref.merged",
        params: { worktreePath: "/w", ref: "x", base: "main" },
        negated: true,
      }),
    );
    expect(result.ok && result.value.kind).toBe("not");
  });

  it("rejects negating a transient atom", () => {
    const result = buildAtomLeafCondition(
      atomLeaf({
        domain: "git",
        type: "pr.merged",
        params: { repo: "a/b", pr: "1" },
        negated: true,
      }),
    );
    expect(result.ok).toBe(false);
  });
});

describe("buildCompositeCondition", () => {
  it("builds an and over two leaves", () => {
    const result = buildCompositeCondition(
      form({
        compositeOp: "and",
        leaves: [
          atomLeaf({ domain: "git", type: "pr.merged", params: { repo: "a/b", pr: "1" } }),
          atomLeaf({
            domain: "git",
            type: "ref.merged",
            params: { worktreePath: "/w", ref: "x", base: "main" },
          }),
        ],
      }),
    );
    expect(result.ok && result.value.kind).toBe("and");
    expect(result.ok && result.value.kind === "and" && result.value.conditions).toHaveLength(2);
  });

  it("requires at least two leaves", () => {
    const result = buildCompositeCondition(
      form({
        leaves: [atomLeaf({ domain: "git", type: "pr.merged", params: { repo: "a/b", pr: "1" } })],
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("surfaces a leaf error", () => {
    const result = buildCompositeCondition(
      form({
        leaves: [
          atomLeaf({ domain: "git", type: "pr.merged", params: { repo: "a/b", pr: "1" } }),
          atomLeaf(),
        ],
      }),
    );
    expect(result.ok).toBe(false);
  });
});

describe("optionalDurationMs", () => {
  it("returns undefined for a non-positive value", () => {
    expect(optionalDurationMs(0, "minutes")).toBeUndefined();
    expect(optionalDurationMs(-1, "hours")).toBeUndefined();
  });

  it("converts to milliseconds", () => {
    expect(optionalDurationMs(5, "minutes")).toBe(300_000);
  });
});

describe("buildTriggerAction", () => {
  it("builds a startSession action from prompt text only", () => {
    const result = buildTriggerAction(
      form({ promptText: "  run the checks  ", worktreeMode: "current" }),
    );
    expect(result).toEqual({
      ok: true,
      value: { kind: "startSession", spec: { text: "run the checks" } },
    });
  });

  it("includes the model selection when provided", () => {
    const modelSelection = {
      kind: "specific",
      modelId: "claude-x",
    } as unknown as TriggerFormValues["modelSelection"];
    const result = buildTriggerAction(form({ promptText: "go", modelSelection }));
    expect(result.ok && result.value.spec.modelSelection).toEqual(modelSelection);
  });

  it("attaches prepareWorktree when a new worktree is requested", () => {
    const result = buildTriggerAction(
      form({ promptText: "go", worktreeMode: "new", baseBranch: "main", branch: "feat/x" }),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        kind: "startSession",
        spec: { text: "go", prepareWorktree: { baseBranch: "main", branch: "feat/x" } },
      },
    });
  });

  it("omits the optional branch when left blank", () => {
    const result = buildTriggerAction(
      form({ promptText: "go", worktreeMode: "new", baseBranch: "main", branch: "" }),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        kind: "startSession",
        spec: { text: "go", prepareWorktree: { baseBranch: "main" } },
      },
    });
  });

  it("rejects empty prompt text", () => {
    expect(buildTriggerAction(form({ promptText: "   " })).ok).toBe(false);
  });

  it("rejects a new worktree with no base branch", () => {
    expect(
      buildTriggerAction(form({ promptText: "go", worktreeMode: "new", baseBranch: " " })).ok,
    ).toBe(false);
  });
});

describe("buildCreateTriggerInput", () => {
  it("assembles the full trigger.create input", () => {
    const result = buildCreateTriggerInput({
      triggerId,
      projectId,
      form: form({
        name: "  Nightly checks  ",
        scheduleKind: "interval",
        intervalEvery: 15,
        intervalUnit: "minutes",
        promptText: "run",
        enabled: true,
      }),
    });
    expect(result).toEqual({
      ok: true,
      value: {
        triggerId,
        projectId,
        name: "Nightly checks",
        condition: { kind: "temporal", schedule: { kind: "interval", everyMs: 900_000 } },
        action: { kind: "startSession", spec: { text: "run" } },
        enabled: true,
      },
    });
  });

  it("rejects a blank name", () => {
    expect(
      buildCreateTriggerInput({
        triggerId,
        projectId,
        form: form({ name: "  ", promptText: "run" }),
      }).ok,
    ).toBe(false);
  });

  it("surfaces the schedule error", () => {
    const result = buildCreateTriggerInput({
      triggerId,
      projectId,
      form: form({ name: "n", promptText: "run", scheduleKind: "interval", intervalEvery: 0 }),
    });
    expect(result.ok).toBe(false);
  });

  it("attaches window/delay only for a composite condition", () => {
    const result = buildCreateTriggerInput({
      triggerId,
      projectId,
      form: form({
        name: "n",
        promptText: "run",
        conditionKind: "composite",
        compositeOp: "or",
        leaves: [
          atomLeaf({ domain: "git", type: "pr.merged", params: { repo: "a/b", pr: "1" } }),
          atomLeaf({
            domain: "git",
            type: "ref.merged",
            params: { worktreePath: "/w", ref: "x", base: "main" },
          }),
        ],
        windowEvery: 10,
        windowUnit: "minutes",
        delayEvery: 30,
        delayUnit: "seconds",
      }),
    });
    expect(result.ok && result.value.windowMs).toBe(600_000);
    expect(result.ok && result.value.delayMs).toBe(30_000);
  });

  it("omits window/delay for a non-composite condition", () => {
    const result = buildCreateTriggerInput({
      triggerId,
      projectId,
      form: form({ name: "n", promptText: "run", windowEvery: 10, delayEvery: 5 }),
    });
    expect(result.ok && "windowMs" in result.value).toBe(false);
    expect(result.ok && "delayMs" in result.value).toBe(false);
  });
});

const trigger = (
  overrides: Partial<OrchestrationTrigger>,
): Pick<OrchestrationTrigger, "lastFiredAt" | "lastOutcome"> => ({
  lastFiredAt: null,
  lastOutcome: null,
  ...overrides,
});

describe("describeLastFire", () => {
  it("reports never fired when there is no last fire", () => {
    expect(describeLastFire(trigger({}))).toEqual({ status: "never", label: "Never fired" });
  });

  it("reports success", () => {
    const result = describeLastFire(
      trigger({
        lastFiredAt: "2026-07-31T00:00:00.000Z" as OrchestrationTrigger["lastFiredAt"],
        lastOutcome: {
          status: "succeeded",
          threadId: "thread-1",
        } as unknown as OrchestrationTrigger["lastOutcome"],
      }),
    );
    expect(result).toEqual({ status: "succeeded", label: "Last run succeeded" });
  });

  it("reports failure with kind and reason", () => {
    const result = describeLastFire(
      trigger({
        lastFiredAt: "2026-07-31T00:00:00.000Z" as OrchestrationTrigger["lastFiredAt"],
        lastOutcome: {
          status: "failed",
          failureKind: "transient",
          reason: "timed out",
        } as unknown as OrchestrationTrigger["lastOutcome"],
      }),
    );
    expect(result).toEqual({ status: "failed", label: "Last run failed (transient): timed out" });
  });
});

describe("describeSchedule", () => {
  it("summarizes an interval schedule", () => {
    expect(
      describeSchedule({ kind: "temporal", schedule: { kind: "interval", everyMs: 60_000 } }),
    ).toBe("Every 1 minute");
    expect(
      describeSchedule({ kind: "temporal", schedule: { kind: "interval", everyMs: 300_000 } }),
    ).toBe("Every 5 minutes");
    expect(
      describeSchedule({ kind: "temporal", schedule: { kind: "interval", everyMs: 7_200_000 } }),
    ).toBe("Every 2 hours");
  });

  it("summarizes an atom condition", () => {
    expect(
      describeSchedule({ kind: "atom", atom: { domain: "git", type: "pr.merged", params: {} } }),
    ).toBe("When git/pr.merged");
  });

  it("summarizes a negated atom", () => {
    expect(
      describeSchedule({
        kind: "not",
        condition: { kind: "atom", atom: { domain: "git", type: "ref.merged", params: {} } },
      }),
    ).toBe("Not (When git/ref.merged)");
  });

  it("summarizes an and/or composite", () => {
    const leafA = { kind: "atom", atom: { domain: "git", type: "pr.merged", params: {} } } as const;
    const leafB = {
      kind: "atom",
      atom: { domain: "git", type: "ref.merged", params: {} },
    } as const;
    expect(describeSchedule({ kind: "and", conditions: [leafA, leafB] })).toBe(
      "When git/pr.merged and When git/ref.merged",
    );
    expect(describeSchedule({ kind: "or", conditions: [leafA, leafB] })).toBe(
      "When git/pr.merged or When git/ref.merged",
    );
  });
});
