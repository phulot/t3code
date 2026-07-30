# Switching providers in a thread

T3 Code can continue a settled thread with another configured provider. For example, a thread that
started in Claude can send its next message through Codex/GPT without changing the thread or its
workspace.

## Switch providers

1. Wait for the current turn to finish, or interrupt it.
2. Open the model picker in the composer.
3. Choose a model from another provider.
4. Send the next message.

T3 Code starts a fresh native session for the selected provider and gives it a compact handoff built
from the thread history and workspace state. The handoff is not shown as a user message. The timeline
records the transition, such as **Switched from Claude to Codex**.

You can switch back through the same model picker after the new provider's turn settles.

## What carries over

The receiving provider gets the original goal, recent conversation, recent operational activity,
branch, and workspace path. T3 Code keeps this context bounded so long threads do not replay every
provider-specific tool event.

The provider's native session identifier does not carry over. Claude and Codex use different resume
formats, so each transition starts a fresh native session inside the same durable T3 Code thread.

## Availability

Only enabled and available provider instances appear in the picker. A provider change is unavailable
while a turn is starting or running. Providers that require a new thread for model changes keep that
restriction.
