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
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--ink);
        font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
      }

      /* ── Hero Banner ── */
      .hero {
        padding: 28px 32px;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 16px;
        transition: background 0.4s;
      }
      .hero.running { background: #22c55e; color: #fff; }
      .hero.idle    { background: #b45309; color: #fff; }
      .hero.paused  { background: #8b5cf6; color: #fff; }
      .hero-title {
        font-size: 26px;
        font-weight: 700;
        letter-spacing: -0.02em;
      }
      .hero-sub {
        font-size: 13px;
        opacity: 0.85;
      }
      .hero-right {
        margin-left: auto;
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .pulse {
        width: 10px; height: 10px;
        border-radius: 50%;
        background: rgba(255,255,255,0.9);
        animation: pulse-ring 2s ease-in-out infinite;
      }
      @keyframes pulse-ring {
        0%, 100% { box-shadow: 0 0 0 0 rgba(255,255,255,0.5); }
        50%      { box-shadow: 0 0 0 6px rgba(255,255,255,0); }
      }
      @media (prefers-reduced-motion: reduce) {
        .hero {
          transition: none;
        }
        .pulse {
          animation: none;
        }
      }
      .hero-meta {
        font-size: 12px;
        opacity: 0.75;
      }

      /* ── Layout ── */
      .wrap {
        padding: 20px 32px 32px;
        display: grid;
        gap: 20px;
      }

      /* ── Panels ── */
      .panel {
        background: var(--panel);
        border-radius: 16px;
        padding: 16px 20px;
        box-shadow: 0 10px 25px rgba(0,0,0,0.05);
      }
      .panel h2 {
        margin: 0 0 12px;
        font-size: 18px;
      }
      .empty {
        color: var(--muted);
        font-size: 13px;
      }

      /* ── Task Cards ── */
      .card-grid {
        display: flex;
        flex-wrap: wrap;
        gap: 16px;
      }
      .task-card {
        flex: 1 1 320px;
        max-width: 480px;
        background: #fafafa;
        border: 1px solid #e5e5e5;
        border-radius: 14px;
        padding: 16px 18px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .card-header {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }
      .card-repo {
        font-size: 17px;
        font-weight: 700;
        letter-spacing: -0.01em;
      }
      .issue-badge {
        background: #111;
        color: #fff;
        font-weight: 700;
        font-size: 13px;
        padding: 2px 10px;
        border-radius: 999px;
      }
      .kind-tag {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        padding: 2px 8px;
        border-radius: 6px;
        background: #e8e8e8;
        color: var(--muted);
      }
      .card-task {
        font-size: 13px;
        color: var(--muted);
        line-height: 1.4;
      }
      .card-footer {
        display: flex;
        align-items: center;
        gap: 14px;
        margin-top: 4px;
        font-size: 13px;
      }
      .age { font-weight: 700; }
      .age.green  { color: #16a34a; }
      .age.yellow { color: #ca8a04; }
      .age.red    { color: #dc2626; }
      .card-footer a {
        color: var(--accent);
        text-decoration: underline;
        text-underline-offset: 2px;
        cursor: pointer;
        font-size: 12px;
      }

      /* ── Stale toggle ── */
      .stale-toggle {
        background: none;
        border: 1px solid #d0d0d0;
        border-radius: 8px;
        padding: 8px 14px;
        font-size: 13px;
        cursor: pointer;
        color: var(--muted);
        font-weight: 600;
      }
      .stale-toggle:hover { background: #f5f5f5; }
      .stale-details { margin-top: 12px; }
      .stale-details table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      .stale-details th, .stale-details td {
        text-align: left;
        padding: 6px;
        border-bottom: 1px solid #efefef;
        vertical-align: top;
      }
      .stale-details th {
        color: var(--muted);
        font-weight: 600;
      }

      /* ── Compact log list ── */
      .log-list {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .log-list li {
        padding: 5px 0;
        border-bottom: 1px solid #f0f0f0;
        font-size: 13px;
        display: flex;
        align-items: baseline;
        gap: 8px;
      }
      .log-list li:last-child { border-bottom: none; }
      .log-list a {
        color: var(--accent);
        text-decoration: underline;
        text-underline-offset: 2px;
        cursor: pointer;
        word-break: break-all;
      }
      .log-time {
        color: var(--muted);
        font-size: 12px;
        white-space: nowrap;
      }
      .log-label {
        font-weight: 600;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--muted);
        white-space: nowrap;
      }

      code {
        font-family: "Cascadia Mono", "Consolas", monospace;
        font-size: 12px;
        background: #f3f3f3;
        padding: 2px 6px;
        border-radius: 6px;
      }

      @media (max-width: 700px) {
        .hero, .wrap { padding-left: 16px; padding-right: 16px; }
        .task-card { max-width: 100%; }
        .hero-right { margin-left: 0; }
      }
    </style>
  </head>
  <body>
    <!-- Hero Banner -->
    <div id="hero" class="hero idle">
      <div>
        <div id="heroTitle" class="hero-title">Idle</div>
        <div id="heroSub" class="hero-sub"></div>
      </div>
      <div class="hero-right">
        <div class="pulse"></div>
        <div class="hero-meta">
          <span id="heroMeta"></span><br/>
          <code id="workdir" style="background:rgba(255,255,255,0.2);color:inherit;">-</code>
        </div>
      </div>
    </div>

    <div class="wrap">
      <!-- Running Tasks Cards -->
      <section class="panel">
        <h2>Running Tasks</h2>
        <div id="runningEmpty" class="empty">No active tasks.</div>
        <div id="cardGrid" class="card-grid"></div>
      </section>

      <!-- Stale Records (collapsed) -->
      <section class="panel" id="staleSection" hidden>
        <button id="staleToggle" class="stale-toggle" type="button" aria-controls="staleDetails" aria-expanded="false"></button>
        <div id="staleDetails" class="stale-details" hidden>
          <table>
            <thead>
              <tr>
                <th>Repo</th>
                <th>Issue</th>
                <th>Kind</th>
                <th>Age</th>
                <th>Log</th>
              </tr>
            </thead>
            <tbody id="staleBody"></tbody>
          </table>
        </div>
      </section>

      <!-- Logs & Reports -->
      <section class="panel">
        <h2>Logs</h2>
        <ul id="logsList" class="log-list"></ul>
      </section>
      <section class="panel">
        <h2>Reports</h2>
        <ul id="reportsList" class="log-list"></ul>
      </section>
      <section class="panel">
        <h2>Review Follow-ups</h2>
        <ul id="reviewFollowupsList" class="log-list"></ul>
      </section>
    </div>

    <script>
      const $ = (id) => document.getElementById(id);
      const hero = $("hero");
      const heroTitle = $("heroTitle");
      const heroSub = $("heroSub");
      const heroMeta = $("heroMeta");
      const workdir = $("workdir");
      const cardGrid = $("cardGrid");
      const runningEmpty = $("runningEmpty");
      const staleSection = $("staleSection");
      const staleToggle = $("staleToggle");
      const staleDetails = $("staleDetails");
      const staleBody = $("staleBody");
      const logsList = $("logsList");
      const reportsList = $("reportsList");
      const reviewFollowupsList = $("reviewFollowupsList");

      staleToggle.addEventListener("click", () => {
        staleDetails.hidden = !staleDetails.hidden;
        staleToggle.setAttribute("aria-expanded", String(!staleDetails.hidden));
        staleToggle.textContent = staleDetails.hidden
          ? staleToggle.dataset.label
          : staleToggle.dataset.label + " (click to collapse)";
      });

      const timeAgo = (isoStr) => {
        if (!isoStr) return "";
        const ts = new Date(isoStr).getTime();
        if (!Number.isFinite(ts)) return "";
        const diff = (Date.now() - ts) / 1000;
        if (diff < 0) return "just now";
        if (diff < 60) return Math.round(diff) + "s ago";
        const totalMinutes = Math.round(diff / 60);
        if (totalMinutes < 60) return totalMinutes + " min ago";
        if (totalMinutes < 1440) {
          const h = Math.floor(totalMinutes / 60);
          const m = totalMinutes % 60;
          return h + "h " + m + "min ago";
        }
        return Math.round(totalMinutes / 1440) + "d ago";
      };

      const humanAge = (minutes) => {
        if (minutes == null) return "-";
        if (minutes < 1) return "<1 min";
        if (minutes < 60) return Math.round(minutes) + " min";
        const total = Math.round(minutes);
        const h = Math.floor(total / 60);
        const m = total % 60;
        return h + "h " + m + "min";
      };

      const ageClass = (minutes) => {
        if (minutes == null) return "";
        if (minutes < 30) return "green";
        if (minutes <= 60) return "yellow";
        return "red";
      };

      const ageLevel = (minutes) => {
        if (minutes == null) return "Unknown";
        if (minutes < 30) return "Low";
        if (minutes <= 60) return "Medium";
        return "High";
      };

      const openPath = (pathValue) => {
        if (!pathValue) return;
        fetch("/open?path=" + encodeURIComponent(pathValue), { method: "POST" }).catch(() => {});
      };

      const makeLink = (pathValue, label) => {
        const a = document.createElement("a");
        const targetHref = "/open?path=" + encodeURIComponent(pathValue || "");
        a.href = targetHref;
        a.textContent = label || pathValue;
        a.addEventListener("click", (e) => { e.preventDefault(); openPath(pathValue); });
        return a;
      };

      const makeExternalLink = (url, label) => {
        const a = document.createElement("a");
        a.href = url || "";
        a.textContent = label || url || "-";
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        return a;
      };

      /* ── Render running task cards ── */
      const renderCards = (rows) => {
        cardGrid.textContent = "";
        runningEmpty.hidden = rows.length > 0;
        rows.forEach((row) => {
          const card = document.createElement("div");
          card.className = "task-card";

          const hdr = document.createElement("div");
          hdr.className = "card-header";

          const repo = document.createElement("span");
          repo.className = "card-repo";
          repo.textContent = row.repo ? row.repo.owner + "/" + row.repo.repo : "-";
          hdr.appendChild(repo);

          if (row.issueNumber) {
            const ib = document.createElement("span");
            ib.className = "issue-badge";
            ib.textContent = "#" + row.issueNumber;
            hdr.appendChild(ib);
          }

          const kindLabel = row.engine ? row.kind + "/" + row.engine : row.kind;
          const kt = document.createElement("span");
          kt.className = "kind-tag";
          kt.textContent = kindLabel;
          hdr.appendChild(kt);

          card.appendChild(hdr);

          if (row.task) {
            const desc = document.createElement("div");
            desc.className = "card-task";
            desc.textContent = row.task;
            card.appendChild(desc);
          }

          const footer = document.createElement("div");
          footer.className = "card-footer";

          const ageSp = document.createElement("span");
          ageSp.className = "age " + ageClass(row.ageMinutes);
          ageSp.textContent = ageLevel(row.ageMinutes) + " " + humanAge(row.ageMinutes);
          footer.appendChild(ageSp);

          if (row.logPath) {
            footer.appendChild(makeLink(row.logPath, "Open log"));
          }

          card.appendChild(footer);
          cardGrid.appendChild(card);
        });
      };

      /* ── Render stale table rows ── */
      const renderStale = (rows) => {
        const hadRows = !staleSection.hidden;
        staleSection.hidden = rows.length === 0;
        const label = rows.length + " stale record" + (rows.length === 1 ? "" : "s");
        staleToggle.dataset.label = label;
        if (rows.length === 0 || !hadRows) {
          staleDetails.hidden = true;
        }
        staleToggle.setAttribute("aria-expanded", String(!staleDetails.hidden));
        staleToggle.textContent = staleDetails.hidden ? label : label + " (click to collapse)";

        staleBody.textContent = "";
        rows.forEach((row) => {
          const tr = document.createElement("tr");
          const cells = [
            row.repo ? row.repo.owner + "/" + row.repo.repo : "-",
            row.issueNumber ? "#" + row.issueNumber : "-",
            row.engine ? row.kind + "/" + row.engine : row.kind,
            humanAge(row.ageMinutes)
          ];
          cells.forEach((v) => {
            const td = document.createElement("td");
            td.textContent = v;
            tr.appendChild(td);
          });
          const logTd = document.createElement("td");
          if (row.logPath) {
            logTd.appendChild(makeLink(row.logPath, "Open"));
          } else {
            logTd.textContent = "-";
          }
          tr.appendChild(logTd);
          staleBody.appendChild(tr);
        });
      };

      /* ── Render combined log list ── */
      const renderLogs = (target, latestTaskRun, latestIdle, recentLogs) => {
        target.textContent = "";

        const items = [];

        if (latestTaskRun && latestTaskRun.path) {
          items.push({ label: "task-run", path: latestTaskRun.path, time: latestTaskRun.updatedAt });
        }
        if (latestIdle && latestIdle.path) {
          items.push({ label: "idle", path: latestIdle.path, time: latestIdle.updatedAt });
        }
        (recentLogs || []).forEach((f) => {
          if (items.some((i) => i.path === f.path)) return;
          items.push({ path: f.path, time: f.updatedAt });
        });

        if (!items.length) {
          const li = document.createElement("li");
          li.textContent = "None";
          li.className = "empty";
          target.appendChild(li);
          return;
        }

        items.forEach((item) => {
          const li = document.createElement("li");
          if (item.label) {
            const lb = document.createElement("span");
            lb.className = "log-label";
            lb.textContent = item.label;
            li.appendChild(lb);
          }
          li.appendChild(makeLink(item.path, item.path));
          const ts = document.createElement("span");
          ts.className = "log-time";
          ts.textContent = timeAgo(item.time);
          li.appendChild(ts);
          target.appendChild(li);
        });
      };

      /* ── Render report list ── */
      const renderReports = (target, rows) => {
        target.textContent = "";
        if (!rows || !rows.length) {
          const li = document.createElement("li");
          li.textContent = "None";
          li.className = "empty";
          target.appendChild(li);
          return;
        }
        rows.forEach((row) => {
          const li = document.createElement("li");
          li.appendChild(makeLink(row.path, row.path));
          const ts = document.createElement("span");
          ts.className = "log-time";
          ts.textContent = timeAgo(row.updatedAt);
          li.appendChild(ts);
          target.appendChild(li);
        });
      };

      const renderReviewFollowups = (target, rows) => {
        target.textContent = "";
        if (!rows || !rows.length) {
          const li = document.createElement("li");
          li.textContent = "None";
          li.className = "empty";
          target.appendChild(li);
          return;
        }
        rows.forEach((row) => {
          const li = document.createElement("li");

          const mode = document.createElement("span");
          mode.className = "log-label";
          mode.textContent = row.requiresEngine ? "engine" : "merge-only";
          li.appendChild(mode);

          const reason = document.createElement("span");
          reason.className = "log-label";
          reason.textContent = row.reason || "review";
          li.appendChild(reason);

          const label =
            row.url ||
            (row.repo && row.prNumber
              ? row.repo.owner + "/" + row.repo.repo + "#" + row.prNumber
              : "review follow-up");
          li.appendChild(makeExternalLink(row.url, label));

          const wait = document.createElement("span");
          wait.className = "log-time";
          wait.textContent = row.waitMinutes == null ? "-" : humanAge(row.waitMinutes) + " queued";
          li.appendChild(wait);

          target.appendChild(li);
        });
      };

      async function refresh() {
        try {
          const res = await fetch("/api/status");
          if (!res.ok) throw new Error("status fetch failed");
          const data = await res.json();

          const stopRequested = Boolean(data.stopRequested);
          const running = data.running || [];
          let label, style;

          if (data.busy) {
            const n = running.length;
            label = "Running " + n + " task" + (n === 1 ? "" : "s");
            if (stopRequested) label += " (stop requested)";
            style = "running";
          } else if (stopRequested) {
            label = "Paused";
            style = "paused";
          } else {
            label = "Idle";
            style = "idle";
          }

          heroTitle.textContent = label;
          hero.className = "hero " + style;

          const activityAgo = timeAgo(data.activityUpdatedAt);
          heroSub.textContent = activityAgo ? "Last activity: " + activityAgo : "";

          heroMeta.textContent = "Updated: " + timeAgo(data.generatedAt);
          workdir.textContent = data.workdirRoot || "-";

          renderCards(running);
          renderStale(data.stale || []);
          renderLogs(logsList, data.latestTaskRun, data.latestIdle, data.logs);
          renderReports(reportsList, data.reports || []);
          renderReviewFollowups(reviewFollowupsList, data.reviewFollowups || []);
        } catch (error) {
          heroTitle.textContent = "Error";
          hero.className = "hero idle";
          heroSub.textContent = "";
          heroMeta.textContent = "";
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
