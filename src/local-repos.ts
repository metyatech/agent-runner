import fs from "node:fs";
import path from "node:path";
import type { RepoInfo } from "./github.js";

const DEFAULT_EXCLUDES = new Set(["agent-rules-local"]);

export function listLocalRepos(
  workdirRoot: string,
  owner: string,
  excludes: Set<string> = DEFAULT_EXCLUDES
): RepoInfo[] {
  const repos: RepoInfo[] = [];
  const entries = fs.readdirSync(workdirRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (excludes.has(entry.name)) {
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
    repos.push({ owner, repo: entry.name });
  }
  return repos;
}
