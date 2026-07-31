import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  TriggerId,
  type AtomRef,
  type TriggerCondition,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { ExternalEventJournalLive } from "../../persistence/Layers/ExternalEventJournal.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionTriggerRepositoryLive } from "../../persistence/Layers/ProjectionTriggers.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ExternalEventJournal } from "../../persistence/Services/ExternalEventJournal.ts";
import { ProjectionTriggerRepository } from "../../persistence/Services/ProjectionTriggers.ts";
import type { ProjectionTrigger } from "../../persistence/Services/ProjectionTriggers.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ServerConfig } from "../../config.ts";
import { AtomDomainRegistry } from "../Services/AtomDomainRegistry.ts";
import { ConditionEvaluator } from "../Services/ConditionEvaluator.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  SessionLauncherService,
  type SessionLauncherShape,
  type StartSessionError,
  type StartSessionSpec,
} from "../Services/SessionLauncher.ts";
import { ConditionEvaluatorLive } from "./ConditionEvaluator.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};

const createdAt = "2026-03-01T00:00:00.000Z";
const NOW = Date.parse("2026-03-01T12:00:00.000Z");

const atom: AtomRef = {
  domain: "git",
  type: "ref.merged",
  params: { worktreePath: "/tmp/repo", ref: "feature", base: "main" },
};
const atomCondition: TriggerCondition = { kind: "atom", atom };

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

// A stubbed atom registry: no real git. `truth` is mutable so a test can flip
// the observed world between ticks. Every catalogued atom here is a STATE atom.
type RegistryStub = {
  readonly layer: Layer.Layer<AtomDomainRegistry>;
  truth: boolean;
};

const makeRegistryStub = (initialTruth: boolean): RegistryStub => {
  const stub = { truth: initialTruth } as RegistryStub;
  const layer = Layer.succeed(AtomDomainRegistry, {
    validate: () => Effect.void,
    natureOf: () => Effect.succeed("state" as const),
    evaluate: () => Effect.sync(() => stub.truth),
  });
  return Object.assign(stub, { layer });
};

// A richer registry stub for composite tests. `pr.merged` is TRANSIENT (never
// evaluated, matched against the journal); everything else is a STATE atom whose
// truth is looked up per identity from a mutable map keyed by `type:ref`.
type FlexibleRegistryStub = {
  readonly layer: Layer.Layer<AtomDomainRegistry>;
  readonly stateTruth: Map<string, boolean>;
};

const stateKey = (atom: AtomRef): string =>
  `${atom.type}:${String((atom.params as { ref?: unknown }).ref ?? "")}`;

const makeFlexibleRegistryStub = (): FlexibleRegistryStub => {
  const stateTruth = new Map<string, boolean>();
  const layer = Layer.succeed(AtomDomainRegistry, {
    validate: () => Effect.void,
    natureOf: (atom: AtomRef) =>
      Effect.succeed(atom.type === "pr.merged" ? ("transient" as const) : ("state" as const)),
    evaluate: (atom: AtomRef) => Effect.sync(() => stateTruth.get(stateKey(atom)) ?? false),
  });
  return { layer, stateTruth };
};

async function createSystem(
  launcher: LauncherStub,
  registry: { readonly layer: Layer.Layer<AtomDomainRegistry> },
) {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-condition-evaluator-test-",
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

  const evaluatorLayer = ConditionEvaluatorLive.pipe(
    Layer.provide(Layer.merge(launcher.layer, registry.layer)),
    Layer.provideMerge(infra),
  );

  const runtime = ManagedRuntime.make(evaluatorLayer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const evaluator = await runtime.runPromise(Effect.service(ConditionEvaluator));
  const triggers = await runtime.runPromise(Effect.service(ProjectionTriggerRepository));
  const journal = await runtime.runPromise(Effect.service(ExternalEventJournal));
  return {
    engine,
    evaluator,
    triggers,
    journal,
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
      title: "Evaluator Project",
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
      name: "On merge",
      condition: atomCondition,
      action: { kind: "startSession", spec: { text: "run on merge" } },
      enabled: true,
    }),
  );
};

const readTrigger = (system: System, triggerId: string): Promise<ProjectionTrigger> =>
  system
    .run(system.triggers.getById({ triggerId: TriggerId.make(triggerId) }))
    .then((option) => Option.getOrThrow(option));

