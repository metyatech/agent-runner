import fs from "node:fs";
import path from "node:path";

export type GitHubNotifyAppConfig = {
  appId: string;
  installationId: number;
  privateKey: string;
  apiBaseUrl?: string;
};

const ENV_APP_ID = "AGENT_GITHUB_NOTIFY_APP_ID";
const ENV_INSTALLATION_ID = "AGENT_GITHUB_NOTIFY_APP_INSTALLATION_ID";
const ENV_PRIVATE_KEY = "AGENT_GITHUB_NOTIFY_APP_PRIVATE_KEY";
const ENV_API_BASE_URL = "AGENT_GITHUB_NOTIFY_APP_API_BASE_URL";

function resolveStateFile(workdirRoot: string, fileName: string): string {
  return path.resolve(workdirRoot, "agent-runner", "state", fileName);
}

function readTrimmedFile(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const value = raw.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function readStateAppJson(
  workdirRoot: string
): { appId?: string; installationId?: number; apiBaseUrl?: string } | null {
  const filePath = resolveStateFile(workdirRoot, "github-notify-app.json");
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as any;
    if (!parsed || typeof parsed !== "object") return null;

    const appId = typeof parsed.appId === "string" && parsed.appId.trim().length > 0 ? parsed.appId.trim() : undefined;
    const installationId =
      typeof parsed.installationId === "number" && Number.isFinite(parsed.installationId) && parsed.installationId > 0
        ? parsed.installationId
        : undefined;
    const apiBaseUrl =
      typeof parsed.apiBaseUrl === "string" && parsed.apiBaseUrl.trim().length > 0
        ? parsed.apiBaseUrl.trim()
        : undefined;
    return { appId, installationId, apiBaseUrl };
  } catch {
    return null;
  }
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return null;
  return parsed;
}

export function resolveGitHubNotifyAppConfig(workdirRoot: string): GitHubNotifyAppConfig | null {
  const envAppId = process.env[ENV_APP_ID];
  const envInstallationId = parsePositiveInt(process.env[ENV_INSTALLATION_ID]);
  const envPrivateKey = typeof process.env[ENV_PRIVATE_KEY] === "string" ? process.env[ENV_PRIVATE_KEY]!.trim() : "";
  const envApiBaseUrl = process.env[ENV_API_BASE_URL];

  if (typeof envAppId === "string" && envAppId.trim().length > 0 && envInstallationId) {
    if (envPrivateKey.length > 0) {
      return {
        appId: envAppId.trim(),
        installationId: envInstallationId,
        privateKey: envPrivateKey,
        apiBaseUrl:
          typeof envApiBaseUrl === "string" && envApiBaseUrl.trim().length > 0 ? envApiBaseUrl.trim() : undefined
      };
    }
    const keyPath = resolveStateFile(workdirRoot, "github-notify-app-private-key.pem");
    const keyFromFile = readTrimmedFile(keyPath);
    if (keyFromFile) {
      return {
        appId: envAppId.trim(),
        installationId: envInstallationId,
        privateKey: keyFromFile,
        apiBaseUrl:
          typeof envApiBaseUrl === "string" && envApiBaseUrl.trim().length > 0 ? envApiBaseUrl.trim() : undefined
      };
    }
  }

  const state = readStateAppJson(workdirRoot);
  if (!state?.appId || !state.installationId) {
    return null;
  }
  const keyPath = resolveStateFile(workdirRoot, "github-notify-app-private-key.pem");
  const key = readTrimmedFile(keyPath);
  if (!key) {
    return null;
  }

  return {
    appId: state.appId,
    installationId: state.installationId,
    privateKey: key,
    apiBaseUrl: state.apiBaseUrl
  };
}
