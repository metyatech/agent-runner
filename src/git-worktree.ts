import fs from "node:fs";
import path from "node:path";
import type { RepoInfo } from "./github.js";
import { commandExists } from "./command-exists.js";
import { runCommand } from "./git.js";
import { buildGitAuthEnv } from "./git-auth-env.js";
import { withGitCacheLock } from "./git-cache-lock.js";
import { isProcessAlive, loadRunnerState, resolveRunnerStatePath } from "./runner-state.js";

function resolveCacheDir(workdirRoot: string): string {
  return path.resolve(workdirRoot, "agent-runner", "git-cache");
}

export function resolveRepoCachePath(workdirRoot: string, repo: RepoInfo): string {
  return path.join(resolveCacheDir(workdirRoot), repo.owner, `${repo.repo}.git`);
}

export function resolveRunWorkRoot(workdirRoot: string, runId: string): string {
  return path.resolve(workdirRoot, "agent-runner", "work", runId);
}

function resolveLocalRepoPath(workdirRoot: string, repo: RepoInfo): string {
  return path.resolve(workdirRoot, repo.repo);
}

function isGitRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"));
}

function repoHttpsUrl(repo: RepoInfo): string {
  return `https://github.com/${repo.owner}/${repo.repo}.git`;
}

function buildAuthEnv(): NodeJS.ProcessEnv {
  const token =
    process.env.AGENT_GITHUB_TOKEN ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    "";
  return buildGitAuthEnv(process.env, token);
}

async function ensureDirAbsent(dir: string): Promise<void> {
  if (!fs.existsSync(dir)) {
    return;
  }
  await fs.promises.rm(dir, { recursive: true, force: true });
}

