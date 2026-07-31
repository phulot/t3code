/**
 * SessionLauncher - Programmatic thread/session bootstrap service interface.
 *
 * Owns the ability to start (bootstrap + turn.start) or resume (turn.start on
 * an existing thread) an orchestration session without going through the
 * interactive websocket hot-path. It mirrors the bootstrap sequence performed
 * by `ws.ts#dispatchBootstrapTurnStart` while relying on the same underlying
 * services (orchestration engine, git workflow, setup script runner, project
 * projection). This is the backend plumbing consumed by the orchestration MCP
 * surface.
 *
 * @module SessionLauncher
 */
import type {
  GitCommandError,
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { ProjectSetupScriptRunnerError } from "../../project/ProjectSetupScriptRunner.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";

/**
 * Raised when no explicit `modelSelection` was provided and the target project
 * has no `defaultModelSelection` to fall back to (Decision D6).
 */
export class SessionLauncherModelSelectionMissingError extends Schema.TaggedErrorClass<SessionLauncherModelSelectionMissingError>()(
  "SessionLauncherModelSelectionMissingError",
  {
    projectId: Schema.String,
  },
) {
  override get message(): string {
    return `No model selection provided and project '${this.projectId}' has no default model selection.`;
  }
}

/**
 * Raised when the target project cannot be found while resolving its default
 * model selection.
 */
export class SessionLauncherProjectNotFoundError extends Schema.TaggedErrorClass<SessionLauncherProjectNotFoundError>()(
  "SessionLauncherProjectNotFoundError",
  {
    projectId: Schema.String,
  },
) {
  override get message(): string {
    return `Project '${this.projectId}' was not found while starting an orchestrated session.`;
  }
}

/**
 * Worktree preparation spec, mirroring the real fields of
 * `ThreadTurnStartBootstrapPrepareWorktree`. When present, a fresh worktree is
 * created before the initial turn is dispatched.
 */
export interface StartSessionWorktreePreparation {
  /** Project working directory the worktree is created from. */
  readonly projectCwd: string;
  /** Base branch/ref the new worktree branches off. */
  readonly baseBranch: string;
  /** Name of the branch created for the new worktree. */
  readonly branch: string;
  /**
   * When true, fetch `origin` and resolve the remote-tracking commit for
   * `baseBranch` before creating the worktree.
   */
  readonly startFromOrigin?: boolean;
}

/**
 * StartSessionSpec - Input describing a session to start.
 */
export interface StartSessionSpec {
  /** Target project id the thread is created under. */
  readonly projectId: string;
  /** Optional thread title; derived from `text` when omitted. */
  readonly title?: string;
  /** Initial user prompt dispatched as the first turn. */
  readonly text: string;
  /**
   * Model selection for the thread. When omitted, resolved from the project's
   * `defaultModelSelection`; when both are absent the launch fails with
   * {@link SessionLauncherModelSelectionMissingError}.
   */
  readonly modelSelection?: ModelSelection;
  /**
   * Runtime mode for the session. Defaults to `"auto"` (Decision D5: an
   * orchestrated session never runs in `approval-required`).
   */
  readonly runtimeMode?: RuntimeMode;
  /** Interaction mode for the session. Defaults to `"default"`. */
  readonly interactionMode?: ProviderInteractionMode;
  /**
   * When present, a fresh worktree is prepared before the initial turn. Mutually
   * complementary with {@link worktreePath}: use one or the other.
   */
  readonly prepareWorktree?: StartSessionWorktreePreparation;
  /** An already-existing worktree path to bind the thread to. */
  readonly worktreePath?: string;
  /** When true, run the project setup script in the worktree. Defaults to false. */
  readonly runSetupScript?: boolean;
}

/**
 * ResumeSessionSpec - Input describing a turn dispatched on an existing thread.
 */
export interface ResumeSessionSpec {
  /** Existing thread id to resume. */
  readonly threadId: string;
  /** User prompt dispatched as the new turn. */
  readonly text: string;
  /** Optional per-turn model selection override. */
  readonly modelSelection?: ModelSelection;
}

/**
 * Error union raised while starting a session.
 */
export type StartSessionError =
  | SessionLauncherModelSelectionMissingError
  | SessionLauncherProjectNotFoundError
  | OrchestrationDispatchError
  | GitCommandError
  | ProjectSetupScriptRunnerError
  | ProjectionRepositoryError;

/**
 * SessionLauncherShape - Service API for programmatic session start/resume.
 */
export interface SessionLauncherShape {
  /**
   * Create a thread, optionally prepare a worktree and run the setup script,
   * then dispatch the initial `thread.turn.start`. On failure after the thread
   * was created, the thread is rolled back (best-effort delete).
   */
  readonly startSession: (
    spec: StartSessionSpec,
  ) => Effect.Effect<{ readonly threadId: string; readonly sequence: number }, StartSessionError>;

  /**
   * Dispatch a `thread.turn.start` (no bootstrap) on an existing thread.
   */
  readonly resumeSession: (
    spec: ResumeSessionSpec,
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchError>;
}

/**
 * SessionLauncherService - Service tag for programmatic session launching.
 */
export class SessionLauncherService extends Context.Service<
  SessionLauncherService,
  SessionLauncherShape
>()("t3/orchestration/Services/SessionLauncher/SessionLauncherService") {}
