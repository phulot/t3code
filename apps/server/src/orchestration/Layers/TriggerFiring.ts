/**
 * TriggerFiring - Shared trigger fire pipeline.
 *
 * Factored out of the temporal scheduler so both the {@link TriggerScheduler}
 * (temporal conditions) and the condition evaluator (atom STATE conditions)
 * fire a trigger through the exact same sequence:
 *   1. dispatch `trigger.fire-started` (stamps `last_fired_at` +
 *      `next_eligible_at`, arming the 60s anti-rebound before the launch),
 *   2. build a `StartSessionSpec` from the trigger action + project and call
 *      `SessionLauncher.startSession`,
 *   3. dispatch `trigger.fire-settled` with the classified outcome.
 * A per-trigger failure never breaks the caller's loop nor its siblings.
 *
 * @module TriggerFiring
 */
import {
  CommandId,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TriggerId,
  TrimmedNonEmptyString,
  type TriggerCondition,
  type TriggerFireOutcome,
} from "@t3tools/contracts";
import type * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import type { ProjectionTrigger } from "../../persistence/Services/ProjectionTriggers.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { SessionLauncherService } from "../Services/SessionLauncher.ts";
import type { StartSessionSpec } from "../Services/SessionLauncher.ts";

/** Upper bound on the `reason` carried by a failed `fire-settled`. */
export const FAILURE_REASON_MAX_CHARS = 500;

/**
 * Raised while resolving the session spec for a firing trigger (e.g. the
 * trigger's project could not be found while resolving its worktree cwd).
 * Treated as a permanent failure: retrying will not fix a misconfigured trigger.
 */
export class TriggerSpecResolutionError {
  readonly _tag = "TriggerSpecResolutionError";
  readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
}

/** Error `_tag`s that classify a fire failure as permanent (no retry). */
export const PERMANENT_FAILURE_TAGS = new Set<string>([
  "SessionLauncherModelSelectionMissingError",
  "SessionLauncherProjectNotFoundError",
  "TriggerSpecResolutionError",
]);

const toReason = (message: string) => {
  const trimmed = message.trim();
  const clamped =
    trimmed.length === 0
      ? "Unknown error"
      : trimmed.length > FAILURE_REASON_MAX_CHARS
        ? trimmed.slice(0, FAILURE_REASON_MAX_CHARS)
        : trimmed;
  return TrimmedNonEmptyString.make(clamped);
};

export const classifyFailure = (error: {
  readonly _tag?: string;
  readonly message?: string;
}): Extract<TriggerFireOutcome, { status: "failed" }> => {
  const tag = error._tag ?? "";
  const failureKind = PERMANENT_FAILURE_TAGS.has(tag) ? "permanent" : "transient";
  return {
    status: "failed",
    failureKind,
    reason: toReason(error.message ?? tag ?? "Unknown error"),
  };
};

/**
 * Whether a condition may fire more than once over the trigger's life. Recurring
 * fires get a firedAt-suffixed worktree branch to avoid collisions across
 * successive fires (Decision D10). Only a one-shot temporal `at` is non-recurring;
 * `interval` and atom conditions may re-fire.
 */
export function isRecurringCondition(condition: TriggerCondition): boolean {
  if (condition.kind === "temporal") {
    return condition.schedule.kind === "interval";
  }
  return true;
}

export interface TriggerFiringDeps {
  readonly orchestrationEngine: OrchestrationEngineService["Service"];
  readonly sessionLauncher: SessionLauncherService["Service"];
  readonly projectRepository: ProjectionProjectRepository["Service"];
  readonly crypto: Crypto.Crypto;
  /** Prefix for generated command ids, identifying the firing reactor. */
  readonly commandNamespace: string;
}

export interface TriggerFiring {
  /** Fire one trigger, isolating any typed error or defect via logging. */
  readonly fireTriggerSafely: (trigger: ProjectionTrigger, now: number) => Effect.Effect<void>;
}

