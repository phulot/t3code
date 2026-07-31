import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TriggerId,
  GitCommandError,
  type TriggerCondition,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionTriggerRepositoryLive } from "../../persistence/Layers/ProjectionTriggers.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionTriggerRepository } from "../../persistence/Services/ProjectionTriggers.ts";
import type { ProjectionTrigger } from "../../persistence/Services/ProjectionTriggers.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  SessionLauncherModelSelectionMissingError,
  SessionLauncherService,
  type SessionLauncherShape,
  type StartSessionError,
  type StartSessionSpec,
} from "../Services/SessionLauncher.ts";
import { TriggerSchedulerLive } from "./TriggerScheduler.ts";
import { computeDueTriggers } from "../Services/TriggerScheduler.ts";
import { TriggerScheduler } from "../Services/TriggerScheduler.ts";

// ---------------------------------------------------------------------------
// computeDueTriggers (pure)
// ---------------------------------------------------------------------------

const iso = (ms: number): IsoDateTime =>
  IsoDateTime.make(DateTime.formatIso(DateTime.makeUnsafe(ms)));

const NOW = Date.parse("2026-03-01T12:00:00.000Z");

const intervalCondition = (everyMs: number): TriggerCondition => ({
  kind: "temporal",
  schedule: { kind: "interval", everyMs },
});
const atCondition = (timestamp: number): TriggerCondition => ({
  kind: "temporal",
  schedule: { kind: "at", timestamp },
});

const makeTrigger = (overrides: Partial<ProjectionTrigger>): ProjectionTrigger => ({
  triggerId: TriggerId.make("trigger-x"),
  projectId: ProjectId.make("project-x"),
  name: "Trigger X",
  condition: intervalCondition(60_000),
  action: { kind: "startSession", spec: { text: "run job" } },
  enabled: true,
  consecutiveTransientFailures: NonNegativeInt.make(0),
  lastFiredAt: null,
  lastOutcome: null,
  nextEligibleAt: null,
  conditionTruth: null,
  windowMs: null,
  delayMs: null,
  windowOpenedAt: null,
  fireDueAt: null,
  createdAt: iso(NOW - 1_000_000),
  updatedAt: iso(NOW - 1_000_000),
  ...overrides,
});

describe("computeDueTriggers", () => {
  const cases: ReadonlyArray<{ name: string; trigger: ProjectionTrigger; due: boolean }> = [
    {
      name: "interval never fired is due",
      trigger: makeTrigger({ lastFiredAt: null, nextEligibleAt: null }),
      due: true,
    },
    {
      name: "interval fired within everyMs is not due",
      trigger: makeTrigger({
        condition: intervalCondition(60_000),
        lastFiredAt: iso(NOW - 30_000),
        nextEligibleAt: null,
      }),
      due: false,
    },
    {
      name: "interval elapsed past everyMs is due",
      trigger: makeTrigger({
        condition: intervalCondition(60_000),
        lastFiredAt: iso(NOW - 70_000),
        nextEligibleAt: iso(NOW - 10_000),
      }),
      due: true,
    },
    {
      name: "interval elapsed but anti-rebound window still open is not due",
      trigger: makeTrigger({
        condition: intervalCondition(60_000),
        lastFiredAt: iso(NOW - 70_000),
        nextEligibleAt: iso(NOW + 10_000),
      }),
      due: false,
    },
    {
      name: "at whose timestamp has passed and never fired is due",
      trigger: makeTrigger({
        condition: atCondition(NOW - 1_000),
        lastFiredAt: null,
        nextEligibleAt: null,
      }),
      due: true,
    },
    {
      name: "at whose timestamp is in the future is not due",
      trigger: makeTrigger({
        condition: atCondition(NOW + 1_000),
        lastFiredAt: null,
        nextEligibleAt: null,
      }),
      due: false,
    },
    {
      name: "at already fired is never due again",
      trigger: makeTrigger({
        condition: atCondition(NOW - 1_000),
        lastFiredAt: iso(NOW - 500),
        nextEligibleAt: iso(NOW - 500 + 60_000),
      }),
      due: false,
    },
    {
      name: "disabled trigger is ignored even when otherwise due",
      trigger: makeTrigger({ enabled: false, lastFiredAt: null, nextEligibleAt: null }),
      due: false,
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const due = computeDueTriggers([testCase.trigger], NOW);
      expect(due.length).toBe(testCase.due ? 1 : 0);
    });
  }

  it("returns only the due subset from a mixed list", () => {
    const dueTrigger = makeTrigger({
      triggerId: TriggerId.make("due"),
      lastFiredAt: null,
      nextEligibleAt: null,
    });
    const notDue = makeTrigger({
      triggerId: TriggerId.make("not-due"),
      lastFiredAt: iso(NOW - 1_000),
      nextEligibleAt: iso(NOW + 60_000),
    });
    const result = computeDueTriggers([dueTrigger, notDue], NOW);
    expect(result.map((trigger) => trigger.triggerId)).toEqual(["due"]);
  });
});

