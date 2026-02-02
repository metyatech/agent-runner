#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { Command } from "commander";
import pLimit from "p-limit";
import { loadConfig } from "./config.js";
import { GitHubClient, type IssueInfo, type LabelInfo, type RepoInfo } from "./github.js";
import { buildAgentLabels } from "./labels.js";
import { log } from "./logger.js";
import { acquireLock, releaseLock } from "./lock.js";
import { buildAgentComment, hasUserReplySince, NEEDS_USER_MARKER } from "./notifications.js";
import { evaluateUsageGate, fetchCodexStatusOutput, parseCodexStatus } from "./codex-status.js";
import { listTargetRepos, listQueuedIssues, pickNextIssues, queueNewRequests } from "./queue.js";
import { planIdleTasks, runIdleTask, runIssue } from "./runner.js";
import {
  evaluateRunningIssues,
  isProcessAlive,
  loadRunnerState,
  resolveRunnerStatePath
} from "./runner-state.js";

const program = new Command();

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
      const repos = await listTargetRepos(client, config);
      log("info", `Discovered ${repos.length} repositories.`, json);

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
      }

      const resumed = await resumeAwaitingUser(repos);
      if (resumed > 0) {
        log("info", `Re-queued ${resumed} request(s) after user reply.`, json);
      }

      const queuedIssues: IssueInfo[] = [];
      const queuedIds = new Set<number>();
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

      const picked = pickNextIssues(queuedIssues, config.concurrency);
      if (picked.length === 0) {
        if (!config.idle?.enabled) {
          log("info", "No queued requests.", json);
          return;
        }

        const usageGate = config.idle.usageGate;
        if (usageGate?.enabled) {
          try {
            const output = await fetchCodexStatusOutput(
              usageGate.command,
              usageGate.args,
              usageGate.timeoutSeconds,
              config.workdirRoot
            );
            const status = parseCodexStatus(output);
            if (!status) {
              log("warn", "Idle usage gate: unable to parse /status output. Skipping idle.", json);
              return;
            }

            const decision = evaluateUsageGate(status, usageGate);
            if (!decision.allow) {
              log("info", `Idle usage gate blocked. ${decision.reason}`, json);
              return;
            }

            log("info", `Idle usage gate allowed. ${decision.reason}`, json, {
              window: decision.window?.label,
              minutesToReset: decision.minutesToReset
            });
          } catch (error) {
            log("warn", "Idle usage gate failed. Skipping idle.", json, {
              error: error instanceof Error ? error.message : String(error)
            });
            return;
          }
        }

        const idleTasks = await planIdleTasks(config, repos);
        if (idleTasks.length === 0) {
          log("info", "No queued requests. Idle cooldown active or no eligible repos.", json);
          return;
        }

        log(
          "info",
          `No queued requests. Scheduling ${idleTasks.length} idle task(s).`,
          json,
          {
            repos: idleTasks.map((task) => `${task.repo.owner}/${task.repo.repo}`)
          }
        );

        if (dryRun) {
          log("info", "Dry-run: would execute idle tasks.", json, {
            tasks: idleTasks.map((task) => ({
              repo: `${task.repo.owner}/${task.repo.repo}`,
              task: task.task
            }))
          });
          return;
        }

        const idleLimit = pLimit(config.concurrency);
        await Promise.all(
          idleTasks.map((task) =>
            idleLimit(async () => {
              const result = await runIdleTask(config, task.repo, task.task);
              if (result.success) {
                log("info", "Idle task completed.", json, {
                  repo: `${result.repo.owner}/${result.repo.repo}`,
                  report: result.reportPath,
                  log: result.logPath
                });
                return;
              }
              log("warn", "Idle task failed.", json, {
                repo: `${result.repo.owner}/${result.repo.repo}`,
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

      for (const issue of picked) {
        await client.addLabels(issue, [config.labels.running]);
        await tryRemoveLabel(issue, config.labels.queued);
        await client.comment(
          issue,
          buildAgentComment(
            `${formatMention(issue)}Agent runner started on ${new Date().toISOString()}. Concurrency ${config.concurrency}.`
          )
        );
      }

      const limit = pLimit(config.concurrency);

      await Promise.all(
        picked.map((issue) =>
          limit(async () => {
            try {
              const result = await runIssue(client, config, issue);
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
            }
          })
        )
      );
    };

    try {
      const interval = Number.parseInt(options.interval, 10);
      if (options.once) {
        await runCycle();
        releaseLock(lock);
        return;
      }

      while (true) {
        await runCycle();
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
    const repos = await listTargetRepos(client, config);
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

program.parseAsync(process.argv);
