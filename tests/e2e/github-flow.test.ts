import { Octokit } from "@octokit/rest";
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NEEDS_USER_MARKER } from "../../src/notifications.js";

const cliPath = path.resolve("src", "cli.ts");
const dummyCodexPath = path.resolve("tests", "e2e", "fixtures", "dummy-codex.js");
const titlePrefix = "E2E agent-runner";

const token =
  process.env.AGENT_GITHUB_TOKEN ||
  process.env.GITHUB_TOKEN ||
  process.env.GH_TOKEN;
const owner = process.env.E2E_GH_OWNER;
const repo = process.env.E2E_GH_REPO;
const workdirRoot = process.env.E2E_WORKDIR_ROOT ?? path.resolve("..");

function requireEnv(): { token: string; owner: string; repo: string } {
  if (!token || !owner || !repo) {
    throw new Error(
      "Missing required env vars: AGENT_GITHUB_TOKEN/GITHUB_TOKEN/GH_TOKEN, E2E_GH_OWNER, E2E_GH_REPO."
    );
  }
  return { token, owner, repo };
}

function runCli(args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv }
  });
}

async function fetchLabelNames(octokit: Octokit, issueNumber: number): Promise<string[]> {
  const response = await octokit.issues.get({
    owner: requireEnv().owner,
    repo: requireEnv().repo,
    issue_number: issueNumber
  });
  return response.data.labels.map((label) =>
    typeof label === "string" ? label : label.name ?? ""
  );
}

async function waitForLabels(
  octokit: Octokit,
  issueNumber: number,
  predicate: (labels: string[]) => boolean,
  timeoutMs = 10_000
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let last: string[] = [];
  while (Date.now() < deadline) {
    last = await fetchLabelNames(octokit, issueNumber);
    if (predicate(last)) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return last;
}

async function runUntilLabels(
  octokit: Octokit,
  issueNumber: number,
  predicate: (labels: string[]) => boolean,
  run: () => void,
  attempts: number
): Promise<string[]> {
  let last: string[] = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    run();
    last = await waitForLabels(octokit, issueNumber, predicate, 60_000);
    if (predicate(last)) {
      return last;
    }
  }
  return last;
}

async function closeOpenE2EIssues(
  octokit: Octokit,
  labels: string[],
  prefix: string
): Promise<void> {
  const env = requireEnv();
  const seen = new Set<number>();

  for (const label of labels) {
    const response = await octokit.issues.listForRepo({
      owner: env.owner,
      repo: env.repo,
      labels: label,
      per_page: 100,
      state: "open"
    });
    for (const issue of response.data) {
      if (issue.pull_request || !issue.title.startsWith(prefix)) {
        continue;
      }
      if (seen.has(issue.number)) {
        continue;
      }
      await octokit.issues.update({
        owner: env.owner,
        repo: env.repo,
        issue_number: issue.number,
        state: "closed"
      });
      seen.add(issue.number);
    }
  }
}

async function hasSufficientRateLimit(
  octokit: Octokit,
  minimumRemaining = 20
): Promise<boolean> {
  try {
    const response = await octokit.rateLimit.get();
    return response.data.resources.core.remaining >= minimumRemaining;
  } catch (error) {
    if (typeof error === "object" && error && "status" in error) {
      const status = (error as { status?: number }).status;
      if (status === 403) {
        return false;
      }
    }
    throw error;
  }
}

