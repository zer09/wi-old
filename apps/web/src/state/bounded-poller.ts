export interface BoundedPollOptions<T> {
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly request: (signal: AbortSignal) => Promise<T>;
  readonly onResult: (result: T) => void;
  readonly onError?: (error: unknown) => void;
}

export interface BoundedPoll {
  stop(): void;
}

type PollOutcome<T> =
  | { readonly kind: "result"; readonly result: T }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "timeout" };

export function startBoundedPoll<T>(options: BoundedPollOptions<T>): BoundedPoll {
  let stopped = false;
  let active = false;
  let activeController: AbortController | null = null;

  const poll = async (): Promise<void> => {
    if (stopped || active) return;
    active = true;
    const controller = new AbortController();
    activeController = controller;
    let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
    const timeoutOutcome = new Promise<PollOutcome<T>>((resolve) => {
      timeout = globalThis.setTimeout(() => resolve({ kind: "timeout" }), options.timeoutMs);
    });
    const requestOutcome: Promise<PollOutcome<T>> = options.request(controller.signal).then(
      (result): PollOutcome<T> => ({ kind: "result", result }),
      (error: unknown): PollOutcome<T> => ({ kind: "error", error }),
    );

    try {
      const outcome = await Promise.race([requestOutcome, timeoutOutcome]);
      if (outcome.kind === "timeout") controller.abort();
      if (stopped) return;
      if (outcome.kind === "result") options.onResult(outcome.result);
      else if (outcome.kind === "error") options.onError?.(outcome.error);
      else options.onError?.(new Error("Provider polling request timed out."));
    } finally {
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
      if (activeController === controller) activeController = null;
      active = false;
    }
  };

  void poll();
  const interval = globalThis.setInterval(() => void poll(), options.intervalMs);
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      globalThis.clearInterval(interval);
      activeController?.abort();
    },
  };
}
