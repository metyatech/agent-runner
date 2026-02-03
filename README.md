# agent-runner

Local agent runner that queues and executes GitHub Agent requests using Codex.

## Overview

- Watches GitHub Issues labeled `agent:request`.
- Queues requests, runs up to the configured concurrency, and posts results back to GitHub.
- Runs idle maintenance tasks when no queued issues are available.
- Can optionally run idle tasks through Copilot when monthly quota allows.
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

3. If you want Copilot idle runs, ensure the configured Copilot command is available in PATH.

4. Create a GitHub token with repo access and set it as an environment variable.

```bash
setx AGENT_GITHUB_TOKEN "<token>"
```

5. If using webhooks, set the GitHub App webhook secret.

```bash
setx AGENT_GITHUB_WEBHOOK_SECRET "<secret>"
```

6. If using Cloudflare Tunnel, set the tunnel token for auto-start.

```bash
setx CLOUDFLARED_TUNNEL_TOKEN "<token>"
```

If the environment variable is not available (for example, before a logoff/logon),
you can also save the token to `state/cloudflared-token.txt` (ignored by git).

7. Update `agent-runner.config.json` with your workspace root and concurrency.

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
- `webhooks`: Optional GitHub webhook listener configuration (recommended to avoid repo-wide polling)
  - `webhooks.enabled`: Turn webhook mode on/off
  - `webhooks.host`: Host to bind for the local webhook server
  - `webhooks.port`: Port to bind for the local webhook server
  - `webhooks.path`: URL path for webhook requests (e.g. `/webhooks/github`)
- `webhooks.secret`: Webhook secret (optional if using `webhooks.secretEnv`)
- `webhooks.secretEnv`: Environment variable name holding the webhook secret
- `webhooks.maxPayloadBytes`: Optional max payload size (bytes)
- `webhooks.queueFile`: Optional path for the webhook queue file
- `webhooks.catchup`: Optional low-frequency fallback scan (Search API) to catch requests missed while the webhook listener was down
  - `webhooks.catchup.enabled`: Turn the catch-up scan on/off
  - `webhooks.catchup.intervalMinutes`: Minimum minutes between scans
  - `webhooks.catchup.maxIssuesPerRun`: Maximum issues to queue per scan
- `copilot`: Copilot CLI command and args for idle runs (the prompt is appended as the last argument).
  - `copilot.args`: Ensure `-p` is the final argument so the prompt is passed as the value. Use `--allow-all` for non-interactive runs.
- `idle`: Optional idle task settings (runs when no queued issues exist)
  - `idle.enabled`: Turn idle tasks on/off
  - `idle.maxRunsPerCycle`: Max idle tasks per cycle
  - `idle.cooldownMinutes`: Per-repo cooldown between idle runs
  - `idle.tasks`: List of task prompts to rotate through
  - `idle.promptTemplate`: Prompt template for idle runs; supports `{{repo}}` and `{{task}}`
  - `idle.repoScope`: `"all"` (default) or `"local"` to restrict idle tasks to repos under the workspace root
  - `idle.usageGate`: Optional Codex usage guard (reads `account/rateLimits/read` via Codex app-server)
  - `idle.usageGate.enabled`: Turn usage gating on/off
  - `idle.usageGate.command`: Command used to launch Codex app-server
  - `idle.usageGate.args`: Additional arguments passed to `codex app-server`
  - `idle.usageGate.timeoutSeconds`: Timeout for app-server rate limit lookup
    - `idle.usageGate.minRemainingPercent`: Minimum remaining percent for the 5h window
    - `idle.usageGate.weeklySchedule`: Weekly ramp for remaining percent
      - `idle.usageGate.weeklySchedule.startMinutes`: When to begin idle runs (minutes before weekly reset)
      - `idle.usageGate.weeklySchedule.minRemainingPercentAtStart`: Required weekly percent left at startMinutes
      - `idle.usageGate.weeklySchedule.minRemainingPercentAtEnd`: Required weekly percent left at reset time
  - `idle.copilotUsageGate`: Optional Copilot monthly usage guard (reads `copilot_internal/user`)
  - `idle.copilotUsageGate.enabled`: Turn Copilot usage gating on/off
  - `idle.copilotUsageGate.timeoutSeconds`: Timeout for Copilot usage lookup
  - `idle.copilotUsageGate.apiBaseUrl`: Optional GitHub API base URL (default `https://api.github.com`)
  - `idle.copilotUsageGate.apiVersion`: Optional GitHub API version header (default `2025-05-01`)
  - `idle.copilotUsageGate.monthlySchedule`: Monthly ramp for remaining percent
    - `idle.copilotUsageGate.monthlySchedule.startMinutes`: When to begin idle runs (minutes before monthly reset)
    - `idle.copilotUsageGate.monthlySchedule.minRemainingPercentAtStart`: Required monthly percent left at startMinutes
    - `idle.copilotUsageGate.monthlySchedule.minRemainingPercentAtEnd`: Required monthly percent left at reset time

## Running

One-shot execution:

```bash
node dist/cli.js run --once --yes
```

Looping daemon:

```bash
node dist/cli.js run --yes
```

Webhook listener (GitHub App):

```bash
node dist/cli.js webhook --config agent-runner.config.json
```

When `webhooks.enabled` is true, repo-wide issue polling is skipped and the runner
relies on webhook-queued issues. Keep the webhook listener running (for example,
as a background service or scheduled task).
If `webhooks.catchup.enabled` is true, the runner also performs a low-frequency
Search API scan to catch requests created while the webhook listener was down.

