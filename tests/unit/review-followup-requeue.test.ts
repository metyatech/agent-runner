import { describe, expect, it } from "vitest";
import { hasPattern, QUOTA_ERROR_PATTERNS, extractErrorMessage } from "../../src/runner.js";
import type { RunResult } from "../../src/runner.js";

describe("extractErrorMessage", () => {
  it("extracts message from a standard Error", () => {
    const err = new Error("something went wrong");
    expect(extractErrorMessage(err)).toBe("something went wrong");
  });

  it("returns string errors unchanged", () => {
    expect(extractErrorMessage("plain string error")).toBe("plain string error");
  });

  it("extracts message from non-Error object with message property", () => {
    const obj = { message: "quota exceeded" };
    expect(extractErrorMessage(obj)).toBe("quota exceeded");
  });

  it("extracts reason from non-Error object when no message", () => {
    const obj = { reason: "rateLimitExceeded" };
    expect(extractErrorMessage(obj)).toBe("rateLimitExceeded");
  });

  it("extracts detail from non-Error object when no message or reason", () => {
    const obj = { detail: "too many requests" };
    expect(extractErrorMessage(obj)).toBe("too many requests");
  });

  it("returns JSON.stringify for objects without known fields", () => {
    const obj = { code: 429, status: "RESOURCE_EXHAUSTED" };
    expect(extractErrorMessage(obj)).toBe(JSON.stringify(obj));
  });

  it("does not produce [object Object] for plain quota error objects", () => {
    const geminiErr = { message: "RetryableQuotaError: No capacity available for model gemini-3-flash-preview" };
    const result = extractErrorMessage(geminiErr);
    expect(result).not.toBe("[object Object]");
    expect(result).toContain("RetryableQuotaError");
  });

  it("returns String(error) for null", () => {
    expect(extractErrorMessage(null)).toBe("null");
  });

  it("returns String(error) for numbers", () => {
    expect(extractErrorMessage(42)).toBe("42");
  });
});

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
