import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readRepoFile(...segments: string[]): string {
  return fs.readFileSync(path.join(process.cwd(), ...segments), "utf8");
}

describe("logging config", () => {
  it("applies runner-out parsing stages only to matching bracketed lines", () => {
    const promtail = readRepoFile("ops", "logging", "promtail-config.yml");
    const runnerOutStart = promtail.indexOf("  - job_name: agent-runner-runner-out");
    const runnerErrStart = promtail.indexOf("  - job_name: agent-runner-runner-err");

    expect(runnerOutStart).toBeGreaterThan(-1);
    expect(runnerErrStart).toBeGreaterThan(runnerOutStart);

    const runnerOutBlock = promtail.slice(runnerOutStart, runnerErrStart);
    expect(runnerOutBlock).toContain("- match:");
    expect(runnerOutBlock).toContain("selector: '{job=\"agent-runner\", kind=\"runner-out\"} |~ ");
    expect(runnerOutBlock).toContain("stages:");
    expect(runnerOutBlock).toContain("source: msg");
  });

  it("uses a selector that keeps optional BOM-prefixed bracketed lines eligible for parsing", () => {
    const promtail = readRepoFile("ops", "logging", "promtail-config.yml");
    const selectorPattern = "selector: '{job=\"agent-runner\", kind=\"runner-out\"} |~ \"\\\\[[^\\\\]]+\\\\]\\\\s+\\\\[[A-Z]+\\\\]\\\\s+\"'";

    expect(promtail).toContain(selectorPattern);
    expect(promtail).not.toContain("selector: '{job=\"agent-runner\", kind=\"runner-out\"} |~ \"^(?:\\\\uFEFF)?");
  });

  it("assigns a default tag label to runner-out logs that bypass parsing", () => {
    const promtail = readRepoFile("ops", "logging", "promtail-config.yml");
    const runnerOutStart = promtail.indexOf("  - job_name: agent-runner-runner-out");
    const runnerErrStart = promtail.indexOf("  - job_name: agent-runner-runner-err");
    const runnerOutBlock = promtail.slice(runnerOutStart, runnerErrStart);

    expect(runnerOutBlock).toContain("tag: untagged");
  });

  it("filters by tag only for runner-out logs in the Grafana query", () => {
    const dashboardText = readRepoFile(
      "ops",
      "logging",
      "grafana",
      "provisioning",
      "dashboards-json",
      "agent-runner-logs.json"
    );
    const dashboard = JSON.parse(dashboardText) as {
      panels?: Array<{ id?: number; targets?: Array<{ refId?: string; expr?: string }> }>;
    };

    const logsPanel = dashboard.panels?.find((panel) => panel.id === 1);
    const runnerOutExpr = logsPanel?.targets?.find((target) => target.refId === "A")?.expr ?? "";
    const nonRunnerOutExpr = logsPanel?.targets?.find((target) => target.refId === "B")?.expr ?? "";

    expect(runnerOutExpr).toContain("kind=\"runner-out\"");
    expect(runnerOutExpr).toContain("tag=~\"$tag\"");
    expect(nonRunnerOutExpr).toContain("kind!=\"runner-out\"");
    expect(nonRunnerOutExpr).not.toContain("tag=~\"$tag\"");
  });

  it("includes untagged in the dashboard Tag variable values", () => {
    const dashboardText = readRepoFile(
      "ops",
      "logging",
      "grafana",
      "provisioning",
      "dashboards-json",
      "agent-runner-logs.json"
    );
    const dashboard = JSON.parse(dashboardText) as {
      templating?: { list?: Array<{ name?: string; query?: string }> };
    };
    const tagVariable = dashboard.templating?.list?.find((entry) => entry.name === "tag");
    const query = tagVariable?.query ?? "";

    expect(query.split(",")).toContain("untagged");
  });
});
