#!/usr/bin/env node
import { spawn } from "node:child_process";
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
import { evaluateClaudeUsageGate, fetchClaudeUsage } from "./claude-usage.js";
import { commandExists } from "./command-exists.js";
import { listTargetRepos, listQueuedIssues, pickNextIssues } from "./queue.js";
import { planIdleTasks, runIdleTask, runIssue, QUOTA_ERROR_PATTERNS, hasPattern, extractErrorMessage } from "./runner.js";
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
  resolveAllUnresolvedReviewThreads,
  shouldAutoMergeRetryRequireEngine
} from "./pr-review-actions.js";
import {
  markManagedPullRequest,
  resolveManagedPullRequestsStatePath
} from "./managed-pull-requests.js";
import { ensureManagedPullRequestRecorded } from "./managed-pr.js";
import { notifyIdlePullRequest } from "./idle-pr-notify.js";
import { enqueueManagedPullRequestReviewFollowups } from "./managed-pr-review-catchup.js";
import { parseLastPullRequestUrl } from "./pull-request-url.js";
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
import { planWebhookRunningRecoveries } from "./webhook-running-recovery.js";
import { createServiceLimiters, idleEngineToService } from "./service-concurrency.js";
import { runWithServiceSlot } from "./service-slot.js";
import {
  REVIEW_FOLLOWUP_ACTION_REQUIRED_MARKER,
  REVIEW_FOLLOWUP_WAITING_MARKER,
  buildReviewFollowupActionRequiredComment,
  buildReviewFollowupWaitingComment,
  isManualActionRequiredForAutoMergeSkip,
  shouldPostReviewFollowupMarkerComment
} from "./review-followup-status.js";
import { labelsForReviewFollowupState, listReviewFollowupLabels } from "./review-followup-labels.js";
import {
  clearUiServerState,
  isUiServerProcessAlive,
  loadUiServerState,
  probeUiServer,
  resolveUiServerStatePath,
  saveUiServerState,
  type UiServerState
} from "./ui-server-control.js";

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

