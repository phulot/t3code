import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationCommand,
  type OrchestrationShellSnapshot,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TriggerId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SessionLauncherService } from "../../../orchestration/Services/SessionLauncher.ts";
import { ProjectionThreadRepository } from "../../../persistence/Services/ProjectionThreads.ts";
import {
  type ProjectionTrigger,
  ProjectionTriggerRepository,
} from "../../../persistence/Services/ProjectionTriggers.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import type { McpCapability, McpInvocationScope } from "../../McpInvocationContext.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { orchestrateHandlers } from "./handlers.ts";

const callingThreadId = ThreadId.make("thread-1");
const callingProjectId = ProjectId.make("project-1");

// Deterministic Crypto for id generation; a fixed byte pattern is enough for
// tests that only assert the id is forged and threaded through.
const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(1),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const triggerFixture = (
  overrides: Partial<ProjectionTrigger> & Pick<ProjectionTrigger, "triggerId" | "projectId">,
): ProjectionTrigger =>
  ({
    name: "nightly",
    condition: { kind: "temporal", schedule: { kind: "interval", everyMs: 3_600_000 } },
    action: { kind: "startSession", spec: { text: "go" } },
    enabled: true,
    consecutiveTransientFailures: 0,
    lastFiredAt: null,
    lastOutcome: null,
    nextEligibleAt: null,
    conditionTruth: null,
    windowMs: null,
    delayMs: null,
    windowOpenedAt: null,
    fireDueAt: null,
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
    ...overrides,
  }) as ProjectionTrigger;

const scopeOf = (capabilities: readonly McpCapability[]): McpInvocationScope => ({
  environmentId: EnvironmentId.make("env-1"),
  threadId: callingThreadId,
  providerSessionId: "session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 0,
});

const shellSnapshot: OrchestrationShellSnapshot = {
  snapshotSequence: 1,
  updatedAt: "1970-01-01T00:00:00.000Z",
  projects: [
    { id: callingProjectId, title: "Project 1", workspaceRoot: "/tmp/project-1" },
    { id: ProjectId.make("project-2"), title: "Project 2", workspaceRoot: "/tmp/project-2" },
  ],
  threads: [
    { id: ThreadId.make("thread-1"), projectId: callingProjectId, title: "T1" },
    { id: ThreadId.make("thread-2"), projectId: callingProjectId, title: "T2" },
    { id: ThreadId.make("thread-3"), projectId: ProjectId.make("project-2"), title: "T3" },
  ],
} as unknown as OrchestrationShellSnapshot;

const dependenciesLayer = Layer.mergeAll(
  Layer.succeed(
    ProjectionThreadRepository,
    ProjectionThreadRepository.of({
      upsert: () => Effect.void,
      getById: () => Effect.succeed(Option.some({ projectId: callingProjectId } as never)),
      listByProjectId: () => Effect.succeed([]),
      deleteById: () => Effect.void,
    }),
  ),
  Layer.succeed(
    ProjectionSnapshotQuery,
    ProjectionSnapshotQuery.of({
      getShellSnapshot: () => Effect.succeed(shellSnapshot),
    } as never),
  ),
  Layer.succeed(SessionLauncherService, SessionLauncherService.of({} as never)),
  Layer.succeed(ProviderRegistry, ProviderRegistry.of({} as never)),
);

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | McpInvocationContext.McpInvocationContext
    | ProjectionThreadRepository
    | ProjectionSnapshotQuery
    | SessionLauncherService
    | ProviderRegistry
  >,
  capabilities: readonly McpCapability[],
) =>
  effect.pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, scopeOf(capabilities)),
    Effect.provide(dependenciesLayer),
  );

it.effect("orchestrate_list_sessions fails without the orchestrate capability", () =>
  Effect.gen(function* () {
    const error = yield* run(orchestrateHandlers.orchestrate_list_sessions(), ["preview"]).pipe(
      Effect.flip,
    );
    expect((error as { _tag: string })._tag).toBe("PreviewAutomationUnavailableError");
  }),
);

it.effect("orchestrate_list_sessions returns the calling project's threads", () =>
  Effect.gen(function* () {
    const result = yield* run(orchestrateHandlers.orchestrate_list_sessions(), [
      "preview",
      "orchestrate",
    ]);
    expect(result.project.id).toBe(callingProjectId);
    expect(result.threads.map((thread) => thread.id)).toEqual([
      ThreadId.make("thread-1"),
      ThreadId.make("thread-2"),
    ]);
  }),
);

// ---------------------------------------------------------------------------
// trigger CRUD tools
// ---------------------------------------------------------------------------

type TriggerHandlerContext =
  | McpInvocationContext.McpInvocationContext
  | ProjectionThreadRepository
  | ProjectionSnapshotQuery
  | SessionLauncherService
  | ProviderRegistry
  | ProjectionTriggerRepository
  | OrchestrationEngineService
  | Crypto.Crypto;

