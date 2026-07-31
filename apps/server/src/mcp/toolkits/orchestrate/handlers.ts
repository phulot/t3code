/**
 * Orchestrate toolkit handlers.
 *
 * Each handler starts by asserting the `"orchestrate"` capability, then
 * resolves the calling thread's project from the MCP scope. All work is scoped
 * to that project (manager decision D7).
 */
import { CommandId, ProjectId, ThreadId, TriggerId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ProjectionThreadRepository } from "../../../persistence/Services/ProjectionThreads.ts";
import { ProjectionTriggerRepository } from "../../../persistence/Services/ProjectionTriggers.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { SessionLauncherService } from "../../../orchestration/Services/SessionLauncher.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  OrchestrateSessionScopeError,
  OrchestrateToolkit,
  OrchestrateTriggerScopeError,
} from "./tools.ts";

/**
 * Resolve the project id of the calling thread from the MCP scope after
 * asserting the `"orchestrate"` capability.
 */
const resolveCallingProject = Effect.fn("OrchestrateToolkit.resolveCallingProject")(function* () {
  const scope = yield* McpInvocationContext.requireMcpCapability("orchestrate");
  const threads = yield* ProjectionThreadRepository;
  const thread = yield* threads.getById({ threadId: scope.threadId });
  if (Option.isNone(thread)) {
    return yield* new OrchestrateSessionScopeError({
      reason: "thread-not-found",
      threadId: scope.threadId,
    });
  }
  return { scope, projectId: thread.value.projectId } as const;
});

/**
 * Resolve a targeted trigger, refusing ids that belong to another project. Used
 * by every trigger op that names an existing trigger (get/enable/disable/delete)
 * to enforce the same no-cross-project rule as the session tools.
 */
const resolveTriggerInProject = Effect.fn("OrchestrateToolkit.resolveTriggerInProject")(function* (
  rawTriggerId: string,
  projectId: string,
) {
  const triggers = yield* ProjectionTriggerRepository;
  const triggerId = TriggerId.make(rawTriggerId);
  const target = yield* triggers.getById({ triggerId });
  if (Option.isNone(target)) {
    return yield* new OrchestrateTriggerScopeError({
      reason: "trigger-not-found",
      triggerId: rawTriggerId,
    });
  }
  if (target.value.projectId !== projectId) {
    return yield* new OrchestrateTriggerScopeError({
      reason: "cross-project",
      triggerId: rawTriggerId,
      projectId,
    });
  }
  return { triggerId, trigger: target.value } as const;
});

/**
 * Forge a fresh command id, mirroring the SessionLauncher convention
 * (`orchestrate:<tag>:<uuid>`). A failing CSPRNG is a defect, so `orDie` keeps
 * the handler error channels domain-only.
 */
const newCommandId = (tag: string) =>
  Effect.map(
    Effect.flatMap(Crypto.Crypto, (crypto) => crypto.randomUUIDv4.pipe(Effect.orDie)),
    (uuid) => CommandId.make(`orchestrate:${tag}:${uuid}`),
  );

