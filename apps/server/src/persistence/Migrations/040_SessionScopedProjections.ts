/**
 * Introduces per-session scoping to the thread projections.
 *
 * A thread owns one worktree and now hosts N sessions (chats). Sessions are a
 * sub-entity keyed by (thread_id, session_id). This migration is an IN-PLACE
 * SQL rebuild (not an event replay): every affected table gains a
 * `session_id TEXT NOT NULL DEFAULT 'default'` column and every existing row is
 * backfilled with the literal session id `'default'`.
 *
 * SQLite cannot alter a PRIMARY KEY in place, so the two tables whose primary
 * key must widen (`projection_thread_sessions` and `provider_session_runtime`)
 * are rebuilt: a new table with the widened PK is created, rows are copied in
 * (injecting `'default'`), the old table is dropped and the new one renamed.
 * Their indexes are recreated afterwards.
 *
 * `projection_turns` and `projection_thread_messages` only need turn/message
 * ownership tagging, so they get a plain `ADD COLUMN session_id`. Checkpoints
 * and revert stay thread/worktree-level and global, so `checkpoint_turn_count`
 * uniqueness remains thread-scoped (NOT scoped by session).
 *
 * The migration is defensive: each step is guarded on the presence of the
 * `session_id` column so a partially-applied database still converges.
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

const hasSessionColumn = (columns: ReadonlyArray<{ readonly name: string }>) =>
  columns.some((column) => column.name === "session_id");

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // -- projection_thread_sessions: widen PK to (thread_id, session_id) --------
  const threadSessionColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_sessions)
  `;
  if (!hasSessionColumn(threadSessionColumns)) {
    yield* sql`
      CREATE TABLE projection_thread_sessions_new (
        thread_id TEXT NOT NULL,
        session_id TEXT NOT NULL DEFAULT 'default',
        status TEXT NOT NULL,
        provider_name TEXT,
        provider_session_id TEXT,
        provider_thread_id TEXT,
        provider_instance_id TEXT,
        runtime_mode TEXT NOT NULL DEFAULT 'full-access',
        active_turn_id TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, session_id)
      )
    `;
    yield* sql`
      INSERT INTO projection_thread_sessions_new (
        thread_id,
        session_id,
        status,
        provider_name,
        provider_session_id,
        provider_thread_id,
        provider_instance_id,
        runtime_mode,
        active_turn_id,
        last_error,
        updated_at
      )
      SELECT
        thread_id,
        'default',
        status,
        provider_name,
        provider_session_id,
        provider_thread_id,
        provider_instance_id,
        runtime_mode,
        active_turn_id,
        last_error,
        updated_at
      FROM projection_thread_sessions
    `;
    yield* sql`DROP TABLE projection_thread_sessions`;
    yield* sql`ALTER TABLE projection_thread_sessions_new RENAME TO projection_thread_sessions`;

    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_projection_thread_sessions_provider_session
      ON projection_thread_sessions(provider_session_id)
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_projection_thread_sessions_instance
      ON projection_thread_sessions(provider_instance_id)
    `;
  }

  // -- provider_session_runtime: widen PK to (thread_id, session_id) ----------
  const providerRuntimeColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(provider_session_runtime)
  `;
  if (!hasSessionColumn(providerRuntimeColumns)) {
    yield* sql`
      CREATE TABLE provider_session_runtime_new (
        thread_id TEXT NOT NULL,
        session_id TEXT NOT NULL DEFAULT 'default',
        provider_name TEXT NOT NULL,
        provider_instance_id TEXT,
        adapter_key TEXT NOT NULL,
        runtime_mode TEXT NOT NULL DEFAULT 'full-access',
        status TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        resume_cursor_json TEXT,
        runtime_payload_json TEXT,
        PRIMARY KEY (thread_id, session_id)
      )
    `;
    yield* sql`
      INSERT INTO provider_session_runtime_new (
        thread_id,
        session_id,
        provider_name,
        provider_instance_id,
        adapter_key,
        runtime_mode,
        status,
        last_seen_at,
        resume_cursor_json,
        runtime_payload_json
      )
      SELECT
        thread_id,
        'default',
        provider_name,
        provider_instance_id,
        adapter_key,
        runtime_mode,
        status,
        last_seen_at,
        resume_cursor_json,
        runtime_payload_json
      FROM provider_session_runtime
    `;
    yield* sql`DROP TABLE provider_session_runtime`;
    yield* sql`ALTER TABLE provider_session_runtime_new RENAME TO provider_session_runtime`;

    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_provider_session_runtime_status
      ON provider_session_runtime(status)
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_provider_session_runtime_provider
      ON provider_session_runtime(provider_name)
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_provider_session_runtime_instance
      ON provider_session_runtime(provider_instance_id)
    `;
  }

  // -- projection_turns: tag turn ownership; checkpoints stay thread-scoped ----
  const turnColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_turns)
  `;
  if (!hasSessionColumn(turnColumns)) {
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN session_id TEXT NOT NULL DEFAULT 'default'
    `;
  }

  // -- projection_thread_messages: tag message ownership ----------------------
  const messageColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;
  if (!hasSessionColumn(messageColumns)) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN session_id TEXT NOT NULL DEFAULT 'default'
    `;
  }
});
