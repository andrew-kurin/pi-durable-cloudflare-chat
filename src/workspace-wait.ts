/** Model-facing observation of an existing run. Never activates or dispatches work. */
export interface WorkspaceWaitInput {
  workspaceId: string;
  runId: string;
  waitMs?: number;
}
interface Snapshot {
  id: string;
  phase: string;
  active?: string;
  process?: { state: string; exitCode?: number };
  runs?: Record<string, { state: string; exitCode?: number; deadline: number }>;
  deadline?: number;
  remaining?: { taskMs: number };
  activation?: { mode: string };
}
interface WaitOptions {
  signal?: AbortSignal;
  deadline?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
export function waitDelay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Wait cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
export async function waitForWorkspaceRun(
  read: () => Promise<unknown>,
  input: WorkspaceWaitInput,
  options: WaitOptions = {},
) {
  const duration = input.waitMs ?? 20000;
  if (!Number.isInteger(duration) || duration < 10000 || duration > 30000)
    throw Error("Wait must be 10–30 seconds");
  if (
    !/^[a-f0-9-]{36}$/.test(input.workspaceId) ||
    !/^[a-f0-9]{64}$/.test(input.runId)
  )
    throw Error("Wait requires an existing workspace ID and durable run ID");
  const now = options.now ?? Date.now,
    sleep = options.sleep ?? waitDelay,
    start = now(),
    deadline = Math.min(options.deadline ?? start + duration, start + duration);
  let latest: Snapshot | undefined, observedAt: number | undefined;
  const result = (
    outcome:
      | "completed"
      | "failed"
      | "interrupted"
      | "stopping"
      | "stopped"
      | "not_found"
      | "still_running"
      | "unavailable",
  ) => ({
    workspaceId: input.workspaceId,
    runId: input.runId,
    outcome,
    waitedMs: Math.max(0, now() - start),
    ...(latest
      ? {
          status: latest,
          observedAt,
          taskRemainingMs: Math.max(0, (latest.deadline ?? now()) - now()),
          commandRemainingMs:
            latest.process?.state === "running" ||
            latest.process?.state === "dispatching"
              ? Math.max(
                  0,
                  (latest.runs?.[input.runId]?.deadline ?? now()) - now(),
                )
              : 0,
        }
      : {}),
    nextStep:
      outcome === "completed"
        ? "The command completed successfully. Continue the originally requested dependent work with its next tool call; do not replay this command."
        : outcome === "still_running"
          ? "The command is still running; the requested work is not complete. Call workspace_wait again with these same workspaceId/runId rather than rapid status/log calls. After successful completion, continue the requested dependent work. Do not replay the command."
          : outcome === "failed"
            ? "The command finished without confirmed success. Read its recorded logs and report or address the failure; do not claim dependent work ran or blindly replay it."
            : outcome === "unavailable"
              ? "Status was unavailable within this wait budget. Check this same existing run later; do not restart it or claim completion."
              : outcome === "not_found"
                ? "This run was not found in the explicitly targeted workspace. Check the recorded original workspace/run IDs; do not create a process or replay a command."
                : "The run or workspace is stopping, closed or interrupted. Preserve available logs/artifacts and report its exact status; cancellation does not confirm cleanup finished. Do not restart or replay it.",
  });
  while (true) {
    options.signal?.throwIfAborted();
    // A completed sleep can consume the budget. Keep the last verified running
    // observation rather than starting an RPC that would race a zero-ms timer.
    const left = deadline - now();
    if (left <= 0) return result(latest ? "still_running" : "unavailable");
    // Bound even a slow status RPC. No coordinator/lifecycle lock is held while waiting.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: () => void = () => {};
    try {
      const observation = await Promise.race([
        read().then((value) => ({ value })),
        new Promise<{ timeout: true }>((resolve, reject) => {
          timer = setTimeout(() => resolve({ timeout: true }), left);
          abort = () =>
            reject(options.signal?.reason ?? new Error("Wait cancelled"));
          options.signal?.addEventListener("abort", abort, { once: true });
          if (options.signal?.aborted) abort();
        }),
      ]);
      if ("timeout" in observation) return result("unavailable");
      latest = observation.value as Snapshot;
      observedAt = now();
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
    if (latest.id !== input.workspaceId) return result("not_found");
    if (latest.phase === "closed") return result("stopped");
    if (latest.phase === "stopping" || latest.activation?.mode === "owner_open")
      return result("stopping");
    if (
      latest.process?.state === "not_found" ||
      latest.process?.state === "none" ||
      !latest.runs ||
      !Object.hasOwn(latest.runs, input.runId)
    )
      return result("not_found");
    if (latest.process?.state === "interrupted") return result("interrupted");
    if (latest.process?.state === "done")
      return result(latest.process.exitCode === 0 ? "completed" : "failed");
    if (!["running", "dispatching"].includes(latest.process?.state ?? ""))
      return result("unavailable");
    if (now() >= deadline) return result("still_running");
    await sleep(Math.min(2000, deadline - now()), options.signal);
  }
}
