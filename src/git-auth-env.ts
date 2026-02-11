import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let askpassCmdPath: string | null = null;

function ensureAskPassCommand(): string {
  if (askpassCmdPath) {
    return askpassCmdPath;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-git-askpass-"));
  const jsPath = path.join(dir, "askpass.js");
  const cmdPath = path.join(dir, "askpass.cmd");

  fs.writeFileSync(
    jsPath,
    [
      "const prompt = process.argv.slice(2).join(' ');",
      "if (/username/i.test(prompt)) {",
      "  process.stdout.write('x-access-token');",
      "} else {",
      "  process.stdout.write(process.env.AGENT_RUNNER_GIT_TOKEN ?? '');",
      "}"
    ].join("\n"),
    "utf8"
  );

  fs.writeFileSync(cmdPath, `@echo off\r\nnode "${jsPath}" %*\r\n`, "utf8");

  askpassCmdPath = cmdPath;
  return cmdPath;
}

export function buildGitAuthEnv(base: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  if (!token) {
    return { ...base };
  }

  const askpass = ensureAskPassCommand();
  return {
    ...base,
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    AGENT_RUNNER_GIT_TOKEN: token,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: askpass
  };
}
