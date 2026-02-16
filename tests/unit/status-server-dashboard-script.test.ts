import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import { startStatusServer } from "../../src/status-server.js";

type FetchScenario = {
  ok?: boolean;
  data?: unknown;
  error?: Error;
};

type DashboardExports = {
  timeAgo: (isoStr: string) => string;
  humanAge: (minutes: number | null) => string;
  renderCards: (rows: Array<Record<string, unknown>>) => void;
  renderStale: (rows: Array<Record<string, unknown>>) => void;
  renderLogs: (
    target: FakeElement,
    latestTaskRun: Record<string, unknown> | null,
    latestIdle: Record<string, unknown> | null,
    recentLogs: Array<Record<string, unknown>>
  ) => void;
  renderReports: (target: FakeElement, rows: Array<Record<string, unknown>>) => void;
  makeLink: (pathValue: string, label?: string) => FakeElement;
  refresh: () => Promise<void>;
};

class FakeElement {
  className = "";
  hidden = false;
  href = "";
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  private attributes: Record<string, string> = {};
  private listeners: Record<string, Array<(event: { preventDefault: () => void }) => void>> = {};
  private value = "";

  constructor(readonly id: string) {}

  get textContent(): string {
    return this.value;
  }

  set textContent(next: string) {
    this.value = String(next ?? "");
    this.children = [];
  }

  addEventListener(type: string, listener: (event: { preventDefault: () => void }) => void): void {
    this.listeners[type] ??= [];
    this.listeners[type].push(listener);
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  dispatch(type: string): void {
    for (const listener of this.listeners[type] ?? []) {
      listener({ preventDefault: () => {} });
    }
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = String(value);
  }

  getAttribute(name: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? this.attributes[name]
      : null;
  }
}

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
  });
}

async function loadDashboardScript(): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runner-ui-"));
  const server = await startStatusServer({
    workdirRoot: root,
    host: "127.0.0.1",
    port: 0
  });

  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP address.");
    }
    const html = await fetchText(`http://127.0.0.1:${address.port}/`);
    const match = html.match(/<script>([\s\S]*?)<\/script>/);
    if (!match) {
      throw new Error("Expected inline dashboard script.");
    }
    return match[1];
  } finally {
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}

function instrumentDashboardScript(script: string): string {
  return script.replace(
    /refresh\(\);\s*setInterval\(\s*refresh\s*,\s*[\d_]+\s*\);\s*/,
    "globalThis.__testExports = { timeAgo, humanAge, renderCards, renderStale, renderLogs, renderReports, makeLink, refresh };\n"
  );
}

async function createDashboardRuntime(scenarios: FetchScenario[] = []): Promise<{
  api: DashboardExports;
  elements: Record<string, FakeElement>;
}> {
  const script = await loadDashboardScript();
  const instrumented = instrumentDashboardScript(script);
  if (!instrumented.includes("__testExports")) {
    throw new Error("Failed to instrument dashboard script for tests.");
  }

  const ids = [
    "hero",
    "heroTitle",
    "heroSub",
    "heroMeta",
    "workdir",
    "cardGrid",
    "runningEmpty",
    "staleSection",
    "staleToggle",
    "staleDetails",
    "staleBody",
    "logsList",
    "reportsList",
    "reviewFollowupsList"
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement(id)])) as Record<string, FakeElement>;
  elements.staleSection.hidden = true;
  elements.staleDetails.hidden = true;
  const queue = [...scenarios];

  const context = createContext({
    document: {
      getElementById(id: string): FakeElement {
        const element = elements[id];
        if (!element) {
          throw new Error(`Unknown element id: ${id}`);
        }
        return element;
      },
      createElement(tagName: string): FakeElement {
        return new FakeElement(tagName);
      }
    },
    fetch: async (): Promise<{ ok: boolean; json: () => Promise<unknown> }> => {
      const next = queue.shift();
      if (!next) {
        throw new Error("No queued fetch response.");
      }
      if (next.error) {
        throw next.error;
      }
      return {
        ok: next.ok ?? true,
        json: async () => next.data
      };
    },
    setInterval: (): number => 1,
    clearInterval: (): void => {},
    Date,
    Math,
    console
  });

  runInContext(instrumented, context);
  const api = (context as { __testExports?: DashboardExports }).__testExports;
  if (!api) {
    throw new Error("Test exports were not set.");
  }
  return { api, elements };
}

