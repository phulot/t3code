/**
 * TriggerSchedulerLive - Temporal trigger scheduler implementation.
 *
 * Polls the trigger projection every {@link TICK_INTERVAL} and fires temporal
 * triggers that have become due, running each through the shared trigger fire
 * pipeline ({@link makeTriggerFiring}). A per-trigger failure never breaks the
 * loop nor stops sibling triggers.
 *
 * @module TriggerSchedulerLive
 */
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionTriggerRepository } from "../../persistence/Services/ProjectionTriggers.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { SessionLauncherService } from "../Services/SessionLauncher.ts";
import {
  computeDueTriggers,
  TriggerScheduler,
  type TriggerSchedulerShape,
} from "../Services/TriggerScheduler.ts";
import { makeTriggerFiring } from "./TriggerFiring.ts";

/** Polling cadence. Kept well under the 60s anti-rebound window. */
const TICK_INTERVAL = Duration.seconds(5);

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const sessionLauncher = yield* SessionLauncherService;
  const triggerRepository = yield* ProjectionTriggerRepository;
  const projectRepository = yield* ProjectionProjectRepository;
  const crypto = yield* Crypto.Crypto;

  const { fireTriggerSafely } = makeTriggerFiring({
    orchestrationEngine,
    sessionLauncher,
    projectRepository,
    crypto,
    commandNamespace: "trigger-scheduler",
  });

  const runTick: TriggerSchedulerShape["runTick"] = (now) =>
    Effect.gen(function* () {
      const triggers = yield* triggerRepository.listActiveTemporal();
      const due = computeDueTriggers(triggers, now);
      yield* Effect.forEach(due, (trigger) => fireTriggerSafely(trigger, now), {
        discard: true,
      });
    }).pipe(
      Effect.catch((error) => Effect.logWarning("trigger scheduler tick failed", { error })),
      Effect.catchDefect((defect) =>
        Effect.logWarning("trigger scheduler tick crashed", { defect }),
      ),
    );

  const start: TriggerSchedulerShape["start"] = Effect.fn("start")(function* () {
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
  } satisfies TriggerSchedulerShape;
});

export const TriggerSchedulerLive = Layer.effect(TriggerScheduler, make);
