import type { AgentRunnerConfig } from "./config.js";
import type { GitHubClient, IssueInfo, RepoInfo } from "./github.js";
import { buildAgentComment, hasUserReplySince, NEEDS_USER_MARKER } from "./notifications.js";
import { isAllowedAuthorAssociation, parseAgentCommand } from "./agent-command.js";
import {
  hasProcessedAgentCommandComment,
  markAgentCommandCommentProcessed,
  resolveAgentCommandStatePath
} from "./agent-command-state.js";
import { enqueueWebhookIssue } from "./webhook-queue.js";
import type { WebhookEvent } from "./webhook-server.js";

type IssuePayload = {
  id?: number;
  number?: number;
  title?: string;
  body?: string | null;
  html_url?: string;
  user?: { login?: string | null };
  labels?: Array<{ name?: string | null } | string>;
  pull_request?: unknown;
};

type PullRequestPayload = {
  id?: number;
  number?: number;
  html_url?: string;
};

type CommentPayload = {
  id?: number;
  body?: string | null;
  html_url?: string;
  author_association?: string;
  user?: { login?: string | null };
};

type RepositoryPayload = {
  name?: string;
  owner?: { login?: string };
};

type WebhookPayload = {
  action?: string;
  issue?: IssuePayload;
  pull_request?: PullRequestPayload;
  repository?: RepositoryPayload;
  label?: { name?: string };
  comment?: CommentPayload;
};

function parseLabels(labels: IssuePayload["labels"]): string[] {
  if (!Array.isArray(labels)) {
    return [];
  }
  return labels
    .map((label) => (typeof label === "string" ? label : label?.name ?? ""))
    .filter((label) => Boolean(label));
}

function parseRepo(payload: WebhookPayload): RepoInfo | null {
  const repoName = payload.repository?.name;
  const ownerName = payload.repository?.owner?.login;
  if (!repoName || !ownerName) {
    return null;
  }
  return { owner: ownerName, repo: repoName };
}

function parseIssue(payload: WebhookPayload, repo: RepoInfo): IssueInfo | null {
  const issue = payload.issue;
  if (!issue) {
    return null;
  }
  if (!issue.id || !issue.number || !issue.title || !issue.html_url) {
    return null;
  }
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? null,
    author: issue.user?.login ?? null,
    repo,
    labels: parseLabels(issue.labels),
    url: issue.html_url
  };
}

function shouldQueueIssue(issue: IssueInfo, config: AgentRunnerConfig, labelHint?: string): boolean {
  const requestLabel = config.labels.request;
  const hasRequest = issue.labels.includes(requestLabel) || labelHint === requestLabel;
  if (!hasRequest) {
    return false;
  }
  if (issue.labels.includes(config.labels.running)) {
    return false;
  }
  if (issue.labels.includes(config.labels.needsUser)) {
    return false;
  }
  if (issue.labels.includes(config.labels.done)) {
    return false;
  }
  if (issue.labels.includes(config.labels.failed)) {
    return false;
  }
  return true;
}

function isBusyOrTerminal(issue: IssueInfo, config: AgentRunnerConfig): "running" | "queued" | "terminal" | null {
  if (issue.labels.includes(config.labels.running)) {
    return "running";
  }
  if (issue.labels.includes(config.labels.queued)) {
    return "queued";
  }
  if (issue.labels.includes(config.labels.needsUser)) {
    return "terminal";
  }
  if (issue.labels.includes(config.labels.done)) {
    return "terminal";
  }
  if (issue.labels.includes(config.labels.failed)) {
    return "terminal";
  }
  return null;
}

async function ensureQueued(
  client: GitHubClient,
  config: AgentRunnerConfig,
  queuePath: string,
  issue: IssueInfo
): Promise<boolean> {
  if (!issue.labels.includes(config.labels.queued)) {
    await client.addLabels(issue, [config.labels.queued]);
  }
  return enqueueWebhookIssue(queuePath, issue);
}