const triggerRepoLayer = (triggers: readonly ProjectionTrigger[]) =>
  Layer.succeed(
    ProjectionTriggerRepository,
    ProjectionTriggerRepository.of({
      getById: (input: { readonly triggerId: TriggerId }) => {
        const found = triggers.find((trigger) => trigger.triggerId === input.triggerId);
        return Effect.succeed(found === undefined ? Option.none() : Option.some(found));
      },
      listByProject: (input: { readonly projectId: ProjectId }) =>
        Effect.succeed(triggers.filter((trigger) => trigger.projectId === input.projectId)),
    } as never),
  );

const engineLayer = (dispatched: Ref.Ref<ReadonlyArray<OrchestrationCommand>>) =>
  Layer.succeed(
    OrchestrationEngineService,
    OrchestrationEngineService.of({
      readEvents: () => Stream.empty,
      dispatch: (command: OrchestrationCommand) =>
        Ref.update(dispatched, (all) => [...all, command]).pipe(Effect.as({ sequence: 42 })),
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    } as never),
  );

const runTrigger = <A, E>(
  effect: Effect.Effect<A, E, TriggerHandlerContext>,
  options: {
    readonly capabilities: readonly McpCapability[];
    readonly triggers: readonly ProjectionTrigger[];
    readonly dispatched: Ref.Ref<ReadonlyArray<OrchestrationCommand>>;
  },
) =>
  effect.pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, scopeOf(options.capabilities)),
    Effect.provide(
      Layer.mergeAll(
        dependenciesLayer,
        triggerRepoLayer(options.triggers),
        engineLayer(options.dispatched),
        Layer.succeed(Crypto.Crypto, testCrypto),
      ),
    ),
  );

it.effect("orchestrate_create_trigger dispatches trigger.create for the calling project", () =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const result = yield* runTrigger(
      orchestrateHandlers.orchestrate_create_trigger({
        name: "nightly",
        condition: { kind: "temporal", schedule: { kind: "interval", everyMs: 3_600_000 } },
        action: { kind: "startSession", spec: { text: "go" } },
      }),
      { capabilities: ["orchestrate"], triggers: [], dispatched },
    );
    expect(result.sequence).toBe(42);
    const commands = yield* Ref.get(dispatched);
    expect(commands).toHaveLength(1);
    const command = commands[0] as Extract<OrchestrationCommand, { type: "trigger.create" }>;
    expect(command.type).toBe("trigger.create");
    expect(command.projectId).toBe(callingProjectId);
    expect(command.triggerId).toBe(result.triggerId);
  }),
);

it.effect("orchestrate_get_trigger refuses a trigger from another project", () =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const foreign = triggerFixture({
      triggerId: TriggerId.make("trigger-x"),
      projectId: ProjectId.make("project-2"),
    });
    const error = yield* runTrigger(
      orchestrateHandlers.orchestrate_get_trigger({ triggerId: "trigger-x" }),
      { capabilities: ["orchestrate"], triggers: [foreign], dispatched },
    ).pipe(Effect.flip);
    expect((error as { _tag: string })._tag).toBe("OrchestrateTriggerScopeError");
    expect((error as { reason?: string }).reason).toBe("cross-project");
  }),
);

it.effect("orchestrate_get_trigger returns a trigger of the calling project", () =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const own = triggerFixture({
      triggerId: TriggerId.make("trigger-own"),
      projectId: callingProjectId,
    });
    const result = yield* runTrigger(
      orchestrateHandlers.orchestrate_get_trigger({ triggerId: "trigger-own" }),
      { capabilities: ["orchestrate"], triggers: [own], dispatched },
    );
    expect(result.triggerId).toBe(TriggerId.make("trigger-own"));
  }),
);

it.effect("orchestrate_enable_trigger dispatches trigger.enable for an owned trigger", () =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const own = triggerFixture({
      triggerId: TriggerId.make("trigger-own"),
      projectId: callingProjectId,
      enabled: false,
    });
    const result = yield* runTrigger(
      orchestrateHandlers.orchestrate_enable_trigger({ triggerId: "trigger-own" }),
      { capabilities: ["orchestrate"], triggers: [own], dispatched },
    );
    expect(result.sequence).toBe(42);
    const commands = yield* Ref.get(dispatched);
    const command = commands[0] as Extract<OrchestrationCommand, { type: "trigger.enable" }>;
    expect(command.type).toBe("trigger.enable");
    expect(command.triggerId).toBe(TriggerId.make("trigger-own"));
  }),
);

it.effect("orchestrate_delete_trigger refuses a trigger from another project", () =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const foreign = triggerFixture({
      triggerId: TriggerId.make("trigger-x"),
      projectId: ProjectId.make("project-2"),
    });
    const error = yield* runTrigger(
      orchestrateHandlers.orchestrate_delete_trigger({ triggerId: "trigger-x" }),
      { capabilities: ["orchestrate"], triggers: [foreign], dispatched },
    ).pipe(Effect.flip);
    expect((error as { _tag: string })._tag).toBe("OrchestrateTriggerScopeError");
    const commands = yield* Ref.get(dispatched);
    expect(commands).toHaveLength(0);
  }),
);