function parsePort(raw: string, fieldName = "port"): number {
  const port = Number.parseInt(raw, 10);
  if (Number.isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid ${fieldName}: ${raw}`);
  }
  return port;
}

function resolveCliEntryScriptPath(): string {
  const entry = process.argv[1];
  if (!entry || entry.trim().length === 0) {
    throw new Error("Unable to resolve CLI entry script path.");
  }
  return path.resolve(entry);
}

async function waitForUiServer(host: string, port: number, attempts: number, intervalMs: number): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    if (await probeUiServer(host, port, Math.max(200, intervalMs))) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
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
    ...listReviewFollowupLabels(config),
    config.labels.running,
    config.labels.done,
    config.labels.failed,
    config.labels.needsUserReply
  ];

  log("info", "Webhook catch-up scan: searching for missed /agent run comment requests.", json, {
    intervalMinutes: catchup.intervalMinutes,
    maxIssuesPerRun: maxIssues
  }, "catch-up");

  const parsedLastRunAt = state.lastRunAt ? Date.parse(state.lastRunAt) : Number.NaN;
  const lastRunAt = Number.isNaN(parsedLastRunAt) ? now.getTime() - intervalMs : parsedLastRunAt;
  const commandStatePath = resolveAgentCommandStatePath(config.workdirRoot);
  const managedStatePath = resolveManagedPullRequestsStatePath(config.workdirRoot);
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
    }, "catch-up");
    return;
  }

  if (found.length === 0) {
    saveWebhookCatchupState(statePath, { lastRunAt: now.toISOString() });
    return;
  }

  const limited = found.slice(0, maxIssues);
  log("info", `Webhook catch-up scan found ${found.length} issue(s).`, json, {
    queued: limited.length
  }, "catch-up");

  let hadErrors = false;
  for (const issue of limited) {
    if (dryRun) {
      log("info", `Dry-run: would queue catch-up issue ${issue.url}`, json, "catch-up");
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
    if (issue.isPullRequest) {
      try {
        await markManagedPullRequest(managedStatePath, issue.repo, issue.number);
      } catch (error) {
        hadErrors = true;
        log("warn", "Failed to record managed PR during webhook catch-up scan.", json, {
          issue: issue.url,
          error: error instanceof Error ? error.message : String(error)
        }, "catch-up");
      }
    }
    try {
      await client.addLabels(issue, [config.labels.queued]);
    } catch (error) {
      hadErrors = true;
      log("warn", "Failed to add queued label during catch-up.", json, {
        issue: issue.url,
        error: error instanceof Error ? error.message : String(error)
      }, "catch-up");
      continue;
    }
    try {
      await enqueueWebhookIssue(queuePath, issue);
    } catch (error) {
      hadErrors = true;
      log("warn", "Failed to enqueue catch-up issue.", json, {
        issue: issue.url,
        error: error instanceof Error ? error.message : String(error)
      }, "catch-up");
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
  try {
    const enqueued = await enqueueManagedPullRequestReviewFollowups({
      client,
      config,
      maxEntries: options.maxEntries,
      dryRun,
      onLog: (level, message, data) => log(level, message, json, data, "review")
    });
    if (enqueued > 0) {
      log("info", `Managed PR catch-up scan enqueued ${enqueued} follow-up(s).`, json, "review");
    }
  } catch (error) {
    log("warn", "Managed PR catch-up scan failed.", json, {
      error: error instanceof Error ? error.message : String(error)
    }, "review");
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
  const reviewFollowupLabelSet = new Set(listReviewFollowupLabels(config));

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
      }, "queue");
      continue;
    }
    if (!issue) {
      removeIds.push(entry.issueId);
      continue;
    }

    if (
      issue.labels.includes(config.labels.running) ||
      issue.labels.some((label) => reviewFollowupLabelSet.has(label)) ||
      issue.labels.includes(config.labels.needsUserReply) ||
      issue.labels.includes(config.labels.done) ||
      issue.labels.includes(config.labels.failed)
    ) {
      removeIds.push(entry.issueId);
      continue;
    }

    if (!issue.labels.includes(config.labels.queued)) {
      if (dryRun) {
        log("info", `Dry-run: would add queued label to ${issue.url}`, json, "queue");
        issue.labels = [...issue.labels, config.labels.queued];
      } else {
        try {
          await client.addLabels(issue, [config.labels.queued]);
          issue.labels = [...issue.labels, config.labels.queued];
        } catch (error) {
          log("warn", "Failed to add queued label to webhook issue.", json, {
            issue: issue.url,
            error: error instanceof Error ? error.message : String(error)
          }, "queue");
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
      }, "maint");
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
      }, "maint");
    }

    let lock: ReturnType<typeof acquireLock>;
    try {
      lock = acquireLock(path.resolve(config.workdirRoot, "agent-runner", "state", "runner.lock"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.once && message.startsWith("Runner already active")) {
        log("info", message, json, "init");
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
    const reviewFollowupLabels = listReviewFollowupLabels(config);
    const reviewFollowupLabelSet = new Set(reviewFollowupLabels);
    if (notifyClient) {
      log(
        "info",
        notifySource === "github-app"
          ? "GitHub notify client configured via GitHub App. Completion comments will be posted as the app installation."
          : "GitHub notify token detected. Completion comments will be posted as a bot user.",
        json,
        "init"
      );
    }
    const tryRemoveLabel = async (issue: IssueInfo, label: string): Promise<void> => {
      try {
        await client.removeLabel(issue, label);
      } catch (error) {
        const status =
          error !== null && typeof error === "object" && "status" in error
            ? (error as { status?: unknown }).status
            : undefined;
        const message = extractErrorMessage(error).toLowerCase();
        if (
          status === 404 ||
          status === 422 ||
          message.includes("label does not exist")
        ) {
          return;
        }
        log("warn", `Failed to remove label ${label} from ${issue.url}`, json, {
          error: extractErrorMessage(error)
        }, "run");
      }
    };
    const tryRemoveReviewFollowupLabels = async (issue: IssueInfo): Promise<void> => {
      for (const label of reviewFollowupLabels) {
        await tryRemoveLabel(issue, label);
      }
      issue.labels = issue.labels.filter((label) => !reviewFollowupLabelSet.has(label));
    };
    const tryApplyReviewFollowupLabelState = async (
      issue: IssueInfo,
      state: "queued" | "waiting" | "action-required" | "none"
    ): Promise<void> => {
      const desired = new Set(labelsForReviewFollowupState(config, state));
      const toAdd = Array.from(desired).filter((label) => !issue.labels.includes(label));
      if (toAdd.length > 0) {
        try {
          await client.addLabels(issue, toAdd);
          issue.labels = Array.from(new Set([...issue.labels, ...toAdd]));
        } catch (error) {
          log("warn", "Failed to add review follow-up labels.", json, {
            issue: issue.url,
            labels: toAdd,
            error: error instanceof Error ? error.message : String(error)
          }, "review");
        }
      }
      for (const label of reviewFollowupLabels) {
        if (!desired.has(label)) {
          await tryRemoveLabel(issue, label);
        }
      }
      issue.labels = issue.labels.filter((label) => !reviewFollowupLabelSet.has(label) || desired.has(label));
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
          }, "run");
        }
      }
      await client.comment(issue, body);
    };

    type ReviewFollowupStateComment = "waiting" | "action-required";
    const postedReviewFollowupStateMarkers = new Set<string>();

    const maybePostReviewFollowupStateComment = async (options: {
      issue: IssueInfo;
      state: ReviewFollowupStateComment;
      reason: string;
      queuedEngineFollowups?: number;
    }): Promise<void> => {
      if (dryRun) {
        return;
      }

      const marker =
        options.state === "waiting"
          ? REVIEW_FOLLOWUP_WAITING_MARKER
          : REVIEW_FOLLOWUP_ACTION_REQUIRED_MARKER;
      const key = `${options.issue.repo.owner}/${options.issue.repo.repo}#${options.issue.number}:${marker}`;
      if (postedReviewFollowupStateMarkers.has(key)) {
        return;
      }

      try {
        await tryApplyReviewFollowupLabelState(options.issue, options.state);
      } catch (error) {
        log("warn", "Failed to add review follow-up label while posting state.", json, {
          issue: options.issue.url,
          error: error instanceof Error ? error.message : String(error)
        }, "review");
      }

      try {
        const comments = await client.listIssueComments(options.issue);
        if (!shouldPostReviewFollowupMarkerComment(comments, marker)) {
          postedReviewFollowupStateMarkers.add(key);
          return;
        }

        const body =
          options.state === "waiting"
            ? buildReviewFollowupWaitingComment({
                reason: options.reason,
                queuedEngineFollowups: options.queuedEngineFollowups ?? 0
              })
            : buildReviewFollowupActionRequiredComment({
                reason: options.reason
              });

        await commentCompletion(options.issue, body);
        postedReviewFollowupStateMarkers.add(key);
      } catch (error) {
        log("warn", "Failed to post review follow-up state comment.", json, {
          issue: options.issue.url,
          state: options.state,
          reason: options.reason,
          error: error instanceof Error ? error.message : String(error)
        }, "review");
      }
    };

    const maybeNotifyIdlePullRequest = async (result: IdleTaskResult): Promise<void> => {
      try {
        await notifyIdlePullRequest({
          client,
          notifyClient,
          config,
          result,
          json,
          log: (level, message, jsonValue, metaOrTag, tag) => {
            if (typeof metaOrTag === "string") {
              log(level, message, jsonValue, metaOrTag);
              return;
            }
            log(level, message, jsonValue, metaOrTag, tag);
          }
        });
      } catch (error) {
        log("warn", "Failed to notify idle PR.", json, {
          repo: `${result.repo.owner}/${result.repo.repo}`,
          error: error instanceof Error ? error.message : String(error)
        }, "idle");
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
        await tryRemoveReviewFollowupLabels(issue);

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
            }, "resume");
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
            log("info", `Dry-run: would re-queue ${issue.url}`, json, "resume");
            resumed += 1;
            continue;
          }

          await client.addLabels(issue, [config.labels.queued]);
          await tryRemoveLabel(issue, config.labels.needsUserReply);
          await tryRemoveLabel(issue, config.labels.failed);
          await tryRemoveLabel(issue, config.labels.done);
          await tryRemoveLabel(issue, config.labels.running);
          await tryRemoveReviewFollowupLabels(issue);
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
              }, "resume");
            }
          }
          resumed += 1;
        }
      }
      return resumed;
    };

    const runIssueWithSessionResume = async (
      issue: IssueInfo,
      engine: IdleEngine
    ): Promise<Awaited<ReturnType<typeof runIssue>>> => {
      if (engine !== "codex") {
        return runIssue(client, config, issue, { engine });
      }
      let resumeSessionId = getIssueSession(issueSessionStatePath, issue);
      let resumePrompt: string | null =
        resumeSessionId
          ? "Continue from the previous Codex session and complete the pending task with the latest issue comments."
          : null;
      while (true) {
        const result = await runIssue(client, config, issue, {
          resumeSessionId,
          resumePrompt,
          engine
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
        await tryRemoveLabel(issue, config.labels.done);
        await tryRemoveLabel(issue, config.labels.running);
        await tryRemoveLabel(issue, config.labels.needsUserReply);
        await tryRemoveReviewFollowupLabels(issue);
        const when = formatResumeTime(runAfter);
        await commentCompletion(
          issue,
          buildAgentComment(
            `${title}\n\nCause: ${result.engine ?? "Codex"} usage limit reached.${detailLine}` +
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
        await tryRemoveReviewFollowupLabels(issue);
        const userReplyBody =
          result.summary?.trim() ||
          `${contextLabel === "review-followup" ? "Agent runner paused review follow-up." : "Agent runner paused."}` +
            `${detailLine}` +
            `\n\nPlease reply on this thread. The runner will resume from the same Codex session after your reply.`;
        await commentCompletion(
          issue,
          buildAgentComment(userReplyBody, [NEEDS_USER_MARKER])
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
      await tryRemoveLabel(issue, config.labels.done);
      await tryRemoveLabel(issue, config.labels.running);
      await tryRemoveLabel(issue, config.labels.needsUserReply);
      await tryRemoveReviewFollowupLabels(issue);
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
        ...reviewFollowupLabels,
        config.labels.running,
        config.labels.done,
        config.labels.failed,
        config.labels.needsUserReply
      ];
      const commandStatePath = resolveAgentCommandStatePath(config.workdirRoot);
      const managedStatePath = resolveManagedPullRequestsStatePath(config.workdirRoot);
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
        }, "queue");
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
          }, "queue");
          continue;
        }

        if (!triggerCommentId) {
          continue;
        }

        if (dryRun) {
          log("info", `Dry-run: would queue ${issue.url} via /agent run comment`, json, "queue");
          queued.push(issue);
          continue;
        }

        if (issue.isPullRequest) {
          try {
            await markManagedPullRequest(managedStatePath, issue.repo, issue.number);
          } catch (error) {
            log("warn", "Failed to record managed PR for /agent run catch-up.", json, {
              issue: issue.url,
              error: error instanceof Error ? error.message : String(error)
            }, "queue");
          }
        }

        try {
          await client.addLabels(issue, [config.labels.queued]);
          clearRetry(scheduledRetryStatePath, issue.id);
          queued.push(issue);
        } catch (error) {
          log("warn", "Failed to add queued label for /agent run request.", json, {
            issue: issue.url,
            error: error instanceof Error ? error.message : String(error)
          }, "queue");
          continue;
        }

        try {
          await markAgentCommandCommentProcessed(commandStatePath, triggerCommentId);
        } catch (error) {
          log("warn", "Failed to mark /agent run comment as processed.", json, {
            issue: issue.url,
            commentId: triggerCommentId,
            error: error instanceof Error ? error.message : String(error)
          }, "queue");
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
        log("info", "Pruned stale activity records.", json, { removed: prunedActivityCount }, "maint");
      }
      if (shouldListRepos) {
        const repoResult = await listTargetRepos(client, config, config.workdirRoot);
        rateLimitedUntil = repoResult.blockedUntil;
        if (repoResult.source === "cache" && repoResult.blockedUntil) {
          log(
            "warn",
            `Using cached repo list due to rate limit until ${repoResult.blockedUntil}.`,
            json,
            "init"
          );
        } else if (repoResult.source === "local" && repoResult.blockedUntil) {
          log(
            "warn",
            `Using local workspace repo list due to rate limit until ${repoResult.blockedUntil}.`,
            json,
            "init"
          );
        } else if (repoResult.source === "cache") {
          log("info", "Using cached repo list.", json, "init");
        } else if (repoResult.source === "local") {
          log("info", "Using local workspace repo list.", json, "init");
        }
        repos = repoResult.repos;
        log("info", `Discovered ${repos.length} repositories.`, json, "init");
      } else {
        log("info", "Skipping repo discovery; webhooks enabled.", json, "init");
      }

      if (rateLimitedUntil && shouldPollIssues) {
        log("warn", `Skipping GitHub issue polling until ${rateLimitedUntil}.`, json, "init");
      }

      const statePath = resolveRunnerStatePath(config.workdirRoot);
      let state;
      try {
        state = loadRunnerState(statePath);
      } catch (error) {
        log("warn", "Failed to read runner state; skipping running issue checks.", json, {
          error: error instanceof Error ? error.message : String(error)
        }, "init");
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
                postRecoveryComment: (target, message) =>
                  commentCompletion(target, buildAgentComment(message)),
                log: (level, message, data) => log(level, message, json, data, "recovery")
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
                postRecoveryComment: (target, message) =>
                  commentCompletion(target, buildAgentComment(message)),
                log: (level, message, data) => log(level, message, json, data, "recovery")
              });
            }
          }
        } else if (webhooksEnabled) {
          let runningIssues: IssueInfo[] | null = null;
          try {
            runningIssues = await client.searchOpenItemsByLabelAcrossOwner(config.owner, config.labels.running, {
              perPage: 100,
              maxPages: 1
            });
          } catch (error) {
            log(
              "warn",
              "Failed to search running issues in webhook mode; falling back to state-only recovery.",
              json,
              { error: error instanceof Error ? error.message : String(error) },
              "recovery"
            );
          }

          if (runningIssues) {
            const plans = planWebhookRunningRecoveries({
              issuesWithRunningLabel: runningIssues,
              state,
              config,
              aliveCheck: isProcessAlive
            });
            for (const plan of plans) {
              await recoverStalledIssue({
                issue: plan.issue,
                reason: plan.reason,
                pid: plan.pid,
                dryRun,
                labels: config.labels,
                webhookQueuePath,
                addLabel: (target, labels) => client.addLabels(target, labels),
                removeLabel: tryRemoveLabel,
                enqueueWebhookIssue,
                removeRunningIssue: (issueId) => removeRunningIssue(statePath, issueId),
                removeActivity: (activityId) => removeActivity(activityPath, activityId),
                clearRetry: (issueId) => clearRetry(scheduledRetryStatePath, issueId),
                postRecoveryComment: (target, message) =>
                  commentCompletion(target, buildAgentComment(message)),
                log: (level, message, data) => log(level, message, json, data, "recovery")
              });
            }
          } else {
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
                postRecoveryComment: (target, message) =>
                  commentCompletion(target, buildAgentComment(message)),
                log: (level, message, data) => log(level, message, json, data, "recovery")
              });
            }
          }
        }
      }

      const resumed =
        shouldPollIssues && !rateLimitedUntil ? await resumeAwaitingUser(repos) : 0;
      if (resumed > 0) {
        log("info", `Re-queued ${resumed} request(s) after user reply.`, json, "resume");
      }

      const resumedBySchedule = await enqueueDueScheduledRetries();
      if (resumedBySchedule > 0) {
        log("info", `Re-queued ${resumedBySchedule} request(s) after scheduled retry time.`, json, "resume");
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
          log("info", `Queued ${queued.length} request(s) via /agent run comments.`, json, "queue");
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
            log("warn", "Idle Codex usage gate: unable to read rate limits from app-server.", json, "idle");
            return false;
          }

          const decision = evaluateUsageGate(status, usageGate);
          if (!decision.allow) {
            log("info", `Idle Codex usage gate blocked. ${decision.reason}`, json, "idle");
            return false;
          }

          log("info", `Idle Codex usage gate allowed. ${decision.reason}`, json, {
            window: decision.window?.label,
            minutesToReset: decision.minutesToReset
          }, "idle");

          if (timingEnabled && timingEvents.length > 0) {
            log(
              "info",
              `${timingPrefix} (Codex): ${timingEvents.map((event) => `${event.phase}=${event.durationMs}ms`).join(", ")}`,
              json,
              "idle"
            );
          }

          return true;
        } catch (error) {
          log("warn", "Idle Codex usage gate failed. Codex idle disabled.", json, {
            error: error instanceof Error ? error.message : String(error)
          }, "idle");
          return false;
        }
      };

      const resolveAllowedIdleEngines = async (options: {
        allowGeminiWarmup: boolean;
      }): Promise<{
        engines: IdleEngine[];
        geminiWarmup: { warmupPro: boolean; warmupFlash: boolean; reason: string | null };
      }> => {
        const codexAllowed = await evaluateCodexIdleAllowed();

        let copilotAllowed = false;
        const copilotGate = config.idle?.copilotUsageGate;
        if (copilotGate?.enabled) {
          try {
            const copilotStart = Date.now();
            const usage = await fetchCopilotUsage(token, copilotGate);
            if (timingEnabled) {
              log("info", `${timingPrefix} (Copilot): rateLimits=${Date.now() - copilotStart}ms`, json, "idle");
            }
            if (!usage) {
              log("warn", "Idle Copilot usage gate: unable to parse Copilot quota info.", json, "idle");
            } else {
              const decision = evaluateCopilotUsageGate(usage, copilotGate);
              if (!decision.allow) {
                log("info", `Idle Copilot usage gate blocked. ${decision.reason}`, json, "idle");
              } else {
                copilotAllowed = true;
                log("info", `Idle Copilot usage gate allowed. ${decision.reason}`, json, {
                  percentRemaining: decision.percentRemaining,
                  minutesToReset: decision.minutesToReset
                }, "idle");
              }
            }
          } catch (error) {
            log("warn", "Idle Copilot usage gate failed. Copilot idle disabled.", json, {
              error: error instanceof Error ? error.message : String(error)
            }, "idle");
          }
        }

        if (copilotAllowed) {
          if (!config.copilot) {
            log("warn", "Idle Copilot enabled but no copilot command configured. Skipping Copilot idle.", json, "idle");
            copilotAllowed = false;
          } else {
            const exists = await commandExists(config.copilot.command);
            if (!exists) {
              log("warn", `Idle Copilot command not found (${config.copilot.command}). Skipping Copilot idle.`, json, "idle");
              copilotAllowed = false;
            }
          }
        }

        let geminiProAllowed = false;
        let geminiFlashAllowed = false;
        let geminiWarmupPro = false;
        let geminiWarmupFlash = false;
        let geminiWarmupReason: string | null = null;
        const geminiGate = config.idle?.geminiUsageGate;
        if (geminiGate?.enabled) {
          try {
            const geminiStart = Date.now();
            const usage = await fetchGeminiUsage();
            if (timingEnabled) {
              log("info", `${timingPrefix} (Gemini): rateLimits=${Date.now() - geminiStart}ms`, json, "idle");
            }
            if (!usage) {
              log("warn", "Idle Gemini usage gate: unable to parse Gemini quota info.", json, "idle");
            } else {
              const now = new Date();
              const decision = evaluateGeminiUsageGate(usage, geminiGate, now);
              if (!decision.allowPro && !decision.allowFlash) {
                if (options.allowGeminiWarmup) {
                  let warmupState = { models: {} };
                  try {
                    warmupState = loadGeminiWarmupState(resolveGeminiWarmupStatePath(config.workdirRoot));
                  } catch (error) {
                    log("warn", "Idle Gemini warmup: unable to read warmup state. Proceeding without cooldown.", json, {
                      error: error instanceof Error ? error.message : String(error)
                    }, "idle");
                  }

                  const warmupDecision = evaluateGeminiWarmup(usage, geminiGate, warmupState, now);
                  if (warmupDecision?.warmupPro || warmupDecision?.warmupFlash) {
                    geminiWarmupPro = warmupDecision.warmupPro;
                    geminiWarmupFlash = warmupDecision.warmupFlash;
                    geminiWarmupReason = warmupDecision.reason;
                    if (geminiWarmupPro) geminiProAllowed = true;
                    if (geminiWarmupFlash) geminiFlashAllowed = true;
                    log("info", `Idle Gemini warmup allowed. ${warmupDecision.reason}`, json, "idle");
                  } else {
                    log("info", `Idle Gemini usage gate blocked. ${decision.reason}`, json, "idle");
                  }
                } else {
                  log("info", `Idle Gemini usage gate blocked. ${decision.reason}`, json, "idle");
                }
              } else {
                if (decision.allowPro) geminiProAllowed = true;
                if (decision.allowFlash) geminiFlashAllowed = true;
                log("info", `Idle Gemini usage gate allowed. ${decision.reason}`, json, "idle");
              }
            }
          } catch (error) {
            log("warn", "Idle Gemini usage gate failed. Gemini idle disabled.", json, {
              error: error instanceof Error ? error.message : String(error)
            }, "idle");
          }
        }

        if (geminiProAllowed || geminiFlashAllowed) {
          if (!config.gemini) {
            log("warn", "Idle Gemini enabled but no gemini command configured. Skipping Gemini idle.", json, "idle");
            geminiProAllowed = false;
            geminiFlashAllowed = false;
            geminiWarmupPro = false;
            geminiWarmupFlash = false;
            geminiWarmupReason = null;
          } else {
            const exists = await commandExists(config.gemini.command);
            if (!exists) {
              log("warn", `Idle Gemini command not found (${config.gemini.command}).`, json, "idle");
              geminiProAllowed = false;
              geminiFlashAllowed = false;
              geminiWarmupPro = false;
              geminiWarmupFlash = false;
              geminiWarmupReason = null;
            }
          }
        }

        let amazonQAllowed = false;
        if (config.amazonQ?.enabled) {
          const exists = await commandExists(config.amazonQ.command);
          if (!exists) {
            log("warn", `Idle Amazon Q command not found (${config.amazonQ.command}).`, json, "idle");
          } else {
            const amazonQGate = config.idle?.amazonQUsageGate;
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
                  log("info", `Idle Amazon Q usage gate blocked. ${decision.reason}`, json, "idle");
                } else {
                  amazonQAllowed = true;
                  log("info", `Idle Amazon Q usage gate allowed. ${decision.reason}`, json, {
                    percentRemaining: decision.percentRemaining,
                    minutesToReset: decision.minutesToReset,
                    used: decision.used,
                    limit: decision.limit
                  }, "idle");
                }
              } catch (error) {
                log("warn", "Idle Amazon Q usage gate failed. Amazon Q idle disabled.", json, {
                  error: error instanceof Error ? error.message : String(error)
                }, "idle");
              }
            } else {
              amazonQAllowed = true;
            }
          }
        }

        let claudeAllowed = false;
        if (config.claude?.enabled) {
          const exists = await commandExists(config.claude.command);
          if (!exists) {
            log("warn", `Idle Claude command not found (${config.claude.command}).`, json, "idle");
          } else {
            const claudeGate = config.idle?.claudeUsageGate;
            if (claudeGate?.enabled) {
              const now = new Date();
              const usage = await fetchClaudeUsage(5000);
              const decision = evaluateClaudeUsageGate(usage, claudeGate, now);
              if (!decision.allowed) {
                log("info", `Idle Claude usage gate blocked. ${decision.reason}`, json, "idle");
              } else {
                claudeAllowed = true;
                log("info", `Idle Claude usage gate allowed. ${decision.reason}`, json, "idle");
              }
            } else {
              claudeAllowed = true;
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
        if (claudeAllowed) {
          engines.push("claude");
        }

        return {
          engines,
          geminiWarmup: {
            warmupPro: geminiWarmupPro,
            warmupFlash: geminiWarmupFlash,
            reason: geminiWarmupReason
          }
        };
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
          let allowedEngines: IdleEngine[] = [];
          if (dryRun) {
            queue = backlog.slice(0, maxEntries);
            allowedEngines = ["codex"];
          } else {
            const mergeOnly = await takeReviewTasksWhere(reviewQueuePath, maxEntries, (entry) => !entry.requiresEngine);
            queue.push(...mergeOnly);
            const remaining = maxEntries - mergeOnly.length;
            if (remaining > 0 && engineBacklog.length > 0) {
              const gate = await resolveAllowedIdleEngines({ allowGeminiWarmup: false });
              allowedEngines = gate.engines;
              if (allowedEngines.length === 0) {
                log(
                  "info",
                  "Review follow-up backlog detected but all idle engine gates are blocked. Skipping engine-required review follow-ups.",
                  json,
                  { queued: engineBacklog.length },
                  "review"
                );
                for (const entry of engineBacklog) {
                  const followupIssue = await client.getIssue(entry.repo, entry.prNumber);
                  if (!followupIssue) {
                    continue;
                  }
                  await maybePostReviewFollowupStateComment({
                    issue: followupIssue,
                    state: "waiting",
                    reason: "idle_engine_gates_blocked",
                    queuedEngineFollowups: engineBacklog.length
                  });
                }
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
              }, "review");
            } else if (engineBacklog.length > 0) {
              log("info", "Review follow-up backlog detected but nothing was scheduled.", json, {
                queued: engineBacklog.length
              }, "review");
            }
          } else {
            scheduledReviewFollowups = scheduleReviewFollowups({
              normalRunning: picked.length,
              concurrency: config.concurrency,
              allowedEngines,
              queue
            });
          }
        }
      }

      if (picked.length === 0 && scheduledReviewFollowups.length === 0) {
        if (!config.idle?.enabled) {
          log("info", "No queued requests.", json, "queue");
          return;
        }

        const gate = await resolveAllowedIdleEngines({ allowGeminiWarmup: true });
        const engines = gate.engines;
        const geminiWarmupPro = gate.geminiWarmup.warmupPro;
        const geminiWarmupFlash = gate.geminiWarmup.warmupFlash;
        const geminiWarmupReason = gate.geminiWarmup.reason;

        if (engines.length === 0) {
          log("info", "Idle usage gate blocked for all engines. Skipping idle.", json, "idle");
          return;
        }

        let idleRepos = repos;
        if (config.idle?.repoScope === "local") {
          idleRepos = listLocalRepos(config.workdirRoot, config.owner);
          log(
            "info",
            `Idle repo scope set to local. Using ${idleRepos.length} workspace repo(s).`,
            json,
            "idle"
          );
        }

        let maxRuns = config.idle.maxRunsPerCycle;
        if (engines.length > maxRuns) {
          log(
            "warn",
            `Idle maxRunsPerCycle (${maxRuns}) is below available engines (${engines.length}). Scheduling ${engines.length} idle task(s).`,
            json,
            "idle"
          );
          maxRuns = engines.length;
        }
        const idleTasks = await planIdleTasks(config, idleRepos, {
          maxRuns,
          now: new Date()
        });
        if (idleTasks.length === 0) {
          log("info", "No queued requests. Idle cooldown active or no eligible repos.", json, "idle");
          return;
        }

        if (idleTasks.length < engines.length) {
          log(
            "warn",
            `Only ${idleTasks.length} idle task(s) available for ${engines.length} engine(s).`,
            json,
            "idle"
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
          },
          "idle"
        );

        if (dryRun) {
          log("info", "Dry-run: would execute idle tasks.", json, {
            tasks: scheduled.map((task) => ({
              repo: `${task.repo.owner}/${task.repo.repo}`,
              engine: task.engine,
              task: task.task
            }))
          }, "idle");
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
            }, "idle");
          } catch (error) {
            log("warn", "Idle Gemini warmup: unable to record warmup attempt.", json, {
              error: error instanceof Error ? error.message : String(error),
              reason: geminiWarmupReason
            }, "idle");
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
                }, "idle");
                return;
              }
              log("warn", "Idle task failed.", json, {
                repo: `${result.repo.owner}/${result.repo.repo}`,
                engine: result.engine,
                report: result.reportPath,
                log: result.logPath
              }, "idle");
            })
          )
        );

        return;
      }

      if (dryRun) {
        log("info", `Dry-run: would process ${picked.length} request(s).`, json, {
          issues: picked.map((issue) => issue.url)
        }, "run");
        if (scheduledReviewFollowups.length > 0) {
          log("info", `Dry-run: would process ${scheduledReviewFollowups.length} review follow-up(s).`, json, {
            followups: scheduledReviewFollowups.map((followup) => ({
              url: followup.url,
              reason: followup.reason,
              requiresEngine: followup.requiresEngine
            }))
          }, "review");
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

              const result = await runWithServiceSlot(serviceLimiters.codex, {
                beforeStart: async () => {
                  await client.addLabels(issue, [config.labels.running]);
                  await tryRemoveLabel(issue, config.labels.queued);
                  await tryRemoveReviewFollowupLabels(issue);
                  await commentCompletion(
                    issue,
                    buildAgentComment(
                      `Agent runner started on ${new Date().toISOString()}. Concurrency ${config.concurrency}.`
                    )
                  );
                  clearRetry(scheduledRetryStatePath, issue.id);
                  if (webhooksEnabled && webhookQueuePath) {
                    await removeWebhookIssues(webhookQueuePath, [issue.id]);
                  }
                },
                task: () => runIssueWithSessionResume(issue, "codex")
              });
              activityId = result.activityId;
              if (result.success) {
                clearRetry(scheduledRetryStatePath, issue.id);
                clearIssueSession(issueSessionStatePath, issue.id);
                if (result.summary) {
                  const pr = parseLastPullRequestUrl(result.summary);
                  if (pr) {
                    try {
                      const prIssue = await client.getIssue(pr.repo, pr.number);
                      if (prIssue) {
                        await ensureManagedPullRequestRecorded(prIssue, config);
                      }
                    } catch (error) {
                      log("warn", "Failed to record managed PR from run summary.", json, {
                        issue: issue.url,
                        pr: pr.url,
                        error: error instanceof Error ? error.message : String(error)
                      }, "run");
                    }
                  }
                }
                await client.addLabels(issue, [config.labels.done]);
                await tryRemoveLabel(issue, config.labels.running);
                await tryRemoveLabel(issue, config.labels.failed);
                await tryRemoveLabel(issue, config.labels.needsUserReply);
                await tryRemoveReviewFollowupLabels(issue);
                await commentCompletion(
                  issue,
                  buildAgentComment(result.summary?.trim() || "Agent runner completed successfully.")
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
              await tryRemoveReviewFollowupLabels(issue);
              await commentCompletion(
                issue,
                buildAgentComment(
                  `Agent runner failed with error: ${extractErrorMessage(error)}`
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
              log("warn", "Review follow-up skipped: unable to resolve PR.", json, { url: followup.url }, "review");
              return;
            }
            await tryRemoveReviewFollowupLabels(issue);

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
                  const requiresEngine = shouldAutoMergeRetryRequireEngine(merge.reason);
                  const reviewQueuePath = resolveReviewQueuePath(config.workdirRoot);
                  await enqueueReviewTask(reviewQueuePath, {
                    issueId: followup.issueId,
                    prNumber: followup.prNumber,
                    repo: followup.repo,
                    url: followup.url,
                    reason: followup.reason,
                    requiresEngine
                  });
                  await tryApplyReviewFollowupLabelState(issue, "queued");
                  log("info", "Auto-merge not ready yet; re-queued approval follow-up.", json, {
                    url: followup.url,
                    reason: merge.reason,
                    requiresEngine
                  }, "review");
                  return;
                }

                log("info", "Auto-merge skipped.", json, { url: followup.url, reason: merge.reason }, "review");
                if (isManualActionRequiredForAutoMergeSkip(merge.reason)) {
                  await maybePostReviewFollowupStateComment({
                    issue,
                    state: "action-required",
                    reason: merge.reason
                  });
                }
              } catch (error) {
                log("warn", "Auto-merge failed.", json, {
                  url: followup.url,
                  error: error instanceof Error ? error.message : String(error)
                }, "review");
              }
              return;
            }

            let activityId: string | null = null;
            try {
              const service = idleEngineToService(followup.engine);
              const result = await runWithServiceSlot(serviceLimiters[service], {
                beforeStart: async () => {
                  await client.addLabels(issue, [config.labels.running]);
                  await tryRemoveLabel(issue, config.labels.queued);
                  await tryRemoveReviewFollowupLabels(issue);
                  await commentCompletion(
                    issue,
                    buildAgentComment(
                      `Agent runner started review follow-up (${followup.reason}) on ${new Date().toISOString()}. Concurrency ${config.concurrency}.`
                    )
                  );
                  clearRetry(scheduledRetryStatePath, issue.id);
                },
                task: () => runIssueWithSessionResume(issue, followup.engine)
              });
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
                    }, "review");
                  }
                } catch (error) {
                  log("warn", "Failed to resolve PR review threads after follow-up run.", json, {
                    url: followup.url,
                    error: error instanceof Error ? error.message : String(error)
                  }, "review");
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
                  }, "review");
                } catch (error) {
                  log("warn", "Failed to re-request reviewers after follow-up run.", json, {
                    url: followup.url,
                    error: error instanceof Error ? error.message : String(error)
                  }, "review");
                }

                await client.addLabels(issue, [config.labels.done]);
                await tryRemoveLabel(issue, config.labels.running);
                await tryRemoveLabel(issue, config.labels.failed);
                await tryRemoveLabel(issue, config.labels.needsUserReply);
                await tryRemoveReviewFollowupLabels(issue);
                await commentCompletion(
                  issue,
                  buildAgentComment(result.summary?.trim() || "Agent runner completed review follow-up successfully.")
                );
                return;
              }

              if (result.failureKind === "quota") {
                const reqPath = resolveReviewQueuePath(config.workdirRoot);
                await enqueueReviewTask(reqPath, {
                  issueId: followup.issueId,
                  prNumber: followup.prNumber,
                  repo: followup.repo,
                  url: followup.url,
                  reason: followup.reason,
                  requiresEngine: followup.requiresEngine
                });
                await tryRemoveLabel(issue, config.labels.running);
                await tryApplyReviewFollowupLabelState(issue, "queued");
                const engineName = result.engine ?? followup.engine ?? "unknown";
                await commentCompletion(
                  issue,
                  buildAgentComment(
                    `Review follow-up paused due to engine capacity limits (${engineName}).` +
                      `\n\nThe task has been re-queued and will retry when engine capacity is available.` +
                      `${result.logPath ? `\n\nLog: ${result.logPath}` : ""}`
                  )
                );
                log("info", "Review follow-up re-queued after quota/capacity failure.", json, {
                  url: followup.url,
                  engine: engineName
                }, "review");
                return;
              }
              await handleRunFailure(issue, result, "review-followup");
            } catch (error) {
              const errorMessage = extractErrorMessage(error);
              if (hasPattern(errorMessage, QUOTA_ERROR_PATTERNS)) {
                try {
                  const reqPath = resolveReviewQueuePath(config.workdirRoot);
                  await enqueueReviewTask(reqPath, {
                    issueId: followup.issueId,
                    prNumber: followup.prNumber,
                    repo: followup.repo,
                    url: followup.url,
                    reason: followup.reason,
                    requiresEngine: followup.requiresEngine
                  });
                  await tryRemoveLabel(issue, config.labels.running);
                  await tryApplyReviewFollowupLabelState(issue, "queued");
                  const engineName = followup.engine ?? "unknown";
                  await commentCompletion(
                    issue,
                    buildAgentComment(
                      `Review follow-up paused due to engine capacity limits (${engineName}).` +
                        `\n\nThe task has been re-queued and will retry when engine capacity is available.`
                    )
                  );
                  log("info", "Review follow-up re-queued after exception with quota pattern.", json, {
                    url: followup.url,
                    engine: engineName,
                    error: errorMessage
                  }, "review");
                  return;
                } catch (requeueError) {
                  log("warn", "Failed to re-queue review follow-up after quota exception.", json, {
                    url: followup.url,
                    error: requeueError instanceof Error ? requeueError.message : String(requeueError)
                  }, "review");
                }
              }
              clearRetry(scheduledRetryStatePath, issue.id);
              clearIssueSession(issueSessionStatePath, issue.id);
              await client.addLabels(issue, [config.labels.failed]);
              await tryRemoveLabel(issue, config.labels.running);
              await tryRemoveLabel(issue, config.labels.needsUserReply);
              await tryRemoveReviewFollowupLabels(issue);
              await commentCompletion(
                issue,
                buildAgentComment(
                  `Agent runner failed review follow-up with error: ${errorMessage}`
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
          log("info", "Stop requested. Exiting runner loop.", json, "init");
          releaseLock(lock);
          return;
        }
        await runCycle();
        releaseLock(lock);
        return;
      }

      while (true) {
        if (isStopRequested(config.workdirRoot)) {
          log("info", "Stop requested. Exiting runner loop.", json, "init");
          break;
        }
        await runCycle();
        if (isStopRequested(config.workdirRoot)) {
          log("info", "Stop requested. Exiting runner loop.", json, "init");
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

    log("info", `Syncing labels across ${repos.length} repositories.`, json, "init");

    for (const repo of repos) {
      for (const label of labels) {
        const existing = await client.getLabel(repo, label.name);
        if (!existing) {
          if (dryRun) {
            log("info", `Would create label ${label.name} in ${repo.repo}.`, json, "init");
            continue;
          }
          await client.createLabel(repo, label);
          log("info", `Created label ${label.name} in ${repo.repo}.`, json, "init");
          continue;
        }

        const needsUpdate =
          existing.color.toLowerCase() !== label.color.toLowerCase() ||
          (existing.description ?? "") !== label.description;

        if (!needsUpdate) {
          continue;
        }

        if (dryRun) {
          log("info", `Would update label ${label.name} in ${repo.repo}.`, json, "init");
          continue;
        }

        const payload: LabelInfo = {
          name: label.name,
          color: label.color,
          description: label.description
        };
        await client.updateLabel(repo, payload);
        log("info", `Updated label ${label.name} in ${repo.repo}.`, json, "init");
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
        }, "maint");
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
        }, "maint");
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
    const followups = snapshot.reviewFollowups ?? [];
    const mergeOnly = followups.filter((entry) => !entry.requiresEngine).length;
    const engineRequired = followups.length - mergeOnly;
    console.log(
      `Review follow-ups: ${followups.length} (merge-only: ${mergeOnly}, engine-required: ${engineRequired})`
    );
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

const uiCommand = program
  .command("ui")
  .description("Manage the local status UI server.");

uiCommand
  .command("start")
  .description("Start status UI in the background.")
  .option("-c, --config <path>", "Path to config file", "agent-runner.config.json")
  .option("--host <host>", "Host to bind", "127.0.0.1")
  .option("--port <port>", "Port to bind", "4311")
  .action(async (options) => {
    const configPath = path.resolve(process.cwd(), options.config);
    const config = loadConfig(configPath);
    const host = String(options.host);
    const port = parsePort(String(options.port));
    const statePath = resolveUiServerStatePath(config.workdirRoot);
    const existing = loadUiServerState(statePath);
    if (existing) {
      const alive = isUiServerProcessAlive(existing);
      const listening = alive ? await probeUiServer(existing.host, existing.port, 500) : false;
      if (alive && listening) {
        console.log(`Status UI already running on http://${existing.host}:${existing.port}/ (pid ${existing.pid}).`);
        return;
      }
      clearUiServerState(statePath);
    }

    const entryScript = resolveCliEntryScriptPath();
    const child = spawn(
      process.execPath,
      [
        entryScript,
        "ui",
        "serve",
        "--config",
        configPath,
        "--host",
        host,
        "--port",
        String(port)
      ],
      {
        cwd: process.cwd(),
        detached: true,
        stdio: "ignore",
        windowsHide: true
      }
    );
    if (!child.pid || child.pid <= 0) {
      throw new Error("Failed to start status UI process.");
    }
    child.unref();

    const state: UiServerState = {
      pid: child.pid,
      host,
      port,
      startedAt: new Date().toISOString(),
      configPath
    };
    saveUiServerState(statePath, state);

    const listening = await waitForUiServer(host, port, 30, 150);
    if (listening) {
      console.log(`Status UI started on http://${host}:${port}/ (pid ${child.pid}).`);
      return;
    }
    console.log(
      `Status UI process started (pid ${child.pid}), but endpoint is not reachable yet. Check with 'agent-runner ui status'.`
    );
  });

uiCommand
  .command("stop")
  .description("Stop background status UI process.")
  .option("-c, --config <path>", "Path to config file", "agent-runner.config.json")
  .action(async (options) => {
    const configPath = path.resolve(process.cwd(), options.config);
    const config = loadConfig(configPath);
    const statePath = resolveUiServerStatePath(config.workdirRoot);
    const state = loadUiServerState(statePath);
    if (!state) {
      console.log("Status UI is not running.");
      return;
    }

    const alive = isUiServerProcessAlive(state);
    if (!alive) {
      clearUiServerState(statePath);
      console.log("Status UI state was stale and has been cleared.");
      return;
    }

    try {
      process.kill(state.pid);
    } catch (error) {
      const code = typeof error === "object" && error ? (error as NodeJS.ErrnoException).code : null;
      if (code !== "ESRCH") {
        throw error;
      }
    }

    let stopped = false;
    for (let i = 0; i < 30; i += 1) {
      if (!isUiServerProcessAlive(state)) {
        stopped = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    clearUiServerState(statePath);
    if (stopped) {
      console.log("Status UI stopped.");
      return;
    }
    console.log("Stop signal sent. Process may still be shutting down.");
  });

uiCommand
  .command("status")
  .description("Show background status UI state.")
  .option("-c, --config <path>", "Path to config file", "agent-runner.config.json")
  .option("--json", "Output JSON", false)
  .action(async (options) => {
    const configPath = path.resolve(process.cwd(), options.config);
    const config = loadConfig(configPath);
    const statePath = resolveUiServerStatePath(config.workdirRoot);
    const state = loadUiServerState(statePath);
    if (!state) {
      if (options.json) {
        console.log(JSON.stringify({ status: "stopped", statePath }, null, 2));
      } else {
        console.log("Status UI: stopped");
      }
      return;
    }

    const alive = isUiServerProcessAlive(state);
    const listening = alive ? await probeUiServer(state.host, state.port, 500) : false;
    const status = alive ? (listening ? "running" : "starting") : "stopped";
    if (!alive) {
      clearUiServerState(statePath);
    }

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            status,
            alive,
            listening,
            statePath,
            host: state.host,
            port: state.port,
            pid: state.pid,
            startedAt: state.startedAt,
            configPath: state.configPath
          },
          null,
          2
        )
      );
      return;
    }

    console.log(`Status UI: ${status}`);
    console.log(`URL: http://${state.host}:${state.port}/`);
    console.log(`PID: ${state.pid}`);
    console.log(`Started: ${state.startedAt}`);
    if (!alive) {
      console.log("Stored state was stale and has been cleared.");
    } else if (!listening) {
      console.log("Process is alive, but endpoint is not reachable yet.");
    }
  });

