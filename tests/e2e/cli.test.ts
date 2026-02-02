import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

const cliPath = path.resolve("src", "cli.ts");

function runCli(args: string[]) {
  const result = spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
    encoding: "utf8"
  });
  return result;
}

describe("cli", () => {
  it("shows help", () => {
    const result = runCli(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("agent-runner");
  });

  it("shows version", () => {
    const result = runCli(["--version"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0.1.0");
  });

  it("shows status json", () => {
    const result = runCli(["status", "--json"]);
    expect(result.status).toBe(0);
    const data = JSON.parse(result.stdout.trim());
    expect(data).toHaveProperty("generatedAt");
    expect(data).toHaveProperty("generatedAtLocal");
    expect(data).toHaveProperty("busy");
  });
});
