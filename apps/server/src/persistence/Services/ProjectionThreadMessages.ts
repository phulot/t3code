/**
 * ProjectionThreadMessageRepository - Projection repository interface for messages.
 *
 * Owns persistence operations for projected thread messages rendered in the
 * orchestration read model.
 *
 * @module ProjectionThreadMessageRepository
 */
import {
  ChatAttachment,
  MessageId,
  OrchestrationMessageRole,
  SessionId,
  ThreadId,
  TurnId,
  IsoDateTime,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Option from "effect/Option";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadMessage = Schema.Struct({
  messageId: MessageId,
  threadId: ThreadId,
  /**
   * Session (chat) this message belongs to within the thread. Optional for
   * backward compatibility: callers that omit it write to the thread's single
   * `'default'` session.
   */
  sessionId: Schema.optional(SessionId),
  turnId: Schema.NullOr(TurnId),
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  isStreaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadMessage = typeof ProjectionThreadMessage.Type;

export const ListProjectionThreadMessagesInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadMessagesInput = typeof ListProjectionThreadMessagesInput.Type;

export const ListProjectionThreadMessagesBySessionInput = Schema.Struct({
  threadId: ThreadId,
  sessionId: SessionId,
});
export type ListProjectionThreadMessagesBySessionInput =
  typeof ListProjectionThreadMessagesBySessionInput.Type;

export const GetProjectionThreadMessageInput = Schema.Struct({
  messageId: MessageId,
});
export type GetProjectionThreadMessageInput = typeof GetProjectionThreadMessageInput.Type;

export const DeleteProjectionThreadMessagesInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadMessagesInput = typeof DeleteProjectionThreadMessagesInput.Type;

/**
 * ProjectionThreadMessageRepositoryShape - Service API for projected thread messages.
 */
export interface ProjectionThreadMessageRepositoryShape {
  /**
   * Insert or replace a projected thread message row.
   *
   * Upserts by `messageId`.
   */
  readonly upsert: (
    message: ProjectionThreadMessage,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a projected thread message by id.
   */
  readonly getByMessageId: (
    input: GetProjectionThreadMessageInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadMessage>, ProjectionRepositoryError>;

  /**
   * List projected thread messages for a thread.
   *
   * Returned in ascending creation order.
   */
  readonly listByThreadId: (
    input: ListProjectionThreadMessagesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadMessage>, ProjectionRepositoryError>;

  /**
   * List projected thread messages for a single session of a thread.
   *
   * Returned in ascending creation order.
   */
  readonly listByThreadSession: (
    input: ListProjectionThreadMessagesBySessionInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadMessage>, ProjectionRepositoryError>;

  /**
   * Delete projected thread messages by thread.
   */
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadMessagesInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionThreadMessageRepository - Service tag for message projection persistence.
 */
export class ProjectionThreadMessageRepository extends Context.Service<
  ProjectionThreadMessageRepository,
  ProjectionThreadMessageRepositoryShape
>()("t3/persistence/Services/ProjectionThreadMessages/ProjectionThreadMessageRepository") {}
