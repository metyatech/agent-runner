import { describe, expect, it } from "vitest";
import { normalizeLogChunk } from "../../src/log-normalize.js";

describe("normalizeLogChunk", () => {
  it("keeps utf8 buffers intact", () => {
    const input = Buffer.from("Hello\n", "utf8");
    const output = normalizeLogChunk(input);
    expect(output).toBe("Hello\n");
  });

  it("decodes utf16le buffers without NUL characters", () => {
    const input = Buffer.from("Status OK\n", "utf16le");
    const output = normalizeLogChunk(input);
    expect(output).toBe("Status OK\n");
    expect(output).not.toContain("\u0000");
  });

  it("normalizes carriage-return-only line breaks", () => {
    const input = "line1\rline2\r\nline3\r";
    const output = normalizeLogChunk(input);
    expect(output).toBe("line1\nline2\r\nline3\n");
  });
});
