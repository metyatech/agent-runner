import { describe, expect, it } from "vitest";
import { classifyNonZeroExit } from "../../src/runner.js";

describe("classifyNonZeroExit", () => {
  it("classifies Gemini model capacity exhaustion as quota", () => {
    const outputTail = [
      "Attempt 3 failed: No capacity available for model gemini-3-flash-preview on the server. Max attempts reached",
      "RetryableQuotaError: No capacity available for model gemini-3-flash-preview on the server"
    ].join("\n");

    const result = classifyNonZeroExit(outputTail);
    expect(result.failureKind).toBe("quota");
    expect(result.failureDetail).toContain("No capacity available");
  });

  it("classifies other failures as execution_error", () => {
    const outputTail = "TypeError: Cannot read properties of undefined (reading 'foo')";
    const result = classifyNonZeroExit(outputTail);
    expect(result.failureKind).toBe("execution_error");
    expect(result.failureDetail).toContain("TypeError");
  });
});

