import { describe, expect, it } from "vitest";
import type { AgentRunnerConfig } from "../../src/config.js";
import {
  listReviewFollowupLabels,
  labelsForReviewFollowupState,
  resolveReviewFollowupActionRequiredLabel,
  resolveReviewFollowupWaitingLabel
} from "../../src/review-followup-labels.js";

function makeConfig(labels?: Partial<AgentRunnerConfig["labels"]>): AgentRunnerConfig {
  return {
    owner: "metyatech",
    repos: "all",
    workdirRoot: "D:/ghws",
    pollIntervalSeconds: 60,
    concurrency: 2,
    labels: {
      queued: "agent:queued",
      reviewFollowup: "agent:review-followup",
      running: "agent:running",
      done: "agent:done",
      failed: "agent:failed",
      needsUserReply: "agent:needs-user",
      ...labels
    },
    codex: {
      command: "codex",
      args: ["exec"],
      promptTemplate: "template"
    }
  };
}

describe("review-followup-labels", () => {
  it("derives waiting/action-required labels from reviewFollowup by default", () => {
    const config = makeConfig();
    expect(resolveReviewFollowupWaitingLabel(config)).toBe("agent:review-followup:waiting");
    expect(resolveReviewFollowupActionRequiredLabel(config)).toBe("agent:review-followup:action-required");
  });

  it("uses explicit waiting/action-required labels when configured", () => {
    const config = makeConfig({
      reviewFollowupWaiting: "agent:rf-waiting",
      reviewFollowupActionRequired: "agent:rf-action-required"
    });
    expect(resolveReviewFollowupWaitingLabel(config)).toBe("agent:rf-waiting");
    expect(resolveReviewFollowupActionRequiredLabel(config)).toBe("agent:rf-action-required");
  });

  it("lists all review follow-up labels without duplicates", () => {
    const config = makeConfig();
    expect(listReviewFollowupLabels(config)).toEqual([
      "agent:review-followup",
      "agent:review-followup:waiting",
      "agent:review-followup:action-required"
    ]);
  });

  it("returns desired labels for each state", () => {
    const config = makeConfig();
    expect(labelsForReviewFollowupState(config, "queued")).toEqual(["agent:review-followup"]);
    expect(labelsForReviewFollowupState(config, "waiting")).toEqual([
      "agent:review-followup",
      "agent:review-followup:waiting"
    ]);
    expect(labelsForReviewFollowupState(config, "action-required")).toEqual([
      "agent:review-followup:action-required"
    ]);
    expect(labelsForReviewFollowupState(config, "none")).toEqual([]);
  });
});
