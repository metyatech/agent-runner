import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AgentRunnerConfig } from "./config.js";
import type { GitHubClient, IssueInfo, RepoInfo } from "./github.js";
import { parseIssueBody } from "./issue.js";

export type RunResult = {
  success: boolean;
  logPath: string;
  repos: RepoInfo[];
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

function renderPrompt(template: string, repos: RepoInfo[], issue: IssueInfo): string {
  const repoList = repos.map((repo) => `${repo.owner}/${repo.repo}`).join(", ");
  const issueBody = issue.body ?? "";
  return template
    .replace("{{repos}}", repoList)
    .replace("{{task}}", `Issue: ${issue.title}\nURL: ${issue.url}\n\n${issueBody}`);
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

  const primaryRepo = repos[0];
  const primaryPath = resolveRepoPath(config.workdirRoot, primaryRepo);
  const prompt = renderPrompt(config.codex.promptTemplate, repos, issue);

  const logDir = path.resolve(config.workdirRoot, "agent-runner", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(
    logDir,
    `${issue.repo.repo}-issue-${issue.number}-${Date.now()}.log`
  );

  const logStream = fs.createWriteStream(logPath, { flags: "a" });

  const args = [
    ...config.codex.args,
    "-C",
    primaryPath,
    "--add-dir",
    config.workdirRoot,
    prompt
  ];

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(config.codex.command, args, {
      cwd: primaryPath,
      shell: true,
      env: process.env
    });

    child.stdout.on("data", (chunk) => {
      logStream.write(chunk);
      process.stdout.write(chunk);
    });

    child.stderr.on("data", (chunk) => {
      logStream.write(chunk);
      process.stderr.write(chunk);
    });

    child.on("error", (error) => reject(error));
    child.on("close", (code) => resolve(code ?? 1));
  });

  logStream.end();

  return {
    success: exitCode === 0,
    logPath,
    repos
  };
}
