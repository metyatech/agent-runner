import type { AgentRunnerConfig } from "./config.js";
import type { GitHubClient, IssueInfo, RepoInfo } from "./github.js";
import { ensureManagedPullRequestRecorded, isManagedPullRequestIssue } from "./managed-pr.js";
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

  const excludeLabels = [
    options.config.labels.queued,
    options.config.labels.running,
    options.config.labels.needsUserReply,
    options.config.labels.failed
  ];

  const managedStatePath = resolveManagedPullRequestsStatePath(options.config.workdirRoot);
  let managed: Array<{ repo: RepoInfo; prNumber: number; key: string }> = [];
  try {
    managed = await listManagedPullRequests(managedStatePath, { limit: 50 });
  } catch (error) {
    options.onLog?.("warn", "Managed PR catch-up scan failed to read state.", {
      error: error instanceof Error ? error.message : String(error)
    });
  }

  const candidates: Array<{ repo: RepoInfo; prNumber: number; key: string; source: "state" | "search" }> = [];
  const seen = new Set<string>();
  for (const entry of managed.slice().reverse()) {
    if (seen.has(entry.key)) {
      continue;
    }
    seen.add(entry.key);
    candidates.push({ ...entry, source: "state" });
  }

  const targetCandidates = Math.max(1, Math.min(50, limit * 10));
  const botAuthorLogins = ["agent-runner-bot", "app/agent-runner-bot", "agent-runner-app[bot]"];
  for (const login of botAuthorLogins) {
    if (candidates.length >= targetCandidates) {
      break;
    }
    let found: IssueInfo[] = [];
    try {
      const remaining = targetCandidates - candidates.length;
      found = await options.client.searchOpenPullRequestsByAuthorAcrossOwner(options.config.owner, login, {
        excludeLabels,
        perPage: remaining,
        maxPages: 1
      });
    } catch (error) {
      options.onLog?.("warn", "Managed PR catch-up scan failed to search for agent-runner bot PRs.", {
        author: login,
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }
    for (const item of found) {
      if (candidates.length >= targetCandidates) {
        break;
      }
      if (!item.isPullRequest) {
        continue;
      }
      const key = `${item.repo.owner.toLowerCase()}/${item.repo.repo.toLowerCase()}#${item.number}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      candidates.push({ repo: item.repo, prNumber: item.number, key, source: "search" });
    }
  }

  if (candidates.length === 0) {
    return 0;
  }

  const reviewQueuePath = resolveReviewQueuePath(options.config.workdirRoot);
  let enqueued = 0;
  for (const entry of candidates) {
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
    if (entry.source === "search") {
      let isManaged: boolean;
      try {
        isManaged = await isManagedPullRequestIssue(issue, options.config);
      } catch (error) {
        options.onLog?.("warn", "Managed PR catch-up scan failed to check managed PR state.", {
          url: issue.url,
          error: error instanceof Error ? error.message : String(error)
        });
        continue;
      }
      if (!isManaged) {
        continue;
      }
      try {
        await ensureManagedPullRequestRecorded(issue, options.config);
      } catch (error) {
        options.onLog?.("warn", "Managed PR catch-up scan failed to record managed PR state.", {
          url: issue.url,
          error: error instanceof Error ? error.message : String(error)
        });
      }
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
