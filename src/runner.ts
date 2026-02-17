import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AgentRunnerConfig } from "./config.js";
import {
  GitHubClient,
  type IssueComment,
  type IssueInfo,
  type PullRequestReviewComment,
  type RepoInfo
} from "./github.js";
import { resolveCodexCommand } from "./codex-command.js";
import { recordAmazonQUsage, resolveAmazonQUsageStatePath } from "./amazon-q-usage.js";
import {
  buildIdleDuplicateWorkGuard,
  buildIdleOpenPrContext,
  formatIdleOpenPrContextBlock,
  formatIdleOpenPrCount
} from "./idle-open-pr-context.js";
import {
  chooseIdleTask,
  loadIdleHistory,
  recordIdleRun,
  resolveIdleHistoryPath,
  saveIdleHistory,
  selectIdleRepos,
  type IdlePlanOptions
} from "./idle.js";
import { recordRunningIssue, removeRunningIssue, resolveRunnerStatePath } from "./runner-state.js";
import {
  recordActivity,
  removeActivity,
  resolveActivityStatePath
} from "./activity-state.js";
import { AGENT_RUNNER_MARKER, findLastMarkerComment, NEEDS_USER_MARKER } from "./notifications.js";
import { normalizeLogChunk } from "./log-normalize.js";
import { resolveLogMaintenance, writeLatestPointer } from "./log-maintenance.js";
import { buildGitHubNotifyChildEnv } from "./github-notify-env.js";
import { resolveTargetRepos } from "./target-repos.js";
import { fetchCodexRateLimits, rateLimitSnapshotToStatus } from "./codex-status.js";
import {
  createWorktreeForRemoteBranch,
  createWorktreeFromDefaultBranch,
  ensureRepoCache,
  refreshRepoCache,
  removeWorktree,
  resolveRunWorkRoot
} from "./git-worktree.js";

export type RunFailureKind = "quota" | "needs_user_reply" | "execution_error";
export type RunFailureStage = "before_session" | "after_session";
type AgentRunStatus = "done" | "needs_user_reply";

export type RunResult = {
  success: boolean;
  logPath: string;
  repos: RepoInfo[];
  summary: string | null;
  activityId: string | null;
  sessionId: string | null;
  failureKind: RunFailureKind | null;
  failureStage: RunFailureStage | null;
  failureDetail: string | null;
  quotaResumeAt: string | null;
};

export type IdleEngine = "codex" | "copilot" | "gemini-pro" | "gemini-flash" | "amazon-q";

export type IdleTaskResult = {
  success: boolean;
  logPath: string;
  repo: RepoInfo;
  task: string;
  engine: IdleEngine;
  summary: string | null;
  reportPath: string;
  headBranch: string;
};

export type EngineInvocation = {
  command: string;
  args: string[];
  stdin?: string;
  options: {
    cwd: string;
    shell: boolean;
    env: NodeJS.ProcessEnv;
  };
};

export function buildAmazonQInvocation(
  config: AgentRunnerConfig,
  primaryPath: string,
  prompt: string,
  envOverrides: NodeJS.ProcessEnv = {}
): EngineInvocation {
  if (!config.amazonQ || !config.amazonQ.enabled) {
    throw new Error("Amazon Q command not configured.");
  }
  const resolved = resolveCodexCommand(config.amazonQ.command, process.env.PATH);
  const promptMode = config.amazonQ.promptMode ?? "stdin";
  const args =
    promptMode === "arg"
      ? [...resolved.prefixArgs, ...config.amazonQ.args, prompt]
      : [...resolved.prefixArgs, ...config.amazonQ.args];

  return {
    command: resolved.command,
    args,
    stdin: promptMode === "stdin" ? prompt : undefined,
    options: {
      cwd: primaryPath,
      shell: false,
      env: { ...process.env, ...envOverrides }
    }
  };
}

function isPullRequestUrl(url: string): boolean {
  return /\/pull\/\d+$/i.test(url);
}

function resolveWorktreeDirName(repo: RepoInfo): string {
  return `${repo.owner}--${repo.repo}`.replace(/[^a-zA-Z0-9._-]/g, "_");
}

const MAX_ISSUE_COMMENT_CHARS = 4_000;
const MAX_ISSUE_COMMENTS_BLOCK_CHARS = 12_000;
const MAX_ISSUE_COMMENTS_COUNT = 8;
const MAX_REVIEW_COMMENT_CHARS = 4_000;
const MAX_REVIEW_COMMENTS_BLOCK_CHARS = 12_000;
const MAX_REVIEW_COMMENTS_COUNT = 8;
const MAX_IDLE_OPEN_PULL_REQUESTS = 50;
const MAX_IDLE_OPEN_PR_CONTEXT_CHARS = 12_000;
const MAX_IDLE_OPEN_PR_CONTEXT_ENTRIES = 50;

type IdleOpenPrLoader = Pick<GitHubClient, "listOpenPullRequests" | "getOpenPullRequestCount">;

export type IdleOpenPrData = {
  openPrContextAvailable: boolean;
  openPrCount: number | null;
  openPrContext: string;
};