// ---------------------------------------------------------------------------
// runTick (single tick, real engine + projection, stubbed launcher)
// ---------------------------------------------------------------------------

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};

const createdAt = "2026-03-01T00:00:00.000Z";

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
    prefix: "t3-trigger-scheduler-test-",
  });

  const infra = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
    ProjectionTriggerRepositoryLive,
    ProjectionProjectRepositoryLive,
  ).pipe(
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );

  const schedulerLayer = TriggerSchedulerLive.pipe(
    Layer.provide(launcher.layer),
    Layer.provideMerge(infra),
  );

  const runtime = ManagedRuntime.make(schedulerLayer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const scheduler = await runtime.runPromise(Effect.service(TriggerScheduler));
  const triggers = await runtime.runPromise(Effect.service(ProjectionTriggerRepository));
  return {
    engine,
    scheduler,
    triggers,
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

type System = Awaited<ReturnType<typeof createSystem>>;

const seedProjectAndTrigger = async (system: System, projectId: string, triggerId: string) => {
  await system.run(
    system.engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`cmd-project-${projectId}`),
      projectId: ProjectId.make(projectId),
      title: "Scheduler Project",
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
      name: "Nightly",
      condition: intervalCondition(60_000),
      action: { kind: "startSession", spec: { text: "run the nightly job" } },
      enabled: true,
    }),
  );
};

const readTrigger = (system: System, triggerId: string) =>
  system
    .run(system.triggers.getById({ triggerId: TriggerId.make(triggerId) }))
    .then((option) => Option.getOrThrow(option));

describe("TriggerScheduler.runTick", () => {
  it("fires a due trigger, launches the session, and settles as succeeded", async () => {
    const launcher = makeLauncherStub(() =>
      Effect.succeed({ threadId: "thread-launched", sequence: 42 }),
    );
    const system = await createSystem(launcher);
    try {
      await seedProjectAndTrigger(system, "project-success", "trigger-success");

      await system.run(system.scheduler.runTick(NOW));

      expect(launcher.calls.length).toBe(1);
      expect(launcher.calls[0]?.projectId).toBe("project-success");
      expect(launcher.calls[0]?.text).toBe("run the nightly job");

      const trigger = await readTrigger(system, "trigger-success");
      expect(trigger.lastFiredAt).not.toBeNull();
      expect(trigger.nextEligibleAt).not.toBeNull();
      expect(trigger.lastOutcome).toEqual({ status: "succeeded", threadId: "thread-launched" });
      expect(trigger.consecutiveTransientFailures).toBe(0);
    } finally {
      await system.dispose();
    }
  });

  it("settles as permanent failure when the launcher raises a permanent error", async () => {
    const launcher = makeLauncherStub(() =>
      Effect.fail(
        new SessionLauncherModelSelectionMissingError({ projectId: "project-permanent" }),
      ),
    );
    const system = await createSystem(launcher);
    try {
      await seedProjectAndTrigger(system, "project-permanent", "trigger-permanent");

      await system.run(system.scheduler.runTick(NOW));

      const trigger = await readTrigger(system, "trigger-permanent");
      expect(trigger.lastOutcome?.status).toBe("failed");
      expect(
        trigger.lastOutcome?.status === "failed" ? trigger.lastOutcome.failureKind : null,
      ).toBe("permanent");
      // A permanent failure does not increment the transient streak.
      expect(trigger.consecutiveTransientFailures).toBe(0);
    } finally {
      await system.dispose();
    }
  });

  it("settles as transient failure when the launcher raises a retryable error", async () => {
    const launcher = makeLauncherStub(() =>
      Effect.fail(
        new GitCommandError({
          operation: "createWorktree",
          command: "git worktree add",
          cwd: "/tmp/project-transient",
          detail: "network blip",
        }),
      ),
    );
    const system = await createSystem(launcher);
    try {
      await seedProjectAndTrigger(system, "project-transient", "trigger-transient");

      await system.run(system.scheduler.runTick(NOW));

      const trigger = await readTrigger(system, "trigger-transient");
      expect(trigger.lastOutcome?.status).toBe("failed");
      expect(
        trigger.lastOutcome?.status === "failed" ? trigger.lastOutcome.failureKind : null,
      ).toBe("transient");
      // A transient failure increments the streak the decider tracks.
      expect(trigger.consecutiveTransientFailures).toBe(1);
    } finally {
      await system.dispose();
    }
  });

  it("does not fire a trigger blocked by the anti-rebound window on a second tick", async () => {
    const launcher = makeLauncherStub(() =>
      Effect.succeed({ threadId: "thread-once", sequence: 1 }),
    );
    const system = await createSystem(launcher);
    try {
      await seedProjectAndTrigger(system, "project-rebound", "trigger-rebound");

      // First tick fires and arms the +60s anti-rebound window.
      await system.run(system.scheduler.runTick(NOW));
      expect(launcher.calls.length).toBe(1);

      // Second tick 5s later: still inside the anti-rebound window -> no fire.
      await system.run(system.scheduler.runTick(NOW + 5_000));
      expect(launcher.calls.length).toBe(1);
    } finally {
      await system.dispose();
    }
  });
});
