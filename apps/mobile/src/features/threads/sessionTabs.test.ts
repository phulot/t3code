import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_SESSION_ID, type OrchestrationSession } from "@t3tools/contracts";

import {
  resolveActiveSessionId,
  resolveThreadSessions,
  scopeThreadDetailToSession,
  sessionIdOf,
  sessionStatusTone,
  SESSION_STATUS_LABEL,
} from "./threadPresentation";

function session(sessionId: string, status: OrchestrationSession["status"]): OrchestrationSession {
  return { sessionId, status } as OrchestrationSession;
}

describe("session helpers", () => {
  it("defaults a missing session id to the default session", () => {
    expect(sessionIdOf({ sessionId: undefined })).toBe(DEFAULT_SESSION_ID);
    expect(sessionIdOf({ sessionId: "s2" as OrchestrationSession["sessionId"] })).toBe("s2");
  });

  it("synthesizes a single tab from the scalar session for legacy threads", () => {
    const scalar = session("legacy", "idle");
    expect(resolveThreadSessions({ session: scalar })).toEqual([scalar]);
  });

  it("prefers the multi-session list when present", () => {
    const list = [session("a", "idle"), session("b", "running")];
    expect(resolveThreadSessions({ sessions: list, session: session("a", "idle") })).toBe(list);
  });

  it("returns an empty list for a missing thread", () => {
    expect(resolveThreadSessions(null)).toEqual([]);
    expect(resolveThreadSessions({})).toEqual([]);
  });
});

describe("resolveActiveSessionId", () => {
  const sessions = [session("a", "idle"), session("b", "running")];

  it("honors the requested session when it exists", () => {
    expect(resolveActiveSessionId(sessions, "b")).toBe("b");
  });

  it("falls back to the first session when the request is unknown", () => {
    expect(resolveActiveSessionId(sessions, "missing")).toBe("a");
    expect(resolveActiveSessionId(sessions, null)).toBe("a");
  });

  it("falls back to the default session id when there are no sessions", () => {
    expect(resolveActiveSessionId([], null)).toBe(DEFAULT_SESSION_ID);
  });
});

describe("sessionStatusTone", () => {
  it("labels every session status", () => {
    expect(sessionStatusTone("running").label).toBe(SESSION_STATUS_LABEL.running);
    expect(sessionStatusTone("ready").label).toBe("Ready");
    expect(sessionStatusTone("error").pillClassName).toContain("rose");
  });
});

describe("scopeThreadDetailToSession", () => {
  const base = {
    session: session(DEFAULT_SESSION_ID, "idle"),
    latestTurn: { id: "t-default" },
    messages: [
      { id: "m1", sessionId: undefined },
      { id: "m2", sessionId: "b" },
      { id: "m3", sessionId: "b" },
    ],
  } as unknown as Parameters<typeof scopeThreadDetailToSession>[0];

  it("returns single-session threads untouched", () => {
    const single = { ...base, sessions: [session(DEFAULT_SESSION_ID, "idle")] } as typeof base;
    expect(scopeThreadDetailToSession(single, DEFAULT_SESSION_ID)).toBe(single);
  });

  it("keeps only the active session's messages and surfaces its turn", () => {
    const multi = {
      ...base,
      sessions: [
        session(DEFAULT_SESSION_ID, "idle"),
        {
          sessionId: "b",
          status: "running",
          latestTurn: { id: "t-b" },
        } as unknown as OrchestrationSession,
      ],
    } as typeof base;
    const scoped = scopeThreadDetailToSession(multi, "b" as never);
    expect(scoped.messages.map((message) => message.id)).toEqual(["m2", "m3"]);
    expect(scoped.latestTurn).toEqual({ id: "t-b" });
    expect(scoped.session.sessionId).toBe("b");
  });

  it("treats messages without a session id as the default session", () => {
    const multi = {
      ...base,
      sessions: [session(DEFAULT_SESSION_ID, "idle"), session("b", "running")],
    } as typeof base;
    const scoped = scopeThreadDetailToSession(multi, DEFAULT_SESSION_ID);
    expect(scoped.messages.map((message) => message.id)).toEqual(["m1"]);
    expect(scoped.latestTurn).toEqual({ id: "t-default" });
  });
});
