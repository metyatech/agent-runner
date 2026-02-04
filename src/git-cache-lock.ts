import fs from "node:fs";
import path from "node:path";
import type { RepoInfo } from "./github.js";
import { acquireLockWithRetry, releaseLock, type AcquireLockRetryOptions, type LockHandle } from "./lock.js";

function resolveLocksDir(workdirRoot: string): string {
  return path.resolve(workdirRoot, "agent-runner", "state", "git-cache-locks");
}

function slug(repo: RepoInfo): string {
  return `${repo.owner}--${repo.repo}`.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function resolveGitCacheLockPath(workdirRoot: string, repo: RepoInfo): string {
  const dir = resolveLocksDir(workdirRoot);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${slug(repo)}.lock`);
}

export async function acquireGitCacheLock(
  workdirRoot: string,
  repo: RepoInfo,
  options: AcquireLockRetryOptions = {}
): Promise<LockHandle> {
  return acquireLockWithRetry(resolveGitCacheLockPath(workdirRoot, repo), options);
}

export function releaseGitCacheLock(lock: LockHandle): void {
  releaseLock(lock);
}

export async function withGitCacheLock<T>(
  workdirRoot: string,
  repo: RepoInfo,
  action: () => Promise<T> | T,
  options: AcquireLockRetryOptions = {}
): Promise<T> {
  const lock = await acquireGitCacheLock(workdirRoot, repo, options);
  try {
    return await action();
  } finally {
    try {
      releaseGitCacheLock(lock);
    } catch {
      // ignore
    }
  }
}

