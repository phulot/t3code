/**
 * githubWebhookRouteLayer - `POST /webhooks/github` detector endpoint.
 *
 * The EVENTIAL channel's ingress. It is intentionally *not* behind the
 * environment auth used by the rest of the API: GitHub authenticates itself with
 * an HMAC of the raw body (`X-Hub-Signature-256`), which is verified here against
 * the `GITHUB_WEBHOOK_SECRET`.
 *
 * Response contract:
 * - secret not configured        → 503 (never process an unverified delivery),
 * - missing/invalid signature    → 401,
 * - malformed JSON body          → 400,
 * - verified but not PR-merged    → 202 (accepted, nothing to ingest),
 * - verified PR-merged delivery   → 202, after journalling + firing.
 *
 * A verified delivery always gets a fast 2xx so GitHub does not retry: per
 * Decision D18 a journal/ingestion failure is detector health — it is logged,
 * not surfaced as a non-2xx that would trigger redelivery.
 *
 * @module GithubWebhookRoute
 */
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { EventIngestion } from "./Services/EventIngestion.ts";
import { normalizeGithubEvent, verifyGithubSignature } from "./GithubWebhook.ts";

const GITHUB_WEBHOOK_SECRET = Config.string("GITHUB_WEBHOOK_SECRET").pipe(Config.option);

// Parse the raw request body, returning None for a body that is not valid JSON.
// A plain module-level helper so the parse (and its guard) is not expressed as
// an effectful step inside the route generator.
const parseJsonBody = (raw: string): Option.Option<unknown> => {
  try {
    return Option.some(JSON.parse(raw));
  } catch {
    return Option.none();
  }
};

export const githubWebhookRouteLayer = HttpRouter.add(
  "POST",
  "/webhooks/github",
  Effect.gen(function* () {
    const secret = yield* GITHUB_WEBHOOK_SECRET;
    if (Option.isNone(secret)) {
      yield* Effect.logWarning(
        "GitHub webhook received but GITHUB_WEBHOOK_SECRET is not configured; rejecting.",
      );
      return HttpServerResponse.text("Webhook secret not configured.", { status: 503 });
    }

    const request = yield* HttpServerRequest.HttpServerRequest;
    const rawBody = yield* request.text;

    const signature = request.headers["x-hub-signature-256"];
    if (!verifyGithubSignature(secret.value, rawBody, signature)) {
      return HttpServerResponse.text("Invalid signature.", { status: 401 });
    }

    const parsedBody = parseJsonBody(rawBody);
    if (Option.isNone(parsedBody)) {
      return HttpServerResponse.text("Invalid JSON body.", { status: 400 });
    }

    const fact = normalizeGithubEvent(request.headers, parsedBody.value);
    if (Option.isNone(fact)) {
      // Verified, but not a fact we act on (non-PR event, unmerged close, ...).
      return HttpServerResponse.empty({ status: 202 });
    }

    // D18: journalling/firing failures are detector health — log and still ack,
    // so GitHub does not retry a delivery we already accepted.
    const ingestion = yield* EventIngestion;
    yield* ingestion.ingest(fact.value).pipe(
      Effect.catch((error) =>
        Effect.logWarning("GitHub webhook ingestion failed", {
          deliveryKey: fact.value.deliveryKey,
          error,
        }),
      ),
    );

    return HttpServerResponse.empty({ status: 202 });
  }),
);
