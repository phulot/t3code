import type {
  OrchestrationMessage,
  OrchestrationThreadActivity,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";

export const PROVIDER_HANDOFF_MAX_CHARS = 24_000;

type ProviderHandoffInput = {
  readonly from: {
    readonly driver: ProviderDriverKind;
    readonly instanceId: ProviderInstanceId;
  };
  readonly to: {
    readonly driver: ProviderDriverKind;
    readonly instanceId: ProviderInstanceId;
  };
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly currentMessageId: string;
  readonly branch: string | null;
  readonly workspacePath: string | null;
  readonly maxChars?: number;
};

function clip(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 1) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - 1)}…`;
}

function appendWithinBudget(sections: Array<string>, section: string, maxChars: number): boolean {
  const separatorLength = sections.length === 0 ? 0 : 2;
  const currentLength = sections.reduce((total, value) => total + value.length, 0);
  if (currentLength + separatorLength + section.length > maxChars) {
    return false;
  }
  sections.push(section);
  return true;
}

export function buildProviderHandoff(input: ProviderHandoffInput): string {
  const maxChars = Math.max(
    0,
    Math.min(input.maxChars ?? PROVIDER_HANDOFF_MAX_CHARS, PROVIDER_HANDOFF_MAX_CHARS),
  );
  if (maxChars === 0) return "";

  const priorMessages = input.messages.filter((message) => message.id !== input.currentMessageId);
  const firstUserMessage = priorMessages.find((message) => message.role === "user");
  const header = [
    "[T3 CODE PROVIDER HANDOFF]",
    `Continue this thread from ${input.from.driver} (${input.from.instanceId}) in ${input.to.driver} (${input.to.instanceId}).`,
    "Use the canonical thread context below to preserve the task, decisions, and completed work.",
    "The user's current request follows after this handoff.",
  ].join("\n");
  const sections = [clip(header, maxChars)];

  if (firstUserMessage?.text.trim()) {
    appendWithinBudget(
      sections,
      `Original goal:\n${clip(firstUserMessage.text.trim(), 3_000)}`,
      maxChars,
    );
  }

  const workspaceLines = [
    `Branch: ${input.branch ?? "(none)"}`,
    `Workspace: ${input.workspacePath ?? "(project root)"}`,
  ];
  appendWithinBudget(sections, `Current workspace:\n${workspaceLines.join("\n")}`, maxChars);

  const recentMessageLines: Array<string> = [];
  for (const message of priorMessages.slice().reverse()) {
    const text = message.text.trim();
    if (!text || message.id === firstUserMessage?.id) continue;
    const label =
      message.role === "assistant" ? "Assistant" : message.role === "user" ? "User" : "System";
    const line = `${label}: ${clip(text, 2_000)}`;
    const candidate = [line, ...recentMessageLines].join("\n\n");
    const section = `Recent conversation:\n${candidate}`;
    const projected = [...sections, section].join("\n\n");
    if (projected.length > maxChars) break;
    recentMessageLines.unshift(line);
    if (recentMessageLines.length >= 12) break;
  }
  if (recentMessageLines.length > 0) {
    appendWithinBudget(
      sections,
      `Recent conversation:\n${recentMessageLines.join("\n\n")}`,
      maxChars,
    );
  }

  const activityLines: Array<string> = [];
  for (const activity of input.activities.slice(-12).reverse()) {
    const line = `- [${activity.kind}] ${activity.summary}`;
    const candidate = [line, ...activityLines].join("\n");
    const section = `Recent operational state:\n${candidate}`;
    const projected = [...sections, section].join("\n\n");
    if (projected.length > maxChars) break;
    activityLines.unshift(line);
  }
  if (activityLines.length > 0) {
    appendWithinBudget(
      sections,
      `Recent operational state:\n${activityLines.join("\n")}`,
      maxChars,
    );
  }

  return clip(sections.join("\n\n"), maxChars);
}