uiCommand
  .command("serve")
  .description("Serve status UI in foreground (used by `ui start`).")
  .option("-c, --config <path>", "Path to config file", "agent-runner.config.json")
  .option("--host <host>", "Host to bind", "127.0.0.1")
  .option("--port <port>", "Port to bind", "4311")
  .action(async (options) => {
    const configPath = path.resolve(process.cwd(), options.config);
    const config = loadConfig(configPath);
    const host = String(options.host);
    const port = parsePort(String(options.port));
    const statePath = resolveUiServerStatePath(config.workdirRoot);
    saveUiServerState(statePath, {
      pid: process.pid,
      host,
      port,
      startedAt: new Date().toISOString(),
      configPath
    });

    process.once("exit", () => clearUiServerState(statePath));
    process.once("SIGTERM", () => {
      clearUiServerState(statePath);
      process.exit(0);
    });
    process.once("SIGINT", () => {
      clearUiServerState(statePath);
      process.exit(0);
    });

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
        json,
        "init"
      );
    }

    if (!client && token) {
      client = new GitHubClient(token);
      log("info", "Webhook listener GitHub client configured via environment token.", json, "init");
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
          onLog: (level, message, data) => log(level, message, json, data, "queue")
        }),
      onLog: (level, message, data) => log(level, message, json, data, "queue")
    });
    log("info", `Webhook listener ready on http://${host}:${portRaw}${pathValue}`, json, "init");
  });

program.parseAsync(process.argv);
