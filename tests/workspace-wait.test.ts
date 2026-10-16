import { test } from "node:test";
import assert from "node:assert/strict";
import { waitForWorkspaceRun } from "../src/workspace-wait";
const workspaceId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  runId = "1".repeat(64),
  input = { workspaceId, runId };
function snapshot(state = "running", exitCode?: number) {
  return {
    id: workspaceId,
    phase: "ready",
    deadline: 900000,
    runs: { [runId]: { id: runId, state, deadline: 300000, exitCode } },
    process: { id: runId, state, exitCode },
    activation: { mode: "ready" },
  };
}
function clock() {
  let time = 0,
    sleeps = 0;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
      sleeps++;
    },
    get time() {
      return time;
    },
    get sleeps() {
      return sleeps;
    },
  };
}
test("saved npm-ci running/empty-log pattern becomes one bounded tool wait with no extra model rounds", async () => {
  const c = clock();
  let polls = 0;
  const result = await waitForWorkspaceRun(
    async () => {
      polls++;
      return snapshot();
    },
    input,
    c,
  );
  assert.equal(result.outcome, "still_running");
  assert.equal(c.time, 20000);
  assert.equal(polls, 10);
  assert.match(result.nextStep, /not complete/);
  assert.match(result.nextStep, /workspace_wait again/);
  assert.equal(result.commandRemainingMs, 280000);
  assert.equal(result.taskRemainingMs, 880000);
});
test("early successful completion returns before the budget and directs dependent work", async () => {
  const c = clock();
  let polls = 0;
  const result = await waitForWorkspaceRun(
    async () => (++polls === 3 ? snapshot("done", 0) : snapshot()),
    input,
    c,
  );
  assert.equal(result.outcome, "completed");
  assert.equal(c.time, 4000);
  assert.equal(result.commandRemainingMs, 0);
  assert.match(
    result.nextStep,
    /Continue the originally requested dependent work/,
  );
});
test("nonzero exit and ambiguous completion are not reported as success", async () => {
  for (const exit of [1, undefined]) {
    const c = clock();
    const result = await waitForWorkspaceRun(
      async () => snapshot("done", exit),
      input,
      c,
    );
    assert.equal(result.outcome, "failed");
    assert.equal(c.sleeps, 0);
    assert.match(result.nextStep, /recorded logs/);
  }
});
test("cancel/closed/interrupted results stop promptly without another poll", async () => {
  for (const phase of ["stopping", "closed", "interrupted"]) {
    const c = clock();
    let polls = 0;
    const result = await waitForWorkspaceRun(
      async () => {
        polls++;
        return polls === 1
          ? snapshot()
          : phase === "interrupted"
            ? snapshot("interrupted")
            : { ...snapshot(), phase };
      },
      input,
      c,
    );
    assert.equal(
      result.outcome,
      phase === "interrupted"
        ? "interrupted"
        : phase === "stopping"
          ? "stopping"
          : "stopped",
    );
    assert.equal(c.time, 2000);
    assert.equal(polls, 2);
  }
});
test("missing run, stale workspace and owner-stop never create a guest or invent a process", async () => {
  for (const value of [
    { ...snapshot(), runs: {}, process: { state: "not_found" } },
    { ...snapshot(), id: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb" },
    { ...snapshot(), activation: { mode: "owner_open" } },
  ]) {
    const c = clock();
    const result = await waitForWorkspaceRun(async () => value, input, c);
    assert.ok(["not_found", "stopped", "stopping"].includes(result.outcome));
    assert.equal(c.sleeps, 0);
  }
});
test("recovered deadline is retained rather than giving an interrupted wait a new full budget", async () => {
  const c = clock();
  const result = await waitForWorkspaceRun(
    async () => snapshot(),
    { ...input, waitMs: 30000 },
    { ...c, deadline: 6000 },
  );
  assert.equal(result.outcome, "still_running");
  assert.equal(result.waitedMs, 6000);
});
test("caller cancellation promptly aborts a sleeping or pending status wait", async () => {
  for (const pending of [true, false]) {
    const abort = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    const waiting = waitForWorkspaceRun(
      async () => {
        entered();
        return pending ? new Promise(() => {}) : snapshot();
      },
      input,
      { signal: abort.signal },
    );
    const rejected = assert.rejects(waiting, /owner cancelled/);
    await started;
    abort.abort(Error("owner cancelled"));
    await rejected;
  }
});
test("wait validates bounds and requires pinned workspace/run IDs before observing", async () => {
  let polls = 0;
  for (const waitMs of [0, 9999, 30001, Infinity])
    await assert.rejects(
      waitForWorkspaceRun(
        async () => {
          polls++;
          return snapshot();
        },
        { ...input, waitMs },
      ),
      /10–30/,
    );
  await assert.rejects(
    waitForWorkspaceRun(
      async () => {
        polls++;
        return snapshot();
      },
      { ...input, workspaceId: "" },
    ),
    /existing workspace/,
  );
  assert.equal(polls, 0);
});
test("a slow status read cannot exceed the wait budget or claim a command completed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const waiting = waitForWorkspaceRun(() => new Promise(() => {}), {
    ...input,
    waitMs: 10000,
  });
  t.mock.timers.tick(10000);
  const result = await waiting;
  assert.equal(result.outcome, "unavailable");
  assert.equal(result.waitedMs, 10000);
  assert.equal(result.status, undefined);
});
test("simultaneous waits observe independently without holding an execution lock", async () => {
  const first = clock(),
    second = clock();
  const [a, b] = await Promise.all([
    waitForWorkspaceRun(
      async () => snapshot(),
      { ...input, waitMs: 10000 },
      first,
    ),
    waitForWorkspaceRun(async () => snapshot("done", 0), input, second),
  ]);
  assert.equal(a.outcome, "still_running");
  assert.equal(b.outcome, "completed");
  assert.equal(second.time, 0);
});
test("status read failures surface immediately without retrying work", async () => {
  let reads = 0;
  await assert.rejects(
    waitForWorkspaceRun(async () => {
      reads++;
      throw Error("status unavailable");
    }, input),
    /status unavailable/,
  );
  assert.equal(reads, 1);
});
test("workspace deadline enforcement stops a wait instead of reporting completion", async () => {
  const c = clock();
  let polls = 0;
  const result = await waitForWorkspaceRun(
    async () =>
      ++polls === 1
        ? snapshot()
        : { ...snapshot(), phase: "stopping", stopReason: "expired" },
    input,
    c,
  );
  assert.equal(result.outcome, "stopping");
  assert.match(result.nextStep, /does not confirm cleanup/);
  assert.equal(result.waitedMs, 2000);
});
test("tool recovery reuses its memoized deadline and never gives a resumed wait a fresh budget", async (t) => {
  const { workspaceTools } = await import("../src/workspace-tools");
  const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const memos = new Map<string, number>();
  let fail = true,
    reads = 0;
  const api = {
    taskId: "task",
    conversationId: "1",
    callId: "wait-call",
    memo: async (name: string, candidate: number) => {
      if (!memos.has(name)) memos.set(name, candidate);
      return memos.get(name);
    },
    details: async () => {
      if (fail) throw Error("interrupted before observation");
    },
  };
  const extension = workspaceTools({
    request: async () => {
      reads++;
      return snapshot();
    },
  });
  const tool = extension.tools!.find((t) => t.name === "workspace_wait")!;
  await assert.rejects(
    tool.execute(input as any, api as any, BACKGROUND_CONTEXT),
    /interrupted before observation/,
  );
  assert.equal(memos.get("wait-deadline"), 20000);
  assert.equal(reads, 0);
  t.mock.timers.tick(30000);
  fail = false;
  const result = await tool.execute(
    input as any,
    api as any,
    BACKGROUND_CONTEXT,
  );
  const data = JSON.parse((result.content![0] as any).text).data;
  assert.equal(data.outcome, "unavailable");
  assert.equal(data.status, undefined);
  assert.equal(data.waitedMs, 0);
  assert.equal(memos.get("wait-deadline"), 20000);
  assert.equal(reads, 0);
});

