#!/usr/bin/env node
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
import {
  evaluateUsageGate,
  fetchCodexRateLimits,
  rateLimitSnapshotToStatus
} from "./codex-status.js";
import { evaluateCopilotUsageGate, fetchCopilotUsage } from "./copilot-usage.js";
import { commandExists } from "./command-exists.js";
import { listTargetRepos, listQueuedIssues, pickNextIssues, queueNewRequests } from "./queue.js";
import { planIdleTasks, runIdleTask, runIssue } from "./runner.js";
import type { IdleEngine } from "./runner.js";
import { listLocalRepos } from "./local-repos.js";
import {
  evaluateRunningIssues,
  isProcessAlive,
  loadRunnerState,
  resolveRunnerStatePath
} from "./runner-state.js";
import { startStatusServer } from "./status-server.js";
import { buildStatusSnapshot } from "./status-snapshot.js";
import { removeActivity, resolveActivityStatePath } from "./activity-state.js";
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
    config.labels.needsUser
  ];

  log("info", "Webhook catch-up scan: searching for missed agent:request issues.", json, {
    intervalMinutes: catchup.intervalMinutes,
    maxIssuesPerRun: maxIssues
  });

  let found: IssueInfo[] = [];
  try {
    found = await client.searchOpenIssuesByLabelAcrossOwner(config.owner, config.labels.request, {
      excludeLabels,
      perPage: 100,
      maxPages: 1
    });
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

  for (const issue of limited) {
    if (dryRun) {
      log("info", `Dry-run: would queue catch-up issue ${issue.url}`, json);
      continue;
    }
    try {
      await client.addLabels(issue, [config.labels.queued]);
    } catch (error) {
      log("warn", "Failed to add queued label during catch-up.", json, {
        issue: issue.url,
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }
    try {
      await enqueueWebhookIssue(queuePath, issue);
    } catch (error) {
      log("warn", "Failed to enqueue catch-up issue.", json, {
        issue: issue.url,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  saveWebhookCatchupState(statePath, { lastRunAt: now.toISOString() });
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
      issue.labels.includes(config.labels.needsUser) ||
      issue.labels.includes(config.labels.done) ||
      issue.labels.includes(config.labels.failed)
    ) {
      removeIds.push(entry.issueId);
      continue;
    }

    if (!issue.labels.includes(config.labels.queued) && issue.labels.includes(config.labels.request)) {
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

    const token =
      process.env.AGENT_GITHUB_TOKEN ||
      process.env.GITHUB_TOKEN ||
      process.env.GH_TOKEN;

    if (!token) {
      throw new Error("Missing GitHub token. Set AGENT_GITHUB_TOKEN or GITHUB_TOKEN.");
    }

    const lock = acquireLock(path.resolve(config.workdirRoot, "agent-runner", "state", "runner.lock"));
    const client = new GitHubClient(token);
    const tryRemoveLabel = async (issue: IssueInfo, label: string): Promise<void> => {
      try {
        await client.removeLabel(issue, label);
      } catch (error) {
        log("warn", `Failed to remove label ${label} from ${issue.url}`, json, {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    };

    const formatMention = (issue: IssueInfo): string =>
      issue.author ? `@${issue.author} ` : "";

    const resumeAwaitingUser = async (repos: RepoInfo[]): Promise<number> => {
      let resumed = 0;
      for (const repo of repos) {
        const awaiting = await client.listIssuesByLabel(repo, config.labels.needsUser);
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

          await client.addLabels(issue, [config.labels.request]);
          await tryRemoveLabel(issue, config.labels.needsUser);
          await tryRemoveLabel(issue, config.labels.failed);
          await tryRemoveLabel(issue, config.labels.running);
          await tryRemoveLabel(issue, config.labels.queued);
          await client.comment(
            issue,
            buildAgentComment(
              `${formatMention(issue)}Reply received. Re-queued for execution.`,
              []
            )
          );
          resumed += 1;
        }
      }
      return resumed;
    };

    const runCycle = async (): Promise<void> => {
      const idleEnabled = Boolean(config.idle?.enabled);
      const idleNeedsAllRepos = idleEnabled && config.idle?.repoScope !== "local";
      const shouldPollIssues = !webhooksEnabled;
      const shouldListRepos = shouldPollIssues || idleNeedsAllRepos;

      let repos: RepoInfo[] = [];
      let rateLimitedUntil: string | null = null;
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
              if (dryRun) {
                log("info", `Dry-run: would mark ${issue.issue.url} failed (process exited).`, json);
                continue;
              }

              await client.addLabels(issue.issue, [config.labels.failed, config.labels.needsUser]);
              await tryRemoveLabel(issue.issue, config.labels.running);
              await client.comment(
                issue.issue,
                buildAgentComment(
                  `${formatMention(issue.issue)}Detected runner process exit (pid ${issue.record.pid}). ` +
                    "Please reply with details or requeue instructions.",
                  [NEEDS_USER_MARKER]
                )
              );
            }

            for (const issue of evaluation.missingRecord) {
              if (dryRun) {
                log("info", `Dry-run: would mark ${issue.url} needs-user (missing state).`, json);
                continue;
              }

              await client.addLabels(issue, [config.labels.failed, config.labels.needsUser]);
              await tryRemoveLabel(issue, config.labels.running);
              await client.comment(
                issue,
                buildAgentComment(
                  `${formatMention(issue)}Runner state was missing for this request. ` +
                    "Please reply to re-queue the request.",
                  [NEEDS_USER_MARKER]
                )
              );
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
            if (dryRun) {
              log("info", `Dry-run: would mark ${issue.url} failed (process exited).`, json);
              continue;
            }
            await client.addLabels(issue, [config.labels.failed, config.labels.needsUser]);
            await tryRemoveLabel(issue, config.labels.running);
            await client.comment(
              issue,
              buildAgentComment(
                `${formatMention(issue)}Detected runner process exit (pid ${record.pid}). ` +
                  "Please reply with details or requeue instructions.",
                [NEEDS_USER_MARKER]
              )
            );
          }
        }
      }

      const resumed =
        shouldPollIssues && !rateLimitedUntil ? await resumeAwaitingUser(repos) : 0;
      if (resumed > 0) {
        log("info", `Re-queued ${resumed} request(s) after user reply.`, json);
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
        for (const repo of repos) {
          const queued = await queueNewRequests(client, repo, config);
          if (queued.length > 0) {
            log("info", `Queued ${queued.length} requests in ${repo.repo}.`, json);
          }
          for (const issue of queued) {
            if (queuedIds.has(issue.id)) {
              continue;
            }
            queuedIds.add(issue.id);
            queuedIssues.push(issue);
          }
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
      if (picked.length === 0) {
        if (!config.idle?.enabled) {
          log("info", "No queued requests.", json);
          return;
        }

        const timingEnabled = process.env.AGENT_RUNNER_USAGE_TIMING === "1";
        const timingPrefix = timingEnabled ? "Usage gate timing" : "";

        let codexAllowed = true;
        const usageGate = config.idle.usageGate;
        if (usageGate?.enabled) {
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
              codexAllowed = false;
            } else {
              const decision = evaluateUsageGate(status, usageGate);
              if (!decision.allow) {
                log("info", `Idle Codex usage gate blocked. ${decision.reason}`, json);
                codexAllowed = false;
              } else {
                log("info", `Idle Codex usage gate allowed. ${decision.reason}`, json, {
                  window: decision.window?.label,
                  minutesToReset: decision.minutesToReset
                });
              }
            }
            if (timingEnabled && timingEvents.length > 0) {
              log(
                "info",
                `${timingPrefix} (Codex): ${timingEvents
                  .map((event) => `${event.phase}=${event.durationMs}ms`)
                  .join(", ")}`,
                json
              );
            }
          } catch (error) {
            log("warn", "Idle Codex usage gate failed. Codex idle disabled.", json, {
              error: error instanceof Error ? error.message : String(error)
            });
            codexAllowed = false;
          }
        }

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

        const engines: IdleEngine[] = [];
        if (codexAllowed) {
          engines.push("codex");
        }
        if (copilotAllowed) {
          engines.push("copilot");
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

        const idleLimit = pLimit(config.concurrency);
        await Promise.all(
          scheduled.map((task) =>
            idleLimit(async () => {
              const result = await runIdleTask(config, task.repo, task.task, task.engine);
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
        return;
      }

      const webhookRemoveIds: number[] = [];
      for (const issue of picked) {
        await client.addLabels(issue, [config.labels.running]);
        await tryRemoveLabel(issue, config.labels.queued);
        await client.comment(
          issue,
          buildAgentComment(
            `${formatMention(issue)}Agent runner started on ${new Date().toISOString()}. Concurrency ${config.concurrency}.`
          )
        );
        if (webhooksEnabled && webhookQueuePath) {
          webhookRemoveIds.push(issue.id);
        }
      }
      if (!dryRun && webhookRemoveIds.length > 0 && webhookQueuePath) {
        await removeWebhookIssues(webhookQueuePath, webhookRemoveIds);
      }

      const limit = pLimit(config.concurrency);

      await Promise.all(
        picked.map((issue) =>
          limit(async () => {
            let activityId: string | null = null;
            try {
              const result = await runIssue(client, config, issue);
              activityId = result.activityId;
              if (result.success) {
                await client.addLabels(issue, [config.labels.done]);
                await tryRemoveLabel(issue, config.labels.running);
                await client.comment(
                  issue,
                  buildAgentComment(
                    `${formatMention(issue)}Agent runner completed successfully.` +
                      `${result.summary ? `\n\nSummary:\n${result.summary}` : ""}` +
                      `\n\nLog: ${result.logPath}`
                  )
                );
                return;
              }

              await client.addLabels(issue, [config.labels.failed, config.labels.needsUser]);
              await tryRemoveLabel(issue, config.labels.running);
              await client.comment(
                issue,
                buildAgentComment(
                  `${formatMention(issue)}Agent runner failed.` +
                    `${result.summary ? `\n\nSummary:\n${result.summary}` : ""}` +
                    `\n\nLog: ${result.logPath}\n\nPlease reply with any details or fixes; the runner will re-queue after detecting your response.`,
                  [NEEDS_USER_MARKER]
                )
              );
            } catch (error) {
              await client.addLabels(issue, [config.labels.failed, config.labels.needsUser]);
              await tryRemoveLabel(issue, config.labels.running);
              await client.comment(
                issue,
                buildAgentComment(
                  `${formatMention(issue)}Agent runner failed with error: ${
                    error instanceof Error ? error.message : String(error)
                  }\n\nPlease reply with any details or fixes; the runner will re-queue after detecting your response.`,
                  [NEEDS_USER_MARKER]
                )
              );
            } finally {
              if (activityId) {
                removeActivity(activityPath, activityId);
              }
            }
          })
        )
      );
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
    const client = new GitHubClient(token);

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
