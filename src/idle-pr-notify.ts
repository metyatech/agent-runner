import fs from "node:fs";

import type { AgentRunnerConfig } from "./config.js";
import type { GitHubClient, RepoInfo } from "./github.js";
import { ensureManagedPullRequestRecorded } from "./managed-pr.js";
import { buildAgentComment } from "./notifications.js";
import { parseLastPullRequestUrl } from "./pull-request-url.js";
import type { IdleTaskResult } from "./runner.js";

export type IdlePullRequestNotification = {
  repo: RepoInfo;
  number: number;
  url: string;
  source: "summary" | "log" | "head";
};

export async function notifyIdlePullRequest(options: {
  client: GitHubClient;
  notifyClient: GitHubClient | null;
  config: AgentRunnerConfig;
  result: IdleTaskResult;
  json: boolean;
  log: (level: "info" | "warn" | "error", message: string, json: boolean, meta?: Record<string, unknown>) => void;
}): Promise<IdlePullRequestNotification | null> {
  const expectedRepo = options.result.repo;
  const isSameRepo = (left: RepoInfo, right: RepoInfo): boolean =>
    left.owner.toLowerCase() === right.owner.toLowerCase() && left.repo.toLowerCase() === right.repo.toLowerCase();

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

  const summaryText = options.result.summary ?? "";
  const validateRepo = (
    match: ReturnType<typeof parseLastPullRequestUrl>,
    source: "summary" | "log"
  ): ReturnType<typeof parseLastPullRequestUrl> => {
    if (!match) {
      return null;
    }
    if (isSameRepo(match.repo, expectedRepo)) {
      return match;
    }
    options.log("warn", "Idle PR URL repo mismatch; ignoring.", options.json, {
      expectedRepo: `${expectedRepo.owner}/${expectedRepo.repo}`,
      parsedRepo: `${match.repo.owner}/${match.repo.repo}`,
      source,
      url: match.url
    });
    return null;
  };

  const prFromSummary = validateRepo(parseLastPullRequestUrl(summaryText), "summary");
  const prFromLog = prFromSummary
    ? null
    : validateRepo(parseLastPullRequestUrl(readLogTail(options.result.logPath, 512 * 1024) ?? ""), "log");

  let pr: IdlePullRequestNotification | null = null;
  if (prFromSummary) {
    pr = { ...prFromSummary, source: "summary" };
  } else if (prFromLog) {
    pr = { ...prFromLog, source: "log" };
  } else if (options.result.headBranch) {
    try {
      const found = await options.client.findOpenPullRequestByHead(options.result.repo, options.result.headBranch);
      if (found) {
        pr = {
          repo: options.result.repo,
          number: found.number,
          url: found.url,
          source: "head"
        };
      }
    } catch (error) {
      options.log("warn", "Failed to locate idle PR by head branch; skipping.", options.json, {
        repo: `${options.result.repo.owner}/${options.result.repo.repo}`,
        headBranch: options.result.headBranch,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  if (!pr) {
    return null;
  }

  try {
    const prIssue = await options.client.getIssue(pr.repo, pr.number);
    if (prIssue) {
      await ensureManagedPullRequestRecorded(prIssue, options.config);
    }
  } catch (error) {
    options.log("warn", "Failed to record managed PR from idle PR notification.", options.json, {
      pr: pr.url,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  const authLogin = await options.client.getAuthenticatedLogin();
  if (authLogin) {
    try {
      await options.client.addAssignees(pr.repo, pr.number, [authLogin]);
    } catch (error) {
      options.log("warn", "Failed to assign idle PR to authenticated user.", options.json, {
        pr: pr.url,
        assignee: authLogin,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const mentionLine = authLogin ? `Notify: @${authLogin}\n` : "";
  const body = buildAgentComment(
    `Agent runner idle ${options.result.success ? "completed" : "failed"}.\n\n` +
      `Repo: ${options.result.repo.owner}/${options.result.repo.repo}\n` +
      `Engine: ${options.result.engine}\n` +
      mentionLine +
      `\nSummary:\n${truncate(summaryText || "(missing)", 6000)}`
  );

  const postComment = async (client: GitHubClient): Promise<void> => {
    await client.commentIssue(pr.repo, pr.number, body);
  };

  if (options.notifyClient) {
    try {
      await postComment(options.notifyClient);
      return pr;
    } catch (error) {
      options.log("warn", "Failed to post idle completion comment with notify client; falling back.", options.json, {
        pr: pr.url,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  try {
    await postComment(options.client);
  } catch (error) {
    options.log("warn", "Failed to post idle completion comment to PR.", options.json, {
      pr: pr.url,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  return pr;
}