async function resolveBranchStartRef(cachePath: string, branch: string): Promise<string> {
  const env = buildAuthEnv();
  const candidates = [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`];
  for (const candidate of candidates) {
    try {
      await runCommand("git", ["-C", cachePath, "show-ref", "--verify", "--quiet", candidate], { env });
      return candidate;
    } catch {
      // continue
    }
  }
  throw new Error(`Unable to resolve branch ${branch} in cache repo ${cachePath}`);
}

function buildRemoteBranchRef(branch: string): string {
  return `refs/remotes/origin/${branch}`;
}

function buildBranchFetchRefspec(branch: string): string {
  return `+refs/heads/${branch}:${buildRemoteBranchRef(branch)}`;
}

type GitWorktreeEntry = {
  path: string;
  branchRef: string | null;
  bare: boolean;
};

function normalizePathForComparison(value: string): string {
  const normalized = path.resolve(value).replace(/\\/g, "/");
  return normalized.endsWith("/") ? normalized.slice(0, -1).toLowerCase() : normalized.toLowerCase();
}

function parseGitWorktreeList(output: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  let current: GitWorktreeEntry | null = null;

  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) {
      if (current) {
        entries.push(current);
        current = null;
      }
      continue;
    }

    if (line.startsWith("worktree ")) {
      if (current) {
        entries.push(current);
      }
      current = {
        path: line.slice("worktree ".length).trim(),
        branchRef: null,
        bare: false
      };
      continue;
    }

    if (!current) {
      continue;
    }

    if (line === "bare") {
      current.bare = true;
      continue;
    }

    if (line.startsWith("branch ")) {
      current.branchRef = line.slice("branch ".length).trim();
    }
  }

  if (current) {
    entries.push(current);
  }

  return entries;
}

function parseIssueIdFromWorktreePath(workdirRoot: string, worktreePath: string): number | null {
  const workRoot = normalizePathForComparison(path.resolve(workdirRoot, "agent-runner", "work"));
  const candidate = normalizePathForComparison(worktreePath);
  if (!candidate.startsWith(`${workRoot}/`)) {
    return null;
  }

  const relative = candidate.slice(workRoot.length + 1);
  const runId = relative.split("/")[0] ?? "";
  const match = /^issue-(\d+)-\d+$/i.exec(runId);
  if (!match) {
    return null;
  }

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function cleanupConflictingBranchWorktrees(options: {
  workdirRoot: string;
  cachePath: string;
  branch: string;
  targetWorktreePath: string;
}): Promise<void> {
  const env = buildAuthEnv();
  const desiredBranchRef = `refs/heads/${options.branch}`;
  const targetPathKey = normalizePathForComparison(options.targetWorktreePath);

  const listWorktrees = async (): Promise<GitWorktreeEntry[]> => {
    const result = await runCommand("git", ["-C", options.cachePath, "worktree", "list", "--porcelain"], { env });
    return parseGitWorktreeList(result.stdout);
  };

  const conflicts = (await listWorktrees()).filter((entry) => !entry.bare && entry.branchRef === desiredBranchRef);

  if (conflicts.length === 0) {
    return;
  }

  const statePath = resolveRunnerStatePath(options.workdirRoot);
  const runnerState = loadRunnerState(statePath);

  for (const conflict of conflicts) {
    const conflictKey = normalizePathForComparison(conflict.path);
    let remove = false;

    if (conflictKey === targetPathKey) {
      remove = true;
    } else if (!fs.existsSync(conflict.path)) {
      remove = true;
    } else {
      const issueId = parseIssueIdFromWorktreePath(options.workdirRoot, conflict.path);
      if (issueId !== null) {
        const record = runnerState.running.find((entry) => entry.issueId === issueId);
        if (!record || !isProcessAlive(record.pid)) {
          remove = true;
        }
      }
    }

    if (remove) {
      await runCommand("git", ["-C", options.cachePath, "worktree", "remove", "--force", conflict.path], { env });
    }
  }

  await runCommand("git", ["-C", options.cachePath, "worktree", "prune"], { env });

  const remaining = (await listWorktrees()).filter((entry) => !entry.bare && entry.branchRef === desiredBranchRef);
  if (remaining.length > 0) {
    throw new Error(
      `Branch ${options.branch} is already checked out by an active worktree: ${remaining[0].path}. ` +
        "Wait for the current run to finish or remove the stale worktree manually."
    );
  }
}

export async function ensureRepoCache(workdirRoot: string, repo: RepoInfo): Promise<string> {
  const cachePath = resolveRepoCachePath(workdirRoot, repo);
  if (fs.existsSync(cachePath)) {
    return cachePath;
  }

  return withGitCacheLock(
    workdirRoot,
    repo,
    async () => {
      if (fs.existsSync(cachePath)) {
        return cachePath;
      }

      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      const env = buildAuthEnv();
      const localPath = resolveLocalRepoPath(workdirRoot, repo);

      if (fs.existsSync(localPath)) {
        if (!isGitRepo(localPath)) {
          throw new Error(
            `Local path exists but is not a git repo: ${localPath}. ` +
              "Move it aside or clone the repo there so agent-runner can use it as the base clone."
          );
        }
      } else {
        fs.mkdirSync(path.dirname(localPath), { recursive: true });
        const useGh = await commandExists("gh");
        if (useGh) {
          await runCommand("gh", ["repo", "clone", `${repo.owner}/${repo.repo}`, localPath, "--", "--recursive"], { env });
        } else {
          await runCommand("git", ["clone", "--recursive", repoHttpsUrl(repo), localPath], { env });
        }
      }

      await ensureDirAbsent(cachePath);
      await runCommand("git", ["clone", "--bare", localPath, cachePath], { env });

      try {
        await runCommand("git", ["-C", cachePath, "remote", "set-url", "origin", repoHttpsUrl(repo)], { env });
      } catch {
        // ignore
      }

      return cachePath;
    },
    { timeoutMs: 15 * 60 * 1000 }
  );
}

export async function refreshRepoCache(workdirRoot: string, repo: RepoInfo, cachePath: string): Promise<void> {
  await withGitCacheLock(
    workdirRoot,
    repo,
    async () => {
      const env = buildAuthEnv();
      await runCommand("git", ["-C", cachePath, "fetch", "--prune", "--tags", "origin"], { env });
      try {
        await runCommand("git", ["-C", cachePath, "worktree", "prune"], { env });
      } catch {
        // ignore
      }
    },
    { timeoutMs: 15 * 60 * 1000 }
  );
}

async function maybeUpdateSubmodules(worktreePath: string): Promise<void> {
  if (!fs.existsSync(path.join(worktreePath, ".gitmodules"))) {
    return;
  }
  const env = buildAuthEnv();
  await runCommand("git", ["-C", worktreePath, "submodule", "update", "--init", "--recursive"], { env });
}

export async function createWorktreeFromDefaultBranch(options: {
  workdirRoot: string;
  repo: RepoInfo;
  cachePath: string;
  worktreePath: string;
  defaultBranch: string;
  newBranch: string;
}): Promise<void> {
  fs.mkdirSync(path.dirname(options.worktreePath), { recursive: true });
  await ensureDirAbsent(options.worktreePath);

  await withGitCacheLock(
    options.workdirRoot,
    options.repo,
    async () => {
      const env = buildAuthEnv();
      const startRef = await resolveBranchStartRef(options.cachePath, options.defaultBranch);
      await runCommand(
        "git",
        [
          "-C",
          options.cachePath,
          "worktree",
          "add",
          options.worktreePath,
          "-b",
          options.newBranch,
          startRef
        ],
        { env }
      );
    },
    { timeoutMs: 15 * 60 * 1000 }
  );
  await maybeUpdateSubmodules(options.worktreePath);
}

export async function createWorktreeForRemoteBranch(options: {
  workdirRoot: string;
  repo: RepoInfo;
  cachePath: string;
  worktreePath: string;
  branch: string;
}): Promise<void> {
  fs.mkdirSync(path.dirname(options.worktreePath), { recursive: true });
  await ensureDirAbsent(options.worktreePath);

  await withGitCacheLock(
    options.workdirRoot,
    options.repo,
    async () => {
      const env = buildAuthEnv();
      await runCommand(
        "git",
        ["-C", options.cachePath, "fetch", "--prune", "origin", buildBranchFetchRefspec(options.branch)],
        { env }
      );
      await cleanupConflictingBranchWorktrees({
        workdirRoot: options.workdirRoot,
        cachePath: options.cachePath,
        branch: options.branch,
        targetWorktreePath: options.worktreePath
      });
      const startRef = await resolveBranchStartRef(options.cachePath, options.branch);
      await runCommand("git", ["-C", options.cachePath, "branch", "-f", options.branch, startRef], { env });
      await runCommand("git", ["-C", options.cachePath, "worktree", "add", options.worktreePath, options.branch], { env });
    },
    { timeoutMs: 15 * 60 * 1000 }
  );
  await maybeUpdateSubmodules(options.worktreePath);
}

export async function removeWorktree(options: {
  workdirRoot: string;
  repo: RepoInfo;
  cachePath: string;
  worktreePath: string;
}): Promise<void> {
  try {
    await withGitCacheLock(
      options.workdirRoot,
      options.repo,
      async () => {
        const env = buildAuthEnv();
        await runCommand("git", ["-C", options.cachePath, "worktree", "remove", "--force", options.worktreePath], { env });
      },
      { timeoutMs: 15 * 60 * 1000 }
    );
  } catch {
    // ignore
  }
  try {
    await fs.promises.rm(options.worktreePath, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
