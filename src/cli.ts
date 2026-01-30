#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { Command } from "commander";
import pLimit from "p-limit";
import { loadConfig } from "./config.js";
import { GitHubClient, type IssueInfo } from "./github.js";
import { log } from "./logger.js";
import { acquireLock, releaseLock } from "./lock.js";
import { listTargetRepos, listQueuedIssues, pickNextIssues, queueNewRequests } from "./queue.js";
import { runIssue } from "./runner.js";

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

    const runCycle = async (): Promise<void> => {
      const repos = await listTargetRepos(client, config);
      log("info", `Discovered ${repos.length} repositories.`, json);

      for (const repo of repos) {
        const queued = await queueNewRequests(client, repo, config);
        if (queued.length > 0) {
          log("info", `Queued ${queued.length} requests in ${repo.repo}.`, json);
        }
      }

      const queuedIssues: IssueInfo[] = [];
      for (const repo of repos) {
        const repoQueued = await listQueuedIssues(client, repo, config);
        queuedIssues.push(...repoQueued);
      }

      const picked = pickNextIssues(queuedIssues, config.concurrency);
      if (picked.length === 0) {
        log("info", "No queued requests.", json);
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
          `Agent runner started on ${new Date().toISOString()}. Concurrency ${config.concurrency}.`
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
                  `Agent runner completed successfully. Log: ${result.logPath}`
                );
                return;
              }

              await client.addLabels(issue, [config.labels.failed]);
              await tryRemoveLabel(issue, config.labels.running);
              await client.comment(issue, `Agent runner failed. Log: ${result.logPath}`);
            } catch (error) {
              await client.addLabels(issue, [config.labels.failed]);
              await tryRemoveLabel(issue, config.labels.running);
              await client.comment(
                issue,
                `Agent runner failed with error: ${error instanceof Error ? error.message : String(error)}`
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

program.parseAsync(process.argv);
