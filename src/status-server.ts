import http from "node:http";
import type { StatusSnapshot } from "./status-snapshot.js";
import { buildStatusSnapshot } from "./status-snapshot.js";

type StatusServerOptions = {
  workdirRoot: string;
  host: string;
  port: number;
};

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
        Workdir: <code id="workdir">-</code>
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
      const logsList = document.getElementById("logsList");
      const reportsList = document.getElementById("reportsList");

      const formatLocal = (value) => {
        if (!value) return "-";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return value;
        return date.toLocaleString();
      };

      const renderRows = (target, rows) => {
        target.textContent = "";
        rows.forEach((row) => {
          const tr = document.createElement("tr");
          const cells = [
            row.kind,
            row.repo ? row.repo.owner + "/" + row.repo.repo : "-",
            row.issueNumber ? "#" + row.issueNumber : "-",
            row.task || "-",
            row.pid || "-",
            row.ageMinutes != null ? row.ageMinutes.toFixed(1) : "-",
            formatLocal(row.startedAt),
            row.logPath || "-"
          ];
          cells.forEach((value) => {
            const td = document.createElement("td");
            td.textContent = String(value);
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
          li.textContent = row.path + " (" + formatLocal(row.updatedAt) + ")";
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
          generatedAt.textContent = formatLocal(data.generatedAt);
          workdir.textContent = data.workdirRoot || "-";

          renderRows(runningBody, data.running || []);
          runningTable.hidden = !(data.running && data.running.length);
          runningEmpty.hidden = data.running && data.running.length;

          renderRows(staleBody, data.stale || []);
          staleTable.hidden = !(data.stale && data.stale.length);
          staleEmpty.hidden = data.stale && data.stale.length;

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
