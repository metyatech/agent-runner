import type { AgentRunnerConfig } from "./config.js";
import { GitHubClient, type IssueInfo, type RepoInfo } from "./github.js";
import { log } from "./logger.js";
import type { IdleTaskResult } from "./runner.js";

type GithubIdleNotificationConfig = NonNullable<
  NonNullable<AgentRunnerConfig["idle"]>["notifications"]
>["github"];

const defaultIssueTitle = "Agent Runner: Idle Inbox";
const defaultWorkflowFile = "idle-notify.yml";
const defaultWorkflowRef = "main";

function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 16))}\n…(truncated)…`;
}

function extractPullRequestUrl(text: string): string | null {
  const match = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/i.exec(text);
  return match?.[0] ?? null;
}

function buildIdleInboxIssueBody(config: GithubIdleNotificationConfig): string {
  const workflowFile = config?.workflowFile ?? defaultWorkflowFile;
  const workflowRef = config?.workflowRef ?? defaultWorkflowRef;

  return [
    "This issue is used by agent-runner to post idle completion notifications.",
    "",
    "Why?",
    "- GitHub does not notify you about actions performed by your own account.",
    "- agent-runner often operates using your token, so PR comments/mentions may not generate notifications.",
    "- This issue receives comments posted by github-actions[bot], which will generate GitHub Notifications you can triage and mark Done.",
    "",
    "Mechanism:",
    `- Workflow: \`.github/workflows/${workflowFile}\` (ref: \`${workflowRef}\`)`,
    "",
    "Note: keep this issue open to keep receiving notifications."
  ].join("\n");
}

function buildIdleNotificationComment(result: IdleTaskResult, now: Date): string {
  const targetRepo = `${result.repo.owner}/${result.repo.repo}`;
  const prUrl = result.summary ? extractPullRequestUrl(result.summary) : null;
  const summary = result.summary ? truncate(result.summary, 3000) : null;

  const header = result.success ? "Idle task completed" : "Idle task failed";
  const lines: Array<string | null> = [
    `**${header}** (${now.toISOString()})`,
    "",
    `- Repo: \`${targetRepo}\``,
    `- Engine: \`${result.engine}\``,
    `- Result: \`${result.success ? "success" : "failed"}\``,
    prUrl ? `- PR: ${prUrl}` : null,
    "",
    "<details><summary>Local files</summary>",
    "",
    `- Report: \`${result.reportPath}\``,
    `- Log: \`${result.logPath}\``,
    "",
    "</details>"
  ];

  if (!summary) {
    return lines.filter((line): line is string => Boolean(line)).join("\n");
  }

  return [
    lines.filter((line): line is string => Boolean(line)).join("\n"),
    "",
    "<details><summary>Summary</summary>",
    "",
    "```",
    summary,
    "```",
    "",
    "</details>"
  ].join("\n");
}

async function ensureIdleInboxIssue(options: {
  client: GitHubClient;
  repo: RepoInfo;
  title: string;
  config: GithubIdleNotificationConfig;
  json: boolean;
}): Promise<IssueInfo> {
  const { client, repo, title, config, json } = options;
  const existing = await client.findIssueByTitle(repo, title);
  if (existing) {
    return existing;
  }

  log("info", "Creating GitHub idle inbox issue.", json, {
    repo: `${repo.owner}/${repo.repo}`,
    title
  });

  return client.createIssue(repo, title, buildIdleInboxIssueBody(config));
}

export async function maybeNotifyIdleCompletionGithub(options: {
  client: GitHubClient;
  config: AgentRunnerConfig;
  result: IdleTaskResult;
  json: boolean;
}): Promise<void> {
  const { client, config, result, json } = options;
  const notifyConfig = config.idle?.notifications?.github;
  if (!notifyConfig || !notifyConfig.enabled) {
    return;
  }

  const repo = notifyConfig.repo;
  const issueTitle = notifyConfig.issueTitle ?? defaultIssueTitle;
  const workflowFile = notifyConfig.workflowFile ?? defaultWorkflowFile;
  const workflowRef = notifyConfig.workflowRef ?? defaultWorkflowRef;

  let issue: IssueInfo;
  try {
    issue = await ensureIdleInboxIssue({
      client,
      repo,
      title: issueTitle,
      config: notifyConfig,
      json
    });
  } catch (error) {
    log("warn", "Failed to ensure GitHub idle inbox issue.", json, {
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  const body = truncate(buildIdleNotificationComment(result, new Date()), 6500);
  try {
    await client.dispatchWorkflow({
      repo,
      workflowFile,
      ref: workflowRef,
      inputs: {
        issue_number: String(issue.number),
        body
      }
    });
    log("info", "Dispatched GitHub idle notification.", json, {
      inbox: issue.url,
      targetRepo: `${result.repo.owner}/${result.repo.repo}`,
      engine: result.engine,
      success: result.success
    });
  } catch (error) {
    log("warn", "Failed to dispatch GitHub idle notification.", json, {
      inbox: issue.url,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

