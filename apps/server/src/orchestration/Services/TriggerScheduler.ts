/**
 * TriggerScheduler - Temporal trigger firing reactor service interface.
 *
 * Owns a background loop that polls the trigger projection on a fixed tick and
 * fires temporal triggers that have become due, translating each fire into the
 * `trigger.fire-started` / `trigger.fire-settled` command sequence and a
 * `SessionLauncher` session start. The decider owns auto-disable accounting;
 * the scheduler only reports outcomes.
 *
 * @module TriggerScheduler
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import type { ProjectionTrigger } from "../../persistence/Services/ProjectionTriggers.ts";

/**
 * `computeDueTriggers` - Pure eligibility filter for temporal triggers.
 *
 * A trigger is due when it is enabled, temporal, past its anti-rebound window
 * (`nextEligibleAt`), and its schedule has elapsed:
 * - `interval`: never fired, or `now - lastFiredAt >= everyMs`.
 * - `at` (one-shot): never fired and `now >= timestamp`.
 *
 * @param triggers - Candidate projected trigger rows.
 * @param now - Current epoch milliseconds.
 * @returns The subset of triggers eligible to fire at `now`.
 */
export function computeDueTriggers(
  triggers: ReadonlyArray<ProjectionTrigger>,
  now: number,
): ReadonlyArray<ProjectionTrigger> {
  return triggers.filter((trigger) => isTriggerDue(trigger, now));
}

function isoToMillis(value: string): number {
  return Date.parse(value);
}

function isTriggerDue(trigger: ProjectionTrigger, now: number): boolean {
  if (!trigger.enabled) {
    return false;
  }
  if (trigger.condition.kind !== "temporal") {
    return false;
  }

  // Anti-rebound: never fire before the safety window elapses. Guards against
  // re-firing on the next tick while a slow launch is still in flight.
  if (trigger.nextEligibleAt !== null) {
    const nextEligibleMs = isoToMillis(trigger.nextEligibleAt);
    if (!Number.isNaN(nextEligibleMs) && now < nextEligibleMs) {
      return false;
    }
  }

  const lastFiredMs = trigger.lastFiredAt !== null ? isoToMillis(trigger.lastFiredAt) : null;
  const schedule = trigger.condition.schedule;

  if (schedule.kind === "interval") {
    if (lastFiredMs === null || Number.isNaN(lastFiredMs)) {
      return true;
    }
    return now - lastFiredMs >= schedule.everyMs;
  }

  // `at` is one-shot: fires exactly once, once its timestamp has passed.
  return lastFiredMs === null && now >= schedule.timestamp;
}

/**
 * TriggerSchedulerShape - Service API for the temporal trigger scheduler.
 */
export interface TriggerSchedulerShape {
  /**
   * Start the polling loop in a forked fiber. The returned effect must be run
   * in a scope so the loop fiber is finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Run a single scheduler tick at the supplied epoch-millisecond `now`. Reads
   * active temporal triggers, computes the due set, and fires each one. Never
   * fails: per-trigger and list errors are captured and logged. Exposed for
   * deterministic testing without the timed loop.
   */
  readonly runTick: (now: number) => Effect.Effect<void>;
}

/**
 * TriggerScheduler - Service tag for the temporal trigger scheduler.
 */
export class TriggerScheduler extends Context.Service<TriggerScheduler, TriggerSchedulerShape>()(
  "t3/orchestration/Services/TriggerScheduler",
) {}
