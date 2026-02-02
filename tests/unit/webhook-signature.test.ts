import { describe, expect, it } from "vitest";
import { computeGitHubSignature, verifyGitHubSignature } from "../../src/webhook-signature.js";

describe("webhook-signature", () => {
  it("verifies GitHub HMAC signatures", () => {
    const secret = "top-secret";
    const payload = Buffer.from("hello");
    const signature = computeGitHubSignature(secret, payload);

    expect(verifyGitHubSignature(secret, payload, signature)).toBe(true);
    expect(verifyGitHubSignature(secret, payload, "sha256=deadbeef")).toBe(false);
    expect(verifyGitHubSignature(secret, payload, undefined)).toBe(false);
  });
});
