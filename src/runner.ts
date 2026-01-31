import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AgentRunnerConfig } from "./config.js";
import type { GitHubClient, IssueComment, IssueInfo, RepoInfo } from "./github.js";
import { parseIssueBody } from "./issue.js";
import { recordRunningIssue, removeRunningIssue, resolveRunnerStatePath } from "./runner-state.js";
import { AGENT_RUNNER_MARKER, findLastMarkerComment, NEEDS_USER_MARKER } from "./notifications.js";

export type RunResult = {
  success: boolean;
  logPath: string;
  repos: RepoInfo[];
  summary: string | null;
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

function resolveWindowsCommand(command: string, pathValue: string | undefined): string {
  if (process.platform !== "win32") {
    return command;
  }

  if (path.extname(command) || command.includes("\\") || command.includes("/")) {
    return command;
  }

  const pathEntries = (pathValue ?? "").split(";");
  const fallbackEntries: string[] = [];
  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  const userProfile = process.env.USERPROFILE;
  const npmPrefix = process.env.npm_config_prefix ?? process.env.NPM_CONFIG_PREFIX;

  if (npmPrefix) {
    fallbackEntries.push(npmPrefix);
  }

  if (appData) {
    fallbackEntries.push(path.join(appData, "npm"));
  }

  if (localAppData) {
    fallbackEntries.push(path.join(localAppData, "npm"));
  }

  if (userProfile) {
    fallbackEntries.push(path.join(userProfile, "AppData", "Roaming", "npm"));
  }

  const searchEntries = Array.from(new Set([...pathEntries, ...fallbackEntries]));
  const cmdName = `${command}.cmd`;
  const exeName = `${command}.exe`;

  for (const entry of searchEntries) {
    if (!entry) {
      continue;
    }
    const cmdPath = path.join(entry, cmdName);
    if (fs.existsSync(cmdPath)) {
      return cmdPath;
    }
    const exePath = path.join(entry, exeName);
    if (fs.existsSync(exePath)) {
      return exePath;
    }
  }

  return command;
}

function resolveCodexCommand(
  command: string,
  pathValue: string | undefined
): { command: string; prefixArgs: string[] } {
  const resolved = resolveWindowsCommand(command, pathValue);

  if (process.platform === "win32") {
    const base = path.basename(resolved).toLowerCase();
    if (base === "codex.cmd" || base === "codex.ps1") {
      const codexJs = path.join(
        path.dirname(resolved),
        "node_modules",
        "@openai",
        "codex",
        "bin",
        "codex.js"
      );
      if (fs.existsSync(codexJs)) {
        return { command: process.execPath, prefixArgs: [codexJs] };
      }
    }
  }

  return { command: resolved, prefixArgs: [] };
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

  const invocation = buildCodexInvocation(config, primaryPath, prompt);

  let recordWritten = false;
  let exitCode = 1;

  try {
    exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, invocation.options);

      if (typeof child.pid === "number") {
        recordRunningIssue(statePath, {
          issueId: issue.id,
          issueNumber: issue.number,
          repo: issue.repo,
          startedAt: new Date().toISOString(),
          pid: child.pid,
          logPath
        });
        recordWritten = true;
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
  }

  const summary = extractSummaryFromLog(logPath);

  return {
    success: exitCode === 0,
    logPath,
    repos,
    summary
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