function truncateForPrompt(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n…[truncated]`;
}

function isAgentRunnerComment(comment: IssueComment): boolean {
  return comment.body.includes(AGENT_RUNNER_MARKER);
}

function selectRelevantUserComments(comments: IssueComment[]): IssueComment[] {
  const userComments = comments.filter((comment) => !isAgentRunnerComment(comment));
  const anchor = findLastMarkerComment(comments, NEEDS_USER_MARKER);

  const filtered =
    anchor === null
      ? userComments
      : userComments.filter((comment) => Date.parse(comment.createdAt) > Date.parse(anchor.createdAt));

  return filtered.slice(-MAX_ISSUE_COMMENTS_COUNT);
}

function formatCommentsForPrompt(comments: IssueComment[]): string {
  const selected = selectRelevantUserComments(comments);
  if (selected.length === 0) {
    return "";
  }

  let remaining = MAX_ISSUE_COMMENTS_BLOCK_CHARS;
  const chunks: string[] = [];

  for (const comment of selected) {
    const headerParts = [`comment ${comment.id}`, comment.createdAt];
    if (comment.author) {
      headerParts.push(`@${comment.author}`);
    }
    const header = `--- ${headerParts.join(" ")} ---`;
    const body = truncateForPrompt(comment.body.trim(), MAX_ISSUE_COMMENT_CHARS);
    const chunk = `${header}\n${body}\n`;
    if (chunk.length > remaining) {
      break;
    }
    chunks.push(chunk);
    remaining -= chunk.length;
  }

  if (chunks.length === 0) {
    return "";
  }

  const hasNeedsUserMarker = comments.some((comment) => comment.body.includes(NEEDS_USER_MARKER));
  const note = hasNeedsUserMarker
    ? "Note: only user comments after the last needs-user marker are included.\n"
    : "";

  return `${note}${chunks.join("\n")}`.trim();
}

function formatReviewCommentsForPrompt(comments: PullRequestReviewComment[]): string {
  const selected = comments.slice(-MAX_REVIEW_COMMENTS_COUNT);
  if (selected.length === 0) {
    return "";
  }

  let remaining = MAX_REVIEW_COMMENTS_BLOCK_CHARS;
  const chunks: string[] = [];

  for (const comment of selected) {
    const headerParts = [`review-comment ${comment.id}`, comment.createdAt];
    if (comment.author) {
      headerParts.push(`@${comment.author}`);
    }
    if (comment.path) {
      headerParts.push(comment.line ? `${comment.path}:${comment.line}` : comment.path);
    }
    const header = `--- ${headerParts.join(" ")} ---`;
    const body = truncateForPrompt(comment.body.trim(), MAX_REVIEW_COMMENT_CHARS);
    const chunk = `${header}\n${body}\n`;
    if (chunk.length > remaining) {
      break;
    }
    chunks.push(chunk);
    remaining -= chunk.length;
  }

  if (chunks.length === 0) {
    return "";
  }

  return chunks.join("\n").trim();
}

export function buildIssueTaskText(
  issue: IssueInfo,
  comments: IssueComment[],
  reviewComments: PullRequestReviewComment[] = []
): string {
  const issueBody = issue.body ?? "";
  const base = `Issue: ${issue.title}\nURL: ${issue.url}\n\n${issueBody}`.trim();
  const commentBlock = formatCommentsForPrompt(comments);
  const reviewBlock = formatReviewCommentsForPrompt(reviewComments);

  if (!commentBlock && !reviewBlock) {
    return base;
  }

  const sections: string[] = [base];
  if (commentBlock) {
    sections.push(`Recent user replies (issue comments):\n${commentBlock}`);
  }
  if (reviewBlock) {
    sections.push(`PR review comments:\n${reviewBlock}`);
  }
  return sections.join("\n\n");
}

export async function loadIdleOpenPrData(
  client: IdleOpenPrLoader,
  repo: RepoInfo,
  options: {
    maxOpenPullRequests: number;
    maxContextEntries: number;
    maxContextChars: number;
    warn?: (message: string) => void;
  }
): Promise<IdleOpenPrData> {
  const warn = options.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
  const [openPrListResult, openPrCountResult] = await Promise.allSettled([
    client.listOpenPullRequests(repo, { limit: options.maxOpenPullRequests }),
    client.getOpenPullRequestCount(repo)
  ]);

  let openPrContextAvailable = true;
  let openPrContext = "";
  let openPullRequests: Awaited<ReturnType<GitHubClient["listOpenPullRequests"]>> = [];
  if (openPrListResult.status === "fulfilled") {
    openPullRequests = openPrListResult.value;
  } else {
    openPrContextAvailable = false;
    const message =
      openPrListResult.reason instanceof Error
        ? openPrListResult.reason.message
        : String(openPrListResult.reason);
    warn(`[WARN] Failed to load open PR context for ${repo.owner}/${repo.repo}: ${message}`);
    openPrContext = "Open PR context unavailable due to GitHub API error.";
  }

  let openPrCount: number | null = null;
  if (openPrCountResult.status === "fulfilled") {
    openPrCount = openPrCountResult.value;
  } else {
    const message =
      openPrCountResult.reason instanceof Error
        ? openPrCountResult.reason.message
        : String(openPrCountResult.reason);
    warn(`[WARN] Failed to load open PR count for ${repo.owner}/${repo.repo}: ${message}`);
  }

  if (openPrContextAvailable) {
    openPrContext = buildIdleOpenPrContext(openPullRequests, {
      maxEntries: options.maxContextEntries,
      maxChars: options.maxContextChars,
      totalCount: openPrCount
    });
  }

  return {
    openPrContextAvailable,
    openPrCount,
    openPrContext
  };
}

function renderPrompt(
  template: string,
  repos: RepoInfo[],
  issue: IssueInfo,
  comments: IssueComment[],
  reviewComments: PullRequestReviewComment[]
): string {
  const repoList = repos.map((repo) => `${repo.owner}/${repo.repo}`).join(", ");
  const taskText = buildIssueTaskText(issue, comments, reviewComments);
  return template.replace("{{repos}}", repoList).replace("{{task}}", taskText);
}

export function renderIdlePrompt(
  template: string,
  repo: RepoInfo,
  task: string,
  options: {
    openPrCount: number | null;
    openPrContext: string;
    openPrContextAvailable: boolean;
  }
): string {
  const repoSlug = `${repo.owner}/${repo.repo}`;
  const openPrCountLabel = formatIdleOpenPrCount(options.openPrCount);
  const openPrContext = formatIdleOpenPrContextBlock(options.openPrContext);
  const placeholders: Record<"repo" | "owner" | "repoName" | "openPrCount" | "openPrContext" | "task", string> = {
    repo: repoSlug,
    owner: repo.owner,
    repoName: repo.repo,
    openPrCount: openPrCountLabel,
    openPrContext,
    task
  };
  let rendered = template.replace(
    /{{(repo|owner|repoName|openPrCount|openPrContext|task)}}/g,
    (_match, key: "repo" | "owner" | "repoName" | "openPrCount" | "openPrContext" | "task") =>
      placeholders[key] ?? ""
  );

  if (!template.includes("{{openPrCount}}")) {
    rendered = `${rendered}\nOpen PR count: ${openPrCountLabel}`;
  }
  if (!template.includes("{{openPrContext}}")) {
    rendered = `${rendered}\n\nOpen PR context:\n${openPrContext}`;
  }

  const guard = buildIdleDuplicateWorkGuard(options.openPrCount, options.openPrContextAvailable);
  return `${rendered}\n\n${guard}\n`;
}

function ensureGeminiSystemDefaultsPath(workdirRoot: string): string {
  const stateDir = path.resolve(workdirRoot, "agent-runner", "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const defaultsPath = path.join(stateDir, "gemini-system-defaults.json");

  if (!fs.existsSync(defaultsPath)) {
    const defaults = {
      tools: {
        shell: {
          enableInteractiveShell: false
        }
      }
    };
    fs.writeFileSync(defaultsPath, `${JSON.stringify(defaults, null, 2)}\n`, "utf8");
  }

  return defaultsPath;
}

export function buildGeminiInvocation(
  config: AgentRunnerConfig,
  primaryPath: string,
  prompt: string,
  engine: "gemini-pro" | "gemini-flash",
  envOverrides: NodeJS.ProcessEnv = {}
): EngineInvocation {
  if (!config.gemini) {
    throw new Error("Gemini command not configured.");
  }
  const resolved = resolveCodexCommand(config.gemini.command, process.env.PATH);
  
  const modelArg = engine === "gemini-pro" ? "gemini-3-pro-preview" : "gemini-3-flash-preview";
  const args = [...resolved.prefixArgs, "-m", modelArg, ...config.gemini.args, prompt];

  return {
    command: resolved.command,
    args,
    options: {
      cwd: primaryPath,
      shell: false,
      env: {
        ...process.env,
        ...envOverrides,
        GEMINI_CLI_SYSTEM_DEFAULTS_PATH: ensureGeminiSystemDefaultsPath(config.workdirRoot)
      }
    }
  };
}

export function buildCodexInvocation(
  config: AgentRunnerConfig,
  primaryPath: string,
  prompt: string,
  options: { envOverrides?: NodeJS.ProcessEnv; addDir?: string } = {}
): EngineInvocation {
  const resolved = resolveCodexCommand(config.codex.command, process.env.PATH);
  const envOverrides = options.envOverrides ?? {};
  const addDir = options.addDir ?? config.workdirRoot;
  const args = [
    ...resolved.prefixArgs,
    ...config.codex.args,
    "-C",
    primaryPath,
    "--add-dir",
    addDir,
    prompt
  ];

  return {
    command: resolved.command,
    args,
    options: {
      cwd: primaryPath,
      shell: false,
      env: { ...process.env, ...envOverrides }
    }
  };
}

function resolveCodexExecArgs(config: AgentRunnerConfig): string[] {
  if (config.codex.args.length === 0) {
    return [];
  }
  return config.codex.args[0] === "exec" ? config.codex.args.slice(1) : config.codex.args.slice();
}

export function buildCodexResumeInvocation(
  config: AgentRunnerConfig,
  primaryPath: string,
  sessionId: string,
  prompt: string,
  options: { envOverrides?: NodeJS.ProcessEnv } = {}
): EngineInvocation {
  const resolved = resolveCodexCommand(config.codex.command, process.env.PATH);
  const execArgs = resolveCodexExecArgs(config);
  const envOverrides = options.envOverrides ?? {};
  const args = [
    ...resolved.prefixArgs,
    "exec",
    "resume",
    ...execArgs,
    "--skip-git-repo-check",
    sessionId,
    prompt
  ];

  return {
    command: resolved.command,
    args,
    options: {
      cwd: primaryPath,
      shell: false,
      env: { ...process.env, ...envOverrides }
    }
  };
}

export function buildCopilotInvocation(
  config: AgentRunnerConfig,
  primaryPath: string,
  prompt: string,
  envOverrides: NodeJS.ProcessEnv = {}
): EngineInvocation {
  if (!config.copilot) {
    throw new Error("Copilot command not configured.");
  }
  const resolved = resolveCodexCommand(config.copilot.command, process.env.PATH);
  const args = [...resolved.prefixArgs, ...config.copilot.args, prompt];

  return {
    command: resolved.command,
    args,
    options: {
      cwd: primaryPath,
      shell: false,
      env: { ...process.env, ...envOverrides }
    }
  };
}

type IssueRunMode = "new" | "resume";

type IssueAttemptResult = {
  exitCode: number;
  outputTail: string;
  sessionId: string | null;
};

const SESSION_ID_REGEX = /session id:\s*([0-9a-z-]{8,})/i;
const QUOTA_ERROR_PATTERNS = [
  /usage limit/i,
  /quota[^.\n]*(exceeded|reached|exhausted)/i,
  /rate limit/i,
  /too many requests/i,
  /insufficient credits/i,
  /credits?[^.\n]*(depleted|exhausted)/i
];
const MISSING_SESSION_PATTERNS = [
  /session[^.\n]*not found/i,
  /no matching session/i,
  /could not find[^.\n]*session/i,
  /unknown session/i
];
const MAX_OUTPUT_TAIL_CHARS = 200_000;
const MAX_RESUME_ATTEMPTS = 30;
const AGENT_RUNNER_STATUS_PREFIX = "AGENT_RUNNER_STATUS:";

function keepTail(value: string, limit: number = MAX_OUTPUT_TAIL_CHARS): string {
  if (value.length <= limit) {
    return value;
  }
  return value.slice(value.length - limit);
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function detectSessionId(value: string): string | null {
  const match = stripAnsi(value).match(SESSION_ID_REGEX);
  return match?.[1] ?? null;
}

function hasPattern(value: string, patterns: RegExp[]): boolean {
  const cleaned = stripAnsi(value);
  return patterns.some((pattern) => pattern.test(cleaned));
}

function extractFailureDetail(value: string): string | null {
  const lines = stripAnsi(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }
  const candidates = lines.filter(
    (line) =>
      /error|failed|limit|quota|denied|timeout|exception/i.test(line) &&
      !/^exec$/i.test(line) &&
      !/^thinking$/i.test(line)
  );
  const chosen = (candidates.at(-1) ?? lines.at(-1) ?? "").trim();
  return chosen.length > 0 ? chosen : null;
}

function isLikelyMissingSessionError(value: string): boolean {
  return hasPattern(value, MISSING_SESSION_PATTERNS);
}

function resolveQuotaRunAfter(statusRaw: ReturnType<typeof rateLimitSnapshotToStatus>): Date | null {
  if (!statusRaw || statusRaw.windows.length === 0) {
    return null;
  }
  const weekly = statusRaw.windows.find((window) => window.key === "weekly");
  const fiveHour = statusRaw.windows.find((window) => window.key === "fiveHour");

  if (weekly && weekly.percentLeft <= 0) {
    return weekly.resetAt;
  }
  if (fiveHour && fiveHour.percentLeft <= 0) {
    return fiveHour.resetAt;
  }

  const sorted = statusRaw.windows
    .map((window) => window.resetAt)
    .filter((date) => Number.isFinite(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  return sorted[0] ?? null;
}

async function resolveQuotaResumeAt(config: AgentRunnerConfig): Promise<string | null> {
  const gate = config.idle?.usageGate;
  const command = gate?.command ?? config.codex.command;
  const args = gate?.args ?? [];
  const timeoutSeconds = gate?.timeoutSeconds ?? 20;
  const snapshot = await fetchCodexRateLimits(command, args, timeoutSeconds, config.workdirRoot);
  const status = snapshot ? rateLimitSnapshotToStatus(snapshot, new Date()) : null;
  const runAfter = resolveQuotaRunAfter(status);
  return runAfter ? runAfter.toISOString() : null;
}

async function runCodexAttempt(options: {
  engine: IdleEngine;
  mode: IssueRunMode;
  config: AgentRunnerConfig;
  issue: IssueInfo;
  primaryPath: string;
  workRoot: string;
  prompt: string;
  resumeSessionId: string | null;
  logPath: string;
  activityPath: string;
  statePath: string;
  activityId: string;
  envOverrides: NodeJS.ProcessEnv;
}): Promise<IssueAttemptResult> {
  const invocation =
    options.engine === "copilot"
      ? buildCopilotInvocation(options.config, options.primaryPath, options.prompt, options.envOverrides)
      : options.engine === "amazon-q"
      ? buildAmazonQInvocation(options.config, options.primaryPath, options.prompt, options.envOverrides)
      : options.engine === "gemini-pro" || options.engine === "gemini-flash"
      ? buildGeminiInvocation(options.config, options.primaryPath, options.prompt, options.engine, options.envOverrides)
      : options.mode === "resume" && options.resumeSessionId
      ? buildCodexResumeInvocation(
          options.config,
          options.primaryPath,
          options.resumeSessionId,
          options.prompt,
          { envOverrides: options.envOverrides }
        )
      : buildCodexInvocation(options.config, options.primaryPath, options.prompt, {
          envOverrides: options.envOverrides,
          addDir: options.workRoot
        });

  const appendLog = (value: string): void => {
    fs.appendFileSync(options.logPath, value);
  };

  return new Promise<IssueAttemptResult>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, invocation.options);
    let outputTail = "";
    let sessionId: string | null = null;

    if (invocation.stdin && child.stdin) {
      try {
        child.stdin.write(invocation.stdin);
        child.stdin.end();
      } catch {
        // best-effort: proceed without stdin if writing fails
      }
    }

    if (typeof child.pid === "number") {
      const startedAt = new Date().toISOString();
      recordRunningIssue(options.statePath, {
        issueId: options.issue.id,
        issueNumber: options.issue.number,
        repo: options.issue.repo,
        startedAt,
        pid: child.pid,
        logPath: options.logPath
      });
      recordActivity(options.activityPath, {
        id: options.activityId,
        kind: "issue",
        engine: options.engine,
        repo: options.issue.repo,
        startedAt,
        pid: child.pid,
        logPath: options.logPath,
        issueId: options.issue.id,
        issueNumber: options.issue.number
      });
    }

    const handleChunk = (chunk: Buffer): string => {
      const normalized = normalizeLogChunk(chunk);
      appendLog(normalized);
      outputTail = keepTail(outputTail + normalized);
      if (options.engine === "codex") {
        const detected = detectSessionId(normalized);
        if (detected) {
          sessionId = detected;
        }
      }
      return normalized;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(handleChunk(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(handleChunk(chunk));
    });

    child.on("error", (error) => {
      removeRunningIssue(options.statePath, options.issue.id);
      reject(error);
    });
    child.on("close", (code) => {
      removeRunningIssue(options.statePath, options.issue.id);
      resolve({
        exitCode: code ?? 1,
        outputTail,
        sessionId: options.engine === "codex" ? sessionId ?? detectSessionId(outputTail) : null
      });
    });
  });
}

export async function runIssue(
  client: GitHubClient,
  config: AgentRunnerConfig,
  issue: IssueInfo,
  options: { resumeSessionId?: string | null; resumePrompt?: string | null; engine?: IdleEngine } = {}
): Promise<RunResult> {
  const engine: IdleEngine = options.engine ?? "codex";
  const repos = resolveTargetRepos(issue, config.owner);
  const comments = await client.listIssueComments(issue);
  const reviewComments = isPullRequestUrl(issue.url)
    ? await client.listPullRequestReviewComments(issue.repo, issue.number)
    : [];

  const runId = `issue-${issue.id}-${Date.now()}`;
  const workRoot = resolveRunWorkRoot(config.workdirRoot, runId);
  const prepared: Array<{ repo: RepoInfo; cachePath: string; worktreePath: string }> = [];

  const prHead = isPullRequestUrl(issue.url) ? await client.getPullRequestHead(issue.repo, issue.number) : null;

  const primaryRepo = repos[0];
  let primaryPath: string | null = null;

  try {
    for (const repo of repos) {
      const cachePath = await ensureRepoCache(config.workdirRoot, repo);
      await refreshRepoCache(config.workdirRoot, repo, cachePath);

      const worktreePath = path.join(workRoot, resolveWorktreeDirName(repo));
      const isPrimary =
        repo.owner.toLowerCase() === primaryRepo.owner.toLowerCase() && repo.repo.toLowerCase() === primaryRepo.repo.toLowerCase();

      if (isPrimary && prHead) {
        const expected = `${repo.owner}/${repo.repo}`.toLowerCase();
        const headRepo = prHead.headRepoFullName?.toLowerCase() ?? null;
        if (headRepo && headRepo !== expected) {
          throw new Error(
            `PR head repo is ${prHead.headRepoFullName}, expected ${repo.owner}/${repo.repo}. ` +
              "PRs from forks are not supported for /agent run because the runner cannot push to the head branch."
          );
        }
        await createWorktreeForRemoteBranch({ workdirRoot: config.workdirRoot, repo, cachePath, worktreePath, branch: prHead.headRef });
      } else {
        const defaultBranch = await client.getRepoDefaultBranch(repo);
        const branchSuffix = `${Date.now()}`;
        const newBranch = isPrimary
          ? `agent-runner/issue-${issue.number}-${branchSuffix}`
          : `agent-runner/issue-${issue.number}-${branchSuffix}/${repo.repo}`;
        await createWorktreeFromDefaultBranch({
          workdirRoot: config.workdirRoot,
          repo,
          cachePath,
          worktreePath,
          defaultBranch,
          newBranch
        });
      }

      prepared.push({ repo, cachePath, worktreePath });
      if (isPrimary) {
        primaryPath = worktreePath;
      }
    }

    if (!primaryPath) {
      throw new Error(`Missing primary worktree for ${primaryRepo.owner}/${primaryRepo.repo}`);
    }

    const prompt = renderPrompt(config.codex.promptTemplate, repos, issue, comments, reviewComments);
    const resumePrompt = options.resumePrompt?.trim() ? options.resumePrompt : prompt;

    const logDir = path.resolve(config.workdirRoot, "agent-runner", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(
      logDir,
      `${issue.repo.repo}-issue-${issue.number}-${Date.now()}.log`
    );
    if (resolveLogMaintenance(config).writeLatestPointers) {
      writeLatestPointer(logDir, "issue", logPath);
    }

    const statePath = resolveRunnerStatePath(config.workdirRoot);
    const activityPath = resolveActivityStatePath(config.workdirRoot);
    const activityId = `issue:${issue.id}`;
    const notifyEnv = await buildGitHubNotifyChildEnv(config.workdirRoot);
    const envOverrides: NodeJS.ProcessEnv = {
      ...notifyEnv,
      AGENT_RUNNER_ENGINE: engine,
      AGENT_RUNNER_WORKROOT: workRoot,
      AGENT_RUNNER_PRIMARY_REPO: `${primaryRepo.owner}/${primaryRepo.repo}`,
      AGENT_RUNNER_PRIMARY_REPO_PATH: primaryPath
    };

    let mode: IssueRunMode = engine === "codex" && options.resumeSessionId ? "resume" : "new";
    let latestSessionId: string | null = engine === "codex" ? options.resumeSessionId ?? null : null;
    let currentPrompt = mode === "resume" ? resumePrompt : prompt;
    let attempt = 0;

    try {
      while (true) {
        attempt += 1;
        const result = await runCodexAttempt({
          engine,
          mode,
          config,
          issue,
          primaryPath,
          workRoot,
          prompt: currentPrompt,
          resumeSessionId: latestSessionId,
          logPath,
          activityPath,
          statePath,
          activityId,
          envOverrides
        });

        if (result.sessionId) {
          latestSessionId = result.sessionId;
        }

        const finalResponse = extractFinalResponseFromLog(logPath);
        const agentResult = parseAgentRunResult(finalResponse);
        const summary = agentResult.response;
        if (result.exitCode === 0) {
          if (agentResult.status === "needs_user_reply") {
            const stage: RunFailureStage = latestSessionId ? "after_session" : "before_session";
            return {
              success: false,
              logPath,
              repos,
              summary,
              activityId,
              sessionId: latestSessionId,
              failureKind: "needs_user_reply",
              failureStage: stage,
              failureDetail: null,
              quotaResumeAt: null
            };
          }
          return {
            success: true,
            logPath,
            repos,
            summary,
            activityId,
            sessionId: latestSessionId,
            failureKind: null,
            failureStage: null,
            failureDetail: null,
            quotaResumeAt: null
          };
        }

        const stage: RunFailureStage = latestSessionId ? "after_session" : "before_session";
        const quotaFailure = hasPattern(result.outputTail, QUOTA_ERROR_PATTERNS);
        if (quotaFailure) {
          let quotaResumeAt: string | null = null;
          try {
            quotaResumeAt = await resolveQuotaResumeAt(config);
          } catch {
            quotaResumeAt = null;
          }
          return {
            success: false,
            logPath,
            repos,
            summary,
            activityId,
            sessionId: latestSessionId,
            failureKind: "quota",
            failureStage: stage,
            failureDetail: extractFailureDetail(result.outputTail),
            quotaResumeAt
          };
        }

        if (agentResult.status === "needs_user_reply") {
          return {
            success: false,
            logPath,
            repos,
            summary,
            activityId,
            sessionId: latestSessionId,
            failureKind: "needs_user_reply",
            failureStage: stage,
            failureDetail: extractFailureDetail(result.outputTail),
            quotaResumeAt: null
          };
        }

        if (engine === "codex" && mode === "resume" && isLikelyMissingSessionError(result.outputTail) && attempt < MAX_RESUME_ATTEMPTS) {
          mode = "new";
          latestSessionId = null;
          currentPrompt = prompt;
          continue;
        }

        if (engine === "codex" && stage === "after_session" && attempt < MAX_RESUME_ATTEMPTS) {
          mode = "resume";
          currentPrompt =
            "The previous execution ended unexpectedly. Continue this same session and complete the original task. " +
            "If additional user input is required, explicitly ask for it.";
          continue;
        }

        return {
          success: false,
          logPath,
          repos,
          summary,
          activityId,
          sessionId: latestSessionId,
          failureKind: "execution_error",
          failureStage: stage,
          failureDetail: extractFailureDetail(result.outputTail),
          quotaResumeAt: null
        };
      }
    } catch (error) {
      removeActivity(activityPath, activityId);
      throw error;
    }
  } finally {
    for (const entry of prepared) {
      await removeWorktree({
        workdirRoot: config.workdirRoot,
        repo: entry.repo,
        cachePath: entry.cachePath,
        worktreePath: entry.worktreePath
      });
    }
    try {
      await fs.promises.rm(workRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function resolveIdleReportPath(workdirRoot: string, repo: RepoInfo): string {
  const reportsDir = path.resolve(workdirRoot, "agent-runner", "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  return path.join(reportsDir, `${repo.owner}-${repo.repo}-idle-${Date.now()}.md`);
}

function writeIdleReport(
  reportPath: string,
  repo: RepoInfo,
  task: string,
  engine: IdleEngine,
  success: boolean,
  summary: string | null,
  logPath: string
): void {
  const lines = [
    `# Idle task report`,
    ``,
    `- Repo: ${repo.owner}/${repo.repo}`,
    `- Task: ${task}`,
    `- Engine: ${engine}`,
    `- Success: ${success}`,
    `- Log: ${logPath}`,
    `- Timestamp: ${new Date().toISOString()}`,
    ``,
    `## Summary`,
    summary ? summary.trim() : "No summary captured."
  ];
  fs.writeFileSync(reportPath, `${lines.join("\n")}\n`, "utf8");
}

