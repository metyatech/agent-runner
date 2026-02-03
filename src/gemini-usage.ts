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

// Google OAuth client ID used by Gemini CLI
const CLIENT_ID = "681255809395-oo8ft2oprdnrp9e3aqf6av3hmdib135j.apps.googleusercontent.com";

async function refreshAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
      grant_type: "refresh_type"
    })
  });

  if (!res.ok) {
    throw new Error(`Failed to refresh Google access token: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as any;
  return data.access_token;
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
      accessToken = await refreshAccessToken(creds.refresh_token);
      // Optional: update the file with new access token and expiry?
      // For now, just return the new one in memory.
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