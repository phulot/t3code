import { describe, expect, it } from "vite-plus/test";

import type { AtomRef, TriggerCondition } from "@t3tools/contracts";
import {
  anyLeafSatisfied,
  collectAtoms,
  computeCompositeTransition,
  type CompositeEvaluationInput,
  type CompositeTriggerState,
  evaluateCondition,
} from "./CompositeCondition.ts";

const atom = (type: string): AtomRef => ({
  domain: "git",
  type,
  params: { repo: "octo/repo" },
});

const atomCond = (type: string): TriggerCondition => ({ kind: "atom", atom: atom(type) });
const and = (...conditions: TriggerCondition[]): TriggerCondition => ({ kind: "and", conditions });
const or = (...conditions: TriggerCondition[]): TriggerCondition => ({ kind: "or", conditions });
const not = (condition: TriggerCondition): TriggerCondition => ({ kind: "not", condition });

// A leaf-truth function driven by a set of "true" atom types.
const truthOf =
  (...trueTypes: string[]) =>
  (a: AtomRef): boolean =>
    trueTypes.includes(a.type);

describe("evaluateCondition", () => {
  it("evaluates a single atom", () => {
    expect(evaluateCondition(atomCond("a"), truthOf("a"))).toBe(true);
    expect(evaluateCondition(atomCond("a"), truthOf())).toBe(false);
  });

  it("evaluates AND (all must hold)", () => {
    const cond = and(atomCond("a"), atomCond("b"));
    expect(evaluateCondition(cond, truthOf("a", "b"))).toBe(true);
    expect(evaluateCondition(cond, truthOf("a"))).toBe(false);
    expect(evaluateCondition(cond, truthOf())).toBe(false);
  });

  it("evaluates OR (any holds)", () => {
    const cond = or(atomCond("a"), atomCond("b"));
    expect(evaluateCondition(cond, truthOf("a"))).toBe(true);
    expect(evaluateCondition(cond, truthOf("b"))).toBe(true);
    expect(evaluateCondition(cond, truthOf())).toBe(false);
  });

  it("evaluates NOT (negates the leaf)", () => {
    const cond = not(atomCond("a"));
    expect(evaluateCondition(cond, truthOf())).toBe(true);
    expect(evaluateCondition(cond, truthOf("a"))).toBe(false);
  });

  it("evaluates nested composites", () => {
    // AND(a, OR(b, NOT(c)))
    const cond = and(atomCond("a"), or(atomCond("b"), not(atomCond("c"))));
    expect(evaluateCondition(cond, truthOf("a", "b", "c"))).toBe(true); // b true
    expect(evaluateCondition(cond, truthOf("a"))).toBe(true); // NOT c true
    expect(evaluateCondition(cond, truthOf("a", "c"))).toBe(false); // b false, c true
    expect(evaluateCondition(cond, truthOf("b"))).toBe(false); // a false
  });

  it("treats a temporal node as false defensively", () => {
    const cond: TriggerCondition = {
      kind: "temporal",
      schedule: { kind: "interval", everyMs: 1000 },
    };
    expect(evaluateCondition(cond, truthOf())).toBe(false);
  });
});

describe("collectAtoms", () => {
  it("collects leaves in tree order", () => {
    const cond = and(atomCond("a"), or(atomCond("b"), not(atomCond("c"))));
    expect(collectAtoms(cond).map((a) => a.type)).toEqual(["a", "b", "c"]);
  });

  it("returns nothing for a temporal node", () => {
    const cond: TriggerCondition = {
      kind: "temporal",
      schedule: { kind: "interval", everyMs: 1000 },
    };
    expect(collectAtoms(cond)).toEqual([]);
  });
});

describe("anyLeafSatisfied", () => {
  it("signals as soon as one AND leaf holds", () => {
    const cond = and(atomCond("a"), atomCond("b"));
    expect(anyLeafSatisfied(cond, truthOf("a"))).toBe(true);
    expect(anyLeafSatisfied(cond, truthOf())).toBe(false);
  });

  it("signals for NOT(atom) when the atom is false", () => {
    const cond = and(atomCond("a"), not(atomCond("b")));
    // a false but NOT(b) satisfied -> signals
    expect(anyLeafSatisfied(cond, truthOf())).toBe(true);
    // a false and b true -> no leaf satisfied
    expect(anyLeafSatisfied(cond, truthOf("b"))).toBe(false);
  });
});

// --- computeCompositeTransition ---------------------------------------------

const rest: CompositeTriggerState = {
  windowOpenedAt: null,
  fireDueAt: null,
  conditionTruth: false,
  nextEligibleAt: null,
};

const evalInput = (over?: Partial<CompositeEvaluationInput>): CompositeEvaluationInput => ({
  conditionTruth: false,
  anyLeafSatisfied: false,
  windowMs: null,
  delayMs: null,
  ...over,
});

