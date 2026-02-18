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
  // Base gate mirrors the Codex-equivalent config: weekly ramp + 5-hour hard floor
  const baseGate: ClaudeUsageGateConfig = {
    enabled: true,
    minRemainingPercent: {
      fiveHour: 50
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

  it("blocks when weekly reset is too far away (regardless of 5-hour)", () => {
    // now = 2026-02-18T00:00:00Z; seven_day resets in 10 days — far beyond 1440m threshold
    const now = new Date("2026-02-18T00:00:00Z");
    const usage: ClaudeUsageData = {
      five_hour: {
        utilization: 0, // 100% remaining — 5-hour would pass its floor
        resets_at: "2026-02-18T04:00:00Z"
      },
      seven_day: {
        utilization: 0,
        resets_at: "2026-02-28T00:00:00Z" // ~14400 min away — well beyond 1440m threshold
      },
      seven_day_sonnet: null,
      extra_usage: null
    };
    const decision = evaluateClaudeUsageGate(usage, baseGate, now);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Weekly blocked");
  });

  it("allows when weekly is close and 5-hour remaining >= 50%", () => {
    // now = 2026-02-24T09:00:00Z; seven_day resets in 1440 min (at boundary of startMinutes)
    // 5-hour utilization = 40 → 60% remaining → passes 50% floor
    const now = new Date("2026-02-24T09:00:00Z");
    const usage: ClaudeUsageData = {
      five_hour: {
        utilization: 40, // 60% remaining — above 50% floor
        resets_at: "2026-02-24T13:00:00Z"
      },
      seven_day: {
        utilization: 0, // 100% remaining — well above weekly ramp requirement
        resets_at: "2026-02-25T09:00:00Z" // exactly 1440 min away
      },
      seven_day_sonnet: null,
      extra_usage: null
    };
    const decision = evaluateClaudeUsageGate(usage, baseGate, now);
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain("passed");
  });

  it("blocks when weekly is close but 5-hour remaining < 50% floor", () => {
    // Weekly passes ramp, but 5-hour has only 30% remaining (below 50% floor)
    const now = new Date("2026-02-24T09:00:00Z");
    const usage: ClaudeUsageData = {
      five_hour: {
        utilization: 70, // 30% remaining — below 50% floor
        resets_at: "2026-02-24T13:00:00Z"
      },
      seven_day: {
        utilization: 0, // 100% remaining — weekly passes ramp
        resets_at: "2026-02-25T09:00:00Z" // 1440 min away
      },
      seven_day_sonnet: null,
      extra_usage: null
    };
    const decision = evaluateClaudeUsageGate(usage, baseGate, now);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Five-hour floor");
    expect(decision.reason).toContain("30.0%");
    expect(decision.reason).toContain("threshold 50%");
  });

  it("blocks when weekly ramp fails due to low remaining near reset", () => {
    // seven_day is 500 min away (within 1440m threshold), but utilization=97 (3% remaining)
    // at ratio=500/1440: required = 0 + 100*(500/1440) ≈ 34.7% — 3% < 34.7% → weekly blocked
    const now = new Date("2026-02-24T20:40:00Z");
    const usage: ClaudeUsageData = {
      five_hour: {
        utilization: 0, // 100% remaining — 5-hour would pass
        resets_at: "2026-02-25T00:00:00Z"
      },
      seven_day: {
        utilization: 97, // only 3% remaining
        resets_at: "2026-02-25T09:00:00Z" // ~500 min away
      },
      seven_day_sonnet: null,
      extra_usage: null
    };
    const decision = evaluateClaudeUsageGate(usage, baseGate, now);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Weekly blocked");
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

  it("allows when only weeklySchedule configured and it passes (no 5-hour floor)", () => {
    // Gate has only weeklySchedule, no minRemainingPercent
    const gateWeeklyOnly: ClaudeUsageGateConfig = {
      enabled: true,
      weeklySchedule: {
        startMinutes: 1440,
        minRemainingPercentAtStart: 100,
        minRemainingPercentAtEnd: 0
      }
    };
    // Weekly: 1440 min away, 100% remaining — passes ramp (required = 100% at start, exactly at boundary)
    const now = new Date("2026-02-24T09:00:00Z");
    const usage: ClaudeUsageData = {
      five_hour: { utilization: 90, resets_at: "2026-02-24T13:00:00Z" }, // would fail floor if configured
      seven_day: { utilization: 0, resets_at: "2026-02-25T09:00:00Z" },
      seven_day_sonnet: null,
      extra_usage: null
    };
    const decision = evaluateClaudeUsageGate(usage, gateWeeklyOnly, now);
    expect(decision.allowed).toBe(true);
  });
});
