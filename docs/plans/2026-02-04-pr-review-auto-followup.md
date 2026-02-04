# PR Review Auto-Followup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Automatically handle PR review feedback (review comments / reviews) for agent-runner-managed PRs using spare capacity, under the same usage-gate conditions as `idle`.

**Architecture:** Add a dedicated `review-queue` persisted state (separate from the existing request queue). Webhooks enqueue PRs on review feedback. The runner loop consumes review-queue entries only when idle usage-gates allow and concurrency has spare slots; it re-runs the agent on the PR branch, then resolves review threads and auto-merges when approved.

**Tech Stack:** Node.js (TypeScript), Octokit REST + GraphQL, existing agent-runner runner loop, Vitest.

---

## Definitions

- **Managed PR**:
  - PR author is a bot (`*[*]bot`), OR
  - PR already has `config.labels.request` (meaning it was previously run via `/agent run` / agent-runner flow).
- **Review feedback event**:
  - `pull_request_review_comment` (created), OR
  - `pull_request_review` (submitted with state `approved` or `changes_requested`, or non-empty body).
- **Idle conditions**:
  - Use the same engine allow-list and gating logic as the current idle scheduling path in `src/cli.ts` (Codex/Copilot/Gemini/AmazonQ).

---

## Task 1: Add review queue state (RED)

**Files:**
- Create: `src/review-queue.ts`
- Test: `tests/unit/review-queue.test.ts`

**Step 1: Write the failing test**

Create `tests/unit/review-queue.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { RepoInfo } from "../../src/github.js";
import { enqueueReviewTask, loadReviewQueue } from "../../src/review-queue.js";

describe("review-queue", () => {
  it("enqueues and dedupes by issueId", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-review-queue-"));
    const queuePath = path.join(root, "agent-runner", "state", "review-queue.json");
    const repo: RepoInfo = { owner: "metyatech", repo: "demo" };
    const inserted1 = await enqueueReviewTask(queuePath, {
      issueId: 123,
      repo,
      prNumber: 5,
      url: "https://github.com/metyatech/demo/pull/5",
      reason: "review_comment",
      requiresEngine: true
    });
    const inserted2 = await enqueueReviewTask(queuePath, {
      issueId: 123,
      repo,
      prNumber: 5,
      url: "https://github.com/metyatech/demo/pull/5",
      reason: "review_comment",
      requiresEngine: true
    });
    expect(inserted1).toBe(true);
    expect(inserted2).toBe(false);
    expect(loadReviewQueue(queuePath)).toHaveLength(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/review-queue.test.ts`
Expected: FAIL (module missing).

**Step 3: Write minimal implementation**

Create `src/review-queue.ts` mirroring the style of `src/webhook-queue.ts`:
- lock-file based concurrency (same pattern)
- `ReviewQueueEntry` includes: `issueId`, `repo`, `prNumber`, `url`, `reason`, `requiresEngine`, `enqueuedAt`
- Deduplicate by `issueId`
- Cap queue length (e.g., keep last 10,000)

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/review-queue.test.ts`
Expected: PASS.

**Step 5: Commit**

Run:
- `git add src/review-queue.ts tests/unit/review-queue.test.ts`
- `git commit -m "feat: add review queue state"`

---

## Task 2: Enqueue managed PRs on review feedback (RED)

**Files:**
- Modify: `src/webhook-handler.ts`
- Test: `tests/unit/webhook-handler-review-followup.test.ts`

**Step 1: Write failing test**

Create a test that:
- Sends a `pull_request_review_comment` webhook payload (not containing `/agent run`)
- Mocks `client.getIssue()` to return an IssueInfo for a PR with `author: "agent-runner-bot[bot]"` (managed)
- Asserts the PR is enqueued into review-queue and labels are refreshed for re-run (at minimum: `agent:request`)

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/webhook-handler-review-followup.test.ts`
Expected: FAIL (handler not implemented).

**Step 3: Minimal implementation**

In `src/webhook-handler.ts`:
- Extend payload typing for `pull_request_review` and `pull_request_review_comment`
- Add a path for non-`/agent run` review comments:
  - Resolve PR issue via `client.getIssue(repo, prNumber)`
  - If not managed, ignore
  - Enqueue into review-queue with `requiresEngine: true`
- Add a path for `pull_request_review` submitted:
  - If managed, enqueue with:
    - `requiresEngine: true` when `changes_requested` or body non-empty
    - `requiresEngine: false` when `approved` (merge-check only)

**Step 4: Verify pass**

Run: `npm test -- tests/unit/webhook-handler-review-followup.test.ts`

**Step 5: Commit**

Run:
- `git add src/webhook-handler.ts tests/unit/webhook-handler-review-followup.test.ts`
- `git commit -m "feat: enqueue managed PRs on review feedback"`

