/**
 * ProjectionThreadSessionRepository - Repository interface for thread sessions.
 *
 * Owns persistence operations for projected provider-session linkage and
 * runtime status for each thread.
 *
 * @module ProjectionThreadSessionRepository
 */
import {
  RuntimeMode,
  IsoDateTime,
  OrchestrationSessionStatus,
  ProviderInstanceId,
  SessionId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadSession = Schema.Struct({
  threadId: ThreadId,
  /**
   * Session (chat) this row belongs to within the thread. Optional for
   * backward compatibility: callers that omit it operate on the thread's
   * single `'default'` session. New session-aware callers set it explicitly.
   */
  sessionId: Schema.optional(SessionId),
  status: OrchestrationSessionStatus,
  providerName: Schema.NullOr(Schema.String),
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  runtimeMode: RuntimeMode,
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type ProjectionThreadSession = typeof ProjectionThreadSession.Type;

export const GetProjectionThreadSessionInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetProjectionThreadSessionInput = typeof GetProjectionThreadSessionInput.Type;

export const DeleteProjectionThreadSessionInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadSessionInput = typeof DeleteProjectionThreadSessionInput.Type;

export const GetProjectionThreadSessionBySessionInput = Schema.Struct({
  threadId: ThreadId,
  sessionId: SessionId,
});
export type GetProjectionThreadSessionBySessionInput =
  typeof GetProjectionThreadSessionBySessionInput.Type;

export const ListProjectionThreadSessionsByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadSessionsByThreadInput =
  typeof ListProjectionThreadSessionsByThreadInput.Type;

/**
 * ProjectionThreadSessionRepositoryShape - Service API for projected thread sessions.
 */
export interface ProjectionThreadSessionRepositoryShape {
  /**
   * Insert or replace a projected thread-session row.
   *
   * Upserts by `threadId`.
   */
  readonly upsert: (row: ProjectionThreadSession) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read projected thread-session state by thread id.
   *
   * Resolves the thread's `'default'` session for backward compatibility.
   */
  readonly getByThreadId: (
    input: GetProjectionThreadSessionInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadSession>, ProjectionRepositoryError>;

  /**
   * Read projected thread-session state by (thread id, session id).
   */
  readonly getByThreadAndSession: (
    input: GetProjectionThreadSessionBySessionInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadSession>, ProjectionRepositoryError>;

  /**
   * List all projected sessions hosted by a thread, in ascending session id order.
   */
  readonly listByThreadId: (
    input: ListProjectionThreadSessionsByThreadInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadSession>, ProjectionRepositoryError>;

  /**
   * Delete projected thread-session state by thread id.
   */
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadSessionInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionThreadSessionRepository - Service tag for thread-session persistence.
 */
export class ProjectionThreadSessionRepository extends Context.Service<
  ProjectionThreadSessionRepository,
  ProjectionThreadSessionRepositoryShape
>()("t3/persistence/Services/ProjectionThreadSessions/ProjectionThreadSessionRepository") {}
