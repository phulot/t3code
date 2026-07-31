/**
 * Orchestrate toolkit tool definitions.
 *
 * The orchestrate control plane lets an opted-in project's agent inspect and
 * pilot other T3 Code sessions. Every tool is scoped to the calling thread's
 * own project (manager decision D7): the project id is resolved from the MCP
 * invocation scope, never accepted as a tool parameter.
 */
import {
  GitCommandError,
  ModelSelection,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  PositiveInt,
  PreviewAutomationUnavailableError,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeMode,
  ServerProviderModel,
  TriggerAction,
  TriggerCondition,
  TriggerFireOutcome,
  TriggerId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  OrchestrationListenerCallbackError,
  OrchestrationProjectorDecodeError,
} from "../../../orchestration/Errors.ts";
import { PersistenceDecodeError, PersistenceSqlError } from "../../../persistence/Errors.ts";
import {
  ProjectSetupScriptOperationError,
  ProjectSetupScriptProjectNotFoundError,
} from "../../../project/ProjectSetupScriptRunner.ts";
import {
  SessionLauncherModelSelectionMissingError,
  SessionLauncherProjectNotFoundError,
} from "../../../orchestration/Services/SessionLauncher.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { ProjectionThreadRepository } from "../../../persistence/Services/ProjectionThreads.ts";
import { ProjectionTriggerRepository } from "../../../persistence/Services/ProjectionTriggers.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { SessionLauncherService } from "../../../orchestration/Services/SessionLauncher.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/**
 * Raised when the calling thread cannot be resolved to a project, or when a
 * targeted thread does not belong to the calling project (no cross-project
 * orchestration is allowed in V1).
 */
export class OrchestrateSessionScopeError extends Schema.TaggedErrorClass<OrchestrateSessionScopeError>()(
  "OrchestrateSessionScopeError",
  {
    reason: Schema.Literals(["thread-not-found", "project-not-found", "cross-project"]),
    threadId: Schema.String,
    projectId: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "thread-not-found":
        return `Thread '${this.threadId}' was not found while resolving the orchestration scope.`;
      case "project-not-found":
        return `Project '${this.projectId ?? "?"}' was not found for thread '${this.threadId}'.`;
      case "cross-project":
        return `Thread '${this.threadId}' does not belong to the calling project; cross-project orchestration is not allowed.`;
    }
  }
}

/**
 * Raised when a targeted trigger cannot be found, or when it belongs to another
 * project than the calling thread's (no cross-project orchestration in V1).
 */
export class OrchestrateTriggerScopeError extends Schema.TaggedErrorClass<OrchestrateTriggerScopeError>()(
  "OrchestrateTriggerScopeError",
  {
    reason: Schema.Literals(["trigger-not-found", "cross-project"]),
    triggerId: Schema.String,
    projectId: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "trigger-not-found":
        return `Trigger '${this.triggerId}' was not found in the calling project.`;
      case "cross-project":
        return `Trigger '${this.triggerId}' does not belong to the calling project; cross-project orchestration is not allowed.`;
    }
  }
}

/**
 * Failure union shared by every orchestrate tool. It carries the capability
 * gating error, the scope-resolution error, and the domain errors surfaced by
 * `SessionLauncher` and the projection reads. Kept as a single superset schema
 * so all tools declare a consistent failure shape.
 */
export const OrchestrateToolError = Schema.Union([
  PreviewAutomationUnavailableError,
  OrchestrateSessionScopeError,
  OrchestrateTriggerScopeError,
  SessionLauncherModelSelectionMissingError,
  SessionLauncherProjectNotFoundError,
  GitCommandError,
  ProjectSetupScriptOperationError,
  ProjectSetupScriptProjectNotFoundError,
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  OrchestrationProjectorDecodeError,
  OrchestrationListenerCallbackError,
  PersistenceSqlError,
  PersistenceDecodeError,
]);
export type OrchestrateToolError = typeof OrchestrateToolError.Type;

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  SessionLauncherService,
  ProjectionSnapshotQuery,
  ProjectionThreadRepository,
  ProjectionTriggerRepository,
  OrchestrationEngineService,
  ProviderRegistry,
  Crypto.Crypto,
];

// ---------------------------------------------------------------------------
// list_sessions
// ---------------------------------------------------------------------------

export const OrchestrateListSessionsResult = Schema.Struct({
  project: OrchestrationProjectShell,
  threads: Schema.Array(OrchestrationThreadShell),
});
export type OrchestrateListSessionsResult = typeof OrchestrateListSessionsResult.Type;

export const OrchestrateListSessionsTool = Tool.make("orchestrate_list_sessions", {
  description:
    "List the calling project together with its threads (title, id, latest-turn state, branch, worktree path, runtime mode, and live session activity). Scoped to the calling thread's own project.",
  parameters: Schema.Struct({}),
  success: OrchestrateListSessionsResult,
  failure: OrchestrateToolError,
  dependencies,
})
  .annotate(Tool.Title, "List orchestration sessions")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