---

## Task 3: Include PR review comments in the agent prompt (RED)

**Files:**
- Modify: `src/github.ts`
- Modify: `src/runner.ts`
- Test: `tests/unit/runner-prompt-review-comments.test.ts`

**Step 1: Write failing test**

Test `buildIssueTaskText(...)` includes a section for “PR review comments” when provided.

**Step 2: Run and verify RED**

Run: `npm test -- tests/unit/runner-prompt-review-comments.test.ts`
Expected: FAIL.

**Step 3: Minimal implementation**

- Add `GitHubClient.listPullRequestReviewComments(repo, prNumber)` using `octokit.pulls.listReviewComments`.
- In `runIssue(...)` detect PR URL and fetch review comments in addition to issue comments.
- Extend `buildIssueTaskText(...)` to include recent review comments similarly to issue comments (limit count/bytes).

**Step 4: Verify GREEN**

Run: `npm test -- tests/unit/runner-prompt-review-comments.test.ts`

**Step 5: Commit**

Run:
- `git add src/github.ts src/runner.ts tests/unit/runner-prompt-review-comments.test.ts`
- `git commit -m "feat: include PR review comments in prompts"`

---

## Task 4: Consume review queue with idle gating + spare concurrency (RED)

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/runner.ts` (if needed for a review-specific entrypoint)
- Test: `tests/unit/cli-review-scheduler.test.ts` (logic-level, mocked)

**Step 1: Write failing test**

Add a unit test that:
- Simulates: normal request queue has fewer items than `concurrency`
- Simulates: review-queue has entries
- Simulates: idle engines allow-list contains at least one engine
- Asserts: review tasks are executed for remaining slots (without touching normal request execution order)

Prefer to isolate scheduling decisions into a pure helper that can be tested with mocks.

**Step 2: Verify RED**

Run: `npm test -- tests/unit/cli-review-scheduler.test.ts`

**Step 3: Minimal implementation**

In `src/cli.ts` runner loop:
- Load review queue from `workdirRoot/agent-runner/state/review-queue.json`
- If review queue non-empty and spare capacity exists:
  - Compute allowed engines using the same gating as idle (refactor the engine gating logic into a helper to avoid duplication).
  - Run up to `spareSlots` review tasks.
  - Each task:
    - Add `running` label, remove `queued` label if present
    - Call `runIssue(...)` (engine selection round-robin like idle)
    - On success/failure: same label/comment handling as normal issues
    - Remove entry from review queue when processed (even on failure, it will be retried via new review feedback or manual trigger).

**Step 4: Verify GREEN**

Run: `npm test -- tests/unit/cli-review-scheduler.test.ts`

**Step 5: Commit**

Run:
- `git add src/cli.ts tests/unit/cli-review-scheduler.test.ts src/review-queue.ts`
- `git commit -m "feat: run review followups with idle gating"`

---

## Task 5: Resolve review threads + auto-merge on approval (RED)

**Files:**
- Modify: `src/github.ts`
- Create: `src/pr-review-automation.ts`
- Test: `tests/unit/pr-review-automation.test.ts`

**Step 1: Write failing tests**

Unit-test pure logic that:
- When `approved` and no conflicts -> calls merge + delete ref
- When not approved -> does not merge
- When resolving threads -> calls `resolveReviewThread` for each unresolved thread id

Mock GitHubClient methods rather than mocking Octokit directly.

**Step 2: Verify RED**

Run: `npm test -- tests/unit/pr-review-automation.test.ts`

**Step 3: Minimal implementation**

- Add to `GitHubClient`:
  - `listPullRequestReviews(repo, prNumber)` (REST `pulls.listReviews`)
  - `mergePullRequest(repo, prNumber)` (REST `pulls.merge`)
  - `deleteBranchRef(repo, ref)` (REST `git.deleteRef`)
  - `listPullRequestReviewThreads(repo, prNumber)` (GraphQL)
  - `resolveReviewThread(threadId)` (GraphQL mutation)
- Implement `src/pr-review-automation.ts`:
  - `resolveAllReviewThreads(client, repo, prNumber)`
  - `maybeAutoMerge(client, repo, prNumber)`
- Wire into review-queue processing:
  - After a successful engine run: resolve threads, then if approved merge + delete head branch.
  - For `requiresEngine: false` entries: just attempt resolve+merge.

**Step 4: Verify GREEN**

Run: `npm test -- tests/unit/pr-review-automation.test.ts`

**Step 5: Commit**

Run:
- `git add src/github.ts src/pr-review-automation.ts tests/unit/pr-review-automation.test.ts`
- `git commit -m "feat: auto-resolve review threads and merge managed PRs"`

---

## Final Verification

Run:
- `npm run lint`
- `npm test`
- `npm run build`

Expected: all green.

