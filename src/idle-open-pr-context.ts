import type { OpenPullRequestInfo } from "./github.js";

const MAX_TITLE_CHARS = 200;
const MAX_BODY_CHARS = 800;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars - 14)} …(truncated)…`;
}

function summarizeTitle(value: string): string {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return "(untitled)";
  }
  return truncate(normalized, MAX_TITLE_CHARS);
}

function summarizeBody(value: string | null): string {
  const normalized = normalizeWhitespace(value ?? "");
  if (!normalized) {
    return "No description.";
  }
  return truncate(normalized, MAX_BODY_CHARS);
}

export function buildIdleOpenPrContext(openPullRequests: OpenPullRequestInfo[]): string {
  if (openPullRequests.length === 0) {
    return "No open pull requests found in this repository.";
  }

  const lines: string[] = [];
  for (const pull of openPullRequests) {
    lines.push(`- #${pull.number} ${summarizeTitle(pull.title)}`);
    lines.push(`  URL: ${pull.url}`);
    lines.push(`  Summary: ${summarizeBody(pull.body)}`);
  }

  return lines.join("\n");
}

export function buildIdleDuplicateWorkGuard(openPrCount: number, openPrContextAvailable: boolean): string {
  const lines = [
    "Duplicate-work guard (required):",
    `- Existing open PR count in this repository: ${openPrCount}.`,
    "- Do NOT perform work that is the same as or substantially overlaps with any listed open PR.",
    "- If overlap is unavoidable, do not create a new PR; exit cleanly and explain the overlap in AGENT_RUNNER_SUMMARY."
  ];
  if (!openPrContextAvailable) {
    lines.push(
      "- Open PR context could not be fetched. Be conservative and avoid broad changes that might overlap in-progress work."
    );
  } else {
    lines.push("- If overlap is uncertain, treat it as overlap and choose a different safe task.");
  }
  return lines.join("\n");
}
