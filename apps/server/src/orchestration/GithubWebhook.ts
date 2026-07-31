/**
 * GithubWebhook - Pure GitHub webhook detector.
 *
 * Two pure functions with no service dependencies, kept apart from the HTTP
 * route so they can be unit-tested in isolation:
 * - {@link verifyGithubSignature} authenticates a raw delivery body against the
 *   shared secret using GitHub's `X-Hub-Signature-256: sha256=<hex>` HMAC scheme,
 * - {@link normalizeGithubEvent} turns a verified `pull_request` delivery into
 *   the normalized `git/pr.merged` {@link ExternalEventFact}, or {@link Option.none}
 *   for anything that is not a PR-merged event.
 *
 * @module GithubWebhook
 */
import * as Option from "effect/Option";
import * as NodeCrypto from "node:crypto";

import type { ExternalEventFact } from "../persistence/Services/ExternalEventJournal.ts";

/** Detector source stamped on every fact this module produces. */
export const GITHUB_SOURCE = "github";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * Verify a GitHub webhook delivery signature.
 *
 * GitHub signs the *raw* request body with HMAC-SHA256 keyed by the configured
 * secret and sends it as `X-Hub-Signature-256: sha256=<hex>`. The comparison is
 * constant-time. Returns `false` for a missing/malformed header or any mismatch.
 */
export function verifyGithubSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string | undefined,
): boolean {
  if (signatureHeader === undefined || !signatureHeader.startsWith("sha256=")) {
    return false;
  }
  const provided = signatureHeader.slice("sha256=".length);
  const expected = NodeCrypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const providedBuffer = Buffer.from(provided, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return NodeCrypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

/**
 * Normalize a GitHub webhook delivery into a `git/pr.merged` fact.
 *
 * Only `X-GitHub-Event: pull_request` deliveries with `action: "closed"` and
 * `pull_request.merged === true` map to a fact; every other delivery (opened
 * PRs, closed-but-not-merged PRs, pushes, pings, ...) yields {@link Option.none}.
 * `headers` are expected lowercased (as Effect's HTTP layer delivers them).
 */
export function normalizeGithubEvent(
  headers: Record<string, string | undefined>,
  body: unknown,
): Option.Option<ExternalEventFact> {
  const event = headers["x-github-event"];
  if (event !== "pull_request") {
    return Option.none();
  }

  const deliveryKey = asString(headers["x-github-delivery"]);
  if (deliveryKey === undefined) {
    return Option.none();
  }

  if (!isRecord(body) || body.action !== "closed") {
    return Option.none();
  }

  const pullRequest = body.pull_request;
  if (!isRecord(pullRequest) || pullRequest.merged !== true) {
    return Option.none();
  }

  const repository = body.repository;
  const repo = isRecord(repository) ? asString(repository.full_name) : undefined;
  const pr = asNumber(pullRequest.number);
  const head = pullRequest.head;
  const branch = isRecord(head) ? asString(head.ref) : undefined;

  if (repo === undefined || (pr === undefined && branch === undefined)) {
    return Option.none();
  }

  const params: Record<string, unknown> = { repo };
  if (pr !== undefined) {
    params.pr = pr;
  }
  if (branch !== undefined) {
    params.branch = branch;
  }

  return Option.some({
    source: GITHUB_SOURCE,
    domain: "git",
    type: "pr.merged",
    params,
    deliveryKey,
    rawPayload: JSON.stringify(body),
  });
}