describe("status-server dashboard script regressions", () => {
  it("cleans up temporary workdir after loading dashboard script", async () => {
    const rmSpy = vi.spyOn(fs, "rmSync");
    try {
      await loadDashboardScript();
      const cleanupCall = rmSpy.mock.calls.find(
        ([target, options]) =>
          typeof target === "string" &&
          target.includes(`${path.sep}agent-runner-ui-`) &&
          options &&
          typeof options === "object" &&
          "recursive" in options &&
          "force" in options
      );
      expect(cleanupCall).toBeDefined();
      expect(cleanupCall?.[1]).toEqual({ recursive: true, force: true });
    } finally {
      rmSpy.mockRestore();
    }
  });

  it("instrumentation tolerates whitespace around setInterval arguments", () => {
    const source = `
function timeAgo() {}
function humanAge() {}
function renderCards() {}
function renderStale() {}
async function refresh() {}
refresh();
setInterval( refresh , 5_000 );
`;
    const instrumented = instrumentDashboardScript(source);
    expect(instrumented).toContain("__testExports");
  });

  it("renders running cards with key fields", async () => {
    const { api, elements } = await createDashboardRuntime();
    const rows: Array<Record<string, unknown>> = [
      {
        repo: { owner: "metyatech", repo: "agent-runner" },
        issueNumber: 10,
        kind: "task",
        engine: "codex",
        task: "Handle dashboard comments",
        ageMinutes: 8.4,
        logPath: "C:/tmp/task.log"
      },
      {
        repo: { owner: "metyatech", repo: "agent-runner" },
        kind: "task",
        ageMinutes: 61
      }
    ];

    api.renderCards(rows);
    expect(elements.runningEmpty.hidden).toBe(true);
    expect(elements.cardGrid.children).toHaveLength(2);

    const firstCard = elements.cardGrid.children[0];
    const firstHeader = firstCard.children[0];
    const firstFooter = firstCard.children[firstCard.children.length - 1];
    const firstAge = firstFooter.children[0];
    expect(
      firstHeader.children.some((child) => child.className === "issue-badge" && child.textContent === "#10")
    ).toBe(true);
    expect(firstFooter.children.some((child) => child.textContent === "Open log")).toBe(true);
    expect(firstAge.textContent).toMatch(/^Low\s/);

    const secondCard = elements.cardGrid.children[1];
    const secondHeader = secondCard.children[0];
    expect(secondHeader.children.some((child) => child.className === "issue-badge")).toBe(false);

    api.renderCards([]);
    expect(elements.runningEmpty.hidden).toBe(false);
    expect(elements.cardGrid.children).toHaveLength(0);
  });

  it("makeLink keeps a functional href for graceful fallback", async () => {
    const { api } = await createDashboardRuntime();
    const link = api.makeLink("C:/tmp/task.log", "Open log");
    expect(link.href).toBe("/open?path=C%3A%2Ftmp%2Ftask.log");
    expect(link.textContent).toBe("Open log");
  });

  it("humanAge normalizes rounding at hour boundaries", async () => {
    const { api } = await createDashboardRuntime();
    expect(api.humanAge(119.9)).toBe("2h 0min");
  });

  it("timeAgo returns empty string for invalid timestamps", async () => {
    const { api } = await createDashboardRuntime();
    expect(api.timeAgo("not-a-date")).toBe("");
  });

  it("timeAgo avoids 60-minute remainders after rounding", async () => {
    const { api } = await createDashboardRuntime();
    const almostTwoHoursAgo = new Date(Date.now() - 7199 * 1000).toISOString();
    expect(api.timeAgo(almostTwoHoursAgo)).toBe("2h 0min ago");
  });

  it("preserves stale panel expansion across refresh renders", async () => {
    const { api, elements } = await createDashboardRuntime();
    const staleRows: Array<Record<string, unknown>> = [
      {
        repo: { owner: "metyatech", repo: "agent-runner" },
        issueNumber: 10,
        kind: "task",
        engine: "codex",
        ageMinutes: 125.2,
        logPath: "C:/tmp/task.log"
      }
    ];

    api.renderStale(staleRows);
    expect(elements.staleDetails.hidden).toBe(true);

    elements.staleDetails.hidden = false;
    api.renderStale(staleRows);
    expect(elements.staleDetails.hidden).toBe(false);
  });

  it("syncs stale toggle aria-expanded with details visibility", async () => {
    const { api, elements } = await createDashboardRuntime();
    const staleRows: Array<Record<string, unknown>> = [
      {
        repo: { owner: "metyatech", repo: "agent-runner" },
        kind: "task",
        ageMinutes: 12
      }
    ];

    api.renderStale(staleRows);
    expect(elements.staleToggle.getAttribute("aria-expanded")).toBe("false");

    elements.staleToggle.dispatch("click");
    expect(elements.staleDetails.hidden).toBe(false);
    expect(elements.staleToggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("renderLogs deduplicates entries and renders labels and timestamps", async () => {
    const { api, elements } = await createDashboardRuntime();
    const now = new Date().toISOString();

    api.renderLogs(
      elements.logsList,
      { path: "C:/tmp/task.log", updatedAt: now },
      { path: "C:/tmp/idle.log", updatedAt: now },
      [
        { path: "C:/tmp/task.log", updatedAt: now },
        { path: "C:/tmp/other.log", updatedAt: now }
      ]
    );

    expect(elements.logsList.children).toHaveLength(3);
    const linkTexts = elements.logsList.children
      .map((li) => li.children.find((child) => child.href)?.textContent)
      .filter((value): value is string => typeof value === "string");
    expect(linkTexts.filter((value) => value === "C:/tmp/task.log")).toHaveLength(1);
    expect(
      elements.logsList.children[0].children.some(
        (child) => child.className === "log-label" && child.textContent === "task-run"
      )
    ).toBe(true);
    expect(
      elements.logsList.children[0].children.some(
        (child) => child.className === "log-time" && child.textContent.length > 0
      )
    ).toBe(true);
  });

  it("renderReports handles empty and populated rows", async () => {
    const { api, elements } = await createDashboardRuntime();

    api.renderReports(elements.reportsList, []);
    expect(elements.reportsList.children).toHaveLength(1);
    expect(elements.reportsList.children[0].textContent).toBe("None");

    const now = new Date().toISOString();
    api.renderReports(elements.reportsList, [{ path: "C:/tmp/report.json", updatedAt: now }]);
    expect(elements.reportsList.children).toHaveLength(1);
    expect(
      elements.reportsList.children[0].children.some(
        (child) => child.href === "/open?path=C%3A%2Ftmp%2Freport.json"
      )
    ).toBe(true);
    expect(
      elements.reportsList.children[0].children.some(
        (child) => child.className === "log-time" && child.textContent.length > 0
      )
    ).toBe(true);
  });

  it("clears hero metadata when refresh fails after a successful render", async () => {
    const now = new Date().toISOString();
    const { api, elements } = await createDashboardRuntime([
      {
        data: {
          stopRequested: false,
          busy: false,
          running: [],
          stale: [],
          latestTaskRun: null,
          latestIdle: null,
          logs: [],
          reports: [],
          activityUpdatedAt: now,
          generatedAt: now,
          workdirRoot: "D:/ghws/agent-runner"
        }
      },
      { error: new Error("status fetch failed") }
    ]);

    await api.refresh();
    expect(elements.heroSub.textContent).toContain("Last activity:");
    expect(elements.heroMeta.textContent).toContain("Updated:");

    await api.refresh();
    expect(elements.heroTitle.textContent).toBe("Error");
    expect(elements.heroSub.textContent).toBe("");
    expect(elements.heroMeta.textContent).toBe("");
  });
});
