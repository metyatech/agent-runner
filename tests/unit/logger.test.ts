import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../../src/logger.js";

function captureStdout(): { writes: string[] } {
  const writes: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write);
  return { writes };
}

describe("log", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("supports passing tag as the fourth argument without data", () => {
    const { writes } = captureStdout();
    (log as (...args: unknown[]) => void)("info", "runner message", false, "idle");

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("[idle] runner message");
    expect(writes[0]).not.toContain('"idle"');
  });

  it("keeps explicit tag when data also includes tag in json mode", () => {
    const { writes } = captureStdout();
    (log as (...args: unknown[]) => void)("info", "runner message", true, { tag: "from-data", step: "x" }, "idle");

    expect(writes).toHaveLength(1);
    const payload = JSON.parse(writes[0]) as Record<string, unknown>;
    expect(payload.tag).toBe("idle");
    expect(payload.step).toBe("x");
  });
});
