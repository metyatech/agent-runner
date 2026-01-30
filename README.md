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

## Configuration

Config file: `agent-runner.config.json`

- `owner`: GitHub user or org
- `repos`: `"all"` or explicit list
- `workdirRoot`: Local workspace root containing repos
- `pollIntervalSeconds`: Polling interval
- `concurrency`: Max concurrent requests
- `labels`: Workflow labels
- `codex`: Codex CLI command and prompt template

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

## Windows Task Scheduler

Register a scheduled task that runs every minute:

```powershell
.\scripts\register-task.ps1 -RepoPath "C:\\path\\to\\agent-runner" -ConfigPath "C:\\path\\to\\agent-runner\\agent-runner.config.json"
```

Unregister the task:

```powershell
.\scripts\unregister-task.ps1
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
