#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Command } from "commander";
import pLimit from "p-limit";
import { loadConfig } from "./config.js";
import type { AgentRunnerConfig } from "./config.js";
import { GitHubClient, type IssueInfo, type LabelInfo, type RepoInfo } from "./github.js";
import { buildAgentLabels } from "./labels.js";
import { log } from "./logger.js";
import { acquireLock, releaseLock } from "./lock.js";
import { buildAgentComment, hasUserReplySince, NEEDS_USER_MARKER } from "./notifications.js";
import { createGitHubNotifyClient } from "./github-notify-client.js";
import {
  evaluateUsageGate,
  fetchCodexRateLimits,
  rateLimitSnapshotToStatus
} from "./codex-status.js";
import { evaluateCopilotUsageGate, fetchCopilotUsage } from "./copilot-usage.js";
import { evaluateGeminiUsageGate, fetchGeminiUsage } from "./gemini-usage.js";
import {
  evaluateGeminiWarmup,
  loadGeminiWarmupState,
  recordGeminiWarmupAttempt,
  resolveGeminiWarmupStatePath
} from "./gemini-warmup.js";
import {
  evaluateAmazonQUsageGate,
  getAmazonQUsageSnapshot,
  resolveAmazonQUsageStatePath
} from "./amazon-q-usage.js";
import { commandExists } from "./command-exists.js";
import { listTargetRepos, listQueuedIssues, pickNextIssues } from "./queue.js";
import { planIdleTasks, runIdleTask, runIssue } from "./runner.js";
import type { IdleEngine, IdleTaskResult } from "./runner.js";
import { listLocalRepos } from "./local-repos.js";
import {
  evaluateRunningIssues,
  isProcessAlive,
  loadRunnerState,
  removeRunningIssue,
  resolveRunnerStatePath
} from "./runner-state.js";
import { startStatusServer } from "./status-server.js";
import { buildStatusSnapshot } from "./status-snapshot.js";
import { pruneDeadActivityRecords, removeActivity, resolveActivityStatePath } from "./activity-state.js";
import { clearStopRequest, isStopRequested, requestStop } from "./stop-flag.js";
import { handleWebhookEvent } from "./webhook-handler.js";
import { startWebhookServer } from "./webhook-server.js";
import {
  enqueueWebhookIssue,
  loadWebhookQueue,
  removeWebhookIssues,
  resolveWebhookQueuePath
} from "./webhook-queue.js";
import {
  loadWebhookCatchupState,
  resolveWebhookCatchupStatePath,
  saveWebhookCatchupState
} from "./webhook-catchup-state.js";
import { isAllowedAuthorAssociation, parseAgentCommand } from "./agent-command.js";
import {
  hasProcessedAgentCommandComment,
  markAgentCommandCommentProcessed,
  resolveAgentCommandStatePath
} from "./agent-command-state.js";
import { pruneLogs, resolveLogMaintenance, resolveLogsDir } from "./log-maintenance.js";
import { pruneReports, resolveReportMaintenance, resolveReportsDir } from "./report-maintenance.js";
import {
  enqueueReviewTask,
  loadReviewQueue,
  resolveReviewQueuePath,
  takeReviewTasks,
  takeReviewTasksWhere,
  type ReviewQueueEntry
} from "./review-queue.js";
import { scheduleReviewFollowups } from "./review-scheduler.js";
import type { ScheduledReviewFollowup } from "./review-scheduler.js";
import {
  attemptAutoMergeApprovedPullRequest,
  reRequestAllReviewers,
  resolveAllUnresolvedReviewThreads
} from "./pr-review-actions.js";
import { summarizeLatestReviews } from "./pr-review-automation.js";
import {
  listManagedPullRequests,
  markManagedPullRequest,
  resolveManagedPullRequestsStatePath
} from "./managed-pull-requests.js";
import {
  clearIssueSession,
  getIssueSession,
  resolveIssueSessionStatePath,
  setIssueSession
} from "./issue-session-state.js";
import {
  clearRetry,
  resolveScheduledRetryStatePath,
  scheduleRetry,
  takeDueRetries
} from "./scheduled-retry-state.js";
import { recoverStalledIssue } from "./stalled-issue-recovery.js";
import { createServiceLimiters, idleEngineToService } from "./service-concurrency.js";

const program = new Command();

function resolveWebhookSecret(config?: AgentRunnerConfig["webhooks"]): string | null {
  if (!config) {
    return null;
  }
  if (config.secret) {
    return config.secret;
  }
  if (config.secretEnv) {
    return process.env[config.secretEnv] ?? null;
  }
  return null;
}

