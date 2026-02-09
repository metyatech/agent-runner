import type { AgentRunnerConfig } from "./config.js";
import type { IssueInfo } from "./github.js";
import {
  isManagedPullRequest as isManagedPullRequestState,
  markManagedPullRequest,
  resolveManagedPullRequestsStatePath
} from "./managed-pull-requests.js";

export function isAgentRunnerBotLogin(login: string | null): boolean {
  if (!login) return false;
  const normalized = login.trim().toLowerCase();
  if (!normalized.endsWith("[bot]")) return false;
  return normalized.includes("agent-runner");
}

export async function isManagedPullRequestIssue(issue: IssueInfo, config: AgentRunnerConfig): Promise<boolean> {
  if (!issue.isPullRequest) {
    return false;
  }
  if (isAgentRunnerBotLogin(issue.author ?? null)) {
    return true;
  }
  const statePath = resolveManagedPullRequestsStatePath(config.workdirRoot);
  return isManagedPullRequestState(statePath, issue.repo, issue.number);
}

export async function ensureManagedPullRequestRecorded(issue: IssueInfo, config: AgentRunnerConfig): Promise<boolean> {
  if (!issue.isPullRequest) {
    return false;
  }

  const statePath = resolveManagedPullRequestsStatePath(config.workdirRoot);
  if (await isManagedPullRequestState(statePath, issue.repo, issue.number)) {
    return true;
  }

  if (!isAgentRunnerBotLogin(issue.author ?? null)) {
    return false;
  }

  await markManagedPullRequest(statePath, issue.repo, issue.number);
  return true;
}

