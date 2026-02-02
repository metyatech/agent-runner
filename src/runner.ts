import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AgentRunnerConfig } from "./config.js";
import type { GitHubClient, IssueComment, IssueInfo, RepoInfo } from "./github.js";
import { resolveCodexCommand } from "./codex-command.js";
import {
  chooseIdleTask,
  loadIdleHistory,
  recordIdleRun,
  resolveIdleHistoryPath,
  saveIdleHistory,
  selectIdleRepos
} from "./idle.js";
import { parseIssueBody } from "./issue.js";
import { recordRunningIssue, removeRunningIssue, resolveRunnerStatePath } from "./runner-state.js";
import {
  recordActivity,
  removeActivity,
  resolveActivityStatePath
} from "./activity-state.js";
import { AGENT_RUNNER_MARKER, findLastMarkerComment, NEEDS_USER_MARKER } from "./notifications.js";

export type RunResult = {
  success: boolean;
  logPath: string;
  repos: RepoInfo[];
  summary: string | null;
};

export type IdleTaskResult = {
  success: boolean;
  logPath: string;
  repo: RepoInfo;
  task: string;
  summary: string | null;
  reportPath: string;
};

export type CodexInvocation = {
  command: string;
  args: string[];
  options: {
    cwd: string;
    shell: boolean;
    env: NodeJS.ProcessEnv;
  };
};

function resolveRepoPath(root: string, repo: RepoInfo): string {
  return path.join(root, repo.repo);
}

async function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const check = spawn(command, ["--version"], { shell: true });
    check.on("error", () => resolve(false));
    check.on("close", (code) => resolve(code === 0));
  });
}

