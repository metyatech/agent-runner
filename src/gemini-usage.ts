import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { evaluateUsageRamp, type UsageRampSchedule } from "./usage-gate-common.js";

export type GeminiModelUsage = {
  limit: number;
  usage: number;
  resetAt: Date;
};

export type GeminiUsage = {
  "gemini-3-pro-preview"?: GeminiModelUsage;
  "gemini-3-flash-preview"?: GeminiModelUsage;
};

export type GeminiUsageGateConfig = {
  enabled: boolean;
  strategy: "spare-only";
} & UsageRampSchedule;

export type GeminiUsageGateDecision = {
  allowPro: boolean;
  allowFlash: boolean;
  reason: string;
  proUsage?: GeminiModelUsage;
  flashUsage?: GeminiModelUsage;
};

type RefreshAccessTokenResult = {
  accessToken: string;
  expiryDate?: number;
};

type GeminiOauthClientInfo = {
  clientId?: string;
  clientSecret?: string;
  source?: string;
};

const ENV_GEMINI_OAUTH_CLIENT_ID = "AGENT_RUNNER_GEMINI_OAUTH_CLIENT_ID";
const ENV_GEMINI_OAUTH_CLIENT_SECRET = "AGENT_RUNNER_GEMINI_OAUTH_CLIENT_SECRET";

let cachedGeminiOauthClientInfo: GeminiOauthClientInfo | null = null;

function getClientIdFromIdToken(idToken: unknown): string | undefined {
  if (typeof idToken !== "string") return undefined;
  const parts = idToken.split(".");
  if (parts.length !== 3) return undefined;

  try {
    const payloadJson = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(payloadJson) as any;
    if (typeof payload?.aud === "string" && payload.aud.length > 0) return payload.aud;
    if (typeof payload?.azp === "string" && payload.azp.length > 0) return payload.azp;
    return undefined;
  } catch {
    return undefined;
  }
}

function readGeminiOauthClientInfoFromEnv(): GeminiOauthClientInfo | null {
  const clientId = process.env[ENV_GEMINI_OAUTH_CLIENT_ID];
  const clientSecret = process.env[ENV_GEMINI_OAUTH_CLIENT_SECRET];
  if (!clientId && !clientSecret) return null;

  return {
    clientId: typeof clientId === "string" && clientId.length > 0 ? clientId : undefined,
    clientSecret: typeof clientSecret === "string" && clientSecret.length > 0 ? clientSecret : undefined,
    source: "env"
  };
}

function extractOauthConstantsFromJs(content: string): GeminiOauthClientInfo | null {
  const clientIdMatch = content.match(/const\\s+OAUTH_CLIENT_ID\\s*=\\s*['"]([^'"]+)['"]/);
  const clientSecretMatch = content.match(/const\\s+OAUTH_CLIENT_SECRET\\s*=\\s*['"]([^'"]+)['"]/);
  const clientId = clientIdMatch?.[1];
  const clientSecret = clientSecretMatch?.[1];

  if (!clientId && !clientSecret) return null;

  return {
    clientId,
    clientSecret,
    source: "gemini-cli"
  };
}

function tryReadGeminiCliOauthClientInfoFromWellKnownPaths(): GeminiOauthClientInfo | null {
  const candidates: string[] = [];

  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData) {
      const npmGlobal = path.join(appData, "npm", "node_modules");
      candidates.push(
        path.join(
          npmGlobal,
          "@google",
          "gemini-cli",
          "node_modules",
          "@google",
          "gemini-cli-core",
          "dist",
          "src",
          "code_assist",
          "oauth2.js"
        ),
        path.join(npmGlobal, "@google", "gemini-cli-core", "dist", "src", "code_assist", "oauth2.js")
      );
    }
  }

  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, "utf8");
      const extracted = extractOauthConstantsFromJs(content);
      if (extracted) return extracted;
    } catch {
      // ignore and continue
    }
  }

  return null;
}

function getGeminiOauthClientInfo(): GeminiOauthClientInfo | null {
  if (cachedGeminiOauthClientInfo) return cachedGeminiOauthClientInfo;

  cachedGeminiOauthClientInfo =
    readGeminiOauthClientInfoFromEnv() ?? tryReadGeminiCliOauthClientInfoFromWellKnownPaths();

  return cachedGeminiOauthClientInfo;
}

