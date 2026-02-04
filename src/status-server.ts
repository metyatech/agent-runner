import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { StatusSnapshot } from "./status-snapshot.js";
import { buildStatusSnapshot } from "./status-snapshot.js";

type StatusServerOptions = {
  workdirRoot: string;
  host: string;
  port: number;
};

function resolveAllowedPath(requested: string, workdirRoot: string): string | null {
  if (!requested) {
    return null;
  }
  const resolved = path.resolve(requested);
  const root = path.resolve(workdirRoot);
  if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
    return resolved;
  }
  return null;
}

function openPath(resolvedPath: string): void {
  if (!fs.existsSync(resolvedPath)) {
    return;
  }
  const child = spawn("explorer.exe", [resolvedPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

function renderHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Agent Runner Status</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f5f2ee;
        --panel: #ffffff;
        --ink: #111111;
        --muted: #5b5b5b;
        --accent: #1b1b1b;
        --ok: #1a7f37;
        --warn: #b54708;
      }
      body {
        margin: 0;
        background: radial-gradient(circle at 10% 10%, #f7eee5 0%, var(--bg) 45%, #efe7df 100%);
        color: var(--ink);
        font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
      }
      header {
        padding: 24px 32px 8px;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 16px;
      }
      h1 {
        margin: 0;
        font-size: 28px;
        letter-spacing: -0.02em;
      }
      .badge {
        padding: 6px 14px;
        border-radius: 999px;
        font-weight: 700;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .badge.running {
        background: #e7f5ec;
        color: var(--ok);
        border: 1px solid #b8e2c4;
      }
      .badge.idle {
        background: #f8e9e0;
        color: var(--warn);
        border: 1px solid #f2c6ad;
      }
      .badge.paused {
        background: #efe6ff;
        color: #4b2fa3;
        border: 1px solid #d4c6ff;
      }
      .meta {
        color: var(--muted);
        font-size: 13px;
      }
      .control {
        padding: 8px 14px;
        border-radius: 999px;
        border: 1px solid #d0d0d0;
        background: #ffffff;
        color: var(--accent);
        font-weight: 700;
        font-size: 12px;
        cursor: pointer;
      }
      .control:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .wrap {
        padding: 0 32px 32px;
        display: grid;
        gap: 20px;
      }
      .panel {
        background: var(--panel);
        border-radius: 16px;
        padding: 16px;
        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.05);
      }
      .panel h2 {
        margin: 0 0 12px;
        font-size: 18px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      th, td {
        text-align: left;
        padding: 8px 6px;
        border-bottom: 1px solid #efefef;
        vertical-align: top;
      }
      th {
        color: var(--muted);
        font-weight: 600;
      }
      code {
        font-family: "Cascadia Mono", "Consolas", monospace;
        font-size: 12px;
        background: #f3f3f3;
        padding: 2px 6px;
        border-radius: 6px;
      }
      ul {
        margin: 0;
        padding-left: 18px;
        color: var(--muted);
      }
      .empty {
        color: var(--muted);
        font-size: 13px;
      }
      @media (max-width: 900px) {
        header, .wrap {
          padding-left: 16px;
          padding-right: 16px;
        }
        table {
          display: block;
          overflow-x: auto;
        }
      }
    </style>
  </head>
  <body>
    <header>
      <h1>Agent Runner Status</h1>
      <span id="statusBadge" class="badge idle">Idle</span>
      <div class="meta">
        Updated: <span id="generatedAt">-</span><br />
        Workdir: <code id="workdir">-</code><br />
      </div>
    </header>
    <div class="wrap">
      <section class="panel">
        <h2>Running Tasks</h2>
        <div id="runningEmpty" class="empty">No active tasks.</div>
        <table id="runningTable" hidden>
          <thead>
            <tr>
              <th>Kind</th>
              <th>Repo</th>
              <th>Issue</th>
              <th>Task</th>
              <th>PID</th>
              <th>Age (min)</th>
              <th>Started</th>
              <th>Log</th>
            </tr>
          </thead>
          <tbody id="runningBody"></tbody>
        </table>
      </section>
      <section class="panel">
        <h2>Stale Records</h2>
        <div id="staleEmpty" class="empty">No stale records.</div>
        <table id="staleTable" hidden>
          <thead>
            <tr>
              <th>Kind</th>
              <th>Repo</th>
              <th>Issue</th>
              <th>Task</th>
              <th>PID</th>
              <th>Age (min)</th>
              <th>Started</th>
              <th>Log</th>
            </tr>
          </thead>
          <tbody id="staleBody"></tbody>
        </table>
      </section>
      <section class="panel">
        <h2>Latest Logs</h2>
        <ul id="latestLogsList"></ul>
      </section>
      <section class="panel">
        <h2>Recent Logs</h2>
        <ul id="logsList"></ul>
      </section>
      <section class="panel">
        <h2>Recent Reports</h2>
        <ul id="reportsList"></ul>
      </section>
    </div>
    <script>
      const statusBadge = document.getElementById("statusBadge");
      const generatedAt = document.getElementById("generatedAt");
      const workdir = document.getElementById("workdir");
      const runningTable = document.getElementById("runningTable");
      const runningBody = document.getElementById("runningBody");
      const runningEmpty = document.getElementById("runningEmpty");
      const staleTable = document.getElementById("staleTable");
      const staleBody = document.getElementById("staleBody");
      const staleEmpty = document.getElementById("staleEmpty");
      const latestLogsList = document.getElementById("latestLogsList");
      const logsList = document.getElementById("logsList");
      const reportsList = document.getElementById("reportsList");

      const formatLocal = (value) => {
        if (!value) return "-";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return value;
        return date.toLocaleString(undefined, { timeZoneName: "short" });
      };

      const openPath = (pathValue) => {
        if (!pathValue) return;
        const url = "/open?path=" + encodeURIComponent(pathValue);
        fetch(url, { method: "POST" }).catch(() => {});
      };

      const buildLink = (pathValue) => {
        const link = document.createElement("a");
        link.href = "/open?path=" + encodeURIComponent(pathValue);
        link.textContent = pathValue;
        link.addEventListener("click", (event) => {
          event.preventDefault();
          openPath(pathValue);
        });
        return link;
      };

      const renderRows = (target, rows) => {
        target.textContent = "";
        rows.forEach((row) => {
          const tr = document.createElement("tr");
          const kindLabel = row.engine ? row.kind + " (" + row.engine + ")" : row.kind;
          const cells = [
            { value: kindLabel },
            { value: row.repo ? row.repo.owner + "/" + row.repo.repo : "-" },
            { value: row.issueNumber ? "#" + row.issueNumber : "-" },
            { value: row.task || "-" },
            { value: row.pid || "-" },
            { value: row.ageMinutes != null ? row.ageMinutes.toFixed(1) : "-" },
            { value: row.startedAtLocal || formatLocal(row.startedAt) },
            { value: row.logPath || "-", link: row.logPath }
          ];
          cells.forEach((cell) => {
            const td = document.createElement("td");
            if (cell.link) {
              td.appendChild(buildLink(cell.link));
            } else {
              td.textContent = String(cell.value);
            }
            tr.appendChild(td);
          });
          target.appendChild(tr);
        });
      };

      const renderList = (target, rows) => {
        target.textContent = "";
        if (!rows.length) {
          const li = document.createElement("li");
          li.textContent = "None";
          target.appendChild(li);
          return;
        }
        rows.forEach((row) => {
          const li = document.createElement("li");
          const updated = row.updatedAtLocal || formatLocal(row.updatedAt);
          li.appendChild(buildLink(row.path));
          const time = document.createElement("span");
          time.textContent = " (" + updated + ")";
          li.appendChild(time);
          target.appendChild(li);
        });
      };

      const renderLatestLogs = (target, snapshot) => {
        const rows = [
          { label: "task-run", file: snapshot.latestTaskRun },
          { label: "idle", file: snapshot.latestIdle }
        ];
        target.textContent = "";
        rows.forEach((row) => {
          const li = document.createElement("li");
          const label = document.createElement("strong");
          label.textContent = row.label + ": ";
          li.appendChild(label);
          if (!row.file || !row.file.path) {
            li.appendChild(document.createTextNode("None"));
            target.appendChild(li);
            return;
          }
          const updated = row.file.updatedAtLocal || formatLocal(row.file.updatedAt);
          li.appendChild(buildLink(row.file.path));
          const time = document.createElement("span");
          time.textContent = " (" + updated + ")";
          li.appendChild(time);
          target.appendChild(li);
        });
      };

      async function refresh() {
        try {
          const res = await fetch("/api/status");
          if (!res.ok) {
            throw new Error("status fetch failed");
          }
          const data = await res.json();
          const stopRequested = Boolean(data.stopRequested);
          let label = "Idle";
          let style = "idle";
          if (data.busy) {
            label = stopRequested ? "Running (stop requested)" : "Running";
            style = "running";
          } else if (stopRequested) {
            label = "Paused";
            style = "paused";
          }
          statusBadge.textContent = label;
          statusBadge.className = "badge " + style;
          generatedAt.textContent = data.generatedAtLocal || formatLocal(data.generatedAt);
          workdir.textContent = data.workdirRoot || "-";

          renderRows(runningBody, data.running || []);
          runningTable.hidden = !(data.running && data.running.length);
          runningEmpty.hidden = data.running && data.running.length;

          renderRows(staleBody, data.stale || []);
          staleTable.hidden = !(data.stale && data.stale.length);
          staleEmpty.hidden = data.stale && data.stale.length;

          renderLatestLogs(latestLogsList, data || {});
          renderList(logsList, data.logs || []);
          renderList(reportsList, data.reports || []);
        } catch (error) {
          statusBadge.textContent = "Error";
          statusBadge.className = "badge idle";
        }
      }

      refresh();
      setInterval(refresh, 5000);
    </script>
  </body>
</html>`;
}

function sendJson(
  res: http.ServerResponse,
  payload: StatusSnapshot
): void {
  const body = JSON.stringify(payload, null, 2);
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

function sendHtml(res: http.ServerResponse): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(renderHtml());
}

export function startStatusServer(options: StatusServerOptions): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/status") {
      sendJson(res, buildStatusSnapshot(options.workdirRoot));
      return;
    }
    if (url.pathname === "/open") {
      const requested = url.searchParams.get("path") ?? "";
      const resolved = resolveAllowedPath(requested, options.workdirRoot);
      if (!resolved) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Invalid path.");
        return;
      }
      if (!fs.existsSync(resolved)) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Not found.");
        return;
      }
      openPath(resolved);
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end("Opened.");
      return;
    }
    if (url.pathname === "/") {
      sendHtml(res);
      return;
    }
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not found.");
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(options.port, options.host, () => resolve(server));
  });
}
