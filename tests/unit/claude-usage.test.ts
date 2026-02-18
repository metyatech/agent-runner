import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { evaluateClaudeUsageGate, fetchClaudeUsage } from "../../src/claude-usage.js";
import type { ClaudeUsageData, ClaudeUsageGateConfig } from "../../src/claude-usage.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// fetchClaudeUsage tests
// ---------------------------------------------------------------------------

describe("fetchClaudeUsage", () => {
  let tmpDir: string;
  let credentialsPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-claude-creds-"));
    // Point USERPROFILE at tmpDir so getClaudeConfigDir() resolves there
    process.env.USERPROFILE = tmpDir;
    process.env.HOME = tmpDir;
    credentialsPath = path.join(tmpDir, ".claude", ".credentials.json");
    fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.USERPROFILE;
    delete process.env.HOME;
  });

  it("returns null when credentials file does not exist", async () => {
    fs.rmSync(credentialsPath, { force: true });
    const result = await fetchClaudeUsage();
    expect(result).toBeNull();
  });

  it("returns null when token is expired (expiresAt in the past)", async () => {
    const expiredAt = Date.now() - 1000; // already expired
    fs.writeFileSync(
      credentialsPath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "sk-ant-oat01-test",
          expiresAt: expiredAt,
          refreshToken: "sk-ant-ort01-test",
          subscriptionType: "pro"
        }
      })
    );
    const result = await fetchClaudeUsage();
    expect(result).toBeNull();
  });

  it("returns null when token expires within the 5-minute buffer", async () => {
    const expiresAt = Date.now() + 60_000; // 1 minute from now — inside 5-min buffer
    fs.writeFileSync(
      credentialsPath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "sk-ant-oat01-test",
          expiresAt,
          refreshToken: "sk-ant-ort01-test",
          subscriptionType: "pro"
        }
      })
    );
    const result = await fetchClaudeUsage();
    expect(result).toBeNull();
  });

  it("returns null when fetch fails (network error)", async () => {
    const expiresAt = Date.now() + 7_200_000; // 2 hours from now
    fs.writeFileSync(
      credentialsPath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "sk-ant-oat01-test",
          expiresAt,
          subscriptionType: "pro"
        }
      })
    );
    vi.stubGlobal("fetch", async () => {
      throw new Error("Network error");
    });
    const result = await fetchClaudeUsage();
    expect(result).toBeNull();
  });

  it("returns null when API returns non-OK status", async () => {
    const expiresAt = Date.now() + 7_200_000;
    fs.writeFileSync(
      credentialsPath,
      JSON.stringify({
        claudeAiOauth: { accessToken: "sk-ant-oat01-test", expiresAt }
      })
    );
    vi.stubGlobal("fetch", async () => ({
      ok: false,
      status: 401,
      json: async () => ({})
    }));
    const result = await fetchClaudeUsage();
    expect(result).toBeNull();
  });

  it("parses a valid API response and returns ClaudeUsageData", async () => {
    const expiresAt = Date.now() + 7_200_000;
    fs.writeFileSync(
      credentialsPath,
      JSON.stringify({
        claudeAiOauth: { accessToken: "sk-ant-oat01-test", expiresAt }
      })
    );

    const apiResponse = {
      five_hour: { utilization: 21.0, resets_at: "2026-02-18T14:00:00.000Z" },
      seven_day: { utilization: 3.0, resets_at: "2026-02-25T09:00:00.000Z" },
      seven_day_sonnet: { utilization: 3.0, resets_at: "2026-02-25T09:00:00.000Z" },
      extra_usage: {
        is_enabled: true,
        monthly_limit: 2000,
        used_credits: 2130.0,
        utilization: 100.0
      }
    };

    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => apiResponse
    }));

    const result = await fetchClaudeUsage();
    expect(result).not.toBeNull();
    expect(result!.five_hour?.utilization).toBe(21.0);
    expect(result!.five_hour?.resets_at).toBe("2026-02-18T14:00:00.000Z");
    expect(result!.seven_day?.utilization).toBe(3.0);
    expect(result!.seven_day_sonnet?.utilization).toBe(3.0);
    expect(result!.extra_usage?.is_enabled).toBe(true);
    expect(result!.extra_usage?.monthly_limit).toBe(2000);
    expect(result!.extra_usage?.used_credits).toBe(2130.0);
  });

  it("returns partial data when some buckets are missing from the API response", async () => {
    const expiresAt = Date.now() + 7_200_000;
    fs.writeFileSync(
      credentialsPath,
      JSON.stringify({
        claudeAiOauth: { accessToken: "sk-ant-oat01-test", expiresAt }
      })
    );

    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => ({
        five_hour: { utilization: 50.0, resets_at: "2026-02-18T14:00:00.000Z" }
        // seven_day, seven_day_sonnet, extra_usage all absent
      })
    }));

    const result = await fetchClaudeUsage();
    expect(result).not.toBeNull();
    expect(result!.five_hour?.utilization).toBe(50.0);
    expect(result!.seven_day).toBeNull();
    expect(result!.seven_day_sonnet).toBeNull();
    expect(result!.extra_usage).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// evaluateClaudeUsageGate tests
