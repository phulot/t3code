import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as NodeCrypto from "node:crypto";

import { GITHUB_SOURCE, normalizeGithubEvent, verifyGithubSignature } from "./GithubWebhook.ts";

const SECRET = "s3cr3t";

const sign = (body: string): string =>
  `sha256=${NodeCrypto.createHmac("sha256", SECRET).update(body).digest("hex")}`;

const prMergedBody = (overrides?: {
  action?: string;
  merged?: boolean;
  fullName?: string | undefined;
  number?: number | undefined;
  ref?: string | undefined;
}) => ({
  action: overrides?.action ?? "closed",
  pull_request: {
    number: overrides?.number ?? 42,
    merged: overrides?.merged ?? true,
    head: { ref: overrides?.ref ?? "feature/login" },
  },
  repository: { full_name: overrides?.fullName ?? "octo/repo" },
});

const headers = (event: string, delivery = "delivery-1"): Record<string, string | undefined> => ({
  "x-github-event": event,
  "x-github-delivery": delivery,
});

describe("verifyGithubSignature", () => {
  it("accepts a correctly signed body", () => {
    const body = JSON.stringify(prMergedBody());
    assert.isTrue(verifyGithubSignature(SECRET, body, sign(body)));
  });

  it("rejects a tampered body", () => {
    const body = JSON.stringify(prMergedBody());
    const signature = sign(body);
    assert.isFalse(verifyGithubSignature(SECRET, `${body} `, signature));
  });

  it("rejects a wrong secret", () => {
    const body = JSON.stringify(prMergedBody());
    const signature = `sha256=${NodeCrypto.createHmac("sha256", "other").update(body).digest("hex")}`;
    assert.isFalse(verifyGithubSignature(SECRET, body, signature));
  });

  it("rejects a missing or malformed header", () => {
    const body = JSON.stringify(prMergedBody());
    assert.isFalse(verifyGithubSignature(SECRET, body, undefined));
    assert.isFalse(verifyGithubSignature(SECRET, body, "not-a-signature"));
    assert.isFalse(verifyGithubSignature(SECRET, body, "sha256="));
  });
});

describe("normalizeGithubEvent", () => {
  it("normalizes a merged pull_request into a git/pr.merged fact", () => {
    const fact = normalizeGithubEvent(headers("pull_request"), prMergedBody());
    assert.isTrue(Option.isSome(fact));
    if (Option.isNone(fact)) return;
    assert.deepStrictEqual(
      { ...fact.value, rawPayload: undefined },
      {
        source: GITHUB_SOURCE,
        domain: "git",
        type: "pr.merged",
        params: { repo: "octo/repo", pr: 42, branch: "feature/login" },
        deliveryKey: "delivery-1",
        rawPayload: undefined,
      },
    );
    assert.isString(fact.value.rawPayload);
  });

  it("ignores a non pull_request event", () => {
    const fact = normalizeGithubEvent(headers("push"), prMergedBody());
    assert.isTrue(Option.isNone(fact));
  });

  it("ignores a closed-but-not-merged pull request", () => {
    const fact = normalizeGithubEvent(headers("pull_request"), prMergedBody({ merged: false }));
    assert.isTrue(Option.isNone(fact));
  });

  it("ignores an opened pull request", () => {
    const fact = normalizeGithubEvent(headers("pull_request"), prMergedBody({ action: "opened" }));
    assert.isTrue(Option.isNone(fact));
  });

  it("ignores a delivery without the delivery id", () => {
    const fact = normalizeGithubEvent({ "x-github-event": "pull_request" }, prMergedBody());
    assert.isTrue(Option.isNone(fact));
  });

  it("ignores a delivery missing the repository full name", () => {
    const fact = normalizeGithubEvent(headers("pull_request"), {
      action: "closed",
      pull_request: { number: 42, merged: true, head: { ref: "feature/login" } },
      repository: {},
    });
    assert.isTrue(Option.isNone(fact));
  });
});
