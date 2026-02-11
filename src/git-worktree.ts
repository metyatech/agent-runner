import fs from "node:fs";
import path from "node:path";
import type { RepoInfo } from "./github.js";
import { commandExists } from "./command-exists.js";
import { runCommand } from "./git.js";
import { buildGitAuthEnv } from "./git-auth-env.js";
import { withGitCacheLock } from "./git-cache-lock.js";

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
  const token = process.env.AGENT_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
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
          await runCommand("gh", ["repo", "clone", `${repo.owner}/${repo.repo}`, localPath, "--", "--recursive"], {
            env
          });
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
        ["-C", options.cachePath, "worktree", "add", options.worktreePath, "-b", options.newBranch, startRef],
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
      const startRef = await resolveBranchStartRef(options.cachePath, options.branch);
      await runCommand("git", ["-C", options.cachePath, "branch", "-f", options.branch, startRef], { env });
      if (startRef.startsWith("refs/remotes/origin/")) {
        await runCommand(
          "git",
          ["-C", options.cachePath, "branch", "--set-upstream-to", `origin/${options.branch}`, options.branch],
          { env }
        );
      }
      await runCommand("git", ["-C", options.cachePath, "worktree", "add", options.worktreePath, options.branch], {
        env
      });
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
        await runCommand("git", ["-C", options.cachePath, "worktree", "remove", "--force", options.worktreePath], {
          env
        });
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
