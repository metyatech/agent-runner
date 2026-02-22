import type { IssueComment } from "./github.js";

export const AGENT_RUNNER_MARKER = "<!-- agent-runner -->";
export const NEEDS_USER_MARKER = "<!-- agent-runner:needs-user -->";

export function buildAgentComment(body: string, markers: string[] = []): string {
  const uniqueMarkers = [AGENT_RUNNER_MARKER, ...markers];
  return `${uniqueMarkers.join("\n")}\n${body}`;
}

export function findLastMarkerComment(
  comments: IssueComment[],
  marker: string
): IssueComment | null {
  let latest: IssueComment | null = null;
  for (const comment of comments) {
    if (!comment.body.includes(marker)) {
      continue;
    }
    if (!latest) {
      latest = comment;
      continue;
    }
    if (Date.parse(comment.createdAt) > Date.parse(latest.createdAt)) {
      latest = comment;
    }
  }
  return latest;
}

export function hasUserReplySince(comments: IssueComment[], marker: string): boolean {
  const anchor = findLastMarkerComment(comments, marker);
  if (!anchor) {
    return false;
  }
  const anchorTime = Date.parse(anchor.createdAt);
  return comments.some(
    (comment) =>
      !comment.body.includes(AGENT_RUNNER_MARKER) && Date.parse(comment.createdAt) > anchorTime
  );
}
