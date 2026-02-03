import fs from "node:fs";
import path from "node:path";

export type WebhookCatchupState = {
  lastRunAt: string | null;
};

export function resolveWebhookCatchupStatePath(workdirRoot: string): string {
  return path.resolve(workdirRoot, "agent-runner", "state", "webhook-catchup.json");
}

export function loadWebhookCatchupState(statePath: string): WebhookCatchupState {
  if (!fs.existsSync(statePath)) {
    return { lastRunAt: null };
  }
  const raw = fs.readFileSync(statePath, "utf8");
  const parsed = JSON.parse(raw) as WebhookCatchupState;
  if (!parsed || typeof parsed !== "object") {
    return { lastRunAt: null };
  }
  return {
    lastRunAt: typeof parsed.lastRunAt === "string" ? parsed.lastRunAt : null
  };
}

export function saveWebhookCatchupState(statePath: string, state: WebhookCatchupState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

