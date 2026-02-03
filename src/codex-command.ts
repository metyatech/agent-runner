import fs from "node:fs";
import path from "node:path";

function resolveWindowsCommand(command: string, pathValue: string | undefined): string {
  if (process.platform !== "win32") {
    return command;
  }

  if (path.extname(command) || command.includes("\\") || command.includes("/")) {
    return command;
  }

  const pathEntries = (pathValue ?? "").split(";");
  const fallbackEntries: string[] = [];
  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  const userProfile = process.env.USERPROFILE;
  const npmPrefix = process.env.npm_config_prefix ?? process.env.NPM_CONFIG_PREFIX;

  if (npmPrefix) {
    fallbackEntries.push(npmPrefix);
  }

  if (appData) {
    fallbackEntries.push(path.join(appData, "npm"));
  }

  if (localAppData) {
    fallbackEntries.push(path.join(localAppData, "npm"));
  }

  if (userProfile) {
    fallbackEntries.push(path.join(userProfile, "AppData", "Roaming", "npm"));
  }

  const searchEntries = Array.from(new Set([...pathEntries, ...fallbackEntries]));
  const cmdName = `${command}.cmd`;
  const exeName = `${command}.exe`;

  for (const entry of searchEntries) {
    if (!entry) {
      continue;
    }
    const cmdPath = path.join(entry, cmdName);
    if (fs.existsSync(cmdPath)) {
      return cmdPath;
    }
    const exePath = path.join(entry, exeName);
    if (fs.existsSync(exePath)) {
      return exePath;
    }
  }

  return command;
}

export function resolveCodexCommand(
  command: string,
  pathValue: string | undefined
): { command: string; prefixArgs: string[] } {
  const resolved = resolveWindowsCommand(command, pathValue);

  if (process.platform === "win32") {
    const base = path.basename(resolved).toLowerCase();
    if (base === "codex.cmd" || base === "codex.ps1") {
      const codexJs = path.join(
        path.dirname(resolved),
        "node_modules",
        "@openai",
        "codex",
        "bin",
        "codex.js"
      );
      if (fs.existsSync(codexJs)) {
        return { command: process.execPath, prefixArgs: [codexJs] };
      }
    }
    if (base === "gemini.cmd" || base === "gemini.ps1" || base === "gemini") {
      const geminiJs = path.join(
        path.dirname(resolved),
        "node_modules",
        "@google",
        "gemini-cli",
        "dist",
        "index.js"
      );
      if (fs.existsSync(geminiJs)) {
        return { command: process.execPath, prefixArgs: [geminiJs] };
      }
    }
  }

  return { command: resolved, prefixArgs: [] };
}