export function makeTriggerFiring(deps: TriggerFiringDeps): TriggerFiring {
  const { orchestrationEngine, sessionLauncher, projectRepository, crypto, commandNamespace } =
    deps;

  const commandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`${commandNamespace}:${tag}:${uuid}`)),
    );

  const buildStartSessionSpec = (trigger: ProjectionTrigger, firedAtMillis: number) =>
    Effect.gen(function* () {
      const action = trigger.action;
      const sessionSpec = action.spec;

      const spec: StartSessionSpec = {
        projectId: trigger.projectId,
        text: sessionSpec.text,
        ...(sessionSpec.title !== undefined ? { title: sessionSpec.title } : {}),
        ...(sessionSpec.modelSelection !== undefined
          ? { modelSelection: sessionSpec.modelSelection }
          : {}),
        ...(sessionSpec.runtimeMode !== undefined ? { runtimeMode: sessionSpec.runtimeMode } : {}),
        ...(sessionSpec.worktreePath !== undefined
          ? { worktreePath: sessionSpec.worktreePath }
          : {}),
        ...(sessionSpec.runSetupScript !== undefined
          ? { runSetupScript: sessionSpec.runSetupScript }
          : {}),
      };

      if (sessionSpec.prepareWorktree === undefined) {
        return spec;
      }

      const project = yield* projectRepository
        .getById({ projectId: ProjectId.make(trigger.projectId) })
        .pipe(Effect.map(Option.getOrUndefined));
      if (!project) {
        return yield* Effect.fail(
          new TriggerSpecResolutionError(
            `Project '${trigger.projectId}' was not found while resolving the worktree for trigger '${trigger.triggerId}'.`,
          ),
        );
      }

      const isRecurring = isRecurringCondition(trigger.condition);
      const branchBase = sessionSpec.prepareWorktree.branch ?? `trigger-${trigger.triggerId}`;
      const branch = isRecurring ? `${branchBase}-${firedAtMillis}` : branchBase;

      return {
        ...spec,
        prepareWorktree: {
          projectCwd: project.workspaceRoot,
          baseBranch: sessionSpec.prepareWorktree.baseBranch,
          branch,
          ...(sessionSpec.prepareWorktree.startFromOrigin !== undefined
            ? { startFromOrigin: sessionSpec.prepareWorktree.startFromOrigin }
            : {}),
        },
      } satisfies StartSessionSpec;
    });

  const dispatchFireStarted = (triggerId: string, firedAt: IsoDateTime) =>
    commandId("fire-started").pipe(
      Effect.flatMap((id) =>
        orchestrationEngine.dispatch({
          type: "trigger.fire-started",
          commandId: id,
          triggerId: TriggerId.make(triggerId),
          firedAt,
        }),
      ),
    );

  const dispatchFireSettled = (
    triggerId: string,
    firedAt: IsoDateTime,
    outcome: TriggerFireOutcome,
  ) =>
    commandId("fire-settled").pipe(
      Effect.flatMap((id) =>
        orchestrationEngine.dispatch({
          type: "trigger.fire-settled",
          commandId: id,
          triggerId: TriggerId.make(triggerId),
          firedAt,
          outcome,
        }),
      ),
    );

  // Fire one trigger. Ordering matters: `fire-started` arms the anti-rebound
  // window before the (possibly slow) launch, so a re-tick cannot double fire.
  const fireTrigger = (trigger: ProjectionTrigger, now: number) =>
    Effect.gen(function* () {
      const firedAt = IsoDateTime.make(DateTime.formatIso(DateTime.makeUnsafe(now)));

      yield* dispatchFireStarted(trigger.triggerId, firedAt);

      const outcome: TriggerFireOutcome = yield* buildStartSessionSpec(trigger, now).pipe(
        Effect.flatMap((spec) => sessionLauncher.startSession(spec)),
        Effect.map(
          (result): TriggerFireOutcome => ({
            status: "succeeded",
            threadId: ThreadId.make(result.threadId),
          }),
        ),
        Effect.catch(
          (error): Effect.Effect<TriggerFireOutcome> =>
            Effect.succeed(classifyFailure(error as { _tag?: string; message?: string })),
        ),
      );

      yield* dispatchFireSettled(trigger.triggerId, firedAt, outcome);
    });

  const fireTriggerSafely = (trigger: ProjectionTrigger, now: number) =>
    fireTrigger(trigger, now).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to fire trigger", {
          namespace: commandNamespace,
          triggerId: trigger.triggerId,
          error,
        }),
      ),
      Effect.catchDefect((defect) =>
        Effect.logWarning("crashed while firing trigger", {
          namespace: commandNamespace,
          triggerId: trigger.triggerId,
          defect,
        }),
      ),
    );

  return { fireTriggerSafely };
}