export async function planIdleTasks(
  config: AgentRunnerConfig,
  repos: RepoInfo[],
  options: IdlePlanOptions = {}
): Promise<Array<{ repo: RepoInfo; task: string }>> {
  if (!config.idle?.enabled) {
    return [];
  }

  const maxRuns = options.maxRuns ?? config.idle.maxRunsPerCycle;
  const now = options.now ?? new Date();
  const historyPath = resolveIdleHistoryPath(config.workdirRoot);
  const history = loadIdleHistory(historyPath);
  const targets = selectIdleRepos(
    repos,
    history,
    maxRuns,
    config.idle.cooldownMinutes,
    now
  );

  if (targets.length === 0) {
    return [];
  }

  const planned: Array<{ repo: RepoInfo; task: string }> = [];
  const startedAt = now.toISOString();

  for (const repo of targets) {
    const { task, nextCursor } = chooseIdleTask(config.idle.tasks, history);
    history.taskCursor = nextCursor;
    recordIdleRun(history, repo, task, startedAt);
    planned.push({ repo, task });
  }

  saveIdleHistory(historyPath, history);
  return planned;
}

export async function runIdleTask(
  config: AgentRunnerConfig,
  repo: RepoInfo,
  task: string,
  engine: IdleEngine
): Promise<IdleTaskResult> {
  const runId = `idle-${engine}-${repo.repo}-${Date.now()}`;
  const workRoot = resolveRunWorkRoot(config.workdirRoot, runId);
  const cachePath = await ensureRepoCache(config.workdirRoot, repo);
  await refreshRepoCache(config.workdirRoot, repo, cachePath);

  const repoPath = path.join(workRoot, resolveWorktreeDirName(repo));
  let created = false;

  try {
    const token =
      process.env.AGENT_GITHUB_TOKEN ||
      process.env.GITHUB_TOKEN ||
      process.env.GH_TOKEN;

    if (!token) {
      throw new Error("Missing GitHub token. Set AGENT_GITHUB_TOKEN or GITHUB_TOKEN.");
    }
    const client = new GitHubClient(token);
    const defaultBranch = await client.getRepoDefaultBranch(repo);
    const newBranch = `agent-runner/idle-${engine}-${Date.now()}`;
    await createWorktreeFromDefaultBranch({
      workdirRoot: config.workdirRoot,
      repo,
      cachePath,
      worktreePath: repoPath,
      defaultBranch,
      newBranch
    });
    created = true;

    const { openPrContextAvailable, openPrCount, openPrContext } = await loadIdleOpenPrData(client, repo, {
      maxOpenPullRequests: MAX_IDLE_OPEN_PULL_REQUESTS,
      maxContextEntries: MAX_IDLE_OPEN_PR_CONTEXT_ENTRIES,
      maxContextChars: MAX_IDLE_OPEN_PR_CONTEXT_CHARS,
      warn: (message) => process.stderr.write(`${message}\n`)
    });

    const prompt = renderIdlePrompt(config.idle?.promptTemplate ?? "", repo, task, {
      openPrCount,
      openPrContext,
      openPrContextAvailable
    });

  const logDir = path.resolve(config.workdirRoot, "agent-runner", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${repo.repo}-idle-${Date.now()}.log`);
  if (resolveLogMaintenance(config).writeLatestPointers) {
    writeLatestPointer(logDir, "idle", logPath);
  }

  const appendLog = (value: string): void => {
    fs.appendFileSync(logPath, value);
  };

  const notifyEnv = await buildGitHubNotifyChildEnv(config.workdirRoot);

  const envOverrides: NodeJS.ProcessEnv = {
    AGENT_RUNNER_ENGINE: engine,
    AGENT_RUNNER_REPO: `${repo.owner}/${repo.repo}`,
    AGENT_RUNNER_REPO_PATH: repoPath,
    AGENT_RUNNER_TASK: task,
    AGENT_RUNNER_OPEN_PR_COUNT: formatIdleOpenPrCount(openPrCount),
    AGENT_RUNNER_PROMPT: prompt,
    AGENT_RUNNER_WORKROOT: workRoot,
    ...notifyEnv
  };
  const invocation =
    engine === "copilot"
      ? buildCopilotInvocation(config, repoPath, prompt, envOverrides)
      : engine === "amazon-q"
      ? buildAmazonQInvocation(config, repoPath, prompt, envOverrides)
      : engine === "gemini-pro" || engine === "gemini-flash"
      ? buildGeminiInvocation(config, repoPath, prompt, engine, envOverrides)
      : buildCodexInvocation(config, repoPath, prompt, { envOverrides, addDir: workRoot });
  const activityPath = resolveActivityStatePath(config.workdirRoot);
  const startedAt = new Date().toISOString();
  const activityId = `idle:${engine}:${repo.owner}/${repo.repo}:${Date.now()}`;
  let activityRecorded = false;
  let exitCode: number;
  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, invocation.options);
      if (invocation.stdin && child.stdin) {
        try {
          child.stdin.write(invocation.stdin);
          child.stdin.end();
        } catch {
          // best-effort: proceed without stdin if writing fails
        }
      }
      if (typeof child.pid === "number") {
        recordActivity(activityPath, {
          id: activityId,
          kind: "idle",
          engine,
          repo,
          startedAt,
          pid: child.pid,
          logPath,
          task
        });
        activityRecorded = true;
      }
      child.stdout.on("data", (chunk) => {
        const normalized = normalizeLogChunk(chunk);
        appendLog(normalized);
        process.stdout.write(normalized);
      });
      child.stderr.on("data", (chunk) => {
        const normalized = normalizeLogChunk(chunk);
        appendLog(normalized);
        process.stderr.write(normalized);
      });
      child.on("error", (error) => reject(error));
      child.on("close", (code) => resolve(code ?? 1));
    });
  } catch (error) {
    if (activityRecorded) {
      removeActivity(activityPath, activityId);
    }
    throw error;
  }

  const summary = extractFinalResponseFromLog(logPath);
  if (engine === "amazon-q") {
    const shouldRecordUsage = exitCode === 0 || summary !== null;
    if (shouldRecordUsage) {
      try {
        recordAmazonQUsage(resolveAmazonQUsageStatePath(config.workdirRoot), 1, new Date());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[WARN] Failed to record Amazon Q usage: ${message}\n`);
      }
    }
  }
  const reportPath = resolveIdleReportPath(config.workdirRoot, repo);
  writeIdleReport(reportPath, repo, task, engine, exitCode === 0, summary, logPath);
  if (activityRecorded) {
    removeActivity(activityPath, activityId);
  }

  return {
    success: exitCode === 0,
    logPath,
    repo,
    task,
    engine,
    summary,
    reportPath,
    headBranch: newBranch
  };
  } finally {
    if (created) {
      await removeWorktree({ workdirRoot: config.workdirRoot, repo, cachePath, worktreePath: repoPath });
    }
    try {
      await fs.promises.rm(workRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

export function extractFinalResponseFromLog(logPath: string): string | null {
  if (!fs.existsSync(logPath)) {
    return null;
  }

  const raw = stripAnsi(fs.readFileSync(logPath, "utf8"));
  const speakerPattern = /(?:^|\r?\n)codex\r?\n/g;
  let lastStart = -1;
  let match: RegExpExecArray | null;
  while ((match = speakerPattern.exec(raw)) !== null) {
    lastStart = match.index + match[0].length;
  }
  if (lastStart === -1) {
    return null;
  }

  const afterSpeaker = raw.slice(lastStart);
  const tokenStatsIndex = afterSpeaker.search(/\r?\ntokens used\b/i);
  const body = tokenStatsIndex >= 0 ? afterSpeaker.slice(0, tokenStatsIndex) : afterSpeaker;
  const trimmed = body.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseAgentRunResult(finalResponse: string | null): {
  status: AgentRunStatus | null;
  response: string | null;
} {
  const trimmed = finalResponse?.trim() ?? "";
  if (!trimmed) {
    return { status: null, response: null };
  }

  const lines = trimmed.split(/\r?\n/);
  const statusCandidates = lines
    .map((line, index) => ({ line: line.trim(), index }))
    .filter((entry) => entry.line.length > 0 && entry.line.toUpperCase().startsWith(AGENT_RUNNER_STATUS_PREFIX));

  if (statusCandidates.length === 0) {
    return { status: null, response: trimmed };
  }

  const statusLine = statusCandidates.at(-1);
  if (!statusLine) {
    return { status: null, response: null };
  }

  const rawStatus = statusLine.line.slice(AGENT_RUNNER_STATUS_PREFIX.length).trim().toLowerCase();
  const status: AgentRunStatus | null =
    rawStatus === "done" ? "done" : rawStatus === "needs_user_reply" ? "needs_user_reply" : null;
  const responseBody = lines
    .filter((_, index) => index !== statusLine.index)
    .join("\n")
    .trim();

  return {
    status,
    response: responseBody.length > 0 ? responseBody : null
  };
}
