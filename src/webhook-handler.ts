import type { AgentRunnerConfig } from "./config.js";
import type { GitHubClient, IssueInfo, RepoInfo } from "./github.js";
import { buildAgentComment, hasUserReplySince, NEEDS_USER_MARKER } from "./notifications.js";
import { isAllowedAuthorAssociation, parseAgentCommand } from "./agent-command.js";
import {
  hasProcessedAgentCommandComment,
  markAgentCommandCommentProcessed,
  resolveAgentCommandStatePath
} from "./agent-command-state.js";
import {
  isManagedPullRequest as isManagedPullRequestState,
  markManagedPullRequest,
  resolveManagedPullRequestsStatePath
} from "./managed-pull-requests.js";
import { enqueueWebhookIssue } from "./webhook-queue.js";
import { enqueueReviewTask, resolveReviewQueuePath } from "./review-queue.js";
import { copilotReviewIndicatesNoNewComments, isCopilotReviewerLogin } from "./copilot-review.js";
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

type ReviewPayload = {
  id?: number;
  body?: string | null;
  state?: string;
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
  review?: ReviewPayload;
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
    url: issue.html_url,
    isPullRequest: Boolean(issue.pull_request)
  };
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

function isAgentRunnerBotLogin(login: string | null): boolean {
  if (!login) return false;
  const normalized = login.trim().toLowerCase();
  if (!normalized.endsWith("[bot]")) return false;
  return normalized.includes("agent-runner");
}

function isCopilotBotLogin(login: string | null): boolean {
  return isCopilotReviewerLogin(login);
}

async function isManagedPullRequest(issue: IssueInfo, config: AgentRunnerConfig): Promise<boolean> {
  if (!issue.isPullRequest) {
    return false;
  }
  if (isAgentRunnerBotLogin(issue.author ?? null)) {
    return true;
  }
  const statePath = resolveManagedPullRequestsStatePath(config.workdirRoot);
  return isManagedPullRequestState(statePath, issue.repo, issue.number);
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

  if (issue.isPullRequest) {
    const managedStatePath = resolveManagedPullRequestsStatePath(config.workdirRoot);
    await markManagedPullRequest(managedStatePath, issue.repo, issue.number);
  }
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

async function handleReviewFollowup(options: {
  client: GitHubClient;
  config: AgentRunnerConfig;
  repo: RepoInfo;
  prNumber: number;
  reason: "review_comment" | "review" | "approval";
  requiresEngine: boolean;
  onLog?: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
}): Promise<void> {
  const { client, config, repo, prNumber, reason, requiresEngine, onLog } = options;

  if (!config.idle?.enabled) {
    return;
  }

  const issue = await client.getIssue(repo, prNumber);
  if (!issue) {
    return;
  }

  if (!(await isManagedPullRequest(issue, config))) {
    return;
  }

  await safeRemoveLabel(client, issue, config.labels.needsUser, onLog);
  await safeRemoveLabel(client, issue, config.labels.failed, onLog);
  await safeRemoveLabel(client, issue, config.labels.done, onLog);
  await safeRemoveLabel(client, issue, config.labels.running, onLog);
  await safeRemoveLabel(client, issue, config.labels.queued, onLog);

  const reviewQueuePath = resolveReviewQueuePath(config.workdirRoot);
  await enqueueReviewTask(reviewQueuePath, {
    issueId: issue.id,
    prNumber,
    repo,
    url: issue.url,
    reason,
    requiresEngine
  });
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

    if (issue.isPullRequest) {
      const managedStatePath = resolveManagedPullRequestsStatePath(config.workdirRoot);
      await markManagedPullRequest(managedStatePath, issue.repo, issue.number);
    }
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
    const comment = payload.comment ?? {};
    const commentUserType = (comment.user as { type?: string } | undefined)?.type ?? null;
    const commentLogin = comment.user?.login ?? null;
    if ((commentUserType === "Bot" && !isCopilotBotLogin(commentLogin)) || isAgentRunnerBotLogin(commentLogin)) {
      return;
    }
    if (!isCopilotBotLogin(commentLogin) && !isAllowedAuthorAssociation(comment.author_association)) {
      onLog?.("info", "Ignoring PR review comment from non-collaborator.", {
        repo: `${repo.owner}/${repo.repo}`,
        authorAssociation: comment.author_association ?? null,
        user: commentLogin
      });
      return;
    }

    const prNumber = payload.pull_request?.number ?? 0;
    if (!prNumber || prNumber <= 0) {
      onLog?.("warn", "Ignoring PR review comment due to missing PR number.", { repo: `${repo.owner}/${repo.repo}` });
      return;
    }

    const command = parseAgentCommand(payload.comment?.body ?? null);
    if (command?.kind === "run") {
      const commentId = comment.id ?? 0;
      if (!commentId || commentId <= 0) {
        onLog?.("warn", "Ignoring /agent run review comment due to missing id.", { repo: `${repo.owner}/${repo.repo}` });
        return;
      }

      const statePath = resolveAgentCommandStatePath(config.workdirRoot);
      if (await hasProcessedAgentCommandComment(statePath, commentId)) {
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
      return;
    }

    await handleReviewFollowup({
      client,
      config,
      repo,
      prNumber,
      reason: "review_comment",
      requiresEngine: true,
      onLog
    });
    return;
  }

  if (event.event === "pull_request_review") {
    const action = payload.action ?? "";
    if (action !== "submitted") {
      return;
    }
    const review = payload.review ?? {};
    const reviewUserType = (review.user as { type?: string } | undefined)?.type ?? null;
    const reviewLogin = review.user?.login ?? null;
    const isCopilotReview = isCopilotBotLogin(reviewLogin);
    if ((reviewUserType === "Bot" && !isCopilotReview) || isAgentRunnerBotLogin(reviewLogin)) {
      return;
    }
    if (!isCopilotReview && !isAllowedAuthorAssociation(review.author_association)) {
      onLog?.("info", "Ignoring PR review from non-collaborator.", {
        repo: `${repo.owner}/${repo.repo}`,
        authorAssociation: review.author_association ?? null,
        user: reviewLogin
      });
      return;
    }

    const prNumber = payload.pull_request?.number ?? 0;
    if (!prNumber || prNumber <= 0) {
      onLog?.("warn", "Ignoring PR review due to missing PR number.", { repo: `${repo.owner}/${repo.repo}` });
      return;
    }

    const state = (review.state ?? "").toLowerCase();
    const body = review.body?.trim() ?? "";

    if (state === "approved") {
      await handleReviewFollowup({
        client,
        config,
        repo,
        prNumber,
        reason: "approval",
        requiresEngine: false,
        onLog
      });
      return;
    }

    if (isCopilotReview && state === "commented" && copilotReviewIndicatesNoNewComments(body)) {
      await handleReviewFollowup({
        client,
        config,
        repo,
        prNumber,
        reason: "approval",
        requiresEngine: false,
        onLog
      });
      return;
    }

    if (state === "changes_requested" || body.length > 0) {
      await handleReviewFollowup({
        client,
        config,
        repo,
        prNumber,
        reason: "review",
        requiresEngine: true,
        onLog
      });
    }
  }
}
