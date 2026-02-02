import fs from "node:fs";
import path from "node:path";
import type { AgentRunnerConfig } from "./config.js";
import type { GitHubClient, IssueInfo, RepoInfo } from "./github.js";
import {
  isBlocked,
  isCacheFresh,
  loadRepoCache,
  saveRepoCache,
  type RepoCache
} from "./repo-cache.js";

const DEFAULT_REPO_CACHE_MINUTES = 60;
const LOCAL_REPO_EXCLUDES = new Set(["agent-rules-local"]);

type RateLimitInfo = {
  resetAt: string | null;
};

function parseRateLimit(error: unknown): RateLimitInfo {
  if (!error || typeof error !== "object") {
    return { resetAt: null };
  }
  const status = (error as { status?: number }).status;
  if (status !== 403) {
    return { resetAt: null };
  }
  const message = (error as { message?: string }).message ?? "";
  const response = (error as { response?: { headers?: Record<string, string | number> } }).response;
  const headers = response?.headers ?? {};
  const remaining = headers["x-ratelimit-remaining"]?.toString();
  const reset = headers["x-ratelimit-reset"]?.toString();
  const isRateLimit =
    remaining === "0" ||
    message.toLowerCase().includes("rate limit");
  if (!isRateLimit) {
    return { resetAt: null };
  }
  if (reset && /^\d+$/.test(reset)) {
    const resetDate = new Date(Number(reset) * 1000);
    return { resetAt: resetDate.toISOString() };
  }
  return { resetAt: null };
}

function buildCache(repos: RepoInfo[], blockedUntil?: string | null): RepoCache {
  return {
    repos,
    updatedAt: new Date().toISOString(),
    blockedUntil: blockedUntil ?? null
  };
}

export async function listTargetRepos(
  client: GitHubClient,
  config: AgentRunnerConfig,
  workdirRoot: string,
  cacheMinutes: number = DEFAULT_REPO_CACHE_MINUTES
): Promise<{
  repos: RepoInfo[];
  source: "api" | "cache" | "config" | "local";
  blockedUntil: string | null;
}> {
  if (config.repos !== "all" && config.repos) {
    return {
      repos: config.repos.map((repo) => ({ owner: config.owner, repo })),
      source: "config",
      blockedUntil: null
    };
  }

  const listLocalRepos = (): RepoInfo[] => {
    const entries = fs.readdirSync(workdirRoot, { withFileTypes: true });
    const repos: RepoInfo[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (LOCAL_REPO_EXCLUDES.has(entry.name)) {
        continue;
      }
      const repoPath = path.join(workdirRoot, entry.name, ".git");
      if (!fs.existsSync(repoPath)) {
        continue;
      }
      try {
        const stat = fs.statSync(repoPath);
        if (!stat.isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }
      repos.push({ owner: config.owner, repo: entry.name });
    }
    return repos;
  };

  let cache: RepoCache | null = null;
  try {
    cache = loadRepoCache(workdirRoot);
  } catch {
    cache = null;
  }

  if (cache && isBlocked(cache)) {
    return { repos: cache.repos, source: "cache", blockedUntil: cache.blockedUntil ?? null };
  }

  if (cache && isCacheFresh(cache, cacheMinutes)) {
    return { repos: cache.repos, source: "cache", blockedUntil: cache.blockedUntil ?? null };
  }

  try {
    const repos = await client.listRepos(config.owner);
    saveRepoCache(workdirRoot, buildCache(repos));
    return { repos, source: "api", blockedUntil: null };
  } catch (error) {
    const rate = parseRateLimit(error);
    if (rate.resetAt) {
      const blockedUntil = rate.resetAt;
      const fallbackRepos = cache?.repos ?? listLocalRepos();
      if (fallbackRepos.length > 0) {
        const source = cache?.repos ? "cache" : "local";
        saveRepoCache(workdirRoot, buildCache(fallbackRepos, blockedUntil));
        return { repos: fallbackRepos, source, blockedUntil };
      }
    }
    if (cache) {
      const blockedUntil = rate.resetAt ?? cache.blockedUntil ?? null;
      saveRepoCache(workdirRoot, buildCache(cache.repos, blockedUntil));
      return { repos: cache.repos, source: "cache", blockedUntil };
    }
    throw error;
  }
}

export async function queueNewRequests(
  client: GitHubClient,
  repo: RepoInfo,
  config: AgentRunnerConfig
): Promise<IssueInfo[]> {
  const requestIssues = await client.listIssuesByLabel(repo, config.labels.request);
  const queued: IssueInfo[] = [];

  for (const issue of requestIssues) {
    if (
      issue.labels.includes(config.labels.queued) ||
      issue.labels.includes(config.labels.running) ||
      issue.labels.includes(config.labels.done) ||
      issue.labels.includes(config.labels.failed) ||
      issue.labels.includes(config.labels.needsUser)
    ) {
      continue;
    }
    await client.addLabels(issue, [config.labels.queued]);
    queued.push(issue);
  }

  return queued;
}

export async function listQueuedIssues(
  client: GitHubClient,
  repo: RepoInfo,
  config: AgentRunnerConfig
): Promise<IssueInfo[]> {
  const queuedIssues = await client.listIssuesByLabel(repo, config.labels.queued);
  return queuedIssues.filter(
    (issue) =>
      !issue.labels.includes(config.labels.running) &&
      !issue.labels.includes(config.labels.needsUser)
  );
}

export function pickNextIssues(issues: IssueInfo[], limit: number): IssueInfo[] {
  return issues
    .slice()
    .sort((a, b) => a.number - b.number)
    .slice(0, limit);
}
