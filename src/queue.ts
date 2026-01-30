import type { AgentRunnerConfig } from "./config.js";
import type { GitHubClient, IssueInfo, RepoInfo } from "./github.js";

export async function listTargetRepos(client: GitHubClient, config: AgentRunnerConfig): Promise<RepoInfo[]> {
  if (config.repos === "all" || !config.repos) {
    return client.listRepos(config.owner);
  }

  return config.repos.map((repo) => ({ owner: config.owner, repo }));
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
