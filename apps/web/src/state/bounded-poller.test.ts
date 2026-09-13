import { afterEach, describe, expect, it, vi } from "vitest";

import { startBoundedPoll } from "./bounded-poller.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("bounded provider polling", () => {
  it("keeps one request active while interval ticks elapse", async () => {
    vi.useFakeTimers();
    let resolveRequest: ((value: string) => void) | undefined;
    let requests = 0;
    const results: string[] = [];
    const poll = startBoundedPoll({
      intervalMs: 2_000,
      timeoutMs: 10_000,
      request: () => {
        requests += 1;
        return new Promise<string>((resolve) => {
          resolveRequest = resolve;
        });
      },
      onResult: (result) => results.push(result),
    });

    expect(requests).toBe(1);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(requests).toBe(1);
    resolveRequest?.("first");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(requests).toBe(2);
    expect(results).toEqual(["first"]);
    poll.stop();
  });

  it("aborts a timed-out request before a later interval retries", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    let active = 0;
    let maximumActive = 0;
    const poll = startBoundedPoll({
      intervalMs: 2_000,
      timeoutMs: 5_000,
      request: (signal) => {
        signals.push(signal);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            active -= 1;
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
      },
      onResult: () => undefined,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(signals).toHaveLength(2);
    expect(maximumActive).toBe(1);
    poll.stop();
  });

  it("allows terminal reconciliation to notify exactly once", async () => {
    vi.useFakeTimers();
    let journalEntryPresent = true;
    let notices = 0;
    const poll = startBoundedPoll({
      intervalMs: 2_000,
      timeoutMs: 5_000,
      request: async () => journalEntryPresent ? ["terminal"] : [],
      onResult: (results) => {
        if (results.includes("terminal") && journalEntryPresent) {
          journalEntryPresent = false;
          notices += 1;
        }
      },
    });

    await vi.advanceTimersByTimeAsync(8_000);
    expect(notices).toBe(1);
    poll.stop();
  });

  it("aborts active work and prevents retries after stop", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    let results = 0;
    const poll = startBoundedPoll({
      intervalMs: 2_000,
      timeoutMs: 5_000,
      request: (signal) => {
        signals.push(signal);
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(
            new DOMException("Aborted", "AbortError"),
          ), { once: true });
        });
      },
      onResult: () => {
        results += 1;
      },
    });

    poll.stop();
    expect(signals[0]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(signals).toHaveLength(1);
    expect(results).toBe(0);
  });
});
