export type AgentCommand =
  | {
      kind: "run";
      raw: string;
    };

const RUN_PATTERN = /^\s*\/agent\s+run\b/i;

export function parseAgentCommand(body: string | null | undefined): AgentCommand | null {
  if (!body) {
    return null;
  }
  for (const line of body.split(/\r?\n/)) {
    if (RUN_PATTERN.test(line)) {
      return { kind: "run", raw: line.trim() };
    }
  }
  return null;
}

const ALLOWED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export function isAllowedAuthorAssociation(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }
  return ALLOWED_ASSOCIATIONS.has(value.toUpperCase());
}