// ---------------------------------------------------------------------------

describe("evaluateClaudeUsageGate", () => {
  const baseGate: ClaudeUsageGateConfig = {
    enabled: true,
    fiveHourSchedule: {
      startMinutes: 60,
      minRemainingPercentAtStart: 100,
      minRemainingPercentAtEnd: 0
    },
    weeklySchedule: {
      startMinutes: 1440,
      minRemainingPercentAtStart: 100,
      minRemainingPercentAtEnd: 0
    }
  };

  it("returns allowed=false when usage is null", () => {
    const decision = evaluateClaudeUsageGate(null, baseGate, new Date());
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("unavailable");
  });

  it("returns allowed=false when gate is disabled", () => {
    const usage: ClaudeUsageData = {
      five_hour: { utilization: 0, resets_at: "2026-02-18T14:00:00.000Z" },
      seven_day: { utilization: 0, resets_at: "2026-02-25T09:00:00.000Z" },
      seven_day_sonnet: null,
      extra_usage: null
    };
    const decision = evaluateClaudeUsageGate(usage, { ...baseGate, enabled: false }, new Date());
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("disabled");
  });

  it("blocks when reset is too far away for both windows", () => {
    // now = 2026-02-18T00:00:00Z; resets are both far in the future
    const now = new Date("2026-02-18T00:00:00Z");
    const usage: ClaudeUsageData = {
      five_hour: {
        utilization: 0,
        resets_at: "2026-02-18T10:00:00Z" // 600 minutes away — beyond 60m threshold
      },
      seven_day: {
        utilization: 0,
        resets_at: "2026-02-25T09:00:00Z" // days away — beyond 1440m threshold
      },
      seven_day_sonnet: null,
      extra_usage: null
    };
    const decision = evaluateClaudeUsageGate(usage, baseGate, now);
    expect(decision.allowed).toBe(false);
  });

  it("allows via five-hour window when close to reset with high remaining", () => {
    // now = 2026-02-18T13:10:00Z; five_hour resets at 14:00:00 = 50 minutes away (within 60m threshold)
    const now = new Date("2026-02-18T13:10:00Z");
    const usage: ClaudeUsageData = {
      five_hour: {
        utilization: 0, // 100% remaining
        resets_at: "2026-02-18T14:00:00Z"
      },
      seven_day: {
        utilization: 97,
        resets_at: "2026-02-25T09:00:00Z" // far away — weekly blocked
      },
      seven_day_sonnet: null,
      extra_usage: null
    };
    const decision = evaluateClaudeUsageGate(usage, baseGate, now);
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain("Five-hour");
  });

  it("allows via weekly window when close to reset with high remaining", () => {
    // now = 2026-02-24T09:00:00Z; seven_day resets at 2026-02-25T09:00:00Z = 1440 min away (at boundary)
    const now = new Date("2026-02-24T09:00:00Z");
    const usage: ClaudeUsageData = {
      five_hour: {
        utilization: 95, // low remaining — five_hour blocked
        resets_at: "2026-02-24T10:00:00Z" // 60 min away but too little remaining
      },
      seven_day: {
        utilization: 0, // 100% remaining
        resets_at: "2026-02-25T09:00:00Z"
      },
      seven_day_sonnet: null,
      extra_usage: null
    };
    const decision = evaluateClaudeUsageGate(usage, baseGate, now);
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain("Weekly");
  });

  it("blocks when utilization is too high (low remaining) near reset", () => {
    // five_hour: 50 minutes to reset, utilization=80 (20% remaining)
    // gate requires 100% at start=60m, ramps to 0% at end=0m
    // at 50/60 ratio: required = 0 + (100-0)*(50/60) ≈ 83.3% — 20% < 83.3% → blocked
    const now = new Date("2026-02-18T13:10:00Z");
    const usage: ClaudeUsageData = {
      five_hour: {
        utilization: 80,
        resets_at: "2026-02-18T14:00:00Z"
      },
      seven_day: {
        utilization: 80,
        resets_at: "2026-02-25T09:00:00Z" // far away
      },
      seven_day_sonnet: null,
      extra_usage: null
    };
    const decision = evaluateClaudeUsageGate(usage, baseGate, now);
    expect(decision.allowed).toBe(false);
  });

  it("returns allowed=false when no schedules configured", () => {
    const gateNoSchedules: ClaudeUsageGateConfig = { enabled: true };
    const usage: ClaudeUsageData = {
      five_hour: { utilization: 0, resets_at: "2026-02-18T14:00:00Z" },
      seven_day: { utilization: 0, resets_at: "2026-02-25T09:00:00Z" },
      seven_day_sonnet: null,
      extra_usage: null
    };
    const decision = evaluateClaudeUsageGate(usage, gateNoSchedules, new Date());
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("No applicable");
  });
});
