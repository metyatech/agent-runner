import type { IssueInfo } from "./github.js";

type Labels = {
  queued: string;
  running: string;
  failed: string;
  needsUserReply: string;
};

type Logger = (level: "info" | "warn", message: string, data?: Record<string, unknown>) => void;

export type RecoverStalledIssueOptions = {
  issue: IssueInfo;
  reason: "dead_process" | "missing_state";
  pid?: number;
  dryRun: boolean;
  labels: Labels;
  webhookQueuePath: string | null;
  addLabel: (issue: IssueInfo, labels: string[]) => Promise<void>;
  removeLabel: (issue: IssueInfo, label: string) => Promise<void>;
  enqueueWebhookIssue: (queuePath: string, issue: IssueInfo) => Promise<boolean>;
  removeRunningIssue: (issueId: number) => void;
  removeActivity: (activityId: string) => void;
  clearRetry: (issueId: number) => void;
  log: Logger;
};

export async function recoverStalledIssue(options: RecoverStalledIssueOptions): Promise<void> {
  const baseData: Record<string, unknown> = {
    issue: options.issue.url,
    reason: options.reason
  };
  if (options.pid !== undefined) {
    baseData.pid = options.pid;
  }

  if (options.dryRun) {
    options.log("info", `Dry-run: would recover stalled issue ${options.issue.url}.`, baseData);
    return;
  }

  options.clearRetry(options.issue.id);
  options.removeRunningIssue(options.issue.id);
  options.removeActivity(`issue:${options.issue.id}`);

  await options.addLabel(options.issue, [options.labels.queued]);
  await options.removeLabel(options.issue, options.labels.running);
  await options.removeLabel(options.issue, options.labels.failed);
  await options.removeLabel(options.issue, options.labels.needsUserReply);

  if (options.webhookQueuePath) {
    await options.enqueueWebhookIssue(options.webhookQueuePath, options.issue);
  }

  options.log("info", "Recovered stalled running issue and re-queued.", baseData);
}
