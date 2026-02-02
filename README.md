# agent-runner

Local agent runner that queues and executes GitHub Agent requests using Codex.

## Overview

- Watches GitHub Issues labeled `agent:request`.
- Queues requests, runs up to the configured concurrency, and posts results back to GitHub.
- Runs idle maintenance tasks when no queued issues are available.
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
- `npm run test` (unit tests + local CLI checks; does not call GitHub API)
- `npm run build`
- `npm run dev -- run --once --yes`

## E2E (GitHub API)

The GitHub-flow E2E suite runs against a real GitHub repository and requires environment variables.
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
- `repos`: If `"all"`, the runner caches the repository list and refreshes periodically to avoid GitHub rate limits. When rate-limited and no cache is available, it will fall back to local workspace repositories (directories with a `.git` folder).
- `labels`: Workflow labels
- `labels.needsUser`: Label for requests awaiting user reply after a failure
- `codex`: Codex CLI command and prompt template
- `codex.args`: Default config runs with full access (`--dangerously-bypass-approvals-and-sandbox`); change this if you want approvals or sandboxing.
- `codex.promptTemplate`: The runner expects a summary block in the output to post to the issue thread.
  - The default template allows GitHub operations (issues/PRs/commits/pushes) but forbids sending/posting outside GitHub unless the user explicitly approves in the issue.
- `idle`: Optional idle task settings (runs when no queued issues exist)
  - `idle.enabled`: Turn idle tasks on/off
  - `idle.maxRunsPerCycle`: Max idle tasks per cycle
  - `idle.cooldownMinutes`: Per-repo cooldown between idle runs
  - `idle.tasks`: List of task prompts to rotate through
  - `idle.promptTemplate`: Prompt template for idle runs; supports `{{repo}}` and `{{task}}`
  - `idle.usageGate`: Optional Codex usage guard (reads `/status` output)
  - `idle.usageGate.enabled`: Turn usage gating on/off
  - `idle.usageGate.command`: Command used to launch Codex for `/status`
  - `idle.usageGate.args`: Arguments passed to the command
  - `idle.usageGate.timeoutSeconds`: Timeout for `/status` collection
    - `idle.usageGate.minRemainingPercent`: Minimum remaining percent for the 5h window
    - `idle.usageGate.weeklySchedule`: Weekly ramp for remaining percent
      - `idle.usageGate.weeklySchedule.startMinutes`: When to begin idle runs (minutes before weekly reset)
      - `idle.usageGate.weeklySchedule.minRemainingPercentAtStart`: Required weekly percent left at startMinutes
      - `idle.usageGate.weeklySchedule.minRemainingPercentAtEnd`: Required weekly percent left at reset time

## Running

One-shot execution:

```bash
node dist/cli.js run --once --yes
```

Looping daemon:

```bash
node dist/cli.js run --yes
```

## Idle runs (issue-less)

When no queued issues exist, the runner can execute idle tasks defined in the config.
Each idle run writes a report under `reports/` and streams the Codex output to `logs/`.
When changes are made, the idle prompt is expected to open a PR, mention @metyatech
in a summary comment, and merge the PR, then sync the main branch locally.
If `idle.usageGate.enabled` is true, idle runs only execute when the weekly reset
window is near and unused weekly capacity remains. The weekly threshold ramps
down as the reset approaches. The 5h window is used only to confirm that some
short-term capacity remains (5h reset timing is ignored).

Example config snippet:

```json
{
  "idle": {
    "enabled": true,
    "maxRunsPerCycle": 1,
    "cooldownMinutes": 240,
    "tasks": [
      "Bring the repo into compliance with AGENTS.md and project docs/standards. Identify the highest-impact gap, fix it, and update docs/tests as needed. If nothing meaningful is needed, exit."
    ],
    "promptTemplate": "You are running an autonomous idle task. Target repo: {{repo}}. Task: {{task}}",
    "usageGate": {
      "enabled": true,
      "command": "codex",
      "args": [],
      "timeoutSeconds": 20,
      "minRemainingPercent": {
        "fiveHour": 50
      },
      "weeklySchedule": {
        "startMinutes": 1440,
        "minRemainingPercentAtStart": 100,
        "minRemainingPercentAtEnd": 0
      }
    }
  }
}
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

The runner also includes recent user replies from the issue comments in the next prompt
(limited and truncated to avoid prompt bloat), so you typically do not need to edit the
original issue body when providing additional details.

If a request is labeled `agent:running` but the tracked process exits,
the runner marks it as failed + needs-user and asks for a reply.

## Windows Task Scheduler

Register a scheduled task that runs every minute:

```powershell
.\scripts\register-task.ps1 -RepoPath "." -ConfigPath ".\\agent-runner.config.json"
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
.\scripts\register-label-sync-task.ps1 -RepoPath "." -ConfigPath ".\\agent-runner.config.json"
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

CLI snapshot (text):

```bash
node dist/cli.js status --config agent-runner.config.json
```

CLI snapshot (JSON):

```bash
node dist/cli.js status --config agent-runner.config.json --json
```

Pause/resume runner (graceful stop after current work):

```bash
node dist/cli.js stop --config agent-runner.config.json
node dist/cli.js resume --config agent-runner.config.json
```

## Status UI (GUI)

Serve a local status dashboard that highlights active tasks and recent logs:

```bash
node dist/cli.js ui --config agent-runner.config.json --port 4311
```

Then open:

```text
http://127.0.0.1:4311/
```

Paths shown in the status UI are clickable and will open the file in Explorer.

## System tray

Run a background tray helper to open the status UI and pause/resume the runner:

```powershell
.\scripts\tray.ps1 -RepoPath "." -ConfigPath ".\\agent-runner.config.json"
```

## Release / deploy

Not applicable. This repository is intended to run locally.

