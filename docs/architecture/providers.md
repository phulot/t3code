# Provider architecture

The web app communicates with the server via WebSocket using a simple JSON-RPC-style protocol:

- **Request/Response**: `{ id, method, params }` → `{ id, result }` or `{ id, error }`
- **Push events**: typed envelopes with `channel`, `sequence` (monotonic per connection), and channel-specific `data`

Push channels: `server.welcome`, `server.configUpdated`, `terminal.event`, `orchestration.domainEvent`. Payloads are schema-validated at the transport boundary (`wsTransport.ts`). Decode failures produce structured `WsDecodeDiagnostic` with `code`, `reason`, and path info.

Methods mirror the `NativeApi` interface defined in `@t3tools/contracts`:

- `providers.startSession`, `providers.sendTurn`, `providers.interruptTurn`
- `providers.respondToRequest`, `providers.stopSession`
- `shell.openInEditor`, `server.getConfig`

Provider instances are open routing identities backed by drivers such as Codex, Claude, Cursor, Grok,
and OpenCode.

## Client transport

`wsTransport.ts` manages connection state: `connecting` → `open` → `reconnecting` → `closed` → `disposed`. Outbound requests are queued while disconnected and flushed on reconnect. Inbound pushes are decoded and validated at the boundary, then cached per channel. Subscribers can opt into `replayLatest` to receive the last push on subscribe.

## Server-side orchestration layers

Provider runtime events flow through queue-based workers:

1. **ProviderRuntimeIngestion** — consumes provider runtime streams, emits orchestration commands
2. **ProviderCommandReactor** — reacts to orchestration intent events, dispatches provider calls
3. **CheckpointReactor** — captures git checkpoints on turn start/complete, publishes runtime receipts

All three use `DrainableWorker` internally and expose `drain()` for deterministic test synchronization.

## Cross-provider handoffs

The T3 thread is the durable conversation; a provider session is a replaceable execution epoch.
When a settled thread selects an instance backed by another driver, `ProviderCommandReactor`:

1. derives a bounded handoff from canonical messages, activities, and workspace metadata;
2. stops the active provider session;
3. starts the target provider without the previous provider's resume cursor;
4. appends a `provider.session.switched` activity; and
5. sends the handoff together with the new user message.

`ProviderService` continues to expose one active runtime binding per thread. This keeps routing stable
for local, relay, tunnel, and multi-device clients while allowing the execution provider to change at
a turn boundary.