export const orchestrateHandlers = {
  orchestrate_list_sessions: () =>
    Effect.gen(function* () {
      const { projectId } = yield* resolveCallingProject();
      const snapshots = yield* ProjectionSnapshotQuery;
      const snapshot = yield* snapshots.getShellSnapshot();
      const project = snapshot.projects.find((candidate) => candidate.id === projectId);
      if (project === undefined) {
        return yield* new OrchestrateSessionScopeError({
          reason: "project-not-found",
          threadId: "",
          projectId,
        });
      }
      const threads = snapshot.threads.filter((thread) => thread.projectId === projectId);
      return { project, threads };
    }),

  orchestrate_list_models: () =>
    Effect.gen(function* () {
      yield* resolveCallingProject();
      const registry = yield* ProviderRegistry;
      const providers = yield* registry.getProviders;
      return providers.map((provider) => ({
        instanceId: provider.instanceId,
        driver: provider.driver,
        ...(provider.displayName === undefined ? {} : { displayName: provider.displayName }),
        enabled: provider.enabled,
        models: provider.models,
      }));
    }),

  orchestrate_start_session: (input) =>
    Effect.gen(function* () {
      const { projectId } = yield* resolveCallingProject();
      const launcher = yield* SessionLauncherService;
      const snapshots = yield* ProjectionSnapshotQuery;
      // A worktree preparation is bound to the calling project's workspace root;
      // the caller never supplies an arbitrary project directory (decision D7).
      const prepareWorktree = input.prepareWorktree;
      const projectCwd = prepareWorktree
        ? yield* snapshots.getProjectShellById(ProjectId.make(projectId)).pipe(
            Effect.flatMap((project) =>
              Option.isNone(project)
                ? new OrchestrateSessionScopeError({
                    reason: "project-not-found",
                    threadId: "",
                    projectId,
                  })
                : Effect.succeed(project.value.workspaceRoot),
            ),
          )
        : undefined;
      return yield* launcher.startSession({
        projectId,
        ...(input.title === undefined ? {} : { title: input.title }),
        text: input.text,
        ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
        ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
        ...(prepareWorktree && projectCwd !== undefined
          ? {
              prepareWorktree: {
                projectCwd,
                baseBranch: prepareWorktree.baseBranch,
                branch: prepareWorktree.branch,
                ...(prepareWorktree.startFromOrigin === undefined
                  ? {}
                  : { startFromOrigin: prepareWorktree.startFromOrigin }),
              },
            }
          : {}),
        ...(input.worktreePath === undefined ? {} : { worktreePath: input.worktreePath }),
        ...(input.runSetupScript === undefined ? {} : { runSetupScript: input.runSetupScript }),
      });
    }),

  orchestrate_resume_session: (input) =>
    Effect.gen(function* () {
      const { projectId } = yield* resolveCallingProject();
      const threads = yield* ProjectionThreadRepository;
      const targetThreadId = ThreadId.make(input.threadId);
      const target = yield* threads.getById({ threadId: targetThreadId });
      if (Option.isNone(target)) {
        return yield* new OrchestrateSessionScopeError({
          reason: "thread-not-found",
          threadId: input.threadId,
        });
      }
      if (target.value.projectId !== projectId) {
        return yield* new OrchestrateSessionScopeError({
          reason: "cross-project",
          threadId: input.threadId,
          projectId,
        });
      }
      const launcher = yield* SessionLauncherService;
      return yield* launcher.resumeSession({
        threadId: input.threadId,
        text: input.text,
        ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
      });
    }),

  orchestrate_create_trigger: (input) =>
    Effect.gen(function* () {
      const { projectId } = yield* resolveCallingProject();
      const engine = yield* OrchestrationEngineService;
      const crypto = yield* Crypto.Crypto;
      const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const triggerId = TriggerId.make(`trigger-${uuid}`);
      const commandId = yield* newCommandId("trigger-create");
      const result = yield* engine.dispatch({
        type: "trigger.create",
        commandId,
        triggerId,
        projectId: ProjectId.make(projectId),
        name: input.name,
        condition: input.condition,
        action: input.action,
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.windowMs === undefined ? {} : { windowMs: input.windowMs }),
        ...(input.delayMs === undefined ? {} : { delayMs: input.delayMs }),
      });
      return { triggerId, sequence: result.sequence };
    }),

  orchestrate_list_triggers: () =>
    Effect.gen(function* () {
      const { projectId } = yield* resolveCallingProject();
      const triggers = yield* ProjectionTriggerRepository;
      return yield* triggers.listByProject({ projectId: ProjectId.make(projectId) });
    }),

  orchestrate_get_trigger: (input) =>
    Effect.gen(function* () {
      const { projectId } = yield* resolveCallingProject();
      const { trigger } = yield* resolveTriggerInProject(input.triggerId, projectId);
      return trigger;
    }),

  orchestrate_enable_trigger: (input) =>
    Effect.gen(function* () {
      const { projectId } = yield* resolveCallingProject();
      const { triggerId } = yield* resolveTriggerInProject(input.triggerId, projectId);
      const engine = yield* OrchestrationEngineService;
      const commandId = yield* newCommandId("trigger-enable");
      return yield* engine.dispatch({ type: "trigger.enable", commandId, triggerId });
    }),

  orchestrate_disable_trigger: (input) =>
    Effect.gen(function* () {
      const { projectId } = yield* resolveCallingProject();
      const { triggerId } = yield* resolveTriggerInProject(input.triggerId, projectId);
      const engine = yield* OrchestrationEngineService;
      const commandId = yield* newCommandId("trigger-disable");
      return yield* engine.dispatch({ type: "trigger.disable", commandId, triggerId });
    }),

  orchestrate_delete_trigger: (input) =>
    Effect.gen(function* () {
      const { projectId } = yield* resolveCallingProject();
      const { triggerId } = yield* resolveTriggerInProject(input.triggerId, projectId);
      const engine = yield* OrchestrationEngineService;
      const commandId = yield* newCommandId("trigger-delete");
      return yield* engine.dispatch({ type: "trigger.delete", commandId, triggerId });
    }),
} satisfies Parameters<typeof OrchestrateToolkit.toLayer>[0];

export const OrchestrateToolkitHandlersLive = OrchestrateToolkit.toLayer(orchestrateHandlers);
