import fs from "node:fs";
import path from "node:path";
import type { RepoInfo } from "./github.js";
import { acquireLock, releaseLock, type LockHandle } from "./lock.js";

function resolveLocksDir(workdirRoot: string): string {
  return path.resolve(workdirRoot, "agent-runner", "state", "repo-locks");
}

function slug(repo: RepoInfo): string {
  return `${repo.owner}--${repo.repo}`.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function resolveRepoLockPath(workdirRoot: string, repo: RepoInfo): string {
  const dir = resolveLocksDir(workdirRoot);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${slug(repo)}.lock`);
}

export function acquireRepoLock(workdirRoot: string, repo: RepoInfo): LockHandle {
  return acquireLock(resolveRepoLockPath(workdirRoot, repo));
}

export function releaseRepoLock(lock: LockHandle): void {
  releaseLock(lock);
}

export function acquireRepoLocks(workdirRoot: string, repos: RepoInfo[]): LockHandle[] {
  const sorted = [...repos].sort((a, b) => {
    const aKey = `${a.owner}/${a.repo}`.toLowerCase();
    const bKey = `${b.owner}/${b.repo}`.toLowerCase();
    return aKey.localeCompare(bKey);
  });

  const locks: LockHandle[] = [];
  try {
    for (const repo of sorted) {
      locks.push(acquireRepoLock(workdirRoot, repo));
    }
    return locks;
  } catch (error) {
    for (const lock of locks) {
      try {
        releaseRepoLock(lock);
      } catch {
        // ignore
      }
    }
    throw error;
  }
}

