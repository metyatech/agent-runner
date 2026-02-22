import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  evaluateUsageGate,
  fetchCodexRateLimits,
  rateLimitSnapshotToStatus
} from "../../src/codex-status.js";

describe("rateLimitSnapshotToStatus", () => {
  it("maps primary/secondary windows to 5h and weekly usage", () => {
    const now = new Date("2026-02-02T10:00:00Z");
    const snapshot = {
      primary: {
        usedPercent: 40,
        windowDurationMins: 300,
        resetsAt: 1_770_020_000
      },
      secondary: {
        usedPercent: 10,
        windowDurationMins: 10080,
        resetsAt: 1_770_120_000
      }
    };

    const status = rateLimitSnapshotToStatus(snapshot, now);
    expect(status).not.toBeNull();
    const fiveHour = status?.windows.find((window) => window.key === "fiveHour");
    const weekly = status?.windows.find((window) => window.key === "weekly");

    expect(fiveHour?.percentLeft).toBe(60);
    expect(weekly?.percentLeft).toBe(90);
  });
});

describe("evaluateUsageGate", () => {
  it("allows idle when a window is within the threshold", () => {
    const now = new Date(2026, 1, 2, 12, 30, 0);
    // 5h window: 12% left (resetsAt in the future)
    // Weekly window: 60% left (resetsAt in the future)
    const nowSecs = Math.floor(now.getTime() / 1000);
    const snapshot = {
      primary: {
        used_percent: 88,
        windowDurationMins: 300,
        resetsAt: nowSecs + 30 * 60
      },
      secondary: {
        used_percent: 40,
        windowDurationMins: 10080,
        resetsAt: nowSecs + 30 * 60
      }
    };
    const status = rateLimitSnapshotToStatus(snapshot, now);

    expect(status).not.toBeNull();

    const decision = evaluateUsageGate(
      status!,
      {
        enabled: true,
        timeoutSeconds: 20,
        minRemainingPercent: {
          fiveHour: 5
        },
        weeklySchedule: {
          startMinutes: 60,
          minRemainingPercentAtStart: 20,
          minRemainingPercentAtEnd: 0
        }
      },
      now
    );

    expect(decision.allow).toBe(true);
  });

  it("blocks idle when 5h remaining is below threshold", () => {
    const now = new Date(2026, 1, 2, 12, 30, 0);
    const nowSecs = Math.floor(now.getTime() / 1000);
    const snapshot = {
      primary: {
        used_percent: 100,
        windowDurationMins: 300,
        resetsAt: nowSecs + 30 * 60
      },
      secondary: {
        used_percent: 40,
        windowDurationMins: 10080,
        resetsAt: nowSecs + 30 * 60
      }
    };
    const status = rateLimitSnapshotToStatus(snapshot, now);

    expect(status).not.toBeNull();

    const decision = evaluateUsageGate(
      status!,
      {
        enabled: true,
        timeoutSeconds: 20,
        minRemainingPercent: {
          fiveHour: 1
        },
        weeklySchedule: {
          startMinutes: 60,
          minRemainingPercentAtStart: 20,
          minRemainingPercentAtEnd: 0
        }
      },
      now
    );

    expect(decision.allow).toBe(false);
  });
});

