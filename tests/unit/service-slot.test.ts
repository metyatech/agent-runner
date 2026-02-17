import pLimit from "p-limit";
import { describe, expect, it } from "vitest";
import { runWithServiceSlot } from "../../src/service-slot.js";

describe("runWithServiceSlot", () => {
  it("does not execute beforeStart until a service slot is acquired", async () => {
    const limiter = pLimit(1);
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = runWithServiceSlot(limiter, {
      beforeStart: async () => {
        events.push("first:before");
      },
      task: async () => {
        events.push("first:task:start");
        await firstGate;
        events.push("first:task:end");
        return "first";
      }
    });

    await Promise.resolve();
    await Promise.resolve();

    const second = runWithServiceSlot(limiter, {
      beforeStart: async () => {
        events.push("second:before");
      },
      task: async () => {
        events.push("second:task");
        return "second";
      }
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(events).toContain("first:before");
    expect(events).toContain("first:task:start");
    expect(events).not.toContain("second:before");

    releaseFirst();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe("first");
    expect(secondResult).toBe("second");

    const firstTaskEndIndex = events.indexOf("first:task:end");
    const secondBeforeIndex = events.indexOf("second:before");
    expect(firstTaskEndIndex).toBeGreaterThan(-1);
    expect(secondBeforeIndex).toBeGreaterThan(firstTaskEndIndex);
  });

  it("stops before task execution when beforeStart fails", async () => {
    const limiter = pLimit(1);
    const task = async () => "ok";
    const beforeStart = async () => {
      throw new Error("before-start failed");
    };

    await expect(runWithServiceSlot(limiter, { beforeStart, task })).rejects.toThrow(
      "before-start failed"
    );
  });
});
