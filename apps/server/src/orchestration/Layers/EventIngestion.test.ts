import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  TriggerId,
  type TriggerCondition,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { describe, expect, it } from "vite-plus/test";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ExternalEventJournalLive } from "../../persistence/Layers/ExternalEventJournal.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionTriggerRepositoryLive } from "../../persistence/Layers/ProjectionTriggers.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import type { ExternalEventFact } from "../../persistence/Services/ExternalEventJournal.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ServerConfig } from "../../config.ts";
import { EventIngestion } from "../Services/EventIngestion.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  SessionLauncherService,
  type SessionLauncherShape,
  type StartSessionError,
  type StartSessionSpec,
} from "../Services/SessionLauncher.ts";
import { EventIngestionLive } from "./EventIngestion.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};

const createdAt = "2026-03-01T00:00:00.000Z";

const prMergedCondition = (params: Record<string, unknown>): TriggerCondition => ({
  kind: "atom",
  atom: { domain: "git", type: "pr.merged", params },
});

const fact = (overrides?: Partial<ExternalEventFact>): ExternalEventFact => ({
  source: "github",
  domain: "git",
  type: "pr.merged",
  params: { repo: "octo/repo", pr: 42, branch: "feature/x" },
  deliveryKey: "delivery-1",
  ...overrides,
});

type LauncherStub = {
  readonly layer: Layer.Layer<SessionLauncherService>;
  readonly calls: StartSessionSpec[];
};

const makeLauncherStub = (
  startSession: (
    spec: StartSessionSpec,
  ) => Effect.Effect<{ readonly threadId: string; readonly sequence: number }, StartSessionError>,
): LauncherStub => {
  const calls: StartSessionSpec[] = [];
  const layer = Layer.succeed(SessionLauncherService, {
    startSession: (spec: StartSessionSpec) => {
      calls.push(spec);
      return startSession(spec);
    },
    resumeSession: () => Effect.die("resumeSession is not available in test"),
  } as SessionLauncherShape);
  return { layer, calls };
};

async function createSystem(launcher: LauncherStub) {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-event-ingestion-test-",
  });

  const infra = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
    ProjectionTriggerRepositoryLive,
    ProjectionProjectRepositoryLive,
    ExternalEventJournalLive,
  ).pipe(
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );

  const ingestionLayer = EventIngestionLive.pipe(
    Layer.provide(launcher.layer),
    Layer.provideMerge(infra),
  );

  const runtime = ManagedRuntime.make(ingestionLayer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const ingestion = await runtime.runPromise(Effect.service(EventIngestion));
  return {
    engine,
    ingestion,
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

type System = Awaited<ReturnType<typeof createSystem>>;

const seedProjectAndTrigger = async (
  system: System,
  projectId: string,
  triggerId: string,
  condition: TriggerCondition,
  enabled = true,
) => {
  await system.run(
    system.engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`cmd-project-${projectId}`),
      projectId: ProjectId.make(projectId),
      title: "Ingestion Project",
      workspaceRoot: `/tmp/${projectId}`,
      defaultModelSelection: modelSelection,
      createdAt,
    }),
  );
  await system.run(
    system.engine.dispatch({
      type: "trigger.create",
      commandId: CommandId.make(`cmd-trigger-${triggerId}`),
      triggerId: TriggerId.make(triggerId),
      projectId: ProjectId.make(projectId),
      name: "On PR merge",
      condition,
      action: { kind: "startSession", spec: { text: "run on merge" } },
      enabled,
    }),
  );
};

describe("EventIngestion.ingest", () => {
  it("fires a matching active transient-atom trigger on a fresh fact", async () => {
    const launcher = makeLauncherStub(() =>
      Effect.succeed({ threadId: "thread-merge", sequence: 7 }),
    );
    const system = await createSystem(launcher);
    try {
      await seedProjectAndTrigger(
        system,
        "project-fire",
        "trigger-fire",
        prMergedCondition({ repo: "octo/repo", pr: 42 }),
      );

      const result = await system.run(system.ingestion.ingest(fact()));

      expect(result).toEqual({ inserted: true, fired: 1 });
      expect(launcher.calls.length).toBe(1);
    } finally {
      await system.dispose();
    }
  });

  it("does not fire when the fact matches no trigger", async () => {
    const launcher = makeLauncherStub(() =>
      Effect.succeed({ threadId: "thread-merge", sequence: 7 }),
    );
    const system = await createSystem(launcher);
    try {
      await seedProjectAndTrigger(
        system,
        "project-nomatch",
        "trigger-nomatch",
        prMergedCondition({ repo: "octo/repo", pr: 999 }),
      );

      const result = await system.run(system.ingestion.ingest(fact()));

      expect(result).toEqual({ inserted: true, fired: 0 });
      expect(launcher.calls.length).toBe(0);
    } finally {
      await system.dispose();
    }
  });

  it("ignores a disabled trigger", async () => {
    const launcher = makeLauncherStub(() =>
      Effect.succeed({ threadId: "thread-merge", sequence: 7 }),
    );
    const system = await createSystem(launcher);
    try {
      await seedProjectAndTrigger(
        system,
        "project-disabled",
        "trigger-disabled",
        prMergedCondition({ repo: "octo/repo", pr: 42 }),
        false,
      );

      const result = await system.run(system.ingestion.ingest(fact()));

      expect(result).toEqual({ inserted: true, fired: 0 });
      expect(launcher.calls.length).toBe(0);
    } finally {
      await system.dispose();
    }
  });

  it("does not fire twice for a duplicate delivery", async () => {
    const launcher = makeLauncherStub(() =>
      Effect.succeed({ threadId: "thread-merge", sequence: 7 }),
    );
    const system = await createSystem(launcher);
    try {
      await seedProjectAndTrigger(
        system,
        "project-dedup",
        "trigger-dedup",
        prMergedCondition({ repo: "octo/repo", branch: "feature/x" }),
      );

      const first = await system.run(system.ingestion.ingest(fact()));
      const second = await system.run(system.ingestion.ingest(fact()));

      expect(first).toEqual({ inserted: true, fired: 1 });
      expect(second).toEqual({ inserted: false, fired: 0 });
      expect(launcher.calls.length).toBe(1);
    } finally {
      await system.dispose();
    }
  });
});