async function refreshAccessToken(options: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<RefreshAccessTokenResult> {
  const params = new URLSearchParams();
  params.set("client_id", options.clientId);
  params.set("client_secret", options.clientSecret);
  params.set("refresh_token", options.refreshToken);
  params.set("grant_type", "refresh_token");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });

  if (!res.ok) {
    throw new Error(`Failed to refresh Google access token: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as any;
  if (typeof data?.access_token !== "string" || data.access_token.length === 0) {
    throw new Error("Google token refresh response missing access_token.");
  }

  const expiryDate =
    typeof data?.expires_in === "number" ? Date.now() + Math.max(0, data.expires_in) * 1000 : undefined;

  return { accessToken: data.access_token, expiryDate };
}

async function getCredentials() {
  const credsPath = path.join(os.homedir(), ".gemini", "oauth_creds.json");
  if (!fs.existsSync(credsPath)) {
    throw new Error(`Gemini OAuth credentials not found at ${credsPath}`);
  }

  const raw = fs.readFileSync(credsPath, "utf8");
  const creds = JSON.parse(raw);

  let accessToken = creds.access_token;
  const now = Date.now();
  // Buffer of 5 minutes
  if (!accessToken || (creds.expiry_date && creds.expiry_date < now + 300000)) {
    if (creds.refresh_token) {
      const discovered = getGeminiOauthClientInfo();
      const clientId =
        getClientIdFromIdToken(creds.id_token) ??
        discovered?.clientId ??
        (typeof creds.client_id === "string" && creds.client_id.length > 0 ? creds.client_id : undefined);
      const clientSecret =
        discovered?.clientSecret ??
        (typeof creds.client_secret === "string" && creds.client_secret.length > 0 ? creds.client_secret : undefined);

      if (!clientId) {
        throw new Error(
          `Gemini OAuth refresh requires a client ID; set ${ENV_GEMINI_OAUTH_CLIENT_ID} or install Gemini CLI.`
        );
      }
      if (!clientSecret) {
        throw new Error(
          `Gemini OAuth refresh requires a client secret; set ${ENV_GEMINI_OAUTH_CLIENT_SECRET} or install Gemini CLI.`
        );
      }

      const refreshed = await refreshAccessToken({
        refreshToken: creds.refresh_token,
        clientId,
        clientSecret
      });
      accessToken = refreshed.accessToken;

      try {
        creds.access_token = accessToken;
        if (typeof refreshed.expiryDate === "number") {
          creds.expiry_date = refreshed.expiryDate;
        }
        fs.writeFileSync(credsPath, JSON.stringify(creds, null, 2), "utf8");
      } catch {
        // Best-effort: keep the refreshed token in memory even if persisting fails.
      }
    } else {
      throw new Error("Gemini access token expired and no refresh token available.");
    }
  }

  return { accessToken };
}

export async function fetchGeminiUsage(
  _command?: string, // Kept for compatibility with earlier plan, but ignored
  _args?: string[],
  _timeoutSeconds?: number,
  _cwd?: string
): Promise<GeminiUsage | null> {
  try {
    const { accessToken } = await getCredentials();

    // 1. Load Code Assist to get the project ID
    const loadRes = await fetch("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": "agent-runner"
      },
      body: JSON.stringify({
        metadata: {
          ideType: "GEMINI_CLI",
          platform: process.platform === "win32" ? "WINDOWS_AMD64" : "LINUX_AMD64"
        }
      })
    });

    if (!loadRes.ok) {
      throw new Error(`loadCodeAssist failed: ${loadRes.status} ${await loadRes.text()}`);
    }

    const loadData = await loadRes.json() as any;
    const projectId = loadData.cloudaicompanionProject;

    if (!projectId) {
      throw new Error("No cloudaicompanionProject found in loadCodeAssist response.");
    }

    // 2. Retrieve User Quota
    const quotaRes = await fetch("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": "agent-runner"
      },
      body: JSON.stringify({ project: projectId })
    });

    if (!quotaRes.ok) {
      throw new Error(`retrieveUserQuota failed: ${quotaRes.status} ${await quotaRes.text()}`);
    }

    const quotaData = await quotaRes.json() as any;
    const usage: GeminiUsage = {};

    if (Array.isArray(quotaData.buckets)) {
      for (const bucket of quotaData.buckets) {
        const modelId = bucket.modelId;
        if (modelId === "gemini-3-pro-preview" || modelId === "gemini-3-flash-preview") {
          // remainingFraction is usually between 0.0 and 1.0
          // but we want usage/limit.
          // Gemini CLI's BucketInfo has resetTime.
          const limit = 100; // API doesn't return limit directly, we use 100 as percentage scale
          const used = Math.round((1.0 - (bucket.remainingFraction ?? 1.0)) * 100);
          usage[modelId as keyof GeminiUsage] = {
            limit,
            usage: used,
            resetAt: bucket.resetTime ? new Date(bucket.resetTime) : new Date(Date.now() + 3600000)
          };
        }
      }
    }

    return usage;
  } catch (error) {
    console.error("Error fetching Gemini usage:", error);
    return null;
  }
}

export function evaluateGeminiUsageGate(
  usage: GeminiUsage,
  gate: GeminiUsageGateConfig,
  now: Date = new Date()
): GeminiUsageGateDecision {
    if (!gate.enabled) {
        return { allowPro: false, allowFlash: false, reason: "Gate disabled." };
    }

    const checkModel = (modelUsage?: GeminiModelUsage): { allowed: boolean; reason?: string } => {
        if (!modelUsage) return { allowed: false, reason: "No usage data" };
        
        const percentRemaining = (1.0 - (modelUsage.usage / modelUsage.limit)) * 100;
        const decision = evaluateUsageRamp(percentRemaining, modelUsage.resetAt, gate, now);
        
        return { allowed: decision.allow, reason: decision.reason };
    };

    const pro = checkModel(usage["gemini-3-pro-preview"]);
    const flash = checkModel(usage["gemini-3-flash-preview"]);

    const reasons: string[] = [];
    if (pro.allowed) reasons.push("Pro allowed");
    else reasons.push(`Pro blocked (${pro.reason})`);
    
    if (flash.allowed) reasons.push("Flash allowed");
    else reasons.push(`Flash blocked (${flash.reason})`);

    return {
        allowPro: pro.allowed,
        allowFlash: flash.allowed,
        reason: reasons.join(", "),
        proUsage: usage["gemini-3-pro-preview"],
        flashUsage: usage["gemini-3-flash-preview"]
    };
}
