import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function tryRunGit(args, options = {}) {
  try {
    const stdout = execFileSync("git", args, {
      ...options,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8"
    });
    return { ok: true, stdout: stdout.trim() };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function ensureHooksDirExists(hooksPath) {
  if (!hooksPath || path.isAbsolute(hooksPath)) return;
  fs.mkdirSync(path.join(process.cwd(), hooksPath), { recursive: true });
}

const isWorkTree = tryRunGit(["rev-parse", "--is-inside-work-tree"]);
if (!isWorkTree.ok || isWorkTree.stdout !== "true") {
  process.exit(0);
}

const currentHooksPath = tryRunGit(["config", "--local", "--get", "core.hooksPath"]);
if (!currentHooksPath.ok || currentHooksPath.stdout.length === 0) {
  const setResult = tryRunGit(["config", "--local", "core.hooksPath", ".githooks"]);
  if (!setResult.ok) {
    process.exit(0);
  }
}

const effectiveHooksPath = tryRunGit(["config", "--local", "--get", "core.hooksPath"]);
if (effectiveHooksPath.ok) {
  ensureHooksDirExists(effectiveHooksPath.stdout);
}