async function cloneRepo(root: string, repo: RepoInfo): Promise<void> {
  const repoPath = resolveRepoPath(root, repo);
  if (fs.existsSync(repoPath)) {
    return;
  }

  fs.mkdirSync(root, { recursive: true });
  const useGh = await commandExists("gh");
  const cloneArgs = useGh
    ? ["repo", "clone", `${repo.owner}/${repo.repo}`, repoPath, "--", "--recursive"]
    : ["clone", "--recursive", `https://github.com/${repo.owner}/${repo.repo}.git`, repoPath];
  const command = useGh ? "gh" : "git";

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, cloneArgs, { stdio: "inherit", shell: true });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Clone failed (${command} ${cloneArgs.join(" ")})`));
      }
    });
  });
}

function resolveTargetRepos(issue: IssueInfo, parsed: ReturnType<typeof parseIssueBody>, owner: string): RepoInfo[] {
  const base = issue.repo;
  const additional = parsed.repoList.map((repo) => ({ owner, repo }));
  const combined = [base, ...additional];
  const unique = new Map<string, RepoInfo>();
  for (const repo of combined) {
    unique.set(`${repo.owner}/${repo.repo}`, repo);
  }
  return Array.from(unique.values());
}

const MAX_ISSUE_COMMENT_CHARS = 4_000;
const MAX_ISSUE_COMMENTS_BLOCK_CHARS = 12_000;
const MAX_ISSUE_COMMENTS_COUNT = 8;

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

export function buildIssueTaskText(issue: IssueInfo, comments: IssueComment[]): string {
  const issueBody = issue.body ?? "";
  const base = `Issue: ${issue.title}\nURL: ${issue.url}\n\n${issueBody}`.trim();
  const commentBlock = formatCommentsForPrompt(comments);

  if (!commentBlock) {
    return base;
  }

  return `${base}\n\nRecent user replies (issue comments):\n${commentBlock}`;
}

function renderPrompt(template: string, repos: RepoInfo[], issue: IssueInfo, comments: IssueComment[]): string {
  const repoList = repos.map((repo) => `${repo.owner}/${repo.repo}`).join(", ");
  const taskText = buildIssueTaskText(issue, comments);
  return template.replace("{{repos}}", repoList).replace("{{task}}", taskText);
}

function renderIdlePrompt(template: string, repo: RepoInfo, task: string): string {
  const repoSlug = `${repo.owner}/${repo.repo}`;
  return template
    .split("{{repo}}")
    .join(repoSlug)
    .split("{{owner}}")
    .join(repo.owner)
    .split("{{repoName}}")
    .join(repo.repo)
    .split("{{task}}")
    .join(task);
}

export function buildCodexInvocation(
  config: AgentRunnerConfig,
  primaryPath: string,
  prompt: string
): CodexInvocation {
  const resolved = resolveCodexCommand(config.codex.command, process.env.PATH);
  const args = [
    ...resolved.prefixArgs,
    ...config.codex.args,
    "-C",
    primaryPath,
    "--add-dir",
    config.workdirRoot,
    prompt
  ];

  return {
    command: resolved.command,
    args,
    options: {
      cwd: primaryPath,
      shell: false,
      env: process.env
    }
  };
}

export async function runIssue(
  client: GitHubClient,
  config: AgentRunnerConfig,
  issue: IssueInfo
): Promise<RunResult> {
  const parsed = parseIssueBody(issue.body);
  const repos = resolveTargetRepos(issue, parsed, config.owner);

  for (const repo of repos) {
    await cloneRepo(config.workdirRoot, repo);
  }

  const comments = await client.listIssueComments(issue);

  const primaryRepo = repos[0];
  const primaryPath = resolveRepoPath(config.workdirRoot, primaryRepo);
  const prompt = renderPrompt(config.codex.promptTemplate, repos, issue, comments);

  const logDir = path.resolve(config.workdirRoot, "agent-runner", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(
    logDir,
    `${issue.repo.repo}-issue-${issue.number}-${Date.now()}.log`
  );

  const appendLog = (chunk: Buffer | string): void => {
    fs.appendFileSync(logPath, chunk);
  };
  const statePath = resolveRunnerStatePath(config.workdirRoot);
  const activityPath = resolveActivityStatePath(config.workdirRoot);

  const invocation = buildCodexInvocation(config, primaryPath, prompt);

  let recordWritten = false;
  let activityRecorded = false;
  let activityId: string | null = null;
  let exitCode = 1;

  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, invocation.options);

      if (typeof child.pid === "number") {
        const startedAt = new Date().toISOString();
        recordRunningIssue(statePath, {
          issueId: issue.id,
          issueNumber: issue.number,
          repo: issue.repo,
          startedAt,
          pid: child.pid,
          logPath
        });
        recordWritten = true;
        activityId = `issue:${issue.id}`;
        recordActivity(activityPath, {
          id: activityId,
          kind: "issue",
          repo: issue.repo,
          startedAt,
          pid: child.pid,
          logPath,
          issueId: issue.id,
          issueNumber: issue.number
        });
        activityRecorded = true;
      }

      child.stdout.on("data", (chunk) => {
        appendLog(chunk);
        process.stdout.write(chunk);
      });

      child.stderr.on("data", (chunk) => {
        appendLog(chunk);
        process.stderr.write(chunk);
      });

      child.on("error", (error) => reject(error));
      child.on("close", (code) => resolve(code ?? 1));
    });
  } finally {
    if (recordWritten) {
      removeRunningIssue(statePath, issue.id);
    }
    if (activityRecorded && activityId) {
      removeActivity(activityPath, activityId);
    }
  }

  const summary = extractSummaryFromLog(logPath);

  return {
    success: exitCode === 0,
    logPath,
    repos,
    summary
  };
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
  success: boolean,
  summary: string | null,
  logPath: string
): void {
  const lines = [
    `# Idle task report`,
    ``,
    `- Repo: ${repo.owner}/${repo.repo}`,
    `- Task: ${task}`,
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
  repos: RepoInfo[]
): Promise<Array<{ repo: RepoInfo; task: string }>> {
  if (!config.idle?.enabled) {
    return [];
  }

  const historyPath = resolveIdleHistoryPath(config.workdirRoot);
  const history = loadIdleHistory(historyPath);
  const targets = selectIdleRepos(
    repos,
    history,
    config.idle.maxRunsPerCycle,
    config.idle.cooldownMinutes
  );

  if (targets.length === 0) {
    return [];
  }

  const planned: Array<{ repo: RepoInfo; task: string }> = [];
  const startedAt = new Date().toISOString();

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
  task: string
): Promise<IdleTaskResult> {
  await cloneRepo(config.workdirRoot, repo);

  const repoPath = resolveRepoPath(config.workdirRoot, repo);
  const prompt = renderIdlePrompt(config.idle?.promptTemplate ?? "", repo, task);

  const logDir = path.resolve(config.workdirRoot, "agent-runner", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${repo.repo}-idle-${Date.now()}.log`);

  const appendLog = (chunk: Buffer | string): void => {
    fs.appendFileSync(logPath, chunk);
  };

  const invocation = buildCodexInvocation(config, repoPath, prompt);
  const activityPath = resolveActivityStatePath(config.workdirRoot);
  const startedAt = new Date().toISOString();
  const activityId = `idle:${repo.owner}/${repo.repo}:${Date.now()}`;
  let activityRecorded = false;
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, invocation.options);
    if (typeof child.pid === "number") {
      recordActivity(activityPath, {
        id: activityId,
        kind: "idle",
        repo,
        startedAt,
        pid: child.pid,
        logPath,
        task
      });
      activityRecorded = true;
    }
    child.stdout.on("data", (chunk) => {
      appendLog(chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      appendLog(chunk);
      process.stderr.write(chunk);
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => resolve(code ?? 1));
  }).finally(() => {
    if (activityRecorded) {
      removeActivity(activityPath, activityId);
    }
  });

  const summary = extractSummaryFromLog(logPath);
  const reportPath = resolveIdleReportPath(config.workdirRoot, repo);
  writeIdleReport(reportPath, repo, task, exitCode === 0, summary, logPath);

  return {
    success: exitCode === 0,
    logPath,
    repo,
    task,
    summary,
    reportPath
  };
}

const summaryStart = "AGENT_RUNNER_SUMMARY_START";
const summaryEnd = "AGENT_RUNNER_SUMMARY_END";

export function extractSummaryFromLog(logPath: string): string | null {
  if (!fs.existsSync(logPath)) {
    return null;
  }

  const raw = fs.readFileSync(logPath, "utf8");
  const startIndex = raw.lastIndexOf(summaryStart);
  if (startIndex === -1) {
    return null;
  }
  const endIndex = raw.indexOf(summaryEnd, startIndex);
  if (endIndex === -1) {
    return null;
  }

  const summary = raw
    .slice(startIndex + summaryStart.length, endIndex)
    .trim();

  return summary.length > 0 ? summary : null;
}