describe("readCodexRateLimitsFromSessions (via fetchCodexRateLimits)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "codex-status-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null when sessions directory does not exist", async () => {
    const result = await fetchCodexRateLimits({
      codexHome: join(tmpDir, "nonexistent"),
      timeoutSeconds: 1
    });
    expect(result).toBeNull();
  });

  it("returns null when sessions directory exists but is empty", async () => {
    await mkdir(join(tmpDir, "sessions"), { recursive: true });
    const result = await fetchCodexRateLimits({ codexHome: tmpDir, timeoutSeconds: 1 });
    expect(result).toBeNull();
  });

  it("parses rate_limits from a JSONL session file", async () => {
    const now = new Date();
    const yyyy = now.getFullYear().toString();
    const mm = (now.getMonth() + 1).toString().padStart(2, "0");
    const dd = now.getDate().toString().padStart(2, "0");
    const dayDir = join(tmpDir, "sessions", yyyy, mm, dd);
    await mkdir(dayDir, { recursive: true });

    const entry = JSON.stringify({
      payload: {
        type: "token_count",
        info: {
          rate_limits: {
            primary: { used_percent: 40, window_duration_minutes: 300, resets_in_seconds: 1234 },
            secondary: { used_percent: 10, window_duration_minutes: 10080, resets_in_seconds: 5678 }
          }
        }
      }
    });
    await writeFile(join(dayDir, "rollup-session1.jsonl"), `${entry}\n`);

    const result = await fetchCodexRateLimits({ codexHome: tmpDir, timeoutSeconds: 1 });
    expect(result).not.toBeNull();
    expect(result?.primary).toBeDefined();
    expect(result?.secondary).toBeDefined();
    expect(result?.primary?.used_percent).toBe(40);
    expect(result?.secondary?.used_percent).toBe(10);
  });

  it("returns the most recent entry (last line of newest file)", async () => {
    const now = new Date();
    const yyyy = now.getFullYear().toString();
    const mm = (now.getMonth() + 1).toString().padStart(2, "0");
    const dd = now.getDate().toString().padStart(2, "0");
    const dayDir = join(tmpDir, "sessions", yyyy, mm, dd);
    await mkdir(dayDir, { recursive: true });

    const entry1 = JSON.stringify({
      payload: {
        type: "token_count",
        info: {
          rate_limits: {
            primary: { used_percent: 10, window_duration_minutes: 300, resets_in_seconds: 100 }
          }
        }
      }
    });
    const entry2 = JSON.stringify({
      payload: {
        type: "token_count",
        info: {
          rate_limits: {
            primary: { used_percent: 75, window_duration_minutes: 300, resets_in_seconds: 200 }
          }
        }
      }
    });
    // Both entries in the same file; entry2 is last (most recent)
    await writeFile(join(dayDir, "rollup-session1.jsonl"), `${entry1}\n${entry2}\n`);

    const result = await fetchCodexRateLimits({ codexHome: tmpDir, timeoutSeconds: 1 });
    expect(result).not.toBeNull();
    expect(result?.primary?.used_percent).toBe(75);
  });

  it("skips lines that are not token_count entries", async () => {
    const now = new Date();
    const yyyy = now.getFullYear().toString();
    const mm = (now.getMonth() + 1).toString().padStart(2, "0");
    const dd = now.getDate().toString().padStart(2, "0");
    const dayDir = join(tmpDir, "sessions", yyyy, mm, dd);
    await mkdir(dayDir, { recursive: true });

    const irrelevant = JSON.stringify({ payload: { type: "other_event", info: {} } });
    const relevant = JSON.stringify({
      payload: {
        type: "token_count",
        info: {
          rate_limits: {
            primary: { used_percent: 55, window_duration_minutes: 300, resets_in_seconds: 300 }
          }
        }
      }
    });
    await writeFile(join(dayDir, "rollup-session1.jsonl"), `${irrelevant}\n${relevant}\n`);

    const result = await fetchCodexRateLimits({ codexHome: tmpDir, timeoutSeconds: 1 });
    expect(result?.primary?.used_percent).toBe(55);
  });

  it("looks back up to 7 days for session data", async () => {
    const now = new Date();
    // Write to 3 days ago
    const threeDaysAgo = new Date(now.getTime() - 3 * 86400000);
    const yyyy = threeDaysAgo.getFullYear().toString();
    const mm = (threeDaysAgo.getMonth() + 1).toString().padStart(2, "0");
    const dd = threeDaysAgo.getDate().toString().padStart(2, "0");
    const dayDir = join(tmpDir, "sessions", yyyy, mm, dd);
    await mkdir(dayDir, { recursive: true });

    const entry = JSON.stringify({
      payload: {
        type: "token_count",
        info: {
          rate_limits: {
            primary: { used_percent: 22, window_duration_minutes: 300, resets_in_seconds: 400 }
          }
        }
      }
    });
    await writeFile(join(dayDir, "rollup-old.jsonl"), `${entry}\n`);

    const result = await fetchCodexRateLimits({ codexHome: tmpDir, timeoutSeconds: 1 });
    expect(result?.primary?.used_percent).toBe(22);
  });
});

