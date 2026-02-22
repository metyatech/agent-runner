export type ParsedIssue = {
  goal: string;
  scope: string;
  repoList: string[];
  constraints: string;
  acceptance: string;
};

const sectionTitles = new Map([
  ["Goal", "goal"],
  ["Scope", "scope"],
  ["Repository list (if applicable)", "repoList"],
  ["Constraints", "constraints"],
  ["Acceptance criteria", "acceptance"]
]);

export function parseIssueBody(body: string | null): ParsedIssue {
  const empty: ParsedIssue = {
    goal: "",
    scope: "",
    repoList: [],
    constraints: "",
    acceptance: ""
  };

  if (!body) {
    return empty;
  }

  const lines = body.split(/\r?\n/);
  const sections: Record<string, string[]> = {};
  let currentKey: string | null = null;

  for (const line of lines) {
    const headingMatch = line.match(/^###\s+(.*)$/);
    if (headingMatch) {
      const title = headingMatch[1].trim();
      const key = sectionTitles.get(title);
      if (key) {
        currentKey = key;
        sections[currentKey] = [];
      } else {
        currentKey = null;
      }
      continue;
    }

    if (currentKey) {
      sections[currentKey].push(line);
    }
  }

  const goal = (sections.goal ?? []).join("\n").trim();
  const scope = (sections.scope ?? []).join("\n").trim();
  const repoRaw = (sections.repoList ?? []).join("\n").trim();
  const constraints = (sections.constraints ?? []).join("\n").trim();
  const acceptance = (sections.acceptance ?? []).join("\n").trim();

  return {
    goal,
    scope,
    repoList: parseRepoList(repoRaw),
    constraints,
    acceptance
  };
}

export function parseRepoList(value: string): string[] {
  if (!value) {
    return [];
  }

  const normalized = value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .filter((entry) => !isPlaceholderRepoEntry(entry));

  return Array.from(new Set(normalized));
}

const placeholderRepoEntries = new Set(["no response", "_no response_", "n/a", "na", "none", "-"]);

function isPlaceholderRepoEntry(entry: string): boolean {
  const normalized = entry.toLowerCase();
  return placeholderRepoEntries.has(normalized);
}