// ---------------------------------------------------------------------------
// list_models
// ---------------------------------------------------------------------------

export const OrchestrateProviderModels = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.optional(Schema.String),
  enabled: Schema.Boolean,
  models: Schema.Array(ServerProviderModel),
});
export type OrchestrateProviderModels = typeof OrchestrateProviderModels.Type;

export const OrchestrateListModelsResult = Schema.Array(OrchestrateProviderModels);
export type OrchestrateListModelsResult = typeof OrchestrateListModelsResult.Type;

export const OrchestrateListModelsTool = Tool.make("orchestrate_list_models", {
  description:
    "List the provider instances and models available to start or resume a session, with enough detail (instanceId + model slug) to build a modelSelection.",
  parameters: Schema.Struct({}),
  success: OrchestrateListModelsResult,
  failure: OrchestrateToolError,
  dependencies,
})
  .annotate(Tool.Title, "List orchestration models")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

// ---------------------------------------------------------------------------
// start_session
// ---------------------------------------------------------------------------

export const OrchestrateStartSessionPrepareWorktree = Schema.Struct({
  baseBranch: Schema.String,
  branch: Schema.String,
  startFromOrigin: Schema.optional(Schema.Boolean),
});
export type OrchestrateStartSessionPrepareWorktree =
  typeof OrchestrateStartSessionPrepareWorktree.Type;

export const OrchestrateStartSessionInput = Schema.Struct({
  title: Schema.optional(Schema.String),
  text: Schema.String,
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  prepareWorktree: Schema.optional(OrchestrateStartSessionPrepareWorktree),
  worktreePath: Schema.optional(Schema.String),
  runSetupScript: Schema.optional(Schema.Boolean),
});
export type OrchestrateStartSessionInput = typeof OrchestrateStartSessionInput.Type;

export const OrchestrateStartSessionResult = Schema.Struct({
  threadId: Schema.String,
  sequence: Schema.Number,
});
export type OrchestrateStartSessionResult = typeof OrchestrateStartSessionResult.Type;

export const OrchestrateStartSessionTool = Tool.make("orchestrate_start_session", {
  description:
    "Start a new session in the calling project: create a thread, optionally prepare a worktree and run the setup script, then dispatch the initial turn. The project is resolved from the calling scope and cannot be overridden.",
  parameters: OrchestrateStartSessionInput,
  success: OrchestrateStartSessionResult,
  failure: OrchestrateToolError,
  dependencies,
})
  .annotate(Tool.Title, "Start orchestration session")
  .annotate(Tool.Destructive, false);

// ---------------------------------------------------------------------------
// resume_session
// ---------------------------------------------------------------------------

export const OrchestrateResumeSessionInput = Schema.Struct({
  threadId: Schema.String,
  text: Schema.String,
  modelSelection: Schema.optional(ModelSelection),
});
export type OrchestrateResumeSessionInput = typeof OrchestrateResumeSessionInput.Type;

export const OrchestrateResumeSessionResult = Schema.Struct({
  sequence: Schema.Number,
});
export type OrchestrateResumeSessionResult = typeof OrchestrateResumeSessionResult.Type;

export const OrchestrateResumeSessionTool = Tool.make("orchestrate_resume_session", {
  description:
    "Dispatch a new turn on an existing thread of the calling project. Fails if the target thread belongs to another project.",
  parameters: OrchestrateResumeSessionInput,
  success: OrchestrateResumeSessionResult,
  failure: OrchestrateToolError,
  dependencies,
})
  .annotate(Tool.Title, "Resume orchestration session")
  .annotate(Tool.Destructive, false);

// ---------------------------------------------------------------------------
// trigger view (shared by list_triggers / get_trigger)
// ---------------------------------------------------------------------------

/**
 * Agent-facing view of a projected trigger. Mirrors the useful public subset of
 * the projection row: identity, condition/action, enablement, and the
 * evaluator-owned runtime fields (`conditionTruth`, anti-rebound window,
 * composite bounds) an agent needs to reason about a trigger's state.
 */
export const OrchestrateTriggerView = Schema.Struct({
  triggerId: TriggerId,
  projectId: ProjectId,
  name: Schema.String,
  condition: TriggerCondition,
  action: TriggerAction,
  enabled: Schema.Boolean,
  consecutiveTransientFailures: Schema.Number,
  lastFiredAt: Schema.NullOr(Schema.String),
  lastOutcome: Schema.NullOr(TriggerFireOutcome),
  nextEligibleAt: Schema.NullOr(Schema.String),
  conditionTruth: Schema.NullOr(Schema.Boolean),
  windowMs: Schema.NullOr(Schema.Number),
  delayMs: Schema.NullOr(Schema.Number),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type OrchestrateTriggerView = typeof OrchestrateTriggerView.Type;

// ---------------------------------------------------------------------------
// create_trigger
// ---------------------------------------------------------------------------

export const OrchestrateCreateTriggerInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  condition: TriggerCondition,
  action: TriggerAction,
  enabled: Schema.optional(Schema.Boolean),
  windowMs: Schema.optional(PositiveInt),
  delayMs: Schema.optional(PositiveInt),
});
export type OrchestrateCreateTriggerInput = typeof OrchestrateCreateTriggerInput.Type;

