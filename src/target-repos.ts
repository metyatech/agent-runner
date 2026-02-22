import type { IssueInfo, RepoInfo } from "./github.js";
import { parseIssueBody } from "./issue.js";

export function resolveTargetRepos(issue: IssueInfo, owner: string): RepoInfo[] {
  const parsed = parseIssueBody(issue.body);
  const base = issue.repo;
  const additional = parsed.repoList.map((repo) => ({ owner, repo }));
  const combined = [base, ...additional];
  const unique = new Map<string, RepoInfo>();
  for (const repo of combined) {
    unique.set(`${repo.owner}/${repo.repo}`, repo);
  }
  return Array.from(unique.values());
}