async function maybeRunWebhookCatchup(options: {
  client: GitHubClient;
  config: AgentRunnerConfig;
  webhookConfig: NonNullable<AgentRunnerConfig["webhooks"]>;
  queuePath: string;
  json: boolean;
  dryRun: boolean;
  now: Date;
}): Promise<void> {
  const { client, config, webhookConfig, queuePath, json, dryRun, now } = options;
  const catchup = webhookConfig.catchup;
  if (!catchup || !catchup.enabled) {
    return;
  }
  const statePath = resolveWebhookCatchupStatePath(config.workdirRoot);
  const state = loadWebhookCatchupState(statePath);
  const intervalMs = catchup.intervalMinutes * 60 * 1000;
  if (state.lastRunAt) {
    const last = Date.parse(state.lastRunAt);
    if (!Number.isNaN(last) && now.getTime() - last < intervalMs) {
      return;
    }
  }

  const maxIssues = catchup.maxIssuesPerRun;
  const excludeLabels = [
    config.labels.queued,
    config.labels.running,
    config.labels.done,
    config.labels.failed,
    config.labels.needsUserReply
  ];

  log("info", "Webhook catch-up scan: searching for missed /agent run comment requests.", json, {
    intervalMinutes: catchup.intervalMinutes,
    maxIssuesPerRun: maxIssues
  });

  const parsedLastRunAt = state.lastRunAt ? Date.parse(state.lastRunAt) : Number.NaN;
  const lastRunAt = Number.isNaN(parsedLastRunAt) ? now.getTime() - intervalMs : parsedLastRunAt;
  const commandStatePath = resolveAgentCommandStatePath(config.workdirRoot);
  let found: IssueInfo[] = [];
  try {
    const byCommand = await client.searchOpenItemsByCommentPhraseAcrossOwner(config.owner, "/agent run", {
      excludeLabels,
      perPage: 100,
      maxPages: 1
    });
    found = byCommand;
  } catch (error) {
    log("warn", "Webhook catch-up scan failed.", json, {
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  if (found.length === 0) {
    saveWebhookCatchupState(statePath, { lastRunAt: now.toISOString() });
    return;
  }

  const limited = found.slice(0, maxIssues);
  log("info", `Webhook catch-up scan found ${found.length} issue(s).`, json, {
    queued: limited.length
  });

  let hadErrors = false;
  for (const issue of limited) {
    if (dryRun) {
      log("info", `Dry-run: would queue catch-up issue ${issue.url}`, json);
      continue;
    }

    let triggerCommentId: number | null = null;
    const comments = await client.listIssueComments(issue);
    for (const comment of comments) {
      const createdAt = Date.parse(comment.createdAt);
      if (Number.isNaN(createdAt) || createdAt <= lastRunAt) {
        continue;
      }
      if (!isAllowedAuthorAssociation(comment.authorAssociation)) {
        continue;
      }
      if (parseAgentCommand(comment.body)?.kind !== "run") {
        continue;
      }
      const already = await hasProcessedAgentCommandComment(commandStatePath, comment.id);
      if (already) {
        continue;
      }
      triggerCommentId = comment.id;
      break;
    }
    if (!triggerCommentId) {
      continue;
    }
    try {
      await client.addLabels(issue, [config.labels.queued]);
    } catch (error) {
      hadErrors = true;
      log("warn", "Failed to add queued label during catch-up.", json, {
        issue: issue.url,
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }
    try {
      await enqueueWebhookIssue(queuePath, issue);
    } catch (error) {
      hadErrors = true;
      log("warn", "Failed to enqueue catch-up issue.", json, {
        issue: issue.url,
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }

    await markAgentCommandCommentProcessed(commandStatePath, triggerCommentId);
  }

  if (!hadErrors) {
    saveWebhookCatchupState(statePath, { lastRunAt: now.toISOString() });
  }
}

async function maybeEnqueueManagedPullRequestReviewFollowups(options: {
  client: GitHubClient;
  config: AgentRunnerConfig;
  json: boolean;
  dryRun: boolean;
  maxEntries: number;
}): Promise<void> {
  const { client, config, json, dryRun } = options;
  const limit = Math.max(0, Math.floor(options.maxEntries));
  if (limit <= 0) {
    return;
  }
  if (!config.idle?.enabled) {
    return;
  }

  const managedStatePath = resolveManagedPullRequestsStatePath(config.workdirRoot);
  let managed: Array<{ repo: RepoInfo; prNumber: number; key: string }> = [];
  try {
    managed = await listManagedPullRequests(managedStatePath, { limit: 50 });
  } catch (error) {
    log("warn", "Managed PR catch-up scan failed to read state.", json, {
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  if (managed.length === 0) {
    return;
  }

  const reviewQueuePath = resolveReviewQueuePath(config.workdirRoot);
  let enqueued = 0;
  for (const entry of managed.slice().reverse()) {
    if (enqueued >= limit) {
      break;
    }

    let issue: IssueInfo | null;
    try {
      issue = await client.getIssue(entry.repo, entry.prNumber);
    } catch (error) {
      log("warn", "Managed PR catch-up scan failed to resolve issue.", json, {
        pr: entry.key,
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }
    if (!issue || !issue.isPullRequest) {
      continue;
    }
    if (!issue.labels.includes(config.labels.done)) {
      continue;
    }
    if (
      issue.labels.includes(config.labels.queued) ||
      issue.labels.includes(config.labels.running) ||
      issue.labels.includes(config.labels.needsUserReply) ||
      issue.labels.includes(config.labels.failed)
    ) {
      continue;
    }

    const pr = await client.getPullRequest(entry.repo, entry.prNumber);
    if (!pr || pr.state !== "open" || pr.merged || pr.draft) {
      continue;
    }

    try {
      const threads = await client.listPullRequestReviewThreads(entry.repo, entry.prNumber);
      const unresolved = threads.filter((thread) => !thread.isResolved);
      if (unresolved.length > 0) {
        if (dryRun) {
          log("info", "Dry-run: would enqueue managed PR review follow-up due to unresolved review threads.", json, {
            url: issue.url,
            unresolved: unresolved.length
          });
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
      log("warn", "Managed PR catch-up scan failed to read review threads.", json, {
        url: issue.url,
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }

    let reviews;
    try {
      reviews = await client.listPullRequestReviews(entry.repo, entry.prNumber);
    } catch (error) {
      log("warn", "Managed PR catch-up scan failed to read PR reviews.", json, {
        url: issue.url,
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }

    const summary = summarizeLatestReviews(
      reviews.map((review) => ({
        author: review.author,
        state: review.state,
        submittedAt: review.submittedAt,
        body: review.body
      })),
      pr.requestedReviewerLogins
    );

    if (summary.changesRequested > 0 || summary.actionableComments > 0) {
      if (dryRun) {
        log("info", "Dry-run: would enqueue managed PR review follow-up due to changes requested.", json, { url: issue.url });
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
      if (dryRun) {
        log("info", "Dry-run: would enqueue managed PR merge follow-up after approval.", json, { url: issue.url });
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

  if (enqueued > 0) {
    log("info", `Managed PR catch-up scan enqueued ${enqueued} follow-up(s).`, json);
  }
}

async function resolveWebhookQueuedIssues(
  client: GitHubClient,
  config: AgentRunnerConfig,
  queuePath: string,
  json: boolean,
  dryRun: boolean
): Promise<{ issues: IssueInfo[]; removeIds: number[] }> {
  const entries = loadWebhookQueue(queuePath);
  if (entries.length === 0) {
    return { issues: [], removeIds: [] };
  }

  const issues: IssueInfo[] = [];
  const removeIds: number[] = [];
  const seen = new Set<number>();

  for (const entry of entries) {
    if (seen.has(entry.issueId)) {
      removeIds.push(entry.issueId);
      continue;
    }
    seen.add(entry.issueId);
    let issue: IssueInfo | null;
    try {
      issue = await client.getIssue(entry.repo, entry.issueNumber);
    } catch (error) {
      log("warn", "Failed to resolve webhook queued issue; will retry.", json, {
        issue: `${entry.repo.owner}/${entry.repo.repo}#${entry.issueNumber}`,
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }
    if (!issue) {
      removeIds.push(entry.issueId);
      continue;
    }

    if (
      issue.labels.includes(config.labels.running) ||
      issue.labels.includes(config.labels.needsUserReply) ||
      issue.labels.includes(config.labels.done) ||
      issue.labels.includes(config.labels.failed)
    ) {
      removeIds.push(entry.issueId);
      continue;
    }

    if (!issue.labels.includes(config.labels.queued)) {
      if (dryRun) {
        log("info", `Dry-run: would add queued label to ${issue.url}`, json);
        issue.labels = [...issue.labels, config.labels.queued];
      } else {
        try {
          await client.addLabels(issue, [config.labels.queued]);
          issue.labels = [...issue.labels, config.labels.queued];
        } catch (error) {
          log("warn", "Failed to add queued label to webhook issue.", json, {
            issue: issue.url,
            error: error instanceof Error ? error.message : String(error)
          });
          continue;
        }
      }
    }

    if (issue.labels.includes(config.labels.queued)) {
      issues.push(issue);
    } else {
      removeIds.push(entry.issueId);
    }
  }

  return { issues, removeIds };
}

program
  .name("agent-runner")
  .description("Queue and execute GitHub Agent requests using Codex.")
  .version("0.1.0", "-V, --version", "output the version");

program
  .command("run")
  .description("Poll GitHub for Agent requests and execute them.")
  .option("-c, --config <path>", "Path to config file", "agent-runner.config.json")
  .option("--interval <seconds>", "Polling interval in seconds", "60")
  .option("--once", "Run one cycle and exit", false)
  .option("--concurrency <count>", "Override concurrency", "")
  .option("--json", "Output JSON logs", false)
  .option("--dry-run", "List actions without mutating GitHub or running Codex", false)
  .option("--yes", "Bypass confirmation prompts", false)
  .action(async (options) => {
    const json = Boolean(options.json);
    const dryRun = Boolean(options.dryRun);
    const requireYes = !dryRun && !options.yes;

    if (requireYes) {
      throw new Error("Refusing to mutate GitHub without --yes. Use --dry-run to preview.");
    }

    const configPath = path.resolve(process.cwd(), options.config);
    const config = loadConfig(configPath);
    const activityPath = resolveActivityStatePath(config.workdirRoot);
    const webhookConfig = config.webhooks;
    const webhooksEnabled = Boolean(webhookConfig?.enabled);
    const webhookQueuePath = webhooksEnabled
      ? resolveWebhookQueuePath(config.workdirRoot, webhookConfig)
      : null;

    if (options.concurrency) {
      config.concurrency = Number.parseInt(options.concurrency, 10);
    }

    const serviceLimiters = createServiceLimiters(config);

    const token =
      process.env.AGENT_GITHUB_TOKEN ||
      process.env.GITHUB_TOKEN ||
      process.env.GH_TOKEN;

    if (!token) {
      throw new Error("Missing GitHub token. Set AGENT_GITHUB_TOKEN or GITHUB_TOKEN.");
    }

    const logDecision = resolveLogMaintenance(config);
    const pruneResult = pruneLogs({
      dir: resolveLogsDir(config.workdirRoot),
      decision: logDecision,
      dryRun
    });
    if (logDecision.enabled) {
      log("info", pruneResult.dryRun ? "Dry-run: would prune logs." : "Pruned logs.", json, {
        dir: pruneResult.dir,
        scanned: pruneResult.scanned,
        deleted: pruneResult.deleted,
        deletedMB: Math.round((pruneResult.deletedBytes / (1024 * 1024)) * 100) / 100,
        skipped: pruneResult.skipped,
        kept: pruneResult.kept
      });
    }

    const reportDecision = resolveReportMaintenance(config);
    const pruneReportsResult = pruneReports({
      dir: resolveReportsDir(config.workdirRoot),
      decision: reportDecision,
      dryRun
    });
    if (reportDecision.enabled) {
      log("info", pruneReportsResult.dryRun ? "Dry-run: would prune reports." : "Pruned reports.", json, {
        dir: pruneReportsResult.dir,
        scanned: pruneReportsResult.scanned,
        deleted: pruneReportsResult.deleted,
        deletedMB: Math.round((pruneReportsResult.deletedBytes / (1024 * 1024)) * 100) / 100,
        skipped: pruneReportsResult.skipped,
        kept: pruneReportsResult.kept
      });
    }

    let lock: ReturnType<typeof acquireLock>;
    try {
      lock = acquireLock(path.resolve(config.workdirRoot, "agent-runner", "state", "runner.lock"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.once && message.startsWith("Runner already active")) {
        log("info", message, json);
        return;
      }
      throw error;
    }
    const client = new GitHubClient(token);
    const notify = createGitHubNotifyClient(config.workdirRoot);
    const notifyClient = notify?.client ?? null;
    const notifySource = notify?.source ?? null;
    const issueSessionStatePath = resolveIssueSessionStatePath(config.workdirRoot);
    const scheduledRetryStatePath = resolveScheduledRetryStatePath(config.workdirRoot);
    if (notifyClient) {
      log(
        "info",
        notifySource === "github-app"
          ? "GitHub notify client configured via GitHub App. Completion comments will be posted as the app installation."
          : "GitHub notify token detected. Completion comments will be posted as a bot user.",
        json
      );
    }
    const tryRemoveLabel = async (issue: IssueInfo, label: string): Promise<void> => {
      try {
        await client.removeLabel(issue, label);
      } catch (error) {
        log("warn", `Failed to remove label ${label} from ${issue.url}`, json, {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    };

    const commentCompletion = async (issue: IssueInfo, body: string): Promise<void> => {
      if (notifyClient) {
        try {
          await notifyClient.commentIssue(issue.repo, issue.number, body);
          return;
        } catch (error) {
          log("warn", "Failed to post completion comment with notify token; falling back.", json, {
            issue: issue.url,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      await client.comment(issue, body);
    };

    const parsePullRequestUrl = (text: string): { repo: RepoInfo; number: number; url: string } | null => {
      let last: { repo: RepoInfo; number: number; url: string } | null = null;
      const pattern = /https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/gi;
      for (const match of text.matchAll(pattern)) {
        const number = Number.parseInt(match[3], 10);
        if (Number.isNaN(number) || number <= 0) {
          continue;
        }
        last = {
          repo: { owner: match[1], repo: match[2] },
          number,
          url: match[0]
        };
      }
      return last;
    };

    const maybeNotifyIdlePullRequest = async (result: IdleTaskResult): Promise<void> => {
      if (!notifyClient) {
        return;
      }

      const truncate = (value: string, limit: number): string =>
        value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 16))}\n…(truncated)…`;

      const readLogTail = (logPath: string, maxBytes: number): string | null => {
        if (!fs.existsSync(logPath)) {
          return null;
        }
        try {
          const stat = fs.statSync(logPath);
          const size = stat.size;
          if (size <= maxBytes) {
            return fs.readFileSync(logPath, "utf8");
          }

          const fd = fs.openSync(logPath, "r");
          try {
            const buffer = Buffer.allocUnsafe(maxBytes);
            const offset = Math.max(0, size - maxBytes);
            const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, offset);
            return buffer.subarray(0, bytesRead).toString("utf8");
          } finally {
            fs.closeSync(fd);
          }
        } catch {
          return null;
        }
      };

      const summaryText = result.summary ?? "";
      const pr = parsePullRequestUrl(summaryText) ?? parsePullRequestUrl(readLogTail(result.logPath, 512 * 1024) ?? "");
      if (!pr) {
        return;
      }

      const body = buildAgentComment(
        `Agent runner idle ${result.success ? "completed" : "failed"}.\n\n` +
          `Repo: ${result.repo.owner}/${result.repo.repo}\n` +
          `Engine: ${result.engine}\n\n` +
          `Summary:\n${truncate(summaryText || "(missing)", 6000)}`
      );

      try {
        await notifyClient.commentIssue(pr.repo, pr.number, body);
      } catch (error) {
        log("warn", "Failed to post idle completion comment to PR.", json, {
          pr: pr.url,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    };

    const formatResumeTime = (isoText: string): { iso: string; local: string } => {
      const parsed = new Date(isoText);
      if (Number.isNaN(parsed.getTime())) {
        return { iso: isoText, local: isoText };
      }
      return {
        iso: parsed.toISOString(),
        local: parsed.toLocaleString(undefined, { timeZoneName: "short" })
      };
    };

    const enqueueDueScheduledRetries = async (): Promise<number> => {
      if (dryRun) {
        return 0;
      }

      const due = takeDueRetries(scheduledRetryStatePath, new Date());
      if (due.length === 0) {
        return 0;
      }

      let resumed = 0;
      for (const entry of due) {
        const issue = await client.getIssue(entry.repo, entry.issueNumber);
        if (!issue) {
          clearIssueSession(issueSessionStatePath, entry.issueId);
          continue;
        }

        await client.addLabels(issue, [config.labels.queued]);
        await tryRemoveLabel(issue, config.labels.running);
        await tryRemoveLabel(issue, config.labels.failed);
        await tryRemoveLabel(issue, config.labels.done);
        await tryRemoveLabel(issue, config.labels.needsUserReply);

        if (entry.sessionId) {
          setIssueSession(issueSessionStatePath, issue, entry.sessionId);
        }

        if (webhooksEnabled && webhookQueuePath) {
          try {
            await enqueueWebhookIssue(webhookQueuePath, issue);
          } catch (error) {
            log("warn", "Failed to enqueue scheduled retry in webhook queue.", json, {
              issue: issue.url,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
        resumed += 1;
      }

      return resumed;
    };

    const resumeAwaitingUser = async (repos: RepoInfo[]): Promise<number> => {
      let resumed = 0;
      for (const repo of repos) {
        const awaiting = await client.listIssuesByLabel(repo, config.labels.needsUserReply);
        for (const issue of awaiting) {
          const comments = await client.listIssueComments(issue);
          if (!hasUserReplySince(comments, NEEDS_USER_MARKER)) {
            continue;
          }

          if (dryRun) {
            log("info", `Dry-run: would re-queue ${issue.url}`, json);
            resumed += 1;
            continue;
          }

          await client.addLabels(issue, [config.labels.queued]);
          await tryRemoveLabel(issue, config.labels.needsUserReply);
          await tryRemoveLabel(issue, config.labels.failed);
          await tryRemoveLabel(issue, config.labels.done);
          await tryRemoveLabel(issue, config.labels.running);
          clearRetry(scheduledRetryStatePath, issue.id);
          await client.comment(
            issue,
            buildAgentComment(
              `Reply received. Re-queued for execution from the previous Codex session when available.`,
              []
            )
          );
          if (webhooksEnabled && webhookQueuePath) {
            try {
              await enqueueWebhookIssue(webhookQueuePath, issue);
            } catch (error) {
              log("warn", "Failed to enqueue resumed issue in webhook queue.", json, {
                issue: issue.url,
                error: error instanceof Error ? error.message : String(error)
              });
            }
          }
          resumed += 1;
        }
      }
      return resumed;
    };

    const runIssueWithSessionResume = async (issue: IssueInfo): Promise<Awaited<ReturnType<typeof runIssue>>> => {
      let resumeSessionId = getIssueSession(issueSessionStatePath, issue);
      let resumePrompt: string | null =
        resumeSessionId
          ? "Continue from the previous Codex session and complete the pending task with the latest issue comments."
          : null;
      while (true) {
        const result = await runIssue(client, config, issue, {
          resumeSessionId,
          resumePrompt
        });
        if (result.sessionId) {
          setIssueSession(issueSessionStatePath, issue, result.sessionId);
        }
        const shouldRetryInSameSession =
          !result.success &&
          result.failureKind === "execution_error" &&
          result.failureStage === "after_session" &&
          Boolean(result.sessionId);
        if (!shouldRetryInSameSession) {
          return result;
        }
        resumeSessionId = result.sessionId;
        resumePrompt =
          "The previous attempt stopped unexpectedly. Continue this same session and finish the original task.";
      }
    };

    const handleRunFailure = async (
      issue: IssueInfo,
      result: Awaited<ReturnType<typeof runIssue>>,
      contextLabel: "issue" | "review-followup"
    ): Promise<void> => {
      const title = contextLabel === "review-followup" ? "Agent runner failed review follow-up." : "Agent runner failed.";
      const detailLine = result.failureDetail ? `\n\nDetail: ${result.failureDetail}` : "";

      if (result.failureKind === "quota") {
        const fallback = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const runAfter = result.quotaResumeAt ?? fallback;
        scheduleRetry(scheduledRetryStatePath, issue, runAfter, result.sessionId);
        await client.addLabels(issue, [config.labels.failed]);
        await tryRemoveLabel(issue, config.labels.running);
        await tryRemoveLabel(issue, config.labels.needsUserReply);
        const when = formatResumeTime(runAfter);
        await commentCompletion(
          issue,
          buildAgentComment(
            `${title}\n\nCause: Codex usage limit reached.${detailLine}` +
              `\n\nNext automatic retry: ${when.iso} (${when.local}).` +
              `\nThe runner will automatically resume at or after that time.` +
              `\n\nLog: ${result.logPath}`
          )
        );
        return;
      }

      if (result.failureKind === "needs_user_reply") {
        clearRetry(scheduledRetryStatePath, issue.id);
        await client.addLabels(issue, [config.labels.needsUserReply]);
        await tryRemoveLabel(issue, config.labels.running);
        await tryRemoveLabel(issue, config.labels.failed);
        await commentCompletion(
          issue,
          buildAgentComment(
            `${contextLabel === "review-followup" ? "Agent runner paused review follow-up." : "Agent runner paused."}` +
              `${detailLine}` +
              `\n\nPlease reply on this thread. The runner will resume from the same Codex session after your reply.` +
              `\n\nLog: ${result.logPath}`,
            [NEEDS_USER_MARKER]
          )
        );
        return;
      }

      clearRetry(scheduledRetryStatePath, issue.id);
      if (result.failureStage === "after_session" && result.sessionId) {
        setIssueSession(issueSessionStatePath, issue, result.sessionId);
        return;
      }

      clearIssueSession(issueSessionStatePath, issue.id);
      await client.addLabels(issue, [config.labels.failed]);
      await tryRemoveLabel(issue, config.labels.running);
      await tryRemoveLabel(issue, config.labels.needsUserReply);
      await commentCompletion(
        issue,
        buildAgentComment(
          `${title}${detailLine}` +
            `${result.summary ? `\n\nSummary:\n${result.summary}` : ""}` +
            `\n\nLog: ${result.logPath}`
        )
      );
    };

    const queueNewRequestsByAgentRunComment = async (repos: RepoInfo[]): Promise<IssueInfo[]> => {
      const excludeLabels = [
        config.labels.queued,
        config.labels.running,
        config.labels.done,
        config.labels.failed,
        config.labels.needsUserReply
      ];
      const commandStatePath = resolveAgentCommandStatePath(config.workdirRoot);
      const allowedRepos = new Set(repos.map((repo) => `${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}`));

      let found: IssueInfo[] = [];
      try {
        found = await client.searchOpenItemsByCommentPhraseAcrossOwner(config.owner, "/agent run", {
          excludeLabels,
          perPage: 100,
          maxPages: 1
        });
      } catch (error) {
        log("warn", "Failed to search for /agent run comment requests.", json, {
          error: error instanceof Error ? error.message : String(error)
        });
        return [];
      }

      const queued: IssueInfo[] = [];
      for (const issue of found) {
        const key = `${issue.repo.owner.toLowerCase()}/${issue.repo.repo.toLowerCase()}`;
        if (!allowedRepos.has(key)) {
          continue;
        }

        let triggerCommentId: number | null = null;
        try {
          const comments = await client.listIssueComments(issue);
          for (const comment of comments) {
            if (!isAllowedAuthorAssociation(comment.authorAssociation)) {
              continue;
            }
            if (parseAgentCommand(comment.body)?.kind !== "run") {
              continue;
            }
            if (await hasProcessedAgentCommandComment(commandStatePath, comment.id)) {
              continue;
            }
            triggerCommentId = comment.id;
            break;
          }
        } catch (error) {
          log("warn", "Failed to inspect /agent run comments; will retry.", json, {
            issue: issue.url,
            error: error instanceof Error ? error.message : String(error)
          });
          continue;
        }

        if (!triggerCommentId) {
          continue;
        }

        if (dryRun) {
          log("info", `Dry-run: would queue ${issue.url} via /agent run comment`, json);
          queued.push(issue);
          continue;
        }

        try {
          await client.addLabels(issue, [config.labels.queued]);
          clearRetry(scheduledRetryStatePath, issue.id);
          queued.push(issue);
        } catch (error) {
          log("warn", "Failed to add queued label for /agent run request.", json, {
            issue: issue.url,
            error: error instanceof Error ? error.message : String(error)
          });
          continue;
        }

        try {
          await markAgentCommandCommentProcessed(commandStatePath, triggerCommentId);
        } catch (error) {
          log("warn", "Failed to mark /agent run comment as processed.", json, {
            issue: issue.url,
            commentId: triggerCommentId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      return queued;
    };

    const runCycle = async (): Promise<void> => {
      const idleEnabled = Boolean(config.idle?.enabled);
      const idleNeedsAllRepos = idleEnabled && config.idle?.repoScope !== "local";
      const shouldPollIssues = !webhooksEnabled;
      const shouldListRepos = shouldPollIssues || idleNeedsAllRepos;
      const timingEnabled = process.env.AGENT_RUNNER_USAGE_TIMING === "1";
      const timingPrefix = timingEnabled ? "Usage gate timing" : "";

      let repos: RepoInfo[] = [];
      let rateLimitedUntil: string | null = null;
      const prunedActivityCount = pruneDeadActivityRecords(activityPath, isProcessAlive, ["idle"]);
      if (prunedActivityCount > 0) {
        log("info", "Pruned stale activity records.", json, { removed: prunedActivityCount });
      }
      if (shouldListRepos) {
        const repoResult = await listTargetRepos(client, config, config.workdirRoot);
        rateLimitedUntil = repoResult.blockedUntil;
        if (repoResult.source === "cache" && repoResult.blockedUntil) {
          log(
            "warn",
            `Using cached repo list due to rate limit until ${repoResult.blockedUntil}.`,
            json
          );
        } else if (repoResult.source === "local" && repoResult.blockedUntil) {
          log(
            "warn",
            `Using local workspace repo list due to rate limit until ${repoResult.blockedUntil}.`,
            json
          );
        } else if (repoResult.source === "cache") {
          log("info", "Using cached repo list.", json);
        } else if (repoResult.source === "local") {
          log("info", "Using local workspace repo list.", json);
        }
        repos = repoResult.repos;
        log("info", `Discovered ${repos.length} repositories.`, json);
      } else {
        log("info", "Skipping repo discovery; webhooks enabled.", json);
      }

      if (rateLimitedUntil && shouldPollIssues) {
        log("warn", `Skipping GitHub issue polling until ${rateLimitedUntil}.`, json);
      }

      const statePath = resolveRunnerStatePath(config.workdirRoot);
      let state;
      try {
        state = loadRunnerState(statePath);
      } catch (error) {
        log("warn", "Failed to read runner state; skipping running issue checks.", json, {
          error: error instanceof Error ? error.message : String(error)
        });
      }

      if (state) {
        if (shouldPollIssues && !rateLimitedUntil) {
          for (const repo of repos) {
            const runningIssues = await client.listIssuesByLabel(repo, config.labels.running);
            if (runningIssues.length === 0) {
              continue;
            }
            const evaluation = evaluateRunningIssues(runningIssues, state, isProcessAlive);

            for (const issue of evaluation.deadProcess) {
              await recoverStalledIssue({
                issue: issue.issue,
                reason: "dead_process",
                pid: issue.record.pid,
                dryRun,
                labels: config.labels,
                webhookQueuePath: webhooksEnabled ? webhookQueuePath : null,
                addLabel: (target, labels) => client.addLabels(target, labels),
                removeLabel: tryRemoveLabel,
                enqueueWebhookIssue,
                removeRunningIssue: (issueId) => removeRunningIssue(statePath, issueId),
                removeActivity: (activityId) => removeActivity(activityPath, activityId),
                clearRetry: (issueId) => clearRetry(scheduledRetryStatePath, issueId),
                log: (level, message, data) => log(level, message, json, data)
              });
            }

            for (const issue of evaluation.missingRecord) {
              await recoverStalledIssue({
                issue,
                reason: "missing_state",
                dryRun,
                labels: config.labels,
                webhookQueuePath: webhooksEnabled ? webhookQueuePath : null,
                addLabel: (target, labels) => client.addLabels(target, labels),
                removeLabel: tryRemoveLabel,
                enqueueWebhookIssue,
                removeRunningIssue: (issueId) => removeRunningIssue(statePath, issueId),
                removeActivity: (activityId) => removeActivity(activityPath, activityId),
                clearRetry: (issueId) => clearRetry(scheduledRetryStatePath, issueId),
                log: (level, message, data) => log(level, message, json, data)
              });
            }
          }
        } else if (webhooksEnabled) {
          for (const record of state.running) {
            if (isProcessAlive(record.pid)) {
              continue;
            }
            const issue = await client.getIssue(record.repo, record.issueNumber);
            if (!issue) {
              continue;
            }
            await recoverStalledIssue({
              issue,
              reason: "dead_process",
              pid: record.pid,
              dryRun,
              labels: config.labels,
              webhookQueuePath,
              addLabel: (target, labels) => client.addLabels(target, labels),
              removeLabel: tryRemoveLabel,
              enqueueWebhookIssue,
              removeRunningIssue: (issueId) => removeRunningIssue(statePath, issueId),
              removeActivity: (activityId) => removeActivity(activityPath, activityId),
              clearRetry: (issueId) => clearRetry(scheduledRetryStatePath, issueId),
              log: (level, message, data) => log(level, message, json, data)
            });
          }
        }
      }

      const resumed =
        shouldPollIssues && !rateLimitedUntil ? await resumeAwaitingUser(repos) : 0;
      if (resumed > 0) {
        log("info", `Re-queued ${resumed} request(s) after user reply.`, json);
      }

      const resumedBySchedule = await enqueueDueScheduledRetries();
      if (resumedBySchedule > 0) {
        log("info", `Re-queued ${resumedBySchedule} request(s) after scheduled retry time.`, json);
      }

      if (webhooksEnabled && webhookQueuePath && webhookConfig) {
        await maybeRunWebhookCatchup({
          client,
          config,
          webhookConfig,
          queuePath: webhookQueuePath,
          json,
          dryRun,
          now: new Date()
        });
      }

      const queuedIssues: IssueInfo[] = [];
      const queuedIds = new Set<number>();
      if (shouldPollIssues && !rateLimitedUntil) {
        const queued = await queueNewRequestsByAgentRunComment(repos);
        if (queued.length > 0) {
          log("info", `Queued ${queued.length} request(s) via /agent run comments.`, json);
        }
        for (const issue of queued) {
          if (queuedIds.has(issue.id)) {
            continue;
          }
          queuedIds.add(issue.id);
          queuedIssues.push(issue);
        }

        for (const repo of repos) {
          const repoQueued = await listQueuedIssues(client, repo, config);
          for (const issue of repoQueued) {
            if (queuedIds.has(issue.id)) {
              continue;
            }
            queuedIds.add(issue.id);
            queuedIssues.push(issue);
          }
        }
      }

      if (webhooksEnabled && webhookQueuePath) {
        const resolved = await resolveWebhookQueuedIssues(
          client,
          config,
          webhookQueuePath,
          json,
          dryRun
        );
        for (const issue of resolved.issues) {
          if (queuedIds.has(issue.id)) {
            continue;
          }
          queuedIds.add(issue.id);
          queuedIssues.push(issue);
        }
        if (!dryRun && resolved.removeIds.length > 0) {
          await removeWebhookIssues(webhookQueuePath, resolved.removeIds);
        }
      }

      const picked = pickNextIssues(queuedIssues, config.concurrency);

      const evaluateCodexIdleAllowed = async (): Promise<boolean> => {
        const usageGate = config.idle?.usageGate;
        if (!idleEnabled || !usageGate?.enabled) {
          return true;
        }

        try {
          const timingEvents: Array<{ phase: string; durationMs: number }> = [];
          const timingSink = timingEnabled
            ? (phase: string, durationMs: number) => {
                timingEvents.push({ phase, durationMs });
              }
            : undefined;
          const rateLimits = await fetchCodexRateLimits(
            usageGate.command,
            usageGate.args,
            usageGate.timeoutSeconds,
            config.workdirRoot,
            timingSink
          );
          const status = rateLimits ? rateLimitSnapshotToStatus(rateLimits, new Date()) : null;
          if (!status) {
            log("warn", "Idle Codex usage gate: unable to read rate limits from app-server.", json);
            return false;
          }

          const decision = evaluateUsageGate(status, usageGate);
          if (!decision.allow) {
            log("info", `Idle Codex usage gate blocked. ${decision.reason}`, json);
            return false;
          }

          log("info", `Idle Codex usage gate allowed. ${decision.reason}`, json, {
            window: decision.window?.label,
            minutesToReset: decision.minutesToReset
          });

          if (timingEnabled && timingEvents.length > 0) {
            log(
              "info",
              `${timingPrefix} (Codex): ${timingEvents.map((event) => `${event.phase}=${event.durationMs}ms`).join(", ")}`,
              json
            );
          }

          return true;
        } catch (error) {
          log("warn", "Idle Codex usage gate failed. Codex idle disabled.", json, {
            error: error instanceof Error ? error.message : String(error)
          });
          return false;
        }
      };

      if (idleEnabled && picked.length < config.concurrency) {
        await maybeEnqueueManagedPullRequestReviewFollowups({
          client,
          config,
          json,
          dryRun,
          maxEntries: config.concurrency - picked.length
        });
      }

      let scheduledReviewFollowups: ScheduledReviewFollowup[] = [];
      if (idleEnabled && picked.length < config.concurrency) {
        const reviewQueuePath = resolveReviewQueuePath(config.workdirRoot);
        const backlog = loadReviewQueue(reviewQueuePath);
        if (backlog.length > 0) {
          const maxEntries = config.concurrency - picked.length;
          const mergeOnlyBacklog = backlog.filter((entry) => !entry.requiresEngine);
          const engineBacklog = backlog.filter((entry) => entry.requiresEngine);

          let queue: ReviewQueueEntry[] = [];
          if (dryRun) {
            queue = backlog.slice(0, maxEntries);
          } else {
            const mergeOnly = await takeReviewTasksWhere(reviewQueuePath, maxEntries, (entry) => !entry.requiresEngine);
            queue.push(...mergeOnly);
            const remaining = maxEntries - mergeOnly.length;
            if (remaining > 0 && engineBacklog.length > 0) {
              const codexAllowed = await evaluateCodexIdleAllowed();
              if (!codexAllowed) {
                log(
                  "info",
                  "Review follow-up backlog detected but Codex idle gate is blocked. Skipping engine-required review follow-ups.",
                  json,
                  { queued: engineBacklog.length }
                );
              } else {
                const engineTasks = await takeReviewTasksWhere(reviewQueuePath, remaining, (entry) => entry.requiresEngine);
                queue.push(...engineTasks);
              }
            }
          }

          if (queue.length === 0) {
            if (mergeOnlyBacklog.length > 0) {
              log("info", "Review follow-up merge-only backlog detected but nothing was scheduled.", json, {
                queued: mergeOnlyBacklog.length
              });
            } else if (engineBacklog.length > 0) {
              log("info", "Review follow-up backlog detected but nothing was scheduled.", json, {
                queued: engineBacklog.length
              });
            }
          } else {
            scheduledReviewFollowups = scheduleReviewFollowups({
              normalRunning: picked.length,
              concurrency: config.concurrency,
              allowedEngines: ["codex"],
              queue
            });
          }
        }
      }

      if (picked.length === 0 && scheduledReviewFollowups.length === 0) {
        if (!config.idle?.enabled) {
          log("info", "No queued requests.", json);
          return;
        }

        const codexAllowed = await evaluateCodexIdleAllowed();

        let copilotAllowed = false;
        const copilotGate = config.idle.copilotUsageGate;
        if (copilotGate?.enabled) {
          try {
            const copilotStart = Date.now();
            const usage = await fetchCopilotUsage(token, copilotGate);
            if (timingEnabled) {
              log(
                "info",
                `${timingPrefix} (Copilot): rateLimits=${Date.now() - copilotStart}ms`,
                json
              );
            }
            if (!usage) {
              log("warn", "Idle Copilot usage gate: unable to parse Copilot quota info.", json);
            } else {
              const decision = evaluateCopilotUsageGate(usage, copilotGate);
              if (!decision.allow) {
                log("info", `Idle Copilot usage gate blocked. ${decision.reason}`, json);
              } else {
                copilotAllowed = true;
                log("info", `Idle Copilot usage gate allowed. ${decision.reason}`, json, {
                  percentRemaining: decision.percentRemaining,
                  minutesToReset: decision.minutesToReset
                });
              }
            }
          } catch (error) {
            log("warn", "Idle Copilot usage gate failed. Copilot idle disabled.", json, {
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }

        if (copilotAllowed) {
          if (!config.copilot) {
            log("warn", "Idle Copilot enabled but no copilot command configured. Skipping Copilot idle.", json);
            copilotAllowed = false;
          } else {
            const exists = await commandExists(config.copilot.command);
            if (!exists) {
              log(
                "warn",
                `Idle Copilot command not found (${config.copilot.command}). Skipping Copilot idle.`,
                json
              );
              copilotAllowed = false;
            }
          }
        }

        let geminiProAllowed = false;
        let geminiFlashAllowed = false;
        let geminiWarmupPro = false;
        let geminiWarmupFlash = false;
        let geminiWarmupReason: string | null = null;
        let amazonQAllowed = false;
        const geminiGate = config.idle.geminiUsageGate;
        if (geminiGate?.enabled) {
          try {
            const geminiStart = Date.now();
            const usage = await fetchGeminiUsage();
            if (timingEnabled) {
              log(
                "info",
                `${timingPrefix} (Gemini): rateLimits=${Date.now() - geminiStart}ms`,
                json
              );
            }
            if (!usage) {
              log("warn", "Idle Gemini usage gate: unable to parse Gemini quota info.", json);
            } else {
              const now = new Date();
              const decision = evaluateGeminiUsageGate(usage, geminiGate, now);
              if (!decision.allowPro && !decision.allowFlash) {
                let warmupState = { models: {} };
                try {
                  warmupState = loadGeminiWarmupState(resolveGeminiWarmupStatePath(config.workdirRoot));
                } catch (error) {
                  log("warn", "Idle Gemini warmup: unable to read warmup state. Proceeding without cooldown.", json, {
                    error: error instanceof Error ? error.message : String(error)
                  });
                }

                const warmupDecision = evaluateGeminiWarmup(usage, geminiGate, warmupState, now);
                if (warmupDecision?.warmupPro || warmupDecision?.warmupFlash) {
                  geminiWarmupPro = warmupDecision.warmupPro;
                  geminiWarmupFlash = warmupDecision.warmupFlash;
                  geminiWarmupReason = warmupDecision.reason;
                  if (geminiWarmupPro) geminiProAllowed = true;
                  if (geminiWarmupFlash) geminiFlashAllowed = true;
                  log("info", `Idle Gemini warmup allowed. ${warmupDecision.reason}`, json);
                } else {
                  log("info", `Idle Gemini usage gate blocked. ${decision.reason}`, json);
                }
              } else {
                if (decision.allowPro) geminiProAllowed = true;
                if (decision.allowFlash) geminiFlashAllowed = true;
                log("info", `Idle Gemini usage gate allowed. ${decision.reason}`, json);
              }
            }
          } catch (error) {
            log("warn", "Idle Gemini usage gate failed. Gemini idle disabled.", json, {
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }

        if (geminiProAllowed || geminiFlashAllowed) {
          if (!config.gemini) {
            log("warn", "Idle Gemini enabled but no gemini command configured. Skipping Gemini idle.", json);
            geminiProAllowed = false;
            geminiFlashAllowed = false;
            geminiWarmupPro = false;
            geminiWarmupFlash = false;
            geminiWarmupReason = null;
          } else {
            const exists = await commandExists(config.gemini.command);
            if (!exists) {
              log("warn", `Idle Gemini command not found (${config.gemini.command}).`, json);
              geminiProAllowed = false;
              geminiFlashAllowed = false;
              geminiWarmupPro = false;
              geminiWarmupFlash = false;
              geminiWarmupReason = null;
            }
          }
        }

        if (config.amazonQ?.enabled) {
          const exists = await commandExists(config.amazonQ.command);
          if (!exists) {
            log("warn", `Idle Amazon Q command not found (${config.amazonQ.command}).`, json);
          } else {
            const amazonQGate = config.idle.amazonQUsageGate;
            if (amazonQGate?.enabled) {
              try {
                const now = new Date();
                const usage = getAmazonQUsageSnapshot(
                  resolveAmazonQUsageStatePath(config.workdirRoot),
                  amazonQGate,
                  now
                );
                const decision = evaluateAmazonQUsageGate(usage, amazonQGate, now);
                if (!decision.allow) {
                  log("info", `Idle Amazon Q usage gate blocked. ${decision.reason}`, json);
                } else {
                  amazonQAllowed = true;
                  log("info", `Idle Amazon Q usage gate allowed. ${decision.reason}`, json, {
                    percentRemaining: decision.percentRemaining,
                    minutesToReset: decision.minutesToReset,
                    used: decision.used,
                    limit: decision.limit
                  });
                }
              } catch (error) {
                log("warn", "Idle Amazon Q usage gate failed. Amazon Q idle disabled.", json, {
                  error: error instanceof Error ? error.message : String(error)
                });
              }
            } else {
              amazonQAllowed = true;
            }
          }
        }

        const engines: IdleEngine[] = [];
        if (codexAllowed) {
          engines.push("codex");
        }
        if (copilotAllowed) {
          engines.push("copilot");
        }
        if (geminiProAllowed) {
          engines.push("gemini-pro");
        }
        if (geminiFlashAllowed) {
          engines.push("gemini-flash");
        }
        if (amazonQAllowed) {
          engines.push("amazon-q");
        }

        if (engines.length === 0) {
          log("info", "Idle usage gate blocked for all engines. Skipping idle.", json);
          return;
        }

        let idleRepos = repos;
        if (config.idle?.repoScope === "local") {
          idleRepos = listLocalRepos(config.workdirRoot, config.owner);
          log(
            "info",
            `Idle repo scope set to local. Using ${idleRepos.length} workspace repo(s).`,
            json
          );
        }

        let maxRuns = config.idle.maxRunsPerCycle;
        if (engines.length > maxRuns) {
          log(
            "warn",
            `Idle maxRunsPerCycle (${maxRuns}) is below available engines (${engines.length}). Scheduling ${engines.length} idle task(s).`,
            json
          );
          maxRuns = engines.length;
        }
        const idleTasks = await planIdleTasks(config, idleRepos, {
          maxRuns,
          now: new Date()
        });
        if (idleTasks.length === 0) {
          log("info", "No queued requests. Idle cooldown active or no eligible repos.", json);
          return;
        }

        if (idleTasks.length < engines.length) {
          log(
            "warn",
            `Only ${idleTasks.length} idle task(s) available for ${engines.length} engine(s).`,
            json
          );
        }

        const scheduled = idleTasks.map((task, index) => ({
          ...task,
          engine: engines[index % engines.length]
        }));

        log(
          "info",
          `No queued requests. Scheduling ${scheduled.length} idle task(s).`,
          json,
          {
            tasks: scheduled.map((task) => ({
              repo: `${task.repo.owner}/${task.repo.repo}`,
              engine: task.engine,
              task: task.task
            }))
          }
        );

        if (dryRun) {
          log("info", "Dry-run: would execute idle tasks.", json, {
            tasks: scheduled.map((task) => ({
              repo: `${task.repo.owner}/${task.repo.repo}`,
              engine: task.engine,
              task: task.task
            }))
          });
          return;
        }

        if (geminiWarmupPro || geminiWarmupFlash) {
          try {
            const warmupStatePath = resolveGeminiWarmupStatePath(config.workdirRoot);
            const warmupNow = new Date();
            const scheduledEngines = new Set(scheduled.map((task) => task.engine));
            if (geminiWarmupPro && scheduledEngines.has("gemini-pro")) {
              recordGeminiWarmupAttempt(warmupStatePath, "gemini-3-pro-preview", warmupNow);
            }
            if (geminiWarmupFlash && scheduledEngines.has("gemini-flash")) {
              recordGeminiWarmupAttempt(warmupStatePath, "gemini-3-flash-preview", warmupNow);
            }
            log("info", "Idle Gemini warmup attempt recorded.", json, {
              warmupPro: geminiWarmupPro && scheduledEngines.has("gemini-pro"),
              warmupFlash: geminiWarmupFlash && scheduledEngines.has("gemini-flash"),
              reason: geminiWarmupReason
            });
          } catch (error) {
            log("warn", "Idle Gemini warmup: unable to record warmup attempt.", json, {
              error: error instanceof Error ? error.message : String(error),
              reason: geminiWarmupReason
            });
          }
        }

        const idleLimit = pLimit(config.concurrency);
        await Promise.all(
          scheduled.map((task) =>
            idleLimit(async () => {
              const service = idleEngineToService(task.engine);
              const result = await serviceLimiters[service](() =>
                runIdleTask(config, task.repo, task.task, task.engine)
              );
              await maybeNotifyIdlePullRequest(result);
              if (result.success) {
                log("info", "Idle task completed.", json, {
                  repo: `${result.repo.owner}/${result.repo.repo}`,
                  engine: result.engine,
                  report: result.reportPath,
                  log: result.logPath
                });
                return;
              }
              log("warn", "Idle task failed.", json, {
                repo: `${result.repo.owner}/${result.repo.repo}`,
                engine: result.engine,
                report: result.reportPath,
                log: result.logPath
              });
            })
          )
        );

        return;
      }

      if (dryRun) {
        log("info", `Dry-run: would process ${picked.length} request(s).`, json, {
          issues: picked.map((issue) => issue.url)
        });
        if (scheduledReviewFollowups.length > 0) {
          log("info", `Dry-run: would process ${scheduledReviewFollowups.length} review follow-up(s).`, json, {
            followups: scheduledReviewFollowups.map((followup) => ({
              url: followup.url,
              reason: followup.reason,
              requiresEngine: followup.requiresEngine
            }))
          });
        }
        return;
      }

      const limit = pLimit(config.concurrency);

      await Promise.all([
        ...picked.map((issue) =>
          limit(async () => {
            let activityId: string | null = null;
            try {
              if (issue.isPullRequest) {
                const managedStatePath = resolveManagedPullRequestsStatePath(config.workdirRoot);
                await markManagedPullRequest(managedStatePath, issue.repo, issue.number);
              }

              await client.addLabels(issue, [config.labels.running]);
              await tryRemoveLabel(issue, config.labels.queued);
              await commentCompletion(
                issue,
                buildAgentComment(`Agent runner started on ${new Date().toISOString()}. Concurrency ${config.concurrency}.`)
              );
              clearRetry(scheduledRetryStatePath, issue.id);
              if (webhooksEnabled && webhookQueuePath) {
                await removeWebhookIssues(webhookQueuePath, [issue.id]);
              }

              const result = await serviceLimiters.codex(() => runIssueWithSessionResume(issue));
              activityId = result.activityId;
              if (result.success) {
                clearRetry(scheduledRetryStatePath, issue.id);
                clearIssueSession(issueSessionStatePath, issue.id);
                await client.addLabels(issue, [config.labels.done]);
                await tryRemoveLabel(issue, config.labels.running);
                await tryRemoveLabel(issue, config.labels.failed);
                await tryRemoveLabel(issue, config.labels.needsUserReply);
                await commentCompletion(
                  issue,
                  buildAgentComment(
                    `Agent runner completed successfully.` +
                      `${result.summary ? `\n\nSummary:\n${result.summary}` : ""}` +
                      `\n\nLog: ${result.logPath}`
                  )
                );
                return;
              }

              await handleRunFailure(issue, result, "issue");
            } catch (error) {
              clearRetry(scheduledRetryStatePath, issue.id);
              clearIssueSession(issueSessionStatePath, issue.id);
              await client.addLabels(issue, [config.labels.failed]);
              await tryRemoveLabel(issue, config.labels.running);
              await tryRemoveLabel(issue, config.labels.needsUserReply);
              await commentCompletion(
                issue,
                buildAgentComment(
                  `Agent runner failed with error: ${
                    error instanceof Error ? error.message : String(error)
                  }`
                )
              );
            } finally {
              if (activityId) {
                removeActivity(activityPath, activityId);
              }
            }
          })
        ),
        ...scheduledReviewFollowups.map((followup) =>
          limit(async () => {
            const issue = await client.getIssue(followup.repo, followup.prNumber);
            if (!issue) {
              log("warn", "Review follow-up skipped: unable to resolve PR.", json, { url: followup.url });
              return;
            }

            if (!followup.requiresEngine) {
              try {
                const merge = await attemptAutoMergeApprovedPullRequest({
                  client: notifyClient ?? client,
                  repo: followup.repo,
                  pullNumber: followup.prNumber,
                  issue
                });

                if (merge.merged) {
                  await client.addLabels(issue, [config.labels.done]);
                  await commentCompletion(
                    issue,
                    buildAgentComment(
                      `Agent runner auto-merged after approval (method: ${merge.mergeMethod}).` +
                        `${merge.branchDeleted ? "\n\nDeleted remote branch." : ""}`
                    )
                  );
                  return;
                }

                if (merge.retry) {
                  const reviewQueuePath = resolveReviewQueuePath(config.workdirRoot);
                  await enqueueReviewTask(reviewQueuePath, {
                    issueId: followup.issueId,
                    prNumber: followup.prNumber,
                    repo: followup.repo,
                    url: followup.url,
                    reason: followup.reason,
                    requiresEngine: false
                  });
                  log("info", "Auto-merge not ready yet; re-queued approval follow-up.", json, {
                    url: followup.url,
                    reason: merge.reason
                  });
                  return;
                }

                log("info", "Auto-merge skipped.", json, { url: followup.url, reason: merge.reason });
              } catch (error) {
                log("warn", "Auto-merge failed.", json, {
                  url: followup.url,
                  error: error instanceof Error ? error.message : String(error)
                });
              }
              return;
            }

            let activityId: string | null = null;
            try {
              await client.addLabels(issue, [config.labels.running]);
              await tryRemoveLabel(issue, config.labels.queued);
              await commentCompletion(
                issue,
                buildAgentComment(
                  `Agent runner started review follow-up (${followup.reason}) on ${new Date().toISOString()}. Concurrency ${config.concurrency}.`
                )
              );
              clearRetry(scheduledRetryStatePath, issue.id);

              const result = await serviceLimiters.codex(() => runIssueWithSessionResume(issue));
              activityId = result.activityId;
              if (result.success) {
                clearRetry(scheduledRetryStatePath, issue.id);
                clearIssueSession(issueSessionStatePath, issue.id);
                try {
                  const resolved = await resolveAllUnresolvedReviewThreads({
                    client,
                    repo: followup.repo,
                    pullNumber: followup.prNumber
                  });
                  if (resolved.resolved > 0) {
                    log("info", "Resolved PR review threads after follow-up run.", json, {
                      url: followup.url,
                      resolved: resolved.resolved,
                      unresolvedBefore: resolved.unresolvedBefore,
                      total: resolved.total
                    });
                  }
                } catch (error) {
                  log("warn", "Failed to resolve PR review threads after follow-up run.", json, {
                    url: followup.url,
                    error: error instanceof Error ? error.message : String(error)
                  });
                }
                try {
                  const requested = await reRequestAllReviewers({
                    client: notifyClient ?? client,
                    repo: followup.repo,
                    pullNumber: followup.prNumber,
                    issue
                  });
                  log("info", "Re-requested reviewers after follow-up run.", json, {
                    url: followup.url,
                    humanReviewers: requested.requestedHumanReviewers,
                    copilot: requested.requestedCopilot,
                    codex: requested.requestedCodex
                  });
                } catch (error) {
                  log("warn", "Failed to re-request reviewers after follow-up run.", json, {
                    url: followup.url,
                    error: error instanceof Error ? error.message : String(error)
                  });
                }

                await client.addLabels(issue, [config.labels.done]);
                await tryRemoveLabel(issue, config.labels.running);
                await tryRemoveLabel(issue, config.labels.failed);
                await tryRemoveLabel(issue, config.labels.needsUserReply);
                await commentCompletion(
                  issue,
                  buildAgentComment(
                    `Agent runner completed review follow-up successfully.` +
                      `${result.summary ? `\n\nSummary:\n${result.summary}` : ""}` +
                      `\n\nLog: ${result.logPath}`
                  )
                );
                return;
              }

              await handleRunFailure(issue, result, "review-followup");
            } catch (error) {
              clearRetry(scheduledRetryStatePath, issue.id);
              clearIssueSession(issueSessionStatePath, issue.id);
              await client.addLabels(issue, [config.labels.failed]);
              await tryRemoveLabel(issue, config.labels.running);
              await tryRemoveLabel(issue, config.labels.needsUserReply);
              await commentCompletion(
                issue,
                buildAgentComment(
                  `Agent runner failed review follow-up with error: ${
                    error instanceof Error ? error.message : String(error)
                  }`
                )
              );
            } finally {
              if (activityId) {
                removeActivity(activityPath, activityId);
              }
            }
          })
        )
      ]);
    };

    try {
      const interval = Number.parseInt(options.interval, 10);
      if (options.once) {
        if (isStopRequested(config.workdirRoot)) {
          log("info", "Stop requested. Exiting runner loop.", json);
          releaseLock(lock);
          return;
        }
        await runCycle();
        releaseLock(lock);
        return;
      }

      while (true) {
        if (isStopRequested(config.workdirRoot)) {
          log("info", "Stop requested. Exiting runner loop.", json);
          break;
        }
        await runCycle();
        if (isStopRequested(config.workdirRoot)) {
          log("info", "Stop requested. Exiting runner loop.", json);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, interval * 1000));
      }
    } finally {
      releaseLock(lock);
    }
  });

program
  .command("labels")
  .description("Manage agent labels across repositories.")
  .command("sync")
  .description("Ensure agent labels exist with expected colors and descriptions.")
  .option("-c, --config <path>", "Path to config file", "agent-runner.config.json")
  .option("--json", "Output JSON logs", false)
  .option("--dry-run", "List actions without mutating GitHub", false)
  .option("--yes", "Bypass confirmation prompts", false)
  .action(async (options) => {
    const json = Boolean(options.json);
    const dryRun = Boolean(options.dryRun);
    const requireYes = !dryRun && !options.yes;

    if (requireYes) {
      throw new Error("Refusing to mutate GitHub without --yes. Use --dry-run to preview.");
    }

    const configPath = path.resolve(process.cwd(), options.config);
    const config = loadConfig(configPath);

    const token =
      process.env.AGENT_GITHUB_TOKEN ||
      process.env.GITHUB_TOKEN ||
      process.env.GH_TOKEN;

    if (!token) {
      throw new Error("Missing GitHub token. Set AGENT_GITHUB_TOKEN or GITHUB_TOKEN.");
    }

    const client = new GitHubClient(token);
    const repoResult = await listTargetRepos(client, config, config.workdirRoot);
    const repos = repoResult.repos;
    const labels = buildAgentLabels(config);

    log("info", `Syncing labels across ${repos.length} repositories.`, json);

    for (const repo of repos) {
      for (const label of labels) {
        const existing = await client.getLabel(repo, label.name);
        if (!existing) {
          if (dryRun) {
            log("info", `Would create label ${label.name} in ${repo.repo}.`, json);
            continue;
          }
          await client.createLabel(repo, label);
          log("info", `Created label ${label.name} in ${repo.repo}.`, json);
          continue;
        }

        const needsUpdate =
          existing.color.toLowerCase() !== label.color.toLowerCase() ||
          (existing.description ?? "") !== label.description;

        if (!needsUpdate) {
          continue;
        }

        if (dryRun) {
          log("info", `Would update label ${label.name} in ${repo.repo}.`, json);
          continue;
        }

        const payload: LabelInfo = {
          name: label.name,
          color: label.color,
          description: label.description
        };
        await client.updateLabel(repo, payload);
        log("info", `Updated label ${label.name} in ${repo.repo}.`, json);
      }
    }
  });

program
  .command("logs")
  .description("Manage runner logs.")
  .addCommand(
    new Command("prune")
      .description("Prune old log files under workdirRoot/agent-runner/logs.")
      .option("-c, --config <path>", "Path to config file", "agent-runner.config.json")
      .option("--dry-run", "List files that would be deleted", false)
      .option("--yes", "Actually delete files (required unless --dry-run)", false)
      .option("--json", "Output JSON", false)
      .action((options) => {
        const json = Boolean(options.json);
        const dryRun = Boolean(options.dryRun);
        const requireYes = !dryRun && !options.yes;
        if (requireYes) {
          throw new Error("Refusing to delete logs without --yes. Use --dry-run to preview.");
        }

        const configPath = path.resolve(process.cwd(), options.config);
        const config = loadConfig(configPath);
        const decision = resolveLogMaintenance(config);
        const result = pruneLogs({ dir: resolveLogsDir(config.workdirRoot), decision, dryRun });
        log("info", result.dryRun ? "Dry-run: would prune logs." : "Pruned logs.", json, {
          dir: result.dir,
          scanned: result.scanned,
          deleted: result.deleted,
          deletedMB: Math.round((result.deletedBytes / (1024 * 1024)) * 100) / 100,
          skipped: result.skipped,
          kept: result.kept
        });
      })
  );

program
  .command("reports")
  .description("Manage runner reports.")
  .addCommand(
    new Command("prune")
      .description("Prune old report files under workdirRoot/agent-runner/reports.")
      .option("-c, --config <path>", "Path to config file", "agent-runner.config.json")
      .option("--dry-run", "List files that would be deleted", false)
      .option("--yes", "Actually delete files (required unless --dry-run)", false)
      .option("--json", "Output JSON", false)
      .action((options) => {
        const json = Boolean(options.json);
        const dryRun = Boolean(options.dryRun);
        const requireYes = !dryRun && !options.yes;
        if (requireYes) {
          throw new Error("Refusing to delete reports without --yes. Use --dry-run to preview.");
        }

        const configPath = path.resolve(process.cwd(), options.config);
        const config = loadConfig(configPath);
        const decision = resolveReportMaintenance(config);
        const result = pruneReports({ dir: resolveReportsDir(config.workdirRoot), decision, dryRun });
        log("info", result.dryRun ? "Dry-run: would prune reports." : "Pruned reports.", json, {
          dir: result.dir,
          scanned: result.scanned,
          deleted: result.deleted,
          deletedMB: Math.round((result.deletedBytes / (1024 * 1024)) * 100) / 100,
          skipped: result.skipped,
          kept: result.kept
        });
      })
  );

program
  .command("status")
  .description("Show runner status snapshot.")
  .option("-c, --config <path>", "Path to config file", "agent-runner.config.json")
  .option("--json", "Output JSON", false)
  .action(async (options) => {
    const configPath = path.resolve(process.cwd(), options.config);
    const config = loadConfig(configPath);
    const snapshot = buildStatusSnapshot(config.workdirRoot);
    if (options.json) {
      console.log(JSON.stringify(snapshot, null, 2));
      return;
    }
    let state = snapshot.busy ? "Running" : "Idle";
    if (snapshot.stopRequested && snapshot.busy) {
      state = "Running (stop requested)";
    } else if (snapshot.stopRequested) {
      state = "Paused";
    }
    console.log(`Status: ${state}`);
    const generatedLocal =
      snapshot.generatedAtLocal ??
      new Date(snapshot.generatedAt).toLocaleString(undefined, { timeZoneName: "short" });
    console.log(`Generated: ${generatedLocal}`);
    console.log(`Workdir: ${snapshot.workdirRoot}`);
    console.log(`Running: ${snapshot.running.length}`);
    console.log(`Stale: ${snapshot.stale.length}`);
  });

program
  .command("stop")
  .description("Request the runner to stop after the current work completes.")
  .option("-c, --config <path>", "Path to config file", "agent-runner.config.json")
  .action(async (options) => {
    const configPath = path.resolve(process.cwd(), options.config);
    const config = loadConfig(configPath);
    requestStop(config.workdirRoot);
    console.log("Stop requested.");
  });

program
  .command("resume")
  .description("Clear a stop request so the runner can continue.")
  .option("-c, --config <path>", "Path to config file", "agent-runner.config.json")
  .action(async (options) => {
    const configPath = path.resolve(process.cwd(), options.config);
    const config = loadConfig(configPath);
    clearStopRequest(config.workdirRoot);
    console.log("Stop request cleared.");
  });

program
  .command("ui")
  .description("Serve a local status UI for the agent runner.")
  .option("-c, --config <path>", "Path to config file", "agent-runner.config.json")
  .option("--host <host>", "Host to bind", "127.0.0.1")
  .option("--port <port>", "Port to bind", "4311")
  .action(async (options) => {
    const configPath = path.resolve(process.cwd(), options.config);
    const config = loadConfig(configPath);
    const port = Number.parseInt(options.port, 10);
    if (Number.isNaN(port) || port <= 0) {
      throw new Error(`Invalid port: ${options.port}`);
    }
    const host = String(options.host);
    await startStatusServer({
      workdirRoot: config.workdirRoot,
      host,
      port
    });
    console.log(`Status UI listening on http://${host}:${port}/`);
  });

program
  .command("webhook")
  .description("Start a GitHub webhook listener.")
  .option("-c, --config <path>", "Path to config file", "agent-runner.config.json")
  .option("--host <host>", "Host to bind")
  .option("--port <port>", "Port to bind")
  .option("--path <path>", "Webhook path")
  .option("--json", "Output JSON logs", false)
  .action(async (options) => {
    const json = Boolean(options.json);
    const configPath = path.resolve(process.cwd(), options.config);
    const config = loadConfig(configPath);

    const decision = resolveLogMaintenance(config);
    pruneLogs({ dir: resolveLogsDir(config.workdirRoot), decision, dryRun: false });

    const webhookConfig = config.webhooks;
    if (!webhookConfig || !webhookConfig.enabled) {
      throw new Error("Webhooks are disabled. Set webhooks.enabled to true.");
    }
    const secret = resolveWebhookSecret(webhookConfig);
    if (!secret) {
      throw new Error(
        "Missing webhook secret. Set webhooks.secret or webhooks.secretEnv and ensure the env var is defined."
      );
    }

    const token =
      process.env.AGENT_GITHUB_TOKEN ||
      process.env.GITHUB_TOKEN ||
      process.env.GH_TOKEN;

    if (!token) {
      throw new Error("Missing GitHub token. Set AGENT_GITHUB_TOKEN or GITHUB_TOKEN.");
    }

    const host = options.host ? String(options.host) : webhookConfig.host;
    const portRaw = options.port ? Number.parseInt(options.port, 10) : webhookConfig.port;
    if (Number.isNaN(portRaw) || portRaw <= 0) {
      throw new Error(`Invalid port: ${options.port ?? webhookConfig.port}`);
    }
    const pathValue = options.path ? String(options.path) : webhookConfig.path;
    if (!pathValue.startsWith("/")) {
      throw new Error(`Invalid webhook path: ${pathValue}`);
    }

    const queuePath = resolveWebhookQueuePath(config.workdirRoot, webhookConfig);

    const notify = createGitHubNotifyClient(config.workdirRoot);
    let client: GitHubClient | null = notify?.client ?? null;
    if (client) {
      log(
        "info",
        notify?.source === "github-app"
          ? "Webhook listener GitHub client configured via GitHub App."
          : "Webhook listener GitHub client configured via notify token.",
        json
      );
    }

    if (!client && token) {
      client = new GitHubClient(token);
      log("info", "Webhook listener GitHub client configured via environment token.", json);
    }

    if (!client) {
      throw new Error(
        "Missing GitHub credentials for webhook listener. Configure the GitHub App notify client or set AGENT_GITHUB_TOKEN/GITHUB_TOKEN."
      );
    }

    await startWebhookServer({
      host,
      port: portRaw,
      path: pathValue,
      secret,
      maxPayloadBytes: webhookConfig.maxPayloadBytes,
      onEvent: (event) =>
        handleWebhookEvent({
          event,
          client,
          config,
          queuePath,
          onLog: (level, message, data) => log(level, message, json, data)
        }),
      onLog: (level, message, data) => log(level, message, json, data)
    });
    log("info", `Webhook listener ready on http://${host}:${portRaw}${pathValue}`, json);
  });

program.parseAsync(process.argv);

