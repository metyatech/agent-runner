import { describe, expect, it } from "vitest";
import { hasPattern, QUOTA_ERROR_PATTERNS } from "../../src/runner.js";
import type { RunResult } from "../../src/runner.js";

describe("QUOTA_ERROR_PATTERNS", () => {
  it("matches Gemini MODEL_CAPACITY_EXHAUSTED output", () => {
    const geminiOutput = [
      "Attempt 3 failed: No capacity available for model gemini-3-flash-preview on the server. Max attempts reached",
      'RetryableQuotaError: No capacity available for model gemini-3-flash-preview on the server',
      '"reason": "rateLimitExceeded"',
      '429 Too Many Requests'
    ].join("\n");
    expect(hasPattern(geminiOutput, QUOTA_ERROR_PATTERNS)).toBe(true);
  });

  it("matches Codex usage limit output", () => {
    const codexOutput = "Error: Codex usage limit reached. Please wait before retrying.";
    expect(hasPattern(codexOutput, QUOTA_ERROR_PATTERNS)).toBe(true);
  });

  it("matches rate limit exceeded", () => {
    const output = "Request failed: rate limit exceeded for this API key";
    expect(hasPattern(output, QUOTA_ERROR_PATTERNS)).toBe(true);
  });

  it("matches too many requests", () => {
    const output = "HTTP 429 Too Many Requests";
    expect(hasPattern(output, QUOTA_ERROR_PATTERNS)).toBe(true);
  });

  it("matches quota exceeded", () => {
    const output = "API quota has been exceeded for this project";
    expect(hasPattern(output, QUOTA_ERROR_PATTERNS)).toBe(true);
  });

  it("matches insufficient credits", () => {
    const output = "Error: insufficient credits to complete this request";
    expect(hasPattern(output, QUOTA_ERROR_PATTERNS)).toBe(true);
  });

  it("does not match unrelated errors", () => {
    const output = "TypeError: Cannot read properties of undefined (reading 'foo')";
    expect(hasPattern(output, QUOTA_ERROR_PATTERNS)).toBe(false);
  });

  it("does not match empty string", () => {
    expect(hasPattern("", QUOTA_ERROR_PATTERNS)).toBe(false);
  });
});

describe("RunResult engine field", () => {
  it("includes engine in RunResult type", () => {
    const result: RunResult = {
      success: false,
      logPath: "/tmp/test.log",
      repos: [{ owner: "metyatech", repo: "demo" }],
      summary: null,
      activityId: null,
      sessionId: null,
      engine: "gemini-flash",
      failureKind: "quota",
      failureStage: "before_session",
      failureDetail: "No capacity available",
      quotaResumeAt: null
    };
    expect(result.engine).toBe("gemini-flash");
  });

  it("allows null engine", () => {
    const result: RunResult = {
      success: true,
      logPath: "/tmp/test.log",
      repos: [],
      summary: null,
      activityId: null,
      sessionId: null,
      engine: null,
      failureKind: null,
      failureStage: null,
      failureDetail: null,
      quotaResumeAt: null
    };
    expect(result.engine).toBeNull();
  });
});
