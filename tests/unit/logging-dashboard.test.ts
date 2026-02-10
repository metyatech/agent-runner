import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type DashboardTarget = {
  expr?: string;
};

type DashboardPanel = {
  type?: string;
  title?: string;
  targets?: DashboardTarget[];
};

function loadLogsPanel(): DashboardPanel {
  const dashboardPath = path.resolve(
    "ops",
    "logging",
    "grafana",
    "provisioning",
    "dashboards-json",
    "agent-runner-logs.json"
  );
  const raw = fs.readFileSync(dashboardPath, "utf8");
  const dashboard = JSON.parse(raw) as { panels?: DashboardPanel[] };
  const panel = dashboard.panels?.find((item) => item.type === "logs" && item.title === "Logs");
  if (!panel) {
    throw new Error("Logs panel not found in agent-runner-logs dashboard");
  }
  return panel;
}

describe("agent-runner logs dashboard query", () => {
  it("uses separate targets so tag filtering applies only to runner-out", () => {
    const panel = loadLogsPanel();
    const targets = panel.targets ?? [];

    expect(targets.length).toBe(2);
    expect(targets.every((target) => (target.expr ?? "").includes(" or "))).toBe(false);

    const runnerOutTarget = targets.find((target) => (target.expr ?? "").includes('kind="runner-out"'));
    const nonRunnerOutTarget = targets.find((target) =>
      (target.expr ?? "").includes('kind!="runner-out"')
    );

    expect(runnerOutTarget?.expr).toContain('tag=~"$tag"');
    expect(nonRunnerOutTarget?.expr ?? "").not.toContain('tag=~"$tag"');
  });
});
