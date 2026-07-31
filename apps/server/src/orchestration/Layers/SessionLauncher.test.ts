import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ProjectSetupScriptRunner } from "../../project/ProjectSetupScriptRunner.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { SessionLauncherLive } from "./SessionLauncher.ts";
import { SessionLauncherService } from "../Services/SessionLauncher.ts";

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};

// The launcher requires GitWorkflowService and ProjectSetupScriptRunner in
// context, but tests that provide a `worktreePath` and `runSetupScript: false`
// never call into them. Stub tags with a proxy that dies on any access so the
// heavy real dependency graphs stay out of the test.
const dieProxy = <T extends object>(name: string): T =>
  new Proxy(
    {},
    {
      get: (_target, prop) => () => Effect.die(`${name}.${String(prop)} is not available in test`),
    },
  ) as T;

const GitWorkflowStub = Layer.succeed(
  GitWorkflowService,
  dieProxy<GitWorkflowService["Service"]>("GitWorkflowService"),
);
const ProjectSetupScriptRunnerStub = Layer.succeed(
  ProjectSetupScriptRunner,
  dieProxy<ProjectSetupScriptRunner["Service"]>("ProjectSetupScriptRunner"),
);

async function createSystem() {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-session-launcher-test-",
  });
  const orchestrationLayer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
    ProjectionProjectRepositoryLive,
  ).pipe(
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const launcherLayer = SessionLauncherLive.pipe(
    Layer.provide(GitWorkflowStub),
    Layer.provide(ProjectSetupScriptRunnerStub),
    Layer.provideMerge(orchestrationLayer),
  );
  const runtime = ManagedRuntime.make(launcherLayer);
  const launcher = await runtime.runPromise(Effect.service(SessionLauncherService));
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const projects = await runtime.runPromise(Effect.service(ProjectionProjectRepository));
  return {
    launcher,
    engine,
    projects,
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    events: () =>
      runtime.runPromise(
        Stream.runCollect(engine.readEvents(0)).pipe(
          Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
        ),
      ),
    dispose: () => runtime.dispose(),
  };
}

const createdAt = "2026-01-01T00:00:00.000Z";

const createProject = (system: Awaited<ReturnType<typeof createSystem>>, projectId: string) =>
  system.run(
    system.engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`cmd-project-${projectId}`),
      projectId: ProjectId.make(projectId),
      title: "Launcher Project",
      workspaceRoot: `/tmp/${projectId}`,
      defaultModelSelection: modelSelection,
      createdAt,
    }),
  );

describe("SessionLauncher", () => {
  it("startSession creates a thread and dispatches the initial turn without git", async () => {
    const system = await createSystem();
    try {
      await createProject(system, "project-launch");

      const result = await system.run(
        system.launcher.startSession({
          projectId: "project-launch",
          title: "Orchestrated thread",
          text: "hello from orchestration",
          modelSelection,
          worktreePath: "/tmp/project-launch/worktree",
          runSetupScript: false,
        }),
      );

      expect(typeof result.threadId).toBe("string");
      expect(result.threadId.length).toBeGreaterThan(0);
      expect(result.sequence).toBeGreaterThan(0);

      const events = await system.events();
      const forThread = events.filter(
        (event) =>
          "payload" in event &&
          (event.payload as { threadId?: string }).threadId === result.threadId,
      );
      const types = forThread.map((event) => event.type);
      expect(types).toContain("thread.created");
      expect(types).toContain("thread.turn-start-requested");
    } finally {
      await system.dispose();
    }
  });

  it("startSession resolves the model selection from the project default", async () => {
    const system = await createSystem();
    try {
      await createProject(system, "project-default-model");
      await system.run(
        system.projects.upsert({
          projectId: ProjectId.make("project-default-model"),
          title: "Launcher Project",
          workspaceRoot: "/tmp/project-default-model",
          defaultModelSelection: modelSelection,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
          deletedAt: null,
        }),
      );

      const result = await system.run(
        system.launcher.startSession({
          projectId: "project-default-model",
          text: "resolve model from project",
          worktreePath: "/tmp/project-default-model/worktree",
          runSetupScript: false,
        }),
      );

      expect(result.sequence).toBeGreaterThan(0);
      const events = await system.events();
      expect(events.map((event) => event.type)).toContain("thread.created");
    } finally {
      await system.dispose();
    }
  });

  it("resumeSession dispatches a turn on an existing thread", async () => {
    const system = await createSystem();
    try {
      await createProject(system, "project-resume");
      const started = await system.run(
        system.launcher.startSession({
          projectId: "project-resume",
          text: "first turn",
          modelSelection,
          worktreePath: "/tmp/project-resume/worktree",
          runSetupScript: false,
        }),
      );

      const resumed = await system.run(
        system.launcher.resumeSession({
          threadId: started.threadId,
          text: "second turn",
        }),
      );

      expect(resumed.sequence).toBeGreaterThan(started.sequence);
    } finally {
      await system.dispose();
    }
  });
});
