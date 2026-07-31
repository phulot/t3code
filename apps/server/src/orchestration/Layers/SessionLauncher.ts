/**
 * SessionLauncherLive - Programmatic session start/resume implementation.
 *
 * Replicates the bootstrap sequence performed by
 * `ws.ts#dispatchBootstrapTurnStart` (create thread -> prepare worktree ->
 * run setup script -> dispatch initial turn) while relying on the same
 * underlying services. `ws.ts` is intentionally left untouched; this is an
 * accepted temporary duplicate living off the interactive hot-path.
 *
 * @module SessionLauncherLive
 */
import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { ProjectSetupScriptRunner } from "../../project/ProjectSetupScriptRunner.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  SessionLauncherModelSelectionMissingError,
  SessionLauncherProjectNotFoundError,
  SessionLauncherService,
  type SessionLauncherShape,
  type StartSessionSpec,
} from "../Services/SessionLauncher.ts";

/** Default runtime mode carried by the launcher (Decision D5). */
const DEFAULT_ORCHESTRATED_RUNTIME_MODE = "auto" as const;
const DERIVED_TITLE_MAX_CHARS = 80;
const FALLBACK_TITLE = "Orchestrated session";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const deriveTitle = (spec: StartSessionSpec): string => {
  if (spec.title && spec.title.trim().length > 0) {
    return spec.title.trim();
  }
  const firstLine = spec.text.split("\n", 1)[0]?.trim() ?? "";
  if (firstLine.length === 0) {
    return FALLBACK_TITLE;
  }
  return firstLine.length > DERIVED_TITLE_MAX_CHARS
    ? firstLine.slice(0, DERIVED_TITLE_MAX_CHARS)
    : firstLine;
};

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const gitWorkflow = yield* GitWorkflowService;
  const projectSetupScriptRunner = yield* ProjectSetupScriptRunner;
  const projectRepository = yield* ProjectionProjectRepository;
  const crypto = yield* Crypto.Crypto;

  // ID generation must never surface as a domain error; a failing CSPRNG is a
  // defect, so `orDie` keeps the launcher error channels domain-only.
  const randomUUID = crypto.randomUUIDv4.pipe(Effect.orDie);
  const commandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`orchestrate:${tag}:${uuid}`)));
  const newThreadId = randomUUID.pipe(Effect.map((uuid) => ThreadId.make(`thread-${uuid}`)));
  const newMessageId = randomUUID.pipe(Effect.map((uuid) => MessageId.make(`msg-${uuid}`)));

  const resolveModelSelection = (spec: StartSessionSpec) =>
    Effect.gen(function* () {
      if (spec.modelSelection) {
        return spec.modelSelection;
      }
      const project = yield* projectRepository
        .getById({ projectId: ProjectId.make(spec.projectId) })
        .pipe(Effect.map(Option.getOrUndefined));
      if (!project) {
        return yield* new SessionLauncherProjectNotFoundError({ projectId: spec.projectId });
      }
      if (!project.defaultModelSelection) {
        return yield* new SessionLauncherModelSelectionMissingError({ projectId: spec.projectId });
      }
      return project.defaultModelSelection;
    });

  const startSession: SessionLauncherShape["startSession"] = (spec) =>
    Effect.gen(function* () {
      const threadId = yield* newThreadId;
      const modelSelection = yield* resolveModelSelection(spec);
      const runtimeMode = spec.runtimeMode ?? DEFAULT_ORCHESTRATED_RUNTIME_MODE;
      const interactionMode = spec.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE;
      const title = deriveTitle(spec);

      let createdThread = false;
      let worktreePath = spec.worktreePath ?? null;

      const cleanupCreatedThread = () =>
        createdThread
          ? commandId("thread-delete").pipe(
              Effect.flatMap((id) =>
                orchestrationEngine.dispatch({ type: "thread.delete", commandId: id, threadId }),
              ),
              Effect.ignoreCause({ log: true }),
            )
          : Effect.void;

      const bootstrapProgram = Effect.gen(function* () {
        const createdAt = yield* nowIso;
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: yield* commandId("thread-create"),
          threadId,
          projectId: ProjectId.make(spec.projectId),
          title,
          modelSelection,
          runtimeMode,
          interactionMode,
          branch: null,
          worktreePath,
          createdAt,
        });
        createdThread = true;

        if (spec.prepareWorktree) {
          const prepare = spec.prepareWorktree;
          let worktreeBaseRef = prepare.baseBranch;
          if (prepare.startFromOrigin) {
            yield* gitWorkflow.fetchRemote({ cwd: prepare.projectCwd, remoteName: "origin" });
            const resolvedRemoteBase = yield* gitWorkflow.resolveRemoteTrackingCommit({
              cwd: prepare.projectCwd,
              refName: prepare.baseBranch,
              fallbackRemoteName: "origin",
            });
            worktreeBaseRef = resolvedRemoteBase.commitSha;
          }
          const worktree = yield* gitWorkflow.createWorktree({
            cwd: prepare.projectCwd,
            refName: worktreeBaseRef,
            newRefName: prepare.branch,
            baseRefName: prepare.baseBranch,
            path: null,
          });
          worktreePath = worktree.worktree.path;
          yield* orchestrationEngine.dispatch({
            type: "thread.meta.update",
            commandId: yield* commandId("thread-meta-update"),
            threadId,
            branch: worktree.worktree.refName,
            worktreePath,
          });
        }

        if (spec.runSetupScript && worktreePath) {
          yield* projectSetupScriptRunner.runForThread({
            threadId,
            projectId: spec.projectId,
            ...(spec.prepareWorktree ? { projectCwd: spec.prepareWorktree.projectCwd } : {}),
            worktreePath,
          });
        }

        const turnStartedAt = yield* nowIso;
        const result = yield* orchestrationEngine.dispatch({
          type: "thread.turn.start",
          commandId: yield* commandId("turn-start"),
          threadId,
          message: {
            messageId: yield* newMessageId,
            role: "user",
            text: spec.text,
            attachments: [],
          },
          modelSelection,
          runtimeMode,
          interactionMode,
          createdAt: turnStartedAt,
        });
        return { threadId: threadId as string, sequence: result.sequence };
      });

      return yield* bootstrapProgram.pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return cleanupCreatedThread().pipe(Effect.flatMap(() => Effect.failCause(cause)));
        }),
      );
    });

  const resumeSession: SessionLauncherShape["resumeSession"] = (spec) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      const result = yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: yield* commandId("resume-turn-start"),
        threadId: ThreadId.make(spec.threadId),
        message: {
          messageId: yield* newMessageId,
          role: "user",
          text: spec.text,
          attachments: [],
        },
        ...(spec.modelSelection ? { modelSelection: spec.modelSelection } : {}),
        runtimeMode: DEFAULT_ORCHESTRATED_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt,
      });
      return { sequence: result.sequence };
    });

  return {
    startSession,
    resumeSession,
  } satisfies SessionLauncherShape;
});

export const SessionLauncherLive = Layer.effect(SessionLauncherService, make);
