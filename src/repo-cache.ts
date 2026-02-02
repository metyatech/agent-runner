import fs from "node:fs";
import path from "node:path";
import type { RepoInfo } from "./github.js";

export type RepoCache = {
  updatedAt: string;
  repos: RepoInfo[];
  blockedUntil?: string | null;
};

export function resolveRepoCachePath(workdirRoot: string): string {
  return path.resolve(workdirRoot, "agent-runner", "state", "repos.json");
}

export function loadRepoCache(workdirRoot: string): RepoCache | null {
  const cachePath = resolveRepoCachePath(workdirRoot);
  if (!fs.existsSync(cachePath)) {
    return null;
  }
  const raw = fs.readFileSync(cachePath, "utf8");
  const parsed = JSON.parse(raw) as RepoCache;
  if (!parsed || !Array.isArray(parsed.repos)) {
    throw new Error(`Invalid repo cache at ${cachePath}`);
  }
  return parsed;
}

export function saveRepoCache(workdirRoot: string, cache: RepoCache): void {
  const cachePath = resolveRepoCachePath(workdirRoot);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

export function isCacheFresh(cache: RepoCache, maxAgeMinutes: number): boolean {
  const updatedAt = Date.parse(cache.updatedAt);
  if (Number.isNaN(updatedAt)) {
    return false;
  }
  const ageMs = Date.now() - updatedAt;
  return ageMs <= maxAgeMinutes * 60 * 1000;
}

export function isBlocked(cache: RepoCache): boolean {
  if (!cache.blockedUntil) {
    return false;
  }
  const blockedUntil = Date.parse(cache.blockedUntil);
  if (Number.isNaN(blockedUntil)) {
    return false;
  }
  return blockedUntil > Date.now();
}