async function waitForIssueLabel(
  octokit: Octokit,
  issueNumber: number,
  label: string,
  timeoutMs = 30_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await octokit.issues.listForRepo({
      owner: requireEnv().owner,
      repo: requireEnv().repo,
      labels: label,
      per_page: 100,
      state: "open"
    });
    if (response.data.some((issue) => issue.number === issueNumber)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Issue ${issueNumber} not visible under label ${label}.`);
}

describe("github flow", () => {
  it(
    "marks needs-user on failure and re-queues after reply",
    async () => {
      const env = requireEnv();
      const octokit = new Octokit({ auth: env.token });

      const hasRate = await hasSufficientRateLimit(octokit);
      if (!hasRate) {
        console.warn("Skipping E2E GitHub flow test due to API rate limit.");
        return;
      }

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-e2e-"));
      const configPath = path.join(tempDir, "agent-runner.e2e.json");

      const config = {
        owner: env.owner,
        repos: [env.repo],
        workdirRoot,
        pollIntervalSeconds: 60,
        concurrency: 1,
        labels: {
          queued: "agent:e2e-queued",
          running: "agent:e2e-running",
          done: "agent:e2e-done",
          failed: "agent:e2e-failed",
          needsUserReply: "agent:e2e-needs-user"
        },
        codex: {
          command: "node",
          args: [dummyCodexPath],
          promptTemplate: "Template {{repos}} {{task}}"
        }
      };

      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");

      const labelResult = runCli(["labels", "sync", "--yes", "--config", configPath]);
      expect(labelResult.status).toBe(0);

      await closeOpenE2EIssues(octokit, Object.values(config.labels), titlePrefix);

      const issue = await octokit.issues.create({
        owner: env.owner,
        repo: env.repo,
        title: `${titlePrefix} ${Date.now()}`,
        body: `### Goal\nValidate needs-user flow\n\n### Scope\nThis repository only\n\n### Repository list (if applicable)\n_No response_\n\n### Constraints\nNone\n\n### Autonomy\n- [x] Yes, proceed autonomously\n\n### Acceptance criteria\nNone`,
        labels: []
      });

      const issueNumber = issue.data.number;

      try {
        await octokit.issues.createComment({
          owner: env.owner,
          repo: env.repo,
          issue_number: issueNumber,
          body: "/agent run"
        });

        const failedLabels = await runUntilLabels(
          octokit,
          issueNumber,
          (labels) =>
            labels.includes(config.labels.needsUserReply) && labels.includes(config.labels.failed),
          () => {
            const failRun = runCli(
              ["run", "--once", "--yes", "--config", configPath],
              { E2E_CODEX_EXIT: "1" }
            );
            expect(failRun.status).toBe(0);
          },
          3
        );
        expect(failedLabels).toContain(config.labels.needsUserReply);
        expect(failedLabels).toContain(config.labels.failed);

        const comments = await octokit.issues.listComments({
          owner: env.owner,
          repo: env.repo,
          issue_number: issueNumber,
          per_page: 100
        });
        expect(comments.data.some((comment) => comment.body?.includes(NEEDS_USER_MARKER))).toBe(
          true
        );

        await octokit.issues.createComment({
          owner: env.owner,
          repo: env.repo,
          issue_number: issueNumber,
          body: "Acknowledged. Please retry."
        });

        const doneLabels = await runUntilLabels(
          octokit,
          issueNumber,
          (labels) =>
            labels.includes(config.labels.done) && !labels.includes(config.labels.needsUserReply),
          () => {
            const successRun = runCli(
              ["run", "--once", "--yes", "--config", configPath],
              { E2E_CODEX_EXIT: "0" }
            );
            expect(successRun.status).toBe(0);
          },
          3
        );
        expect(doneLabels).toContain(config.labels.done);
        expect(doneLabels).not.toContain(config.labels.needsUserReply);
      } finally {
        await octokit.issues.update({
          owner: env.owner,
          repo: env.repo,
          issue_number: issueNumber,
          state: "closed"
        });

        for (const label of Object.values(config.labels)) {
          try {
            await octokit.issues.deleteLabel({
              owner: env.owner,
              repo: env.repo,
              name: label
            });
          } catch (error) {
            if (
              typeof error === "object" &&
              error &&
              "status" in error &&
              (error as { status?: number }).status === 404
            ) {
              continue;
            }
            throw error;
          }
        }
      }
    },
    { timeout: 240_000 }
  );
});

