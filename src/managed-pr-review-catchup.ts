import type { AgentRunnerConfig } from "./config.js";
import type { GitHubClient, IssueInfo, RepoInfo } from "./github.js";
import { summarizeLatestReviews } from "./pr-review-automation.js";
import { enqueueReviewTask, resolveReviewQueuePath } from "./review-queue.js";
import { listManagedPullRequests, resolveManagedPullRequestsStatePath } from "./managed-pull-requests.js";

export async function enqueueManagedPullRequestReviewFollowups(options: {
  client: GitHubClient;
  config: AgentRunnerConfig;
  maxEntries: number;
  dryRun: boolean;
  onLog?: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
}): Promise<number> {
  const limit = Math.max(0, Math.floor(options.maxEntries));
  if (limit <= 0) {
    return 0;
  }
  if (!options.config.idle?.enabled) {
    return 0;
  }

  const managedStatePath = resolveManagedPullRequestsStatePath(options.config.workdirRoot);
  let managed: Array<{ repo: RepoInfo; prNumber: number; key: string }> = [];
  try {
    managed = await listManagedPullRequests(managedStatePath, { limit: 50 });
  } catch (error) {
    options.onLog?.("warn", "Managed PR catch-up scan failed to read state.", {
      error: error instanceof Error ? error.message : String(error)
    });
    return 0;
  }

  if (managed.length === 0) {
    return 0;
  }

  const reviewQueuePath = resolveReviewQueuePath(options.config.workdirRoot);
  let enqueued = 0;
  for (const entry of managed.slice().reverse()) {
    if (enqueued >= limit) {
      break;
    }

    let issue: IssueInfo | null;
    try {
      issue = await options.client.getIssue(entry.repo, entry.prNumber);
    } catch (error) {
      options.onLog?.("warn", "Managed PR catch-up scan failed to resolve issue.", {
        pr: entry.key,
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }
    if (!issue || !issue.isPullRequest) {
      continue;
    }
    if (
      issue.labels.includes(options.config.labels.queued) ||
      issue.labels.includes(options.config.labels.running) ||
      issue.labels.includes(options.config.labels.needsUserReply) ||
      issue.labels.includes(options.config.labels.failed)
    ) {
      continue;
    }

    const pr = await options.client.getPullRequest(entry.repo, entry.prNumber);
    if (!pr || pr.state !== "open" || pr.merged || pr.draft) {
      continue;
    }

    try {
      const threads = await options.client.listPullRequestReviewThreads(entry.repo, entry.prNumber);
      const unresolved = threads.filter((thread) => !thread.isResolved);
      if (unresolved.length > 0) {
        if (options.dryRun) {
          enqueued += 1;
          continue;
        }
        const added = await enqueueReviewTask(reviewQueuePath, {
          issueId: issue.id,
          prNumber: entry.prNumber,
          repo: entry.repo,
          url: issue.url,
          reason: "review_comment",
          requiresEngine: true
        });
        if (added) {
          enqueued += 1;
        }
        continue;
      }
    } catch (error) {
      options.onLog?.("warn", "Managed PR catch-up scan failed to read review threads.", {
        url: issue.url,
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }

    let reviews;
    try {
      reviews = await options.client.listPullRequestReviews(entry.repo, entry.prNumber);
    } catch (error) {
      options.onLog?.("warn", "Managed PR catch-up scan failed to read pull request reviews.", {
        url: issue.url,
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }

    const summary = summarizeLatestReviews(
      reviews.map((review) => ({
        state: review.state,
        author: review.author,
        submittedAt: review.submittedAt,
        body: review.body
      })),
      pr.requestedReviewerLogins
    );

    if (summary.changesRequested > 0 || summary.actionableComments > 0) {
      if (options.dryRun) {
        enqueued += 1;
        continue;
      }
      const added = await enqueueReviewTask(reviewQueuePath, {
        issueId: issue.id,
        prNumber: entry.prNumber,
        repo: entry.repo,
        url: issue.url,
        reason: "review",
        requiresEngine: true
      });
      if (added) {
        enqueued += 1;
      }
      continue;
    }

    if (summary.approved) {
      if (options.dryRun) {
        enqueued += 1;
        continue;
      }
      const added = await enqueueReviewTask(reviewQueuePath, {
        issueId: issue.id,
        prNumber: entry.prNumber,
        repo: entry.repo,
        url: issue.url,
        reason: "approval",
        requiresEngine: false
      });
      if (added) {
        enqueued += 1;
      }
    }
  }

  return enqueued;
}