## Idle runs (issue-less)

When no queued issues exist, the runner can execute idle tasks defined in the config.
Each idle run writes a report under `reports/` and streams the Codex output to `logs/`.
When changes are made, the idle prompt is expected to open a PR, mention @metyatech
in a summary comment, and merge the PR, then sync the main branch locally.
If `idle.repoScope` is set to `"local"`, idle runs only target repositories under the workspace root.
If `idle.usageGate.enabled` is true, idle runs only execute when the weekly reset
window is near and unused weekly capacity remains. The weekly threshold ramps
down as the reset approaches. The 5h window is used only to confirm that some
short-term capacity remains (5h reset timing is ignored). The runner queries
Codex app-server (`account/rateLimits/read`) over JSON-RPC (JSONL over stdio) to
fetch rate limits.
If `idle.copilotUsageGate.enabled` is true, idle runs also require Copilot monthly
usage to be within the configured reset window and above the remaining-percent
threshold for that window.
When both Codex and Copilot usage gates allow, the runner schedules idle tasks
for both engines (using different repos when available) and will temporarily
raise `idle.maxRunsPerCycle` if needed to cover both engines.

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
    "repoScope": "local",
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
    },
    "copilotUsageGate": {
      "enabled": true,
      "timeoutSeconds": 20,
      "apiBaseUrl": "https://api.github.com",
      "apiVersion": "2025-05-01",
      "monthlySchedule": {
        "startMinutes": 10080,
        "minRemainingPercentAtStart": 100,
        "minRemainingPercentAtEnd": 0
      }
    }
  },
  "codex": {
    "command": "codex",
    "args": ["exec", "--dangerously-bypass-approvals-and-sandbox", "--model", "gpt-5.2"],
    "promptTemplate": "..."
  },
  "copilot": {
    "command": "copilot",
    "args": ["--allow-all", "--model", "gemini-3-pro-preview", "-p"]
  }
}
```

## GitHub App Webhooks (Cloudflare Tunnel)

Recommended to avoid repo-wide polling and GitHub rate limits.

1. Create a GitHub App and set its webhook URL to your Cloudflare Tunnel URL,
   for example `https://<tunnel-host>/webhooks/github`.
2. Configure the webhook secret and store it in an environment variable
   (example: `AGENT_GITHUB_WEBHOOK_SECRET`).
3. Subscribe to events: **Issues** and **Issue comment**.
4. Install the App on the repositories you want the runner to watch.
5. Enable `webhooks` in `agent-runner.config.json` and start the webhook listener.

Minimal Cloudflare Tunnel config example (save to a file and run with `cloudflared tunnel run`):

```yaml
tunnel: <tunnel-id>
credentials-file: <path-to-credentials.json>
ingress:
  - hostname: <tunnel-host>
    service: http://127.0.0.1:4312
  - service: http_status:404
```

Ensure the webhook listener is running locally on the same host/port as the tunnel target.

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

Task run logs are written to `logs/task-run-YYYYMMDD.log` (one file per day).
The latest task-run log path is also written to `logs/latest-task-run.path`.

Issue logs (e.g. `*-issue-*.log`) are appended as output is produced.

### Webhook + Cloudflare auto-start

Register a webhook listener task (runs at logon):

```powershell
.\scripts\register-webhook-task.ps1 -RepoPath "." -ConfigPath ".\\agent-runner.config.json"
```

Unregister the webhook task:

```powershell
.\scripts\unregister-webhook-task.ps1
```

Register a Cloudflare Tunnel task (runs at logon):

```powershell
.\scripts\register-cloudflared-task.ps1 -RepoPath "."
```

Unregister the tunnel task:

```powershell
.\scripts\unregister-cloudflared-task.ps1
```

Logs are written to `logs/webhook-run-*.out.log` / `logs/webhook-run-*.err.log` and `logs/cloudflared-*.out.log` / `logs/cloudflared-*.err.log`.

### Log cleanup

To prune old logs (uses `logMaintenance` from the config):

```powershell
agent-runner logs prune --config .\\agent-runner.config.json --yes
```

## Amazon Q Developer (Amazon Q for command line)

The agent runner can use Amazon Q for command line as an idle engine via WSL2.

### Setup (Windows + WSL2)

1) Install the CLI inside WSL (Ubuntu example):

```bash
mkdir -p /tmp/amazon-q-install
cd /tmp/amazon-q-install
curl --proto '=https' --tlsv1.2 -sSf 'https://desktop-release.q.us-east-1.amazonaws.com/latest/q-x86_64-linux.zip' -o q.zip
python3 -c "import zipfile; zipfile.ZipFile('q.zip').extractall('.')"
chmod +x q/install.sh
./q/install.sh --no-confirm
```

2) Login (free Builder ID):

```bash
q login --license free --use-device-flow
```

### Enable in the runner

Set `amazonQ` in the config (ships disabled by default):

```json
{
  "amazonQ": {
    "enabled": true,
    "command": "wsl.exe",
    "args": ["-d", "Ubuntu", "--", "q", "chat", "--no-interactive", "--trust-all-tools"],
    "promptMode": "arg"
  }
}
```

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

If `webhooks.enabled` is true, the tray helper will also ensure the webhook listener
is running in the background.

## Release / deploy

Not applicable. This repository is intended to run locally.

