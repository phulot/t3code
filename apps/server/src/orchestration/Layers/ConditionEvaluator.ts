/**
 * ConditionEvaluatorLive - Atom STATE condition evaluator implementation.
 *
 * Polls the trigger projection every {@link TICK_INTERVAL}; for each ACTIVE
 * trigger whose condition is an atom of `nature: "state"`, it evaluates the atom
 * through the {@link AtomDomainRegistry}, plans firings with the pure
 * {@link computeAtomFirings} (rising edge + 60s anti-rebound), fires the planned
 * triggers through the shared trigger fire pipeline ({@link makeTriggerFiring} —
 * the exact same pipeline the temporal scheduler uses) and persists each
 * trigger's last condition truth.
 *
 * Per Decision D18, a failed atom evaluation is domain health: it is logged and
 * the trigger is skipped for that tick (no fire, no truth write, no auto-disable
 * accounting). Evaluation is isolated per trigger so one bad atom never blocks
 * its siblings.
 *
 * @module ConditionEvaluatorLive
 */
import { TriggerId } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ExternalEventJournal } from "../../persistence/Services/ExternalEventJournal.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import type { ProjectionTrigger } from "../../persistence/Services/ProjectionTriggers.ts";
import { ProjectionTriggerRepository } from "../../persistence/Services/ProjectionTriggers.ts";
import { AtomDomainRegistry, matchesAtom } from "../Services/AtomDomainRegistry.ts";
import {
  anyLeafSatisfied,
  atomIdentity,
  collectAtoms,
  computeCompositeTransition,
  type CompositeTriggerState,
  evaluateCondition,
} from "../Services/CompositeCondition.ts";
import {
  type AtomEvaluation,
  computeAtomFirings,
  ConditionEvaluator,
  type ConditionEvaluatorShape,
} from "../Services/ConditionEvaluator.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { SessionLauncherService } from "../Services/SessionLauncher.ts";
import { makeTriggerFiring } from "./TriggerFiring.ts";

/** Parse an ISO instant into epoch ms for the pure composite state machine. */
const toEpochMs = (iso: string | null): number | null => {
  if (iso === null) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
};

