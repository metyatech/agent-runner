# agent-runner

Local agent runner that queues and executes GitHub Agent requests using Codex.

## Overview

- Watches GitHub Issues labeled `agent:request`.
- Queues requests, runs up to the configured concurrency, and posts results back to GitHub.
- Designed for a self-hosted Windows machine running Codex CLI.

## Setup

1. Install dependencies.

```bash
npm install
```

2. Ensure Codex CLI is available in PATH.

```bash
codex --version
```

3. Create a GitHub token with repo access and set it as an environment variable.

```bash
setx AGENT_GITHUB_TOKEN "<token>"
```

4. Update `agent-runner.config.json` with your workspace root and concurrency.

## Development commands

- `npm run lint`
- `npm run test`
- `npm run build`
- `npm run dev -- run --once --yes`

## E2E (GitHub API)

The E2E suite runs against a real GitHub repository.
Recommended: authenticate once with GitHub CLI and use the helper script:

```powershell
.\scripts\run-e2e.ps1 -Owner "<owner>" -Repo "<repo>"
```

You can also set persistent environment variables (PowerShell):

```powershell
setx E2E_GH_OWNER "<owner>"
setx E2E_GH_REPO "<repo>"
setx E2E_WORKDIR_ROOT "<path>"
```

Then run:

```bash
npm run test:e2e
```

Environment variables used by the E2E suite:

- `E2E_GH_OWNER`: GitHub owner/org
- `E2E_GH_REPO`: Repository name
- `E2E_WORKDIR_ROOT`: Workdir root for temporary clones/logs (optional)
- `AGENT_GITHUB_TOKEN` (or `GITHUB_TOKEN`/`GH_TOKEN`): Token with repo access

## Configuration

Config file: `agent-runner.config.json`

- `owner`: GitHub user or org
- `repos`: `"all"` or explicit list
- `workdirRoot`: Local workspace root containing repos
- `pollIntervalSeconds`: Polling interval
- `concurrency`: Max concurrent requests
- `labels`: Workflow labels
- `labels.needsUser`: Label for requests awaiting user reply after a failure
- `codex`: Codex CLI command and prompt template
- `codex.args`: Default config runs with full access (`--dangerously-bypass-approvals-and-sandbox`); change this if you want approvals or sandboxing.
- `codex.promptTemplate`: The runner expects a summary block in the output to post to the issue thread.

## Running

One-shot execution:

```bash
node dist/cli.js run --once --yes
```

Looping daemon:

```bash
node dist/cli.js run --yes
```

## Label sync

Ensure required agent labels exist in all repositories:

```bash
node dist/cli.js labels sync --yes
```

## Failure replies

When a run fails, the runner adds `agent:needs-user` and comments with a reply request.
Reply on the issue with any fixes or details; the runner will detect your response,
remove the failure labels, and re-queue the request automatically.

If a request is labeled `agent:running` but the tracked process exits,
the runner marks it as failed + needs-user and asks for a reply.

## Windows Task Scheduler

Register a scheduled task that runs every minute:

```powershell
.\scripts\register-task.ps1 -RepoPath "C:\\path\\to\\agent-runner" -ConfigPath "C:\\path\\to\\agent-runner\\agent-runner.config.json"
```

Unregister the task:

```powershell
.\scripts\unregister-task.ps1
```

Task run logs are written to `logs/task-run-*.log`.

Issue logs (e.g. `*-issue-*.log`) are appended as output is produced.

### Summary block

At the end of each run, include a summary block so the runner can post it to GitHub:

```
AGENT_RUNNER_SUMMARY_START
- Change 1
- Change 2
Tests: npm run test
Commits: abc1234
AGENT_RUNNER_SUMMARY_END
```

## Label sync scheduling

Register a daily label sync task:

```powershell
.\scripts\register-label-sync-task.ps1 -RepoPath "C:\\path\\to\\agent-runner" -ConfigPath "C:\\path\\to\\agent-runner\\agent-runner.config.json"
```

Unregister the label sync task:

```powershell
.\scripts\unregister-label-sync-task.ps1
```

## Status check

Quick status summary (tasks + recent logs):

```powershell
.\scripts\status.ps1
```

## Release / deploy

Not applicable. This repository is intended to run locally.
