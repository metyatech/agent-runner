import type { AgentRunnerConfig } from "./config.js";
import type { GitHubClient, IssueInfo, RepoInfo } from "./github.js";
import { ensureManagedPullRequestRecorded, isManagedPullRequestIssue } from "./managed-pr.js";
import { summarizeLatestReviews } from "./pr-review-automation.js";
import { enqueueReviewTask, resolveReviewQueuePath } from "./review-queue.js";
import { listManagedPullRequests, resolveManagedPullRequestsStatePath } from "./managed-pull-requests.js";

function buildCandidateKey(repo: RepoInfo, prNumber: number): string {
  return `${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}#${prNumber}`;
}

async function enqueueFollowupWithLabel(options: {
  client: GitHubClient;
  config: AgentRunnerConfig;
  issue: IssueInfo;
  reviewQueuePath: string;
  entry: {
    issueId: number;
    prNumber: number;
    repo: RepoInfo;
    url: string;
    reason: "review_comment" | "review" | "approval";
    requiresEngine: boolean;
  };
  onLog?: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
}): Promise<boolean> {
  const added = await enqueueReviewTask(options.reviewQueuePath, options.entry);
  if (!added) {
    return false;
  }
  try {
    await options.client.addLabels(options.issue, [options.config.labels.reviewFollowup]);
  } catch (error) {
    options.onLog?.("warn", "Managed PR catch-up scan failed to add review follow-up label.", {
      url: options.issue.url,
      error: error instanceof Error ? error.message : String(error)
    });
  }
  return true;
}

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
    options.config.labels.reviewFollowup,
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
    const key = buildCandidateKey(entry.repo, entry.prNumber);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    candidates.push({ repo: entry.repo, prNumber: entry.prNumber, key, source: "state" });
  }

  const allowedRepos =
    Array.isArray(options.config.repos) && options.config.repos.length > 0
      ? new Set(options.config.repos.map((repo) => `${options.config.owner.toLowerCase()}/${repo.toLowerCase()}`))
      : null;

  const targetCandidates = Math.max(1, Math.min(50, limit * 10));
  const botAuthorLogins = ["app/agent-runner-bot"];
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
      if (allowedRepos) {
        const repoKey = `${item.repo.owner.toLowerCase()}/${item.repo.repo.toLowerCase()}`;
        if (!allowedRepos.has(repoKey)) {
          continue;
        }
      }
      const key = buildCandidateKey(item.repo, item.number);
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
      issue.labels.includes(options.config.labels.reviewFollowup) ||
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
        const added = await enqueueFollowupWithLabel({
          client: options.client,
          config: options.config,
          issue,
          reviewQueuePath,
          entry: {
            issueId: issue.id,
            prNumber: entry.prNumber,
            repo: entry.repo,
            url: issue.url,
            reason: "review_comment",
            requiresEngine: true
          },
          onLog: options.onLog
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
      const added = await enqueueFollowupWithLabel({
        client: options.client,
        config: options.config,
        issue,
        reviewQueuePath,
        entry: {
          issueId: issue.id,
          prNumber: entry.prNumber,
          repo: entry.repo,
          url: issue.url,
          reason: "review",
          requiresEngine: true
        },
        onLog: options.onLog
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
      const added = await enqueueFollowupWithLabel({
        client: options.client,
        config: options.config,
        issue,
        reviewQueuePath,
        entry: {
          issueId: issue.id,
          prNumber: entry.prNumber,
          repo: entry.repo,
          url: issue.url,
          reason: "approval",
          requiresEngine: false
        },
        onLog: options.onLog
      });
      if (added) {
        enqueued += 1;
      }
    }
  }

  return enqueued;
}
