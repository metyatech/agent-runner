import type { GitHubClient, IssueInfo, RepoInfo } from "./github.js";
import { chooseMergeMethod, summarizeLatestReviews } from "./pr-review-automation.js";

export type ResolveThreadsResult = {
  total: number;
  unresolvedBefore: number;
  resolved: number;
};

export async function resolveAllUnresolvedReviewThreads(options: {
  client: GitHubClient;
  repo: RepoInfo;
  pullNumber: number;
}): Promise<ResolveThreadsResult> {
  const threads = await options.client.listPullRequestReviewThreads(options.repo, options.pullNumber);
  const unresolved = threads.filter((thread) => !thread.isResolved);
  let resolved = 0;
  for (const thread of unresolved) {
    await options.client.resolvePullRequestReviewThread(thread.id);
    resolved += 1;
  }
  return {
    total: threads.length,
    unresolvedBefore: unresolved.length,
    resolved
  };
}

export type AutoMergeResult =
  | { merged: true; branchDeleted: boolean; mergeMethod: string }
  | { merged: false; retry: boolean; reason: string };

async function waitForMergeable(options: {
  client: GitHubClient;
  repo: RepoInfo;
  pullNumber: number;
  attempts: number;
  delayMs: number;
}): Promise<{ mergeable: boolean | null; mergeableState: string | null; headSha: string } | null> {
  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    const pr = await options.client.getPullRequest(options.repo, options.pullNumber);
    if (!pr) {
      return null;
    }
    if (pr.mergeable !== null) {
      return { mergeable: pr.mergeable, mergeableState: pr.mergeableState, headSha: pr.headSha };
    }
    await new Promise((resolve) => setTimeout(resolve, options.delayMs));
  }
  const pr = await options.client.getPullRequest(options.repo, options.pullNumber);
  if (!pr) return null;
  return { mergeable: pr.mergeable, mergeableState: pr.mergeableState, headSha: pr.headSha };
}

function isMergeableStateClean(state: string | null): boolean {
  if (!state) return false;
  const normalized = state.toLowerCase();
  return normalized === "clean";
}

export async function attemptAutoMergeApprovedPullRequest(options: {
  client: GitHubClient;
  repo: RepoInfo;
  pullNumber: number;
  issue: IssueInfo;
}): Promise<AutoMergeResult> {
  const pr = await options.client.getPullRequest(options.repo, options.pullNumber);
  if (!pr) {
    return { merged: false, retry: false, reason: "pr_not_found" };
  }
  if (pr.state !== "open") {
    return { merged: false, retry: false, reason: `pr_not_open:${pr.state}` };
  }
  if (pr.merged) {
    return { merged: false, retry: false, reason: "already_merged" };
  }
  if (pr.draft) {
    return { merged: false, retry: true, reason: "draft" };
  }

  try {
    await resolveAllUnresolvedReviewThreads({
      client: options.client,
      repo: options.repo,
      pullNumber: options.pullNumber
    });
  } catch {
    // Best-effort: we'll still validate threads below.
  }

  try {
    const threads = await options.client.listPullRequestReviewThreads(options.repo, options.pullNumber);
    const unresolved = threads.filter((thread) => !thread.isResolved);
    if (unresolved.length > 0) {
      return { merged: false, retry: true, reason: "unresolved_review_threads" };
    }
  } catch {
    return { merged: false, retry: true, reason: "review_threads_unavailable" };
  }

  const reviews = await options.client.listPullRequestReviews(options.repo, options.pullNumber);
  const summary = summarizeLatestReviews(
    reviews.map((review) => ({
      author: review.author,
      state: review.state,
      submittedAt: review.submittedAt
    }))
  );

  if (!summary.approved) {
    return { merged: false, retry: false, reason: "not_approved" };
  }

  const mergeOptions = await options.client.getRepoMergeOptions(options.repo);
  const mergeMethod = chooseMergeMethod(mergeOptions);
  if (!mergeMethod) {
    return { merged: false, retry: false, reason: "no_merge_method_enabled" };
  }

  const mergeable = await waitForMergeable({
    client: options.client,
    repo: options.repo,
    pullNumber: options.pullNumber,
    attempts: 10,
    delayMs: 500
  });
  if (!mergeable) {
    return { merged: false, retry: true, reason: "mergeable_unavailable" };
  }
  if (!mergeable.mergeable || !isMergeableStateClean(mergeable.mergeableState)) {
    return {
      merged: false,
      retry: true,
      reason: `not_mergeable:${mergeable.mergeableState ?? "unknown"}`
    };
  }

  const mergeResult = await options.client.mergePullRequest({
    repo: options.repo,
    pullNumber: options.pullNumber,
    sha: mergeable.headSha,
    mergeMethod,
    commitTitle: `agent-runner: merge #${options.pullNumber}`,
    commitMessage: `Auto-merged after approval: ${options.issue.url}`
  });
  if (!mergeResult.merged) {
    return { merged: false, retry: true, reason: `merge_failed:${mergeResult.message ?? "unknown"}` };
  }

  let branchDeleted = false;
  const expectedRepo = `${options.repo.owner}/${options.repo.repo}`.toLowerCase();
  if (pr.headRepoFullName?.toLowerCase() === expectedRepo) {
    try {
      await options.client.deleteBranchRef(options.repo, `heads/${pr.headRef}`);
      branchDeleted = true;
    } catch {
      // ignore
    }
  }

  return { merged: true, branchDeleted, mergeMethod };
}