describe("computeCompositeTransition", () => {
  it("does nothing at rest with no signal", () => {
    const r = computeCompositeTransition(rest, evalInput(), 1000);
    expect(r.action).toBe("none");
    expect(r.nextState.windowOpenedAt).toBeNull();
    expect(r.windowPurged).toBe(false);
  });

  it("opens the window on the first partial signal", () => {
    const r = computeCompositeTransition(rest, evalInput({ anyLeafSatisfied: true }), 1000);
    expect(r.action).toBe("none");
    expect(r.nextState.windowOpenedAt).toBe(1000);
  });

  it("fires immediately on rising edge with no delay", () => {
    const r = computeCompositeTransition(
      rest,
      evalInput({ conditionTruth: true, anyLeafSatisfied: true }),
      1000,
    );
    expect(r.action).toBe("fire");
    expect(r.nextState.conditionTruth).toBe(true);
    expect(r.nextState.windowOpenedAt).toBeNull();
    expect(r.nextState.fireDueAt).toBeNull();
  });

  it("arms a delay on rising edge when delayMs set (no immediate fire)", () => {
    const r = computeCompositeTransition(
      rest,
      evalInput({ conditionTruth: true, anyLeafSatisfied: true, delayMs: 5000 }),
      1000,
    );
    expect(r.action).toBe("none");
    expect(r.nextState.fireDueAt).toBe(6000);
    expect(r.nextState.conditionTruth).toBe(true);
  });

  it("does not fire while a delay is pending and not yet due", () => {
    const armed: CompositeTriggerState = { ...rest, fireDueAt: 6000, conditionTruth: true };
    const r = computeCompositeTransition(armed, evalInput({ conditionTruth: true }), 5999);
    expect(r.action).toBe("none");
    expect(r.nextState.fireDueAt).toBe(6000);
  });

  it("fires when the delay deadline is reached", () => {
    const armed: CompositeTriggerState = { ...rest, fireDueAt: 6000, conditionTruth: true };
    const r = computeCompositeTransition(armed, evalInput({ conditionTruth: true }), 6000);
    expect(r.action).toBe("fire");
    expect(r.nextState.fireDueAt).toBeNull();
    expect(r.nextState.conditionTruth).toBe(true);
  });

  it("does not re-arm a pending delay even if the condition drops and re-rises", () => {
    const armed: CompositeTriggerState = { ...rest, fireDueAt: 6000, conditionTruth: true };
    // condition momentarily false: delay stays fixed at 6000
    const r = computeCompositeTransition(armed, evalInput({ conditionTruth: false }), 5000);
    expect(r.nextState.fireDueAt).toBe(6000);
  });

  it("holds true without re-firing while condition stays satisfied", () => {
    const held: CompositeTriggerState = { ...rest, conditionTruth: true };
    const r = computeCompositeTransition(held, evalInput({ conditionTruth: true }), 2000);
    expect(r.action).toBe("none");
    expect(r.nextState.conditionTruth).toBe(true);
  });

  it("re-arms to rest when the condition falls back to false", () => {
    const held: CompositeTriggerState = { ...rest, conditionTruth: true, windowOpenedAt: 500 };
    const r = computeCompositeTransition(held, evalInput({ conditionTruth: false }), 2000);
    expect(r.action).toBe("none");
    expect(r.nextState.conditionTruth).toBe(false);
    expect(r.nextState.windowOpenedAt).toBeNull();
  });

  it("purges and re-arms when the window expires without completion", () => {
    const open: CompositeTriggerState = { ...rest, windowOpenedAt: 1000 };
    const r = computeCompositeTransition(
      open,
      evalInput({ anyLeafSatisfied: true, windowMs: 5000 }),
      6001,
    );
    expect(r.windowPurged).toBe(true);
    expect(r.action).toBe("none");
    expect(r.nextState.windowOpenedAt).toBeNull();
  });

  it("keeps the window open at the exact expiry boundary", () => {
    const open: CompositeTriggerState = { ...rest, windowOpenedAt: 1000 };
    const r = computeCompositeTransition(
      open,
      evalInput({ anyLeafSatisfied: true, windowMs: 5000 }),
      6000,
    );
    expect(r.windowPurged).toBe(false);
    expect(r.nextState.windowOpenedAt).toBe(1000);
  });

  it("completes within the window: fires and clears the window", () => {
    const open: CompositeTriggerState = { ...rest, windowOpenedAt: 1000 };
    const r = computeCompositeTransition(
      open,
      evalInput({ conditionTruth: true, anyLeafSatisfied: true, windowMs: 5000 }),
      3000,
    );
    expect(r.action).toBe("fire");
    expect(r.nextState.windowOpenedAt).toBeNull();
  });

  it("respects anti-rebound: defers the rising-edge fire until eligible", () => {
    const blocked: CompositeTriggerState = { ...rest, nextEligibleAt: 10000 };
    const early = computeCompositeTransition(
      blocked,
      evalInput({ conditionTruth: true, anyLeafSatisfied: true }),
      5000,
    );
    expect(early.action).toBe("none");
    // truth not recorded, so the edge survives to a later eligible tick
    expect(early.nextState.conditionTruth).toBe(false);

    const later = computeCompositeTransition(
      blocked,
      evalInput({ conditionTruth: true, anyLeafSatisfied: true }),
      10000,
    );
    expect(later.action).toBe("fire");
  });

  it("waits past a delay deadline when not yet eligible, then fires", () => {
    const armed: CompositeTriggerState = {
      ...rest,
      fireDueAt: 6000,
      conditionTruth: true,
      nextEligibleAt: 8000,
    };
    const notEligible = computeCompositeTransition(
      armed,
      evalInput({ conditionTruth: true }),
      6000,
    );
    expect(notEligible.action).toBe("none");
    expect(notEligible.nextState.fireDueAt).toBe(6000);

    const eligible = computeCompositeTransition(armed, evalInput({ conditionTruth: true }), 8000);
    expect(eligible.action).toBe("fire");
  });
});
