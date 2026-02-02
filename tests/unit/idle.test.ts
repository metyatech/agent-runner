import { describe, expect, it } from "vitest";
import { chooseIdleTask, selectIdleRepos } from "../../src/idle.js";
import type { IdleHistory } from "../../src/idle.js";
import type { RepoInfo } from "../../src/github.js";

describe("selectIdleRepos", () => {
  it("respects cooldown and prioritizes oldest runs", () => {
    const repos: RepoInfo[] = [
      { owner: "metyatech", repo: "alpha" },
      { owner: "metyatech", repo: "beta" },
      { owner: "metyatech", repo: "gamma" }
    ];
    const history: IdleHistory = {
      taskCursor: 0,
      repos: {
        "metyatech/alpha": { lastRunAt: "2026-02-02T09:30:00Z", lastTask: "A" },
        "metyatech/beta": { lastRunAt: "2026-02-02T08:00:00Z", lastTask: "B" }
      }
    };
    const now = new Date("2026-02-02T10:00:00Z");
    const selected = selectIdleRepos(repos, history, 2, 60, now);

    expect(selected).toHaveLength(2);
    expect(selected[0].repo).toBe("gamma");
    expect(selected[1].repo).toBe("beta");
  });
});

describe("chooseIdleTask", () => {
  it("rotates tasks using the cursor", () => {
    const history: IdleHistory = {
      taskCursor: 0,
      repos: {}
    };
    const tasks = ["Task A", "Task B"];

    const first = chooseIdleTask(tasks, history);
    history.taskCursor = first.nextCursor;
    const second = chooseIdleTask(tasks, history);

    expect(first.task).toBe("Task A");
    expect(second.task).toBe("Task B");
  });
});
