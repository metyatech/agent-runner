import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

describe("loadConfig", () => {
  it("loads schema independent of current working directory", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-config-"));
    const configPath = path.join(tempDir, "agent-runner.config.json");

    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          owner: "metyatech",
          repos: "all",
          workdirRoot: "D:\\ghws",
          pollIntervalSeconds: 60,
          concurrency: 1,
          idle: {
            enabled: true,
            maxRunsPerCycle: 1,
            cooldownMinutes: 60,
            tasks: [
              "Bring the repo into compliance with AGENTS.md and project docs/standards. Identify the highest-impact gap, fix it, and update docs/tests as needed. If nothing meaningful is needed, exit."
            ],
            repoScope: "local",
            promptTemplate: "Idle {{repo}} {{task}}",
            usageGate: {
              enabled: true,
              command: "codex",
              args: [],
              timeoutSeconds: 20,
              minRemainingPercent: {
                fiveHour: 50
              },
            weeklySchedule: {
              startMinutes: 1440,
              minRemainingPercentAtStart: 100,
              minRemainingPercentAtEnd: 0
            }
            }
          },
          labels: {
            request: "agent:request",
            queued: "agent:queued",
            running: "agent:running",
            done: "agent:done",
            failed: "agent:failed",
            needsUser: "agent:needs-user"
          },
          codex: {
            command: "codex",
            args: ["exec", "--help"],
            promptTemplate: "Template {{repos}} {{task}}"
          }
        },
        null,
        2
      ),
      "utf8"
    );

    try {
      const repoRoot = path.resolve(".");
      const scriptPath = path.join(tempDir, "run-load-config.mjs");
      const configModulePath = path.join(repoRoot, "src", "config.ts");

      fs.writeFileSync(
        scriptPath,
        [
          "import process from 'node:process';",
          "import { pathToFileURL } from 'node:url';",
          "const [tempDir, configPath, configModulePath] = process.argv.slice(2);",
          "process.chdir(tempDir);",
          "const mod = await import(pathToFileURL(configModulePath).href);",
          "mod.loadConfig(configPath);",
          "console.log('OK');"
        ].join("\n"),
        "utf8"
      );

      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", scriptPath, tempDir, configPath, configModulePath],
        { encoding: "utf8", cwd: repoRoot }
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("OK");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
