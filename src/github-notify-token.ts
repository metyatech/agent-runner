import fs from "node:fs";
import path from "node:path";

const ENV_NOTIFY_TOKEN = "AGENT_GITHUB_NOTIFY_TOKEN";

function resolveNotifyTokenPath(workdirRoot: string): string {
  return path.resolve(workdirRoot, "agent-runner", "state", "github-notify-token.txt");
}

export function resolveGitHubNotifyToken(workdirRoot: string): string | null {
  const envToken = process.env[ENV_NOTIFY_TOKEN];
  if (typeof envToken === "string" && envToken.trim().length > 0) {
    return envToken.trim();
  }

  const filePath = resolveNotifyTokenPath(workdirRoot);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const token = raw.trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}
