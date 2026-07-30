import {
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationMessage,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildProviderHandoff, PROVIDER_HANDOFF_MAX_CHARS } from "./ProviderHandoff.ts";

const message = (
  id: string,
  role: OrchestrationMessage["role"],
  text: string,
): OrchestrationMessage => ({
  id: MessageId.make(id),
  role,
  text,
  turnId: null,
  streaming: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const activity = (id: string, summary: string): OrchestrationThreadActivity => ({
  id: EventId.make(id),
  tone: "info",
  kind: "test.activity",
  summary,
  payload: { detail: summary },
  turnId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("buildProviderHandoff", () => {
  it("carries the original goal, recent context, workspace, and activities", () => {
    const handoff = buildProviderHandoff({
      from: {
        driver: ProviderDriverKind.make("claudeAgent"),
        instanceId: ProviderInstanceId.make("claudeAgent"),
      },
      to: {
        driver: ProviderDriverKind.make("codex"),
        instanceId: ProviderInstanceId.make("codex"),
      },
      messages: [
        message("message-1", "user", "Implement provider switching"),
        message("message-2", "assistant", "The server currently locks the provider."),
        message("message-3", "user", "Use a compact handoff."),
      ],
      activities: [activity("activity-1", "Changed two files")],
      currentMessageId: "message-3",
      branch: "feature/provider-handoff",
      workspacePath: "/repo/worktree",
    });

    expect(handoff).toContain("Continue this thread from claudeAgent");
    expect(handoff).toContain("Original goal:\nImplement provider switching");
    expect(handoff).toContain("Assistant: The server currently locks the provider.");
    expect(handoff).not.toContain("User: Use a compact handoff.");
    expect(handoff).toContain("Branch: feature/provider-handoff");
    expect(handoff).toContain("Changed two files");
  });

  it("stays within the requested and global character budgets", () => {
    const handoff = buildProviderHandoff({
      from: {
        driver: ProviderDriverKind.make("claudeAgent"),
        instanceId: ProviderInstanceId.make("claudeAgent"),
      },
      to: {
        driver: ProviderDriverKind.make("codex"),
        instanceId: ProviderInstanceId.make("codex"),
      },
      messages: [message("message-1", "user", "x".repeat(PROVIDER_HANDOFF_MAX_CHARS * 2))],
      activities: [],
      currentMessageId: "message-current",
      branch: null,
      workspacePath: null,
      maxChars: 1_000,
    });

    expect(handoff.length).toBeLessThanOrEqual(1_000);
  });
});