const seedProject = (system: System, projectId: string) =>
  system.run(
    system.engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`cmd-project-${projectId}`),
      projectId: ProjectId.make(projectId),
      title: "Evaluator Project",
      workspaceRoot: `/tmp/${projectId}`,
      defaultModelSelection: modelSelection,
      createdAt,
    }),
  );

describe("trigger.create atom condition validation", () => {
  it("accepts a well-formed known atom condition", async () => {
    const launcher = makeLauncherStub(() => Effect.succeed({ threadId: "t", sequence: 1 }));
    const system = await createSystem(launcher, makeRegistryStub(false));
    try {
      await seedProject(system, "project-valid");
      const exit = await system.run(
        Effect.exit(
          system.engine.dispatch({
            type: "trigger.create",
            commandId: CommandId.make("cmd-valid"),
            triggerId: TriggerId.make("trigger-valid"),
            projectId: ProjectId.make("project-valid"),
            name: "On merge",
            condition: atomCondition,
            action: { kind: "startSession", spec: { text: "go" } },
            enabled: true,
          }),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    } finally {
      await system.dispose();
    }
  });

  it("rejects an unknown atom type", async () => {
    const launcher = makeLauncherStub(() => Effect.succeed({ threadId: "t", sequence: 1 }));
    const system = await createSystem(launcher, makeRegistryStub(false));
    try {
      await seedProject(system, "project-unknown");
      const exit = await system.run(
        Effect.exit(
          system.engine.dispatch({
            type: "trigger.create",
            commandId: CommandId.make("cmd-unknown"),
            triggerId: TriggerId.make("trigger-unknown"),
            projectId: ProjectId.make("project-unknown"),
            name: "Bogus",
            condition: {
              kind: "atom",
              atom: { domain: "git", type: "does.not.exist", params: {} },
            },
            action: { kind: "startSession", spec: { text: "go" } },
            enabled: true,
          }),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      // No trigger row was created.
      const stored = await system.run(
        system.triggers.getById({ triggerId: TriggerId.make("trigger-unknown") }),
      );
      expect(Option.isNone(stored)).toBe(true);
    } finally {
      await system.dispose();
    }
  });

  it("rejects a known atom with invalid params", async () => {
    const launcher = makeLauncherStub(() => Effect.succeed({ threadId: "t", sequence: 1 }));
    const system = await createSystem(launcher, makeRegistryStub(false));
    try {
      await seedProject(system, "project-badparams");
      const exit = await system.run(
        Effect.exit(
          system.engine.dispatch({
            type: "trigger.create",
            commandId: CommandId.make("cmd-badparams"),
            triggerId: TriggerId.make("trigger-badparams"),
            projectId: ProjectId.make("project-badparams"),
            name: "Bad params",
            condition: {
              kind: "atom",
              // `base` is missing -> fails the git/ref.merged params schema.
              atom: { domain: "git", type: "ref.merged", params: { worktreePath: "/x", ref: "f" } },
            },
            action: { kind: "startSession", spec: { text: "go" } },
            enabled: true,
          }),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    } finally {
      await system.dispose();
    }
  });
});

describe("ConditionEvaluator.runTick", () => {
  it("catch-up: fires a trigger whose atom is already true at creation", async () => {
    const launcher = makeLauncherStub(() =>
      Effect.succeed({ threadId: "thread-merge", sequence: 7 }),
    );
    const registry = makeRegistryStub(true);
    const system = await createSystem(launcher, registry);
    try {
      await seedProjectAndTrigger(system, "project-catchup", "trigger-catchup");

      await system.run(system.evaluator.runTick(NOW));

      expect(launcher.calls.length).toBe(1);
      const trigger = await readTrigger(system, "trigger-catchup");
      expect(trigger.conditionTruth).toBe(true);
      expect(trigger.lastFiredAt).not.toBeNull();
      expect(trigger.nextEligibleAt).not.toBeNull();
      expect(trigger.lastOutcome).toEqual({ status: "succeeded", threadId: "thread-merge" });
    } finally {
      await system.dispose();
    }
  });

  it("does not re-fire while the atom stays true across ticks", async () => {
    const launcher = makeLauncherStub(() =>
      Effect.succeed({ threadId: "thread-merge", sequence: 7 }),
    );
    const registry = makeRegistryStub(true);
    const system = await createSystem(launcher, registry);
    try {
      await seedProjectAndTrigger(system, "project-steady", "trigger-steady");

      await system.run(system.evaluator.runTick(NOW));
      await system.run(system.evaluator.runTick(NOW + 120_000));

      expect(launcher.calls.length).toBe(1);
    } finally {
      await system.dispose();
    }
  });

  it("fires on a false -> true transition, not while false", async () => {
    const launcher = makeLauncherStub(() =>
      Effect.succeed({ threadId: "thread-merge", sequence: 7 }),
    );
    const registry = makeRegistryStub(false);
    const system = await createSystem(launcher, registry);
    try {
      await seedProjectAndTrigger(system, "project-edge", "trigger-edge");

      // Tick 1: atom false -> no fire, truth persisted false.
      await system.run(system.evaluator.runTick(NOW));
      expect(launcher.calls.length).toBe(0);
      let trigger = await readTrigger(system, "trigger-edge");
      expect(trigger.conditionTruth).toBe(false);

      // Tick 2: atom becomes true -> rising edge fires.
      registry.truth = true;
      await system.run(system.evaluator.runTick(NOW + 120_000));
      expect(launcher.calls.length).toBe(1);
      trigger = await readTrigger(system, "trigger-edge");
      expect(trigger.conditionTruth).toBe(true);
      expect(trigger.lastFiredAt).not.toBeNull();
    } finally {
      await system.dispose();
    }
  });

  it("re-fires after the atom returns to false and rises again (past anti-rebound)", async () => {
    const launcher = makeLauncherStub(() =>
      Effect.succeed({ threadId: "thread-merge", sequence: 7 }),
    );
    const registry = makeRegistryStub(true);
    const system = await createSystem(launcher, registry);
    try {
      await seedProjectAndTrigger(system, "project-recur", "trigger-recur");

      // Tick 1: catch-up fire (null -> true).
      await system.run(system.evaluator.runTick(NOW));
      expect(launcher.calls.length).toBe(1);

      // Tick 2: atom drops to false -> reset persisted, no fire.
      registry.truth = false;
      await system.run(system.evaluator.runTick(NOW + 120_000));
      expect(launcher.calls.length).toBe(1);
      expect((await readTrigger(system, "trigger-recur")).conditionTruth).toBe(false);

      // Tick 3: atom rises again, well past the 60s anti-rebound -> fires again.
      registry.truth = true;
      await system.run(system.evaluator.runTick(NOW + 240_000));
      expect(launcher.calls.length).toBe(2);
    } finally {
      await system.dispose();
    }
  });
});

// --- Composite conditions (Étape 4) -----------------------------------------

const stateAtomA: AtomRef = {
  domain: "git",
  type: "ref.merged",
  params: { worktreePath: "/tmp/repo", ref: "a", base: "main" },
};
const stateAtomB: AtomRef = {
  domain: "git",
  type: "ref.merged",
  params: { worktreePath: "/tmp/repo", ref: "b", base: "main" },
};
const transientAtom: AtomRef = {
  domain: "git",
  type: "pr.merged",
  params: { repo: "octo/repo", pr: 42 },
};

const createCompositeTrigger = (
  system: System,
  projectId: string,
  triggerId: string,
  condition: TriggerCondition,
  bounds?: { readonly windowMs?: number; readonly delayMs?: number },
) =>
  system.run(
    system.engine.dispatch({
      type: "trigger.create",
      commandId: CommandId.make(`cmd-trigger-${triggerId}`),
      triggerId: TriggerId.make(triggerId),
      projectId: ProjectId.make(projectId),
      name: "Composite",
      condition,
      action: { kind: "startSession", spec: { text: "run composite" } },
      enabled: true,
      ...(bounds?.windowMs !== undefined ? { windowMs: bounds.windowMs } : {}),
      ...(bounds?.delayMs !== undefined ? { delayMs: bounds.delayMs } : {}),
    }),
  );

describe("ConditionEvaluator composite conditions", () => {
  it("AND(state, transient): completes inside the window and fires", async () => {
    const launcher = makeLauncherStub(() => Effect.succeed({ threadId: "thread-c", sequence: 1 }));
    const registry = makeFlexibleRegistryStub();
    registry.stateTruth.set("ref.merged:a", true);
    const system = await createSystem(launcher, registry);
    try {
      await seedProject(system, "project-and");
      await createCompositeTrigger(
        system,
        "project-and",
        "trigger-and",
        {
          kind: "and",
          conditions: [
            { kind: "atom", atom: stateAtomA },
            { kind: "atom", atom: transientAtom },
          ],
        },
        { windowMs: 600_000 },
      );

      // Tick 1: state true opens the window; transient not yet journalled.
      await system.run(system.evaluator.runTick(NOW));
      expect(launcher.calls.length).toBe(0);
      const opened = await readTrigger(system, "trigger-and");
      expect(opened.windowOpenedAt).toBe(NOW);
      expect(opened.conditionTruth).toBe(false);

      // A matching PR-merged fact lands.
      await system.run(
        system.journal.record({
          source: "github",
          domain: "git",
          type: "pr.merged",
          params: { repo: "octo/repo", pr: 42, branch: "feature" },
          deliveryKey: "delivery-and-1",
        }),
      );

      // Tick 2 (inside the window): both leaves satisfied -> fires.
      await system.run(system.evaluator.runTick(NOW + 1_000));
      expect(launcher.calls.length).toBe(1);
      const fired = await readTrigger(system, "trigger-and");
      expect(fired.conditionTruth).toBe(true);
      expect(fired.windowOpenedAt).toBeNull();
      expect(fired.lastFiredAt).not.toBeNull();
    } finally {
      await system.dispose();
    }
  });

  it("AND(state, transient): purges without firing when the window expires", async () => {
    const launcher = makeLauncherStub(() => Effect.succeed({ threadId: "thread-c", sequence: 1 }));
    const registry = makeFlexibleRegistryStub();
    registry.stateTruth.set("ref.merged:a", true);
    const system = await createSystem(launcher, registry);
    try {
      await seedProject(system, "project-expire");
      await createCompositeTrigger(
        system,
        "project-expire",
        "trigger-expire",
        {
          kind: "and",
          conditions: [
            { kind: "atom", atom: stateAtomA },
            { kind: "atom", atom: transientAtom },
          ],
        },
        { windowMs: 5_000 },
      );

      // Tick 1: window opens at NOW.
      await system.run(system.evaluator.runTick(NOW));
      expect((await readTrigger(system, "trigger-expire")).windowOpenedAt).toBe(NOW);

      // Tick 2, past the window, still no matching fact -> purge, no fire.
      await system.run(system.evaluator.runTick(NOW + 6_000));
      expect(launcher.calls.length).toBe(0);
      expect((await readTrigger(system, "trigger-expire")).windowOpenedAt).toBeNull();
    } finally {
      await system.dispose();
    }
  });

  it("AND(state, state) with a delay: fires only once the delay elapses", async () => {
    const launcher = makeLauncherStub(() => Effect.succeed({ threadId: "thread-c", sequence: 1 }));
    const registry = makeFlexibleRegistryStub();
    registry.stateTruth.set("ref.merged:a", true);
    registry.stateTruth.set("ref.merged:b", true);
    const system = await createSystem(launcher, registry);
    try {
      await seedProject(system, "project-delay");
      await createCompositeTrigger(
        system,
        "project-delay",
        "trigger-delay",
        {
          kind: "and",
          conditions: [
            { kind: "atom", atom: stateAtomA },
            { kind: "atom", atom: stateAtomB },
          ],
        },
        { delayMs: 30_000 },
      );

      // Tick 1: fully satisfied -> arms the delay, does not fire.
      await system.run(system.evaluator.runTick(NOW));
      expect(launcher.calls.length).toBe(0);
      const armed = await readTrigger(system, "trigger-delay");
      expect(armed.fireDueAt).toBe(NOW + 30_000);

      // Tick 2: before the deadline -> still no fire.
      await system.run(system.evaluator.runTick(NOW + 29_000));
      expect(launcher.calls.length).toBe(0);

      // Tick 3: at the deadline -> fires.
      await system.run(system.evaluator.runTick(NOW + 30_000));
      expect(launcher.calls.length).toBe(1);
      const done = await readTrigger(system, "trigger-delay");
      expect(done.fireDueAt).toBeNull();
    } finally {
      await system.dispose();
    }
  });
});

describe("composite condition validation", () => {
  const attemptCreate = async (
    system: System,
    projectId: string,
    triggerId: string,
    condition: TriggerCondition,
  ) =>
    system.run(
      Effect.exit(
        system.engine.dispatch({
          type: "trigger.create",
          commandId: CommandId.make(`cmd-${triggerId}`),
          triggerId: TriggerId.make(triggerId),
          projectId: ProjectId.make(projectId),
          name: "Composite",
          condition,
          action: { kind: "startSession", spec: { text: "go" } },
          enabled: true,
        }),
      ),
    );

  it("accepts a nested composite over known atoms", async () => {
    const launcher = makeLauncherStub(() => Effect.succeed({ threadId: "t", sequence: 1 }));
    const system = await createSystem(launcher, makeFlexibleRegistryStub());
    try {
      await seedProject(system, "project-ok");
      const exit = await attemptCreate(system, "project-ok", "trigger-ok", {
        kind: "and",
        conditions: [
          { kind: "atom", atom: stateAtomA },
          {
            kind: "or",
            conditions: [
              { kind: "atom", atom: transientAtom },
              { kind: "not", condition: { kind: "atom", atom: stateAtomB } },
            ],
          },
        ],
      });
      expect(Exit.isSuccess(exit)).toBe(true);
    } finally {
      await system.dispose();
    }
  });

  it("rejects an 'and' with fewer than two sub-conditions", async () => {
    const launcher = makeLauncherStub(() => Effect.succeed({ threadId: "t", sequence: 1 }));
    const system = await createSystem(launcher, makeFlexibleRegistryStub());
    try {
      await seedProject(system, "project-min2");
      const exit = await attemptCreate(system, "project-min2", "trigger-min2", {
        kind: "and",
        conditions: [{ kind: "atom", atom: stateAtomA }],
      });
      expect(Exit.isFailure(exit)).toBe(true);
    } finally {
      await system.dispose();
    }
  });

  it("rejects 'not' of a transient atom", async () => {
    const launcher = makeLauncherStub(() => Effect.succeed({ threadId: "t", sequence: 1 }));
    const system = await createSystem(launcher, makeFlexibleRegistryStub());
    try {
      await seedProject(system, "project-nottransient");
      const exit = await attemptCreate(system, "project-nottransient", "trigger-nottransient", {
        kind: "not",
        condition: { kind: "atom", atom: transientAtom },
      });
      expect(Exit.isFailure(exit)).toBe(true);
    } finally {
      await system.dispose();
    }
  });

  it("rejects 'not' of a composite", async () => {
    const launcher = makeLauncherStub(() => Effect.succeed({ threadId: "t", sequence: 1 }));
    const system = await createSystem(launcher, makeFlexibleRegistryStub());
    try {
      await seedProject(system, "project-notcomposite");
      const exit = await attemptCreate(system, "project-notcomposite", "trigger-notcomposite", {
        kind: "not",
        condition: {
          kind: "and",
          conditions: [
            { kind: "atom", atom: stateAtomA },
            { kind: "atom", atom: stateAtomB },
          ],
        },
      });
      expect(Exit.isFailure(exit)).toBe(true);
    } finally {
      await system.dispose();
    }
  });

  it("rejects a temporal condition nested inside a composite", async () => {
    const launcher = makeLauncherStub(() => Effect.succeed({ threadId: "t", sequence: 1 }));
    const system = await createSystem(launcher, makeFlexibleRegistryStub());
    try {
      await seedProject(system, "project-nestedtemporal");
      const exit = await attemptCreate(system, "project-nestedtemporal", "trigger-nestedtemporal", {
        kind: "and",
        conditions: [
          { kind: "atom", atom: stateAtomA },
          { kind: "temporal", schedule: { kind: "interval", everyMs: 1000 } },
        ],
      });
      expect(Exit.isFailure(exit)).toBe(true);
    } finally {
      await system.dispose();
    }
  });
});