describe("fetchCodexRateLimitsFromApi (via fetchCodexRateLimits)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "codex-status-api-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("returns null when auth.json does not exist", async () => {
    const result = await fetchCodexRateLimits({ codexHome: tmpDir, timeoutSeconds: 1 });
    expect(result).toBeNull();
  });

  it("returns null when auth.json has no access_token", async () => {
    await writeFile(join(tmpDir, "auth.json"), JSON.stringify({ tokens: {} }));
    const result = await fetchCodexRateLimits({ codexHome: tmpDir, timeoutSeconds: 1 });
    expect(result).toBeNull();
  });

  it("returns rate limits from API when no session data exists", async () => {
    await writeFile(
      join(tmpDir, "auth.json"),
      JSON.stringify({ tokens: { access_token: "test-token" } })
    );

    const mockResponse = {
      rate_limits: {
        primary: { used_percent: 30, limit_window_seconds: 18000, reset_after_seconds: 9000 },
        secondary: { used_percent: 5, limit_window_seconds: 604800, reset_after_seconds: 100000 }
      }
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse
      })
    );

    const result = await fetchCodexRateLimits({ codexHome: tmpDir, timeoutSeconds: 5 });
    expect(result).not.toBeNull();
    expect(result?.primary?.used_percent).toBe(30);
    expect(result?.secondary?.used_percent).toBe(5);
    // windowDurationMins = 18000/60 = 300
    expect(result?.primary?.windowDurationMins).toBe(300);
    // windowDurationMins = 604800/60 = 10080
    expect(result?.secondary?.windowDurationMins).toBe(10080);
  });

  it("includes chatgpt-account-id header when account_id is present", async () => {
    await writeFile(
      join(tmpDir, "auth.json"),
      JSON.stringify({ tokens: { access_token: "test-token", account_id: "acc-123" } })
    );

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        rate_limits: {
          primary: { used_percent: 10, limit_window_seconds: 18000, reset_after_seconds: 5000 }
        }
      })
    });
    vi.stubGlobal("fetch", mockFetch);

    await fetchCodexRateLimits({ codexHome: tmpDir, timeoutSeconds: 5 });

    expect(mockFetch).toHaveBeenCalledOnce();
    const callArgs = mockFetch.mock.calls[0];
    const headers = callArgs[1].headers as Record<string, string>;
    expect(headers["chatgpt-account-id"]).toBe("acc-123");
    expect(headers["Authorization"]).toBe("Bearer test-token");
  });

  it("returns null when API returns non-ok status", async () => {
    await writeFile(
      join(tmpDir, "auth.json"),
      JSON.stringify({ tokens: { access_token: "test-token" } })
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({})
      })
    );

    const result = await fetchCodexRateLimits({ codexHome: tmpDir, timeoutSeconds: 5 });
    expect(result).toBeNull();
  });

  it("returns null when API fetch throws (e.g. network error)", async () => {
    await writeFile(
      join(tmpDir, "auth.json"),
      JSON.stringify({ tokens: { access_token: "test-token" } })
    );

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const result = await fetchCodexRateLimits({ codexHome: tmpDir, timeoutSeconds: 5 });
    expect(result).toBeNull();
  });

  it("prefers session data over API when session data exists", async () => {
    // Write session data
    const now = new Date();
    const yyyy = now.getFullYear().toString();
    const mm = (now.getMonth() + 1).toString().padStart(2, "0");
    const dd = now.getDate().toString().padStart(2, "0");
    const dayDir = join(tmpDir, "sessions", yyyy, mm, dd);
    await mkdir(dayDir, { recursive: true });

    const sessionEntry = JSON.stringify({
      payload: {
        type: "token_count",
        info: {
          rate_limits: {
            primary: { used_percent: 99, window_duration_minutes: 300, resets_in_seconds: 100 }
          }
        }
      }
    });
    await writeFile(join(dayDir, "rollup-session1.jsonl"), `${sessionEntry}\n`);

    await writeFile(
      join(tmpDir, "auth.json"),
      JSON.stringify({ tokens: { access_token: "test-token" } })
    );

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        rate_limits: {
          primary: { used_percent: 1, limit_window_seconds: 18000, reset_after_seconds: 5000 }
        }
      })
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await fetchCodexRateLimits({ codexHome: tmpDir, timeoutSeconds: 5 });
    // Should use session data (99), not API data (1)
    expect(result?.primary?.used_percent).toBe(99);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
