import type { AgentRunnerConfig } from "./config.js";
import type { IssueInfo } from "./github.js";
import {
  isManagedPullRequest as isManagedPullRequestState,
  markManagedPullRequest,
  resolveManagedPullRequestsStatePath
} from "./managed-pull-requests.js";

export const AGENT_RUNNER_PR_MARKER = "<!-- agent-runner -->";

export function isAgentRunnerBotLogin(login: string | null): boolean {
  if (!login) return false;
  const trimmed = login.trim().toLowerCase();
  const normalized = trimmed.startsWith("app/") ? trimmed.slice("app/".length) : trimmed;
  if (normalized.endsWith("[bot]")) {
    return normalized.includes("agent-runner");
  }

  return normalized === "agent-runner-bot";
}

export async function isManagedPullRequestIssue(
  issue: IssueInfo,
  config: AgentRunnerConfig
): Promise<boolean> {
  if (!issue.isPullRequest) {
    return false;
  }
  if (isAgentRunnerBotLogin(issue.author ?? null)) {
    return true;
  }
  if ((issue.body ?? "").includes(AGENT_RUNNER_PR_MARKER)) {
    return true;
  }
  const statePath = resolveManagedPullRequestsStatePath(config.workdirRoot);
  return isManagedPullRequestState(statePath, issue.repo, issue.number);
}

export async function ensureManagedPullRequestRecorded(
  issue: IssueInfo,
  config: AgentRunnerConfig
): Promise<boolean> {
  if (!issue.isPullRequest) {
    return false;
  }

  const statePath = resolveManagedPullRequestsStatePath(config.workdirRoot);
  if (await isManagedPullRequestState(statePath, issue.repo, issue.number)) {
    return true;
  }

  if (
    !isAgentRunnerBotLogin(issue.author ?? null) &&
    !(issue.body ?? "").includes(AGENT_RUNNER_PR_MARKER)
  ) {
    return false;
  }

  await markManagedPullRequest(statePath, issue.repo, issue.number);
  return true;
}
