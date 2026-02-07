# Local operations rules

- After any change that requires a process or task restart to take effect, restart the affected local components before concluding.
- Verify post-restart state and report which components were restarted and their final status.
- For agent-runner behavior changes, identify the responsible runtime component (Scheduled Task `AgentRunner` / `dist/cli.js run`, webhook, UI) and restart the correct one(s) before concluding.
- Do not claim a restart occurred unless verified by deterministic evidence (new PID, port check, and/or the latest task-run log showing the expected new behavior).