async function safeRemoveLabel(
  client: GitHubClient,
  issue: IssueInfo,
  label: string,
  onLog?: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void
): Promise<void> {
  try {
    await client.removeLabel(issue, label);
  } catch (error) {
    onLog?.("warn", `Failed to remove label ${label} from ${issue.url}`, {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function handleAgentRunCommand(options: {
  client: GitHubClient;
  config: AgentRunnerConfig;
  queuePath: string;
  issue: IssueInfo;
  comment: CommentPayload;
  onLog?: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
}): Promise<void> {
  const { client, config, queuePath, issue, comment, onLog } = options;
  const commentId = comment.id ?? 0;
  const statePath = resolveAgentCommandStatePath(config.workdirRoot);

  if (!commentId || commentId <= 0) {
    onLog?.("warn", "Ignoring /agent run due to missing comment id.", { issue: issue.url });
    return;
  }

  if (!isAllowedAuthorAssociation(comment.author_association)) {
    onLog?.("info", "Ignoring /agent run from non-collaborator.", {
      issue: issue.url,
      authorAssociation: comment.author_association ?? null,
      user: comment.user?.login ?? null
    });
    return;
  }

  if (await hasProcessedAgentCommandComment(statePath, commentId)) {
    return;
  }

  const status = isBusyOrTerminal(issue, config);
  if (status === "running") {
    await markAgentCommandCommentProcessed(statePath, commentId);
    await client.comment(
      issue,
      buildAgentComment("Ignored `/agent run`: already running.")
    );
    return;
  }
  if (status === "queued") {
    await markAgentCommandCommentProcessed(statePath, commentId);
    await client.comment(
      issue,
      buildAgentComment("Ignored `/agent run`: already queued.")
    );
    return;
  }

  await client.addLabels(issue, [config.labels.request]);
  await safeRemoveLabel(client, issue, config.labels.needsUser, onLog);
  await safeRemoveLabel(client, issue, config.labels.failed, onLog);
  await safeRemoveLabel(client, issue, config.labels.done, onLog);
  await safeRemoveLabel(client, issue, config.labels.running, onLog);
  await safeRemoveLabel(client, issue, config.labels.queued, onLog);

  await ensureQueued(client, config, queuePath, issue);
  await markAgentCommandCommentProcessed(statePath, commentId);

  const requester = comment.user?.login ? `Requested by ${comment.user.login}.` : "Request received.";
  await client.comment(issue, buildAgentComment(`${requester} Queued via \`/agent run\`.`));
}

export async function handleWebhookEvent(options: {
  event: WebhookEvent;
  client: GitHubClient;
  config: AgentRunnerConfig;
  queuePath: string;
  onLog?: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
}): Promise<void> {
  const { event, client, config, queuePath, onLog } = options;
  const payload = event.payload as WebhookPayload;
  const repo = parseRepo(payload);
  if (!repo) {
    onLog?.("warn", "Webhook payload missing repository info.", { event: event.event });
    return;
  }
  if (repo.owner.toLowerCase() !== config.owner.toLowerCase()) {
    onLog?.("warn", "Ignoring webhook payload for mismatched owner.", {
      event: event.event,
      owner: repo.owner
    });
    return;
  }

  if (event.event === "ping") {
    onLog?.("info", "Webhook ping received.");
    return;
  }

  if (event.event === "issues") {
    const issue = parseIssue(payload, repo);
    if (!issue) {
      return;
    }
    const action = payload.action ?? "";
    const labelHint = payload.label?.name;
    if (!["opened", "reopened", "labeled"].includes(action)) {
      return;
    }
    if (!shouldQueueIssue(issue, config, labelHint)) {
      return;
    }
    const queued = await ensureQueued(client, config, queuePath, issue);
    if (queued) {
      onLog?.("info", "Webhook queued issue.", {
        issue: issue.url,
        action
      });
    }
    return;
  }

  if (event.event === "issue_comment") {
    const issue = parseIssue(payload, repo);
    if (!issue) {
      return;
    }
    const action = payload.action ?? "";
    if (action !== "created") {
      return;
    }

    const command = parseAgentCommand(payload.comment?.body ?? null);
    if (command?.kind === "run") {
      await handleAgentRunCommand({
        client,
        config,
        queuePath,
        issue,
        comment: payload.comment ?? {},
        onLog
      });
      return;
    }

    if (!issue.labels.includes(config.labels.needsUser)) {
      return;
    }

    const comments = await client.listIssueComments(issue);
    if (!hasUserReplySince(comments, NEEDS_USER_MARKER)) {
      return;
    }

    await client.addLabels(issue, [config.labels.request]);
    await safeRemoveLabel(client, issue, config.labels.needsUser, onLog);
    await safeRemoveLabel(client, issue, config.labels.failed, onLog);
    await safeRemoveLabel(client, issue, config.labels.running, onLog);
    await safeRemoveLabel(client, issue, config.labels.queued, onLog);
    await client.comment(
      issue,
      buildAgentComment(
        `Reply received. Re-queued for execution.`,
        []
      )
    );
    await ensureQueued(client, config, queuePath, issue);
    onLog?.("info", "Webhook re-queued issue after comment.", {
      issue: issue.url
    });
    return;
  }

  if (event.event === "pull_request_review_comment") {
    const action = payload.action ?? "";
    if (action !== "created") {
      return;
    }
    const command = parseAgentCommand(payload.comment?.body ?? null);
    if (command?.kind !== "run") {
      return;
    }
    const comment = payload.comment ?? {};
    const commentId = comment.id ?? 0;
    if (!commentId || commentId <= 0) {
      onLog?.("warn", "Ignoring /agent run review comment due to missing id.", { repo: `${repo.owner}/${repo.repo}` });
      return;
    }
    if (!isAllowedAuthorAssociation(comment.author_association)) {
      onLog?.("info", "Ignoring /agent run review comment from non-collaborator.", {
        repo: `${repo.owner}/${repo.repo}`,
        authorAssociation: comment.author_association ?? null,
        user: comment.user?.login ?? null
      });
      return;
    }

    const statePath = resolveAgentCommandStatePath(config.workdirRoot);
    if (await hasProcessedAgentCommandComment(statePath, commentId)) {
      return;
    }

    const prNumber = payload.pull_request?.number ?? 0;
    if (!prNumber || prNumber <= 0) {
      onLog?.("warn", "Ignoring /agent run review comment due to missing PR number.", { repo: `${repo.owner}/${repo.repo}` });
      return;
    }

    const issue = await client.getIssue(repo, prNumber);
    if (!issue) {
      onLog?.("warn", "Ignoring /agent run review comment because PR could not be resolved.", {
        repo: `${repo.owner}/${repo.repo}`,
        prNumber
      });
      return;
    }

    await handleAgentRunCommand({
      client,
      config,
      queuePath,
      issue,
      comment,
      onLog
    });
  }
}
