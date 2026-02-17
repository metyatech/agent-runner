import type { AgentRunnerConfig } from "./config.js";
import type { IssueInfo } from "./github.js";
import { evaluateRunningIssues, type RunnerState } from "./runner-state.js";

export type WebhookRunningRecoveryPlan = {
  issue: IssueInfo;
  reason: "dead_process" | "missing_state";
  pid?: number;
};

function normalizeRepoKey(owner: string, repo: string): string {
  return `${owner}/${repo}`.toLowerCase();
}

function buildConfiguredRepoSet(config: AgentRunnerConfig): Set<string> | null {
  if (config.repos === "all" || !config.repos) {
    return null;
  }
  const configured = new Set<string>();
  for (const entry of config.repos) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      continue;
    }
    configured.add(trimmed.toLowerCase());
  }
  return configured;
}

function isIssueInConfiguredScope(issue: IssueInfo, config: AgentRunnerConfig): boolean {
  if (issue.repo.owner.toLowerCase() !== config.owner.toLowerCase()) {
    return false;
  }

  const configured = buildConfiguredRepoSet(config);
  if (!configured) {
    return true;
  }

  const shortName = issue.repo.repo.toLowerCase();
  const fullName = normalizeRepoKey(issue.repo.owner, issue.repo.repo);
  return configured.has(shortName) || configured.has(fullName);
}

export function planWebhookRunningRecoveries(options: {
  issuesWithRunningLabel: IssueInfo[];
  state: RunnerState;
  config: AgentRunnerConfig;
  aliveCheck: (pid: number) => boolean;
}): WebhookRunningRecoveryPlan[] {
  const scopedRunningIssues = options.issuesWithRunningLabel.filter((issue) =>
    isIssueInConfiguredScope(issue, options.config)
  );

  const evaluation = evaluateRunningIssues(scopedRunningIssues, options.state, options.aliveCheck);
  const deadProcessPlans: WebhookRunningRecoveryPlan[] = evaluation.deadProcess.map(({ issue, record }) => ({
    issue,
    reason: "dead_process",
    pid: record.pid
  }));
  const missingStatePlans: WebhookRunningRecoveryPlan[] = evaluation.missingRecord.map((issue) => ({
    issue,
    reason: "missing_state"
  }));

  return [...deadProcessPlans, ...missingStatePlans];
}