// Real transport latency, unlike an immediately resolved promise, loses a race
// against a zero-ms timer. Advance only the logical wait clock to keep this fast.
test("asynchronous status RPCs exhaust the budget with the last verified running snapshot and no extra read", async () => {
  const c = clock();
  const startedAt: number[] = [];
  const observed = snapshot();
  const result = await waitForWorkspaceRun(
    () => {
      startedAt.push(c.time);
      return new Promise((resolve) => setTimeout(() => resolve(observed), 2));
    },
    { ...input, waitMs: 10000 },
    c,
  );
  assert.equal(result.outcome, "still_running");
  assert.deepEqual(startedAt, [0, 2000, 4000, 6000, 8000]);
  assert.equal(result.waitedMs, 10000);
  assert.equal(result.observedAt, 8000);
  assert.equal(result.status, observed);
  assert.equal(result.commandRemainingMs, 290000);
});
test("a pending status RPC remains unavailable even after an earlier running observation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  let reads = 0;
  let startPending!: () => void;
  const pending = new Promise<void>((resolve) => (startPending = resolve));
  const waiting = waitForWorkspaceRun(() => {
    if (++reads === 1) return Promise.resolve(snapshot());
    startPending();
    return new Promise(() => {});
  }, { ...input, waitMs: 10000 }, { sleep: async () => { t.mock.timers.tick(2000); } });
  await pending;
  t.mock.timers.tick(8000);
  const result = await waiting;
  assert.equal(result.outcome, "unavailable");
  assert.equal(result.observedAt, 0);
  assert.equal(result.status?.process?.state, "running");
  assert.equal(reads, 2);
});
test("cancellation at budget expiration takes precedence over a running snapshot", async () => {
  const abort = new AbortController();
  let time = 0, reads = 0;
  await assert.rejects(waitForWorkspaceRun(async () => {
    reads++;
    return snapshot();
  }, { ...input, waitMs: 10000 }, {
    signal: abort.signal,
    now: () => time,
    sleep: async () => {
      time = 10000;
      abort.abort(Error("owner cancelled at deadline"));
    },
  }), /owner cancelled at deadline/);
  assert.equal(reads, 1);
});