export const OrchestrateCreateTriggerResult = Schema.Struct({
  triggerId: TriggerId,
  sequence: Schema.Number,
});
export type OrchestrateCreateTriggerResult = typeof OrchestrateCreateTriggerResult.Type;

export const OrchestrateCreateTriggerTool = Tool.make("orchestrate_create_trigger", {
  description:
    "Create an automation trigger in the calling project. The condition is a temporal schedule, an atom (WHEN a domain signal holds/fires), or a composite (and/or/not) of conditions; the action starts a session when the trigger fires. The project is resolved from the calling scope and cannot be overridden.",
  parameters: OrchestrateCreateTriggerInput,
  success: OrchestrateCreateTriggerResult,
  failure: OrchestrateToolError,
  dependencies,
})
  .annotate(Tool.Title, "Create orchestration trigger")
  .annotate(Tool.Destructive, false);

// ---------------------------------------------------------------------------
// list_triggers
// ---------------------------------------------------------------------------

export const OrchestrateListTriggersResult = Schema.Array(OrchestrateTriggerView);
export type OrchestrateListTriggersResult = typeof OrchestrateListTriggersResult.Type;

export const OrchestrateListTriggersTool = Tool.make("orchestrate_list_triggers", {
  description:
    "List the automation triggers of the calling project, with their condition, action, enablement, last outcome and current evaluator state.",
  parameters: Schema.Struct({}),
  success: OrchestrateListTriggersResult,
  failure: OrchestrateToolError,
  dependencies,
})
  .annotate(Tool.Title, "List orchestration triggers")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

// ---------------------------------------------------------------------------
// get_trigger
// ---------------------------------------------------------------------------

export const OrchestrateGetTriggerInput = Schema.Struct({
  triggerId: Schema.String,
});
export type OrchestrateGetTriggerInput = typeof OrchestrateGetTriggerInput.Type;

export const OrchestrateGetTriggerTool = Tool.make("orchestrate_get_trigger", {
  description:
    "Read one automation trigger of the calling project by id. Fails if the trigger belongs to another project.",
  parameters: OrchestrateGetTriggerInput,
  success: OrchestrateTriggerView,
  failure: OrchestrateToolError,
  dependencies,
})
  .annotate(Tool.Title, "Get orchestration trigger")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

// ---------------------------------------------------------------------------
// enable_trigger / disable_trigger / delete_trigger
// ---------------------------------------------------------------------------

export const OrchestrateTriggerMutationInput = Schema.Struct({
  triggerId: Schema.String,
});
export type OrchestrateTriggerMutationInput = typeof OrchestrateTriggerMutationInput.Type;

export const OrchestrateTriggerMutationResult = Schema.Struct({
  sequence: Schema.Number,
});
export type OrchestrateTriggerMutationResult = typeof OrchestrateTriggerMutationResult.Type;

export const OrchestrateEnableTriggerTool = Tool.make("orchestrate_enable_trigger", {
  description:
    "Enable an automation trigger of the calling project so it can fire again. Fails if the trigger belongs to another project.",
  parameters: OrchestrateTriggerMutationInput,
  success: OrchestrateTriggerMutationResult,
  failure: OrchestrateToolError,
  dependencies,
})
  .annotate(Tool.Title, "Enable orchestration trigger")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const OrchestrateDisableTriggerTool = Tool.make("orchestrate_disable_trigger", {
  description:
    "Disable an automation trigger of the calling project so it stops firing. Fails if the trigger belongs to another project.",
  parameters: OrchestrateTriggerMutationInput,
  success: OrchestrateTriggerMutationResult,
  failure: OrchestrateToolError,
  dependencies,
})
  .annotate(Tool.Title, "Disable orchestration trigger")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const OrchestrateDeleteTriggerTool = Tool.make("orchestrate_delete_trigger", {
  description:
    "Delete an automation trigger of the calling project. Fails if the trigger belongs to another project.",
  parameters: OrchestrateTriggerMutationInput,
  success: OrchestrateTriggerMutationResult,
  failure: OrchestrateToolError,
  dependencies,
})
  .annotate(Tool.Title, "Delete orchestration trigger")
  .annotate(Tool.Destructive, true);

export const OrchestrateToolkit = Toolkit.make(
  OrchestrateListSessionsTool,
  OrchestrateListModelsTool,
  OrchestrateStartSessionTool,
  OrchestrateResumeSessionTool,
  OrchestrateCreateTriggerTool,
  OrchestrateListTriggersTool,
  OrchestrateGetTriggerTool,
  OrchestrateEnableTriggerTool,
  OrchestrateDisableTriggerTool,
  OrchestrateDeleteTriggerTool,
);
