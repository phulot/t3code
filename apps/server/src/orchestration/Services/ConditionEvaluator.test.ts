import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  TriggerId,
  type AtomRef,
  type TriggerCondition,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { ProjectionTrigger } from "../../persistence/Services/ProjectionTriggers.ts";
import { computeAtomFirings, type AtomEvaluation } from "./ConditionEvaluator.ts";

const iso = (ms: number): IsoDateTime =>
  IsoDateTime.make(DateTime.formatIso(DateTime.makeUnsafe(ms)));

const NOW = Date.parse("2026-03-01T12:00:00.000Z");

const atom: AtomRef = {
  domain: "git",
  type: "ref.merged",
  params: { worktreePath: "/tmp/repo", ref: "feature", base: "main" },
};

const atomCondition: TriggerCondition = { kind: "atom", atom };

const makeTrigger = (overrides: Partial<ProjectionTrigger>): ProjectionTrigger => ({
  triggerId: TriggerId.make("trigger-x"),
  projectId: ProjectId.make("project-x"),
  name: "Atom Trigger",
  condition: atomCondition,
  action: { kind: "startSession", spec: { text: "run job" } },
  enabled: true,
  consecutiveTransientFailures: NonNegativeInt.make(0),
  lastFiredAt: null,
  lastOutcome: null,
  nextEligibleAt: null,
  conditionTruth: null,
  windowMs: null,
  delayMs: null,
  windowOpenedAt: null,
  fireDueAt: null,
  createdAt: iso(NOW - 1_000_000),
  updatedAt: iso(NOW - 1_000_000),
  ...overrides,
});

const evaluation = (trigger: ProjectionTrigger, truth: boolean): AtomEvaluation => ({
  trigger,
  truth,
});

describe("computeAtomFirings", () => {
  it("fires on catch-up: never-evaluated (null) condition already true", () => {
    const trigger = makeTrigger({ conditionTruth: null });
    const plan = computeAtomFirings([evaluation(trigger, true)], NOW);

    expect(plan.toFire.map((t) => t.triggerId)).toEqual(["trigger-x"]);
    expect(plan.truthUpdates).toEqual([{ triggerId: "trigger-x", truth: true }]);
  });

  it("fires on a false -> true rising edge", () => {
    const trigger = makeTrigger({ conditionTruth: false });
    const plan = computeAtomFirings([evaluation(trigger, true)], NOW);

    expect(plan.toFire.map((t) => t.triggerId)).toEqual(["trigger-x"]);
    expect(plan.truthUpdates).toEqual([{ triggerId: "trigger-x", truth: true }]);
  });

  it("does not fire while the condition stays true (no rising edge)", () => {
    const trigger = makeTrigger({ conditionTruth: true });
    const plan = computeAtomFirings([evaluation(trigger, true)], NOW);

    expect(plan.toFire).toEqual([]);
    expect(plan.truthUpdates).toEqual([]);
  });

  it("does not fire when the condition is false; persists a true -> false reset", () => {
    const trigger = makeTrigger({ conditionTruth: true });
    const plan = computeAtomFirings([evaluation(trigger, false)], NOW);

    expect(plan.toFire).toEqual([]);
    expect(plan.truthUpdates).toEqual([{ triggerId: "trigger-x", truth: false }]);
  });

  it("does not persist when a false condition stays false", () => {
    const trigger = makeTrigger({ conditionTruth: false });
    const plan = computeAtomFirings([evaluation(trigger, false)], NOW);

    expect(plan.toFire).toEqual([]);
    expect(plan.truthUpdates).toEqual([]);
  });

  it("suppresses a rising edge inside the anti-rebound window and does not persist the truth", () => {
    // Anti-rebound is still open (nextEligibleAt in the future): the rising edge
    // must be deferred, and crucially the truth must NOT be persisted so the
    // edge is still detected once the window elapses.
    const trigger = makeTrigger({
      conditionTruth: false,
      nextEligibleAt: iso(NOW + 30_000),
    });
    const plan = computeAtomFirings([evaluation(trigger, true)], NOW);

    expect(plan.toFire).toEqual([]);
    expect(plan.truthUpdates).toEqual([]);
  });

  it("fires a rising edge once the anti-rebound window has elapsed", () => {
    const trigger = makeTrigger({
      conditionTruth: false,
      nextEligibleAt: iso(NOW - 1_000),
    });
    const plan = computeAtomFirings([evaluation(trigger, true)], NOW);

    expect(plan.toFire.map((t) => t.triggerId)).toEqual(["trigger-x"]);
    expect(plan.truthUpdates).toEqual([{ triggerId: "trigger-x", truth: true }]);
  });

  it("plans independently across a mixed batch of triggers", () => {
    const rising = makeTrigger({ triggerId: TriggerId.make("rising"), conditionTruth: false });
    const steady = makeTrigger({ triggerId: TriggerId.make("steady"), conditionTruth: true });
    const reset = makeTrigger({ triggerId: TriggerId.make("reset"), conditionTruth: true });

    const plan = computeAtomFirings(
      [evaluation(rising, true), evaluation(steady, true), evaluation(reset, false)],
      NOW,
    );

    expect(plan.toFire.map((t) => t.triggerId)).toEqual(["rising"]);
    expect(plan.truthUpdates).toEqual([
      { triggerId: "rising", truth: true },
      { triggerId: "reset", truth: false },
    ]);
  });
});
