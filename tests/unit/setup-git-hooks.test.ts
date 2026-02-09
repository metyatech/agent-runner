import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scriptPath = path.resolve(process.cwd(), "scripts", "setup-git-hooks.mjs");

function runNode(cwd: string) {
  return spawnSync(process.execPath, [scriptPath], { cwd, encoding: "utf8" });
}

function runGit(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    throw new Error(`git ${args.join(" ")} failed (status=${result.status}): ${stderr}`);
  }
  return (result.stdout ?? "").trim();
}

describe("setup-git-hooks script", () => {
  it("exits successfully outside a git repo", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-hooks-notgit-"));
    const result = runNode(dir);
    expect(result.status).toBe(0);
  });

  it("sets core.hooksPath to .githooks when missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-hooks-set-"));
    runGit(dir, ["init"]);

    spawnSync("git", ["config", "--local", "--unset-all", "core.hooksPath"], { cwd: dir, encoding: "utf8" });
    const before = spawnSync("git", ["config", "--local", "--get", "core.hooksPath"], { cwd: dir, encoding: "utf8" });
    expect(before.status).not.toBe(0);

    const result = runNode(dir);
    expect(result.status).toBe(0);

    expect(runGit(dir, ["config", "--local", "--get", "core.hooksPath"])).toBe(".githooks");
    expect(fs.existsSync(path.join(dir, ".githooks"))).toBe(true);
  });

  it("does not override an existing core.hooksPath value", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-hooks-nooverride-"));
    runGit(dir, ["init"]);
    runGit(dir, ["config", "--local", "core.hooksPath", ".custom-hooks"]);

    const result = runNode(dir);
    expect(result.status).toBe(0);

    expect(runGit(dir, ["config", "--local", "--get", "core.hooksPath"])).toBe(".custom-hooks");
  });
});
