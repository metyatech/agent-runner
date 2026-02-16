import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { isProcessAlive } from "./runner-state.js";

export type UiServerState = {
  pid: number;
  host: string;
  port: number;
  startedAt: string;
  configPath: string;
};

export function resolveUiServerStatePath(workdirRoot: string): string {
  return path.resolve(workdirRoot, "agent-runner", "state", "ui-server.json");
}

function isUiServerState(value: unknown): value is UiServerState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const row = value as Partial<UiServerState>;
  return (
    typeof row.pid === "number" &&
    Number.isInteger(row.pid) &&
    row.pid > 0 &&
    typeof row.host === "string" &&
    row.host.length > 0 &&
    typeof row.port === "number" &&
    Number.isInteger(row.port) &&
    row.port > 0 &&
    typeof row.startedAt === "string" &&
    row.startedAt.length > 0 &&
    typeof row.configPath === "string" &&
    row.configPath.length > 0
  );
}

export function loadUiServerState(statePath: string): UiServerState | null {
  if (!fs.existsSync(statePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as unknown;
    return isUiServerState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveUiServerState(statePath: string, state: UiServerState): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function clearUiServerState(statePath: string): void {
  if (!fs.existsSync(statePath)) {
    return;
  }
  try {
    fs.unlinkSync(statePath);
  } catch {
    // ignore
  }
}

export function isUiServerProcessAlive(state: UiServerState): boolean {
  return isProcessAlive(state.pid);
}

export async function probeUiServer(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (value: boolean): void => {
      if (done) {
        return;
      }
      done = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}
