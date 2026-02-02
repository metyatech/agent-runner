import fs from "node:fs";
import path from "node:path";
import type { AgentRunnerConfig } from "./config.js";
import type { GitHubClient, IssueInfo, RepoInfo } from "./github.js";
import { buildAgentComment } from "./notifications.js";

export type IdleReportConfig = {
  enabled: boolean;
  repo: string;
  issueTitle: string;
  createIfMissing: boolean;
};

export type IdleReportState = {
  repo: string;
  issueId: number;
  issueNumber: number;
  issueUrl: string;
};

export type IdleReportPayload = {
  repo: RepoInfo;
  task: string;
  success: boolean;
  logPath: string;
  reportPath: string;
  summary: string | null;
};

export function resolveIdleReportStatePath(workdirRoot: string): string {
  return path.resolve(workdirRoot, "agent-runner", "state", "idle-report.json");
}

export function loadIdleReportState(statePath: string): IdleReportState | null {
  if (!fs.existsSync(statePath)) {
    return null;
  }
  const raw = fs.readFileSync(statePath, "utf8");
  const parsed = JSON.parse(raw) as IdleReportState;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid idle report state at ${statePath}`);
  }
  if (!parsed.repo || !parsed.issueNumber || !parsed.issueUrl) {
    throw new Error(`Invalid idle report state at ${statePath}`);
  }
  const issueId =
    typeof parsed.issueId === "number" && !Number.isNaN(parsed.issueId)
      ? parsed.issueId
      : parsed.issueNumber;
  return { ...parsed, issueId };
}

export function saveIdleReportState(statePath: string, state: IdleReportState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function buildIdleReportComment(payload: IdleReportPayload): string {
  const summaryBlock = payload.summary ? payload.summary.trim() : "No summary captured.";
  const body = [
    `Idle task completed.`,
    ``,
    `- Target repo: ${payload.repo.owner}/${payload.repo.repo}`,
    `- Task: ${payload.task}`,
    `- Success: ${payload.success}`,
    `- Local report: ${payload.reportPath}`,
    `- Local log: ${payload.logPath}`,
    `- Timestamp: ${new Date().toISOString()}`,
    ``,
    `Summary:`,
    summaryBlock
  ].join("\n");

  return buildAgentComment(body);
}

async function resolveIdleReportIssue(
  client: GitHubClient,
  config: AgentRunnerConfig
): Promise<IssueInfo | null> {
  const reportConfig = config.idle?.report;
  if (!reportConfig) {
    return null;
  }

  const reportRepo = { owner: config.owner, repo: reportConfig.repo };
  const statePath = resolveIdleReportStatePath(config.workdirRoot);
  const existing = loadIdleReportState(statePath);
  const reportSlug = `${reportRepo.owner}/${reportRepo.repo}`;

  if (existing && existing.repo === reportSlug) {
    return {
      id: existing.issueId,
      number: existing.issueNumber,
      title: reportConfig.issueTitle,
      body: null,
      author: null,
      repo: reportRepo,
      labels: [],
      url: existing.issueUrl
    };
  }

  const found = await client.findIssueByTitle(reportRepo, reportConfig.issueTitle);
  if (found) {
    saveIdleReportState(statePath, {
      repo: reportSlug,
      issueId: found.id,
      issueNumber: found.number,
      issueUrl: found.url
    });
    return found;
  }

  if (!reportConfig.createIfMissing) {
    return null;
  }

  const body = [
    "This issue collects idle-run summaries from agent-runner.",
    "",
    "Each comment corresponds to an idle task execution."
  ].join("\n");
  const created = await client.createIssue(reportRepo, reportConfig.issueTitle, body);
  saveIdleReportState(statePath, {
    repo: reportSlug,
    issueId: created.id,
    issueNumber: created.number,
    issueUrl: created.url
  });
  return created;
}

export async function postIdleReport(
  client: GitHubClient,
  config: AgentRunnerConfig,
  payload: IdleReportPayload
): Promise<IssueInfo | null> {
  const reportConfig = config.idle?.report;
  if (!config.idle?.enabled || !reportConfig?.enabled) {
    return null;
  }

  const issue = await resolveIdleReportIssue(client, config);
  if (!issue) {
    return null;
  }

  const comment = buildIdleReportComment(payload);
  await client.comment(issue, comment);
  return issue;
}
