import fs from "node:fs";
import path from "node:path";

export type StopRequest = {
  requestedAt: string;
};

export function resolveStopFlagPath(workdirRoot: string): string {
  return path.resolve(workdirRoot, "agent-runner", "state", "stop.request.json");
}

export function isStopRequested(workdirRoot: string): boolean {
  return fs.existsSync(resolveStopFlagPath(workdirRoot));
}

export function requestStop(workdirRoot: string): void {
  const stopPath = resolveStopFlagPath(workdirRoot);
  fs.mkdirSync(path.dirname(stopPath), { recursive: true });
  const payload: StopRequest = { requestedAt: new Date().toISOString() };
  fs.writeFileSync(stopPath, JSON.stringify(payload, null, 2));
}

export function clearStopRequest(workdirRoot: string): void {
  const stopPath = resolveStopFlagPath(workdirRoot);
  if (!fs.existsSync(stopPath)) {
    return;
  }
  fs.unlinkSync(stopPath);
}
