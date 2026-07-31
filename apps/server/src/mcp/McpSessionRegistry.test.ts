import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type T3ProjectFile,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  ProjectionProjectRepository,
  type ProjectionProject,
} from "../persistence/Services/ProjectionProjects.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThread,
} from "../persistence/Services/ProjectionThreads.ts";
import { T3ProjectFileLoader } from "../project/T3ProjectFileLoader.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-1");
const makeFakeHttpServer = (hostname: string, port = 43123) =>
  HttpServer.HttpServer.of({
    address: { _tag: "TcpAddress", hostname, port },
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
const fakeHttpServer = makeFakeHttpServer("127.0.0.1");
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

interface OptInStubs {
  readonly thread?: Option.Option<Pick<ProjectionThread, "projectId">>;
  readonly project?: Option.Option<Pick<ProjectionProject, "workspaceRoot">>;
  readonly projectFile?: Option.Option<T3ProjectFile>;
}

const optInLayer = (stubs: OptInStubs = {}) =>
  Layer.mergeAll(
    Layer.succeed(
      ProjectionThreadRepository,
      ProjectionThreadRepository.of({
        upsert: () => Effect.void,
        getById: () =>
          Effect.succeed((stubs.thread ?? Option.none()) as Option.Option<ProjectionThread>),
        listByProjectId: () => Effect.succeed([]),
        deleteById: () => Effect.void,
      }),
    ),
    Layer.succeed(
      ProjectionProjectRepository,
      ProjectionProjectRepository.of({
        upsert: () => Effect.void,
        getById: () =>
          Effect.succeed((stubs.project ?? Option.none()) as Option.Option<ProjectionProject>),
        listAll: () => Effect.succeed([]),
        deleteById: () => Effect.void,
      }),
    ),
    Layer.succeed(
      T3ProjectFileLoader,
      T3ProjectFileLoader.of({
        load: () => Effect.succeed(stubs.projectFile ?? Option.none()),
      }),
    ),
  );

const makeRegistry = (now: () => number, httpServer = fakeHttpServer, stubs: OptInStubs = {}) =>
  McpSessionRegistry.__testing
    .make({
      now,
      livenessWindowMs: 100,
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provide(Layer.merge(optInLayer(stubs), NodeServices.layer)),
    );

it.effect("stores only a token hash, resolves the bearer token, and revokes by thread", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(token.length).toBeGreaterThan(20);

    const resolved = yield* registry.resolve(token);
    expect(resolved?.threadId).toBe(threadId);

    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();

    timestamp += 2_000;
  }),
);

it.effect("builds MCP endpoints from the bound server host", () =>
  Effect.gen(function* () {
    const cases = [
      ["100.64.0.40", "http://100.64.0.40:43123/mcp"],
      ["0.0.0.0", "http://127.0.0.1:43123/mcp"],
      ["localhost", "http://localhost:43123/mcp"],
      ["127.0.0.1", "http://127.0.0.1:43123/mcp"],
    ] as const;

    for (const [hostname, expectedEndpoint] of cases) {
      const registry = yield* makeRegistry(() => 1_000, makeFakeHttpServer(hostname));
      const issued = yield* registry.issue({
        threadId: ThreadId.make(`thread-${hostname}`),
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      expect(issued.config.endpoint).toBe(expectedEndpoint);
    }
  }),
);

it.effect("expires credentials once their session stops showing signs of life", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-2"),
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("keeps a credential alive across turns that never touch an MCP tool", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-3");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    // Well past the liveness window in total, but each turn reports in before
    // it lapses — this is the long-session case that used to lose the toolkit.
    for (let turn = 0; turn < 10; turn += 1) {
      timestamp += 99;
      yield* registry.touch(threadId);
    }

    expect((yield* registry.resolve(token))?.threadId).toBe(threadId);
  }),
);

it.effect("does not keep credentials of other threads alive", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-4"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    timestamp += 99;
    yield* registry.touch(ThreadId.make("thread-unrelated"));
    timestamp += 2;

    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

const projectFile = (orchestrate?: boolean): T3ProjectFile =>
  (orchestrate === undefined ? {} : { orchestrate }) as T3ProjectFile;

const issueAndResolveCapabilities = (stubs: OptInStubs) =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000, fakeHttpServer, stubs);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-optin"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const resolved = yield* registry.resolve(token);
    return resolved?.capabilities;
  });

it.effect("grants orchestrate when the project's t3.json opts in", () =>
  Effect.gen(function* () {
    const capabilities = yield* issueAndResolveCapabilities({
      thread: Option.some({ projectId: ProjectId.make("project-1") }),
      project: Option.some({ workspaceRoot: "/tmp/project-1" }),
      projectFile: Option.some(projectFile(true)),
    });
    expect(capabilities?.has("preview")).toBe(true);
    expect(capabilities?.has("orchestrate")).toBe(true);
  }),
);

it.effect("does not grant orchestrate when t3.json omits or disables the opt-in", () =>
  Effect.gen(function* () {
    const disabled = yield* issueAndResolveCapabilities({
      thread: Option.some({ projectId: ProjectId.make("project-1") }),
      project: Option.some({ workspaceRoot: "/tmp/project-1" }),
      projectFile: Option.some(projectFile(false)),
    });
    expect(disabled?.has("preview")).toBe(true);
    expect(disabled?.has("orchestrate")).toBe(false);

    const absent = yield* issueAndResolveCapabilities({
      thread: Option.some({ projectId: ProjectId.make("project-1") }),
      project: Option.some({ workspaceRoot: "/tmp/project-1" }),
      projectFile: Option.none(),
    });
    expect(absent?.has("orchestrate")).toBe(false);
  }),
);

it.effect("tolerates a missing thread or project and grants only preview", () =>
  Effect.gen(function* () {
    const noThread = yield* issueAndResolveCapabilities({ thread: Option.none() });
    expect(noThread?.has("preview")).toBe(true);
    expect(noThread?.has("orchestrate")).toBe(false);

    const noProject = yield* issueAndResolveCapabilities({
      thread: Option.some({ projectId: ProjectId.make("project-1") }),
      project: Option.none(),
    });
    expect(noProject?.has("orchestrate")).toBe(false);
  }),
);
