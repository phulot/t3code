/**
 * ConditionEvaluator - Atom STATE condition evaluator reactor service interface.
 *
 * Owns a background loop that polls the trigger projection on a fixed tick and,
 * for every ACTIVE trigger whose condition is an atom of `nature: "state"`,
 * evaluates the atom and fires the trigger on a rising edge (the condition
 * transitions to true). The decider owns auto-disable accounting; the evaluator
 * only reports fire outcomes. Atom evaluation errors are domain health (D18):
 * logged, never counted toward auto-disable.
 *
 * @module ConditionEvaluator
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import type { ProjectionTrigger } from "../../persistence/Services/ProjectionTriggers.ts";

/** A trigger paired with the boolean its STATE atom just evaluated to. */
export interface AtomEvaluation {
  readonly trigger: ProjectionTrigger;
  readonly truth: boolean;
}

/** A pending write of a trigger's last evaluated condition truth. */
export interface ConditionTruthUpdate {
  readonly triggerId: string;
  readonly truth: boolean;
}

/**
 * The outcome of a single evaluator tick: which triggers to fire now, and which
 * condition-truth values to persist.
 */
export interface AtomFiringPlan {
  readonly toFire: ReadonlyArray<ProjectionTrigger>;
  readonly truthUpdates: ReadonlyArray<ConditionTruthUpdate>;
}

function isEligible(trigger: ProjectionTrigger, now: number): boolean {
  if (trigger.nextEligibleAt === null) {
    return true;
  }
  const nextEligibleMs = Date.parse(trigger.nextEligibleAt);
  return Number.isNaN(nextEligibleMs) || now >= nextEligibleMs;
}

/**
 * `computeAtomFirings` - Pure rising-edge + anti-rebound firing planner.
 *
 * For each evaluated atom trigger:
 * - a *rising edge* is `previous condition truth !== true` (false or the
 *   never-evaluated `null`) AND the freshly evaluated `truth === true`. The
 *   `null` case is what guarantees catch-up at creation: a trigger already true
 *   when created fires on its first evaluation.
 * - a rising edge fires only when past its anti-rebound window
 *   (`nextEligibleAt`). When suppressed by anti-rebound the truth is *not*
 *   persisted, so the rising edge survives to a later, eligible tick instead of
 *   being silently swallowed.
 * - a fired rising edge persists the new truth; while the condition stays true
 *   no further rising edge occurs (no re-fire). A return to false persists the
 *   reset, re-arming the next rising edge.
 *
 * @param evaluations - Triggers with their freshly evaluated truth (successful
 *   evaluations only; failed evaluations are omitted by the caller per D18).
 * @param now - Current epoch milliseconds.
 */
export function computeAtomFirings(
  evaluations: ReadonlyArray<AtomEvaluation>,
  now: number,
): AtomFiringPlan {
  const toFire: ProjectionTrigger[] = [];
  const truthUpdates: ConditionTruthUpdate[] = [];

  for (const { trigger, truth } of evaluations) {
    const rising = trigger.conditionTruth !== true && truth === true;

    if (rising) {
      if (!isEligible(trigger, now)) {
        // Defer: keep the stored truth untouched so the rising edge is still
        // detected once the anti-rebound window has elapsed.
        continue;
      }
      toFire.push(trigger);
      // A rising edge means the stored truth was not `true`, so it always
      // changes here; persist the new `true`.
      truthUpdates.push({ triggerId: trigger.triggerId, truth });
      continue;
    }

    // Not a rising edge (condition already true, or now false): persist any
    // change so a return to false re-arms the next rising edge.
    if (trigger.conditionTruth !== truth) {
      truthUpdates.push({ triggerId: trigger.triggerId, truth });
    }
  }

  return { toFire, truthUpdates };
}

/**
 * ConditionEvaluatorShape - Service API for the atom STATE condition evaluator.
 */
export interface ConditionEvaluatorShape {
  /**
   * Start the polling loop in a forked fiber. The returned effect must be run
   * in a scope so the loop fiber is finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Run a single evaluator tick at the supplied epoch-millisecond `now`. Reads
   * active atom triggers, evaluates their STATE atoms, fires on rising edges,
   * and persists condition truth. Never fails: per-trigger evaluation and fire
   * errors are captured and logged. Exposed for deterministic testing without
   * the timed loop.
   */
  readonly runTick: (now: number) => Effect.Effect<void>;
}

/**
 * ConditionEvaluator - Service tag for the atom STATE condition evaluator.
 */
export class ConditionEvaluator extends Context.Service<
  ConditionEvaluator,
  ConditionEvaluatorShape
>()("t3/orchestration/Services/ConditionEvaluator") {}
