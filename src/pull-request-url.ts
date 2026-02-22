import type { RepoInfo } from "./github.js";

export type PullRequestUrlMatch = {
  repo: RepoInfo;
  number: number;
  url: string;
};

export function parseLastPullRequestUrl(text: string): PullRequestUrlMatch | null {
  let last: PullRequestUrlMatch | null = null;
  const pattern = /https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/gi;
  for (const match of text.matchAll(pattern)) {
    const number = Number.parseInt(match[3] ?? "", 10);
    if (!Number.isFinite(number) || number <= 0) {
      continue;
    }
    const owner = match[1] ?? "";
    const repo = match[2] ?? "";
    if (!owner || !repo) {
      continue;
    }
    last = {
      repo: { owner, repo },
      number,
      url: match[0] ?? ""
    };
  }
  return last;
}
