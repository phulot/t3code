import type { AtomRef } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { matchesAtom, validateAtom } from "./AtomDomainRegistry.ts";

const prAtom = (params: Record<string, unknown>): AtomRef => ({
  domain: "git",
  type: "pr.merged",
  params,
});

const prMergedFact = (params: Record<string, unknown>) => ({
  domain: "git",
  type: "pr.merged",
  params,
});

describe("validateAtom git/pr.merged", () => {
  it.effect("accepts params with a pr number", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(validateAtom(prAtom({ repo: "octo/repo", pr: 42 })));
      assert.isTrue(Exit.isSuccess(exit));
    }),
  );

  it.effect("accepts params with only a branch", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        validateAtom(prAtom({ repo: "octo/repo", branch: "feature/x" })),
      );
      assert.isTrue(Exit.isSuccess(exit));
    }),
  );

  it.effect("rejects params with neither pr nor branch", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(validateAtom(prAtom({ repo: "octo/repo" })));
      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("rejects params missing repo", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(validateAtom(prAtom({ pr: 42 })));
      assert.isTrue(Exit.isFailure(exit));
    }),
  );
});

describe("matchesAtom git/pr.merged", () => {
  it("matches on repo + pr (repo case-insensitive)", () => {
    assert.isTrue(
      matchesAtom(
        prAtom({ repo: "Octo/Repo", pr: 42 }),
        prMergedFact({ repo: "octo/repo", pr: 42, branch: "feature/x" }),
      ),
    );
  });

  it("matches on repo + branch", () => {
    assert.isTrue(
      matchesAtom(
        prAtom({ repo: "octo/repo", branch: "feature/x" }),
        prMergedFact({ repo: "octo/repo", pr: 42, branch: "feature/x" }),
      ),
    );
  });

  it("does not match a different pr", () => {
    assert.isFalse(
      matchesAtom(
        prAtom({ repo: "octo/repo", pr: 7 }),
        prMergedFact({ repo: "octo/repo", pr: 42, branch: "feature/x" }),
      ),
    );
  });

  it("does not match a different repo", () => {
    assert.isFalse(
      matchesAtom(
        prAtom({ repo: "octo/other", pr: 42 }),
        prMergedFact({ repo: "octo/repo", pr: 42 }),
      ),
    );
  });

  it("requires all specified identifiers to match", () => {
    assert.isFalse(
      matchesAtom(
        prAtom({ repo: "octo/repo", pr: 42, branch: "other" }),
        prMergedFact({ repo: "octo/repo", pr: 42, branch: "feature/x" }),
      ),
    );
  });

  it("returns false for a STATE atom (no matches)", () => {
    assert.isFalse(
      matchesAtom(
        {
          domain: "git",
          type: "ref.merged",
          params: { worktreePath: "/x", ref: "a", base: "b" },
        } satisfies AtomRef,
        prMergedFact({ repo: "octo/repo", pr: 42 }),
      ),
    );
  });

  it("returns false for an unknown atom type", () => {
    assert.isFalse(
      matchesAtom(
        { domain: "git", type: "nope", params: {} } satisfies AtomRef,
        prMergedFact({ repo: "octo/repo", pr: 42 }),
      ),
    );
  });
});