/** Polling cadence. Kept well under the 60s anti-rebound window. */
const TICK_INTERVAL = Duration.seconds(5);

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const sessionLauncher = yield* SessionLauncherService;
  const triggerRepository = yield* ProjectionTriggerRepository;
  const projectRepository = yield* ProjectionProjectRepository;
  const registry = yield* AtomDomainRegistry;
  const journal = yield* ExternalEventJournal;
  const crypto = yield* Crypto.Crypto;

  const { fireTriggerSafely } = makeTriggerFiring({
    orchestrationEngine,
    sessionLauncher,
    projectRepository,
    crypto,
    commandNamespace: "condition-evaluator",
  });

  // Evaluate one trigger's STATE atom, isolating domain-health failures (D18).
  // Returns the evaluation on success, or None when the atom is not a polled
  // STATE atom or its evaluation failed (logged, never fatal).
  const evaluateTrigger = (
    trigger: ProjectionTrigger,
  ): Effect.Effect<Option.Option<AtomEvaluation>> =>
    Effect.gen(function* () {
      if (trigger.condition.kind !== "atom") {
        return Option.none();
      }
      const atom = trigger.condition.atom;

      const nature = yield* registry.natureOf(atom);
      if (nature !== "state") {
        // TRANSIENT atoms are pushed out-of-band, never polled here.
        return Option.none();
      }

      const truth = yield* registry.evaluate(atom);
      return Option.some({ trigger, truth } satisfies AtomEvaluation);
    }).pipe(
      Effect.catch((error) =>
        Effect.as(
          Effect.logWarning("atom evaluation failed", {
            triggerId: trigger.triggerId,
            error,
          }),
          Option.none(),
        ),
      ),
      Effect.catchDefect((defect) =>
        Effect.as(
          Effect.logWarning("atom evaluation crashed", {
            triggerId: trigger.triggerId,
            defect,
          }),
          Option.none(),
        ),
      ),
    );

  // Process one composite (`and`/`or`/`not`) trigger for a tick: resolve each
  // leaf's truth (STATE atoms via the registry, TRANSIENT atoms against the
  // journal since the window opened — D21), advance the pure composite state
  // machine (D22), fire on demand and persist the partial state. Isolated per
  // trigger: a leaf-resolution failure is domain health (D18), logged and the
  // trigger skipped for this tick (no fire, no state write).
  const processCompositeTrigger = (trigger: ProjectionTrigger, now: number): Effect.Effect<void> =>
    Effect.gen(function* () {
      const condition = trigger.condition;
      if (condition.kind !== "and" && condition.kind !== "or" && condition.kind !== "not") {
        return;
      }

      const windowOpenedAt = trigger.windowOpenedAt;
      const leafEntries = yield* Effect.forEach(collectAtoms(condition), (atom) =>
        Effect.gen(function* () {
          const nature = yield* registry.natureOf(atom);
          if (nature === "state") {
            const truth = yield* registry.evaluate(atom);
            return [atomIdentity(atom), truth] as const;
          }
          // TRANSIENT leaf: satisfied iff a matching fact was journalled since
          // the window opened. Before the window opens there is nothing to
          // match against, so it is false.
          if (windowOpenedAt === null) {
            return [atomIdentity(atom), false] as const;
          }
          const since = DateTime.formatIso(DateTime.makeUnsafe(windowOpenedAt));
          const facts = yield* journal.listFactsSince({
            domain: atom.domain,
            type: atom.type,
            since,
          });
          const matched = facts.some((fact) =>
            matchesAtom(atom, { domain: fact.domain, type: fact.type, params: fact.params }),
          );
          return [atomIdentity(atom), matched] as const;
        }),
      );

      const truthByAtom = new Map(leafEntries);
      const leafTruth = (atom: {
        readonly domain: string;
        readonly type: string;
        readonly params: Record<string, unknown>;
      }) => truthByAtom.get(atomIdentity(atom)) ?? false;

      const conditionTruth = evaluateCondition(condition, leafTruth);
      const anyLeaf = anyLeafSatisfied(condition, leafTruth);

      const state: CompositeTriggerState = {
        windowOpenedAt: trigger.windowOpenedAt,
        fireDueAt: trigger.fireDueAt,
        conditionTruth: trigger.conditionTruth,
        nextEligibleAt: toEpochMs(trigger.nextEligibleAt),
      };

      const transition = computeCompositeTransition(
        state,
        {
          conditionTruth,
          anyLeafSatisfied: anyLeaf,
          windowMs: trigger.windowMs,
          delayMs: trigger.delayMs,
        },
        now,
      );

      if (transition.windowPurged) {
        yield* Effect.logInfo("composite window expired without completion", {
          triggerId: trigger.triggerId,
        });
      }

      if (transition.action === "fire") {
        yield* fireTriggerSafely(trigger, now);
      }

      const next = transition.nextState;
      yield* triggerRepository
        .setCompositeState({
          triggerId: TriggerId.make(trigger.triggerId),
          windowOpenedAt: next.windowOpenedAt,
          fireDueAt: next.fireDueAt,
          conditionTruth: next.conditionTruth,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to persist composite state", {
              triggerId: trigger.triggerId,
              error,
            }),
          ),
        );
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("composite evaluation failed", {
          triggerId: trigger.triggerId,
          error,
        }),
      ),
      Effect.catchDefect((defect) =>
        Effect.logWarning("composite evaluation crashed", {
          triggerId: trigger.triggerId,
          defect,
        }),
      ),
    );

  const runTick: ConditionEvaluatorShape["runTick"] = (now) =>
    Effect.gen(function* () {
      const triggers = yield* triggerRepository.listActiveAtom();

      const evaluated = yield* Effect.forEach(triggers, evaluateTrigger, {
        concurrency: "unbounded",
      });
      const evaluations = Arr.getSomes(evaluated);

      const { toFire, truthUpdates } = computeAtomFirings(evaluations, now);

      yield* Effect.forEach(toFire, (trigger) => fireTriggerSafely(trigger, now), {
        discard: true,
      });

      yield* Effect.forEach(
        truthUpdates,
        (update) =>
          triggerRepository
            .setConditionTruth({ triggerId: TriggerId.make(update.triggerId), truth: update.truth })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("failed to persist condition truth", {
                  triggerId: update.triggerId,
                  error,
                }),
              ),
            ),
        { discard: true },
      );

      // Composite conditions run their own per-trigger state machine.
      const composites = yield* triggerRepository.listActiveComposite();
      yield* Effect.forEach(composites, (trigger) => processCompositeTrigger(trigger, now), {
        discard: true,
      });
    }).pipe(
      Effect.catch((error) => Effect.logWarning("condition evaluator tick failed", { error })),
      Effect.catchDefect((defect) =>
        Effect.logWarning("condition evaluator tick crashed", { defect }),
      ),
    );

  const start: ConditionEvaluatorShape["start"] = Effect.fn("start")(function* () {
    const loop = Clock.currentTimeMillis.pipe(
      Effect.flatMap(runTick),
      Effect.andThen(Effect.sleep(TICK_INTERVAL)),
      Effect.forever,
    );
    yield* Effect.forkScoped(loop);
  });

  return {
    start,
    runTick,
  } satisfies ConditionEvaluatorShape;
});

export const ConditionEvaluatorLive = Layer.effect(ConditionEvaluator, make);
