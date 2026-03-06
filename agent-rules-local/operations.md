# Local operations rules

- After any change that requires a process or task restart to take effect, restart the affected local components before concluding.
- Verify post-restart state and report which components were restarted and their final status.
- For agent-runner behavior changes, identify the responsible runtime component (Scheduled Task `AgentRunner` / `dist/cli.js run`, webhook, UI) and restart the correct one(s) before concluding.
- Do not claim a restart occurred unless verified by deterministic evidence (new PID, port check, and/or the latest task-run log showing the expected new behavior).

## Autonomous task resolution

- If a verification step (e.g., `npm run verify`, `npm audit`) fails due to known security vulnerabilities, attempt to fix them automatically (e.g., `npm audit fix`). If the fix is successful and verification passes, commit and push the changes to the PR branch.
- If a task is stuck or constantly failing due to quota limits (429 errors), ensure the task state is correctly updated in `task-tracker` so it can resume from the last successful stage in the next execution cycle.
- Do not remain idle on a failing PR if a known automated fix exists.
