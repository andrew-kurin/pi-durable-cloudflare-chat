import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspaceCoordinator } from "../src/workspace-coordinator";
import {
  WorkspaceController,
  DEFAULT_WORKSPACE_LIMITS,
  type WorkspaceAdapter,
} from "../src/workspace";
const op = (n: number) => n.toString(16).padStart(64, "0");
const oldId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
function fixture() {
  let now = 0,
    opens = 0,
    dispatches = 0,
    reads = 0,
    edits = 0;
  let gate: ReturnType<typeof deferred> | undefined,
    entered = deferred(),
    failOpen = false,
    failDispatch = false;
  const data = new Map<string, any>(),
    guests = new Map<
      string,
      { controller: WorkspaceController; data: Map<string, any> }
    >();
  const store = {
    get: async <T>(key: string) =>
      structuredClone(data.get(key)) as T | undefined,
    put: async (key: string, value: unknown) => {
      data.set(key, structuredClone(value));
    },
    transaction: async (fn: any) => fn(store),
  };
  const namespace = {
    getByName: (id: string) => {
      if (!guests.has(id)) {
        const local = new Map<string, any>();
        const storage = {
          get: async <T>(key: string) =>
            structuredClone(local.get(key)) as T | undefined,
          put: async (key: string, value: unknown) => {
            local.set(key, structuredClone(value));
          },
          setAlarm: async () => {},
          deleteAlarm: async () => {},
        };
        const adapter: WorkspaceAdapter = {
          open: async (_repo, signal) => {
            opens++;
            entered.resolve();
            if (gate)
              await Promise.race([
                gate.promise,
                new Promise((_, reject) =>
                  signal.addEventListener(
                    "abort",
                    () => reject(Error("cancelled")),
                    { once: true },
                  ),
                ),
              ]);
            if (failOpen) throw Error("synthetic clone failure");
            return "a".repeat(40);
          },
          read: async () => {
            reads++;
            return "source";
          },
          edit: async () => {
            edits++;
          },
          dispatch: async () => {
            dispatches++;
            if (failDispatch) throw Error("lost acknowledgement");
          },
          status: async () => ({ state: "exited", exitCode: 0 }),
          logs: async () => "recorded log",
          terminate: async () => {},
          collect: async () => ({
            base: "a".repeat(40),
            patch: "saved patch",
            logs: {},
            gaps: [],
          }),
          stop: async () => {},
          keepAlive: async () => {},
        };
        guests.set(id, {
          controller: new WorkspaceController(
            storage,
            adapter,
            { ...DEFAULT_WORKSPACE_LIMITS, graceMs: 1 },
            () => now,
          ),
          data: local,
        });
      }
      const c = guests.get(id)!.controller;
      return {
        open: (...args: Parameters<typeof c.open>) => c.open(...args),
        request: (...args: Parameters<typeof c.request>) => c.request(...args),
        artifact: (...args: Parameters<typeof c.artifact>) =>
          c.artifact(...args),
        extend: (...args: Parameters<typeof c.extend>) => c.extend(...args),
      };
    },
  };
  let chatCheck: () => Promise<void> = async () => {};
  const config = {
    ENABLE_WORKSPACE: "true",
    WORKSPACE_IMAGE: "fixture",
    WORKSPACE_REPOSITORY: "owner/project",
    Workspaces: namespace,
  };
  const create = () =>
    new WorkspaceCoordinator(store as any, config as any, async (session) => {
      assert.ok(["1", "2"].includes(session));
      await chatCheck();
    });
  const coordinator = create();
  return {
    coordinator,
    create,
    store,
    data,
    guests,
    async expire(id: string) {
      await guests.get(id)!.controller.tick();
      now += 16 * 60000;
      await guests.get(id)!.controller.tick();
      now += 2;
      await guests.get(id)!.controller.tick();
    },
    hold() {
      entered = deferred();
      gate = deferred();
      return { entered: entered.promise, release: gate.resolve };
    },
    failOpen() {
      failOpen = true;
    },
    failDispatch() {
      failDispatch = true;
    },
    check(fn: () => Promise<void>) {
      chatCheck = fn;
    },
    get counts() {
      return { opens, dispatches, reads, edits };
    },
  };
}
test("read/edit/exec activate once, reuse a ready workspace, and report startup inline", async () => {
  for (const action of [
    { action: "read", path: "README.md" },
    { action: "edit", path: "a", oldText: "", newText: "new" },
    { action: "exec", argv: ["npm", "test"] },
  ] as const) {
    const f = fixture(),
      phases: string[] = [];
    await f.coordinator.execute(
      "1",
      { ...action, operationId: op(1) } as any,
      async (phase) => {
        phases.push(phase);
      },
    );
    const id = f.data.get("workspace-session:1");
    assert.ok(id);
    assert.equal(f.data.get("workspace-owner:" + id), "1");
    assert.deepEqual(phases, ["starting", "ready"]);
    await f.coordinator.execute(
      "1",
      { action: "read", path: "README.md", operationId: op(2) },
      async () => assert.fail("ready guest must not start"),
    );
    assert.equal(f.counts.opens, 1);
  }
});
test("concurrent calls join one startup; duplicate commands dispatch exactly once", async () => {
  const f = fixture(),
    gate = f.hold(),
    input = {
      action: "exec" as const,
      argv: ["npm", "test"],
      operationId: op(1),
    };
  const first = f.coordinator.execute("1", input);
  await gate.entered;
  const duplicate = f.coordinator.execute("1", input),
    other = f.coordinator.execute("1", {
      action: "read",
      path: "a",
      operationId: op(2),
    });
  gate.release();
  await Promise.all([first, duplicate, other]);
  assert.equal(f.counts.opens, 1);
  assert.equal(f.counts.dispatches, 1);
  assert.equal(f.counts.reads, 1);
});
test("status/log/export/artifact observations never start a guest, and foreign owners are rejected", async () => {
  const f = fixture();
  for (const input of [
    { action: "logs", runId: op(1), stream: "stdout" },
    { action: "export" },
  ])
    await assert.rejects(
      f.coordinator.execute("1", { ...input, operationId: op(2) } as any),
      /No workspace/,
    );
  assert.equal(f.counts.opens, 0);
  await f.coordinator.open("1", oldId);
  await f.coordinator.ownerAction("1", oldId, "export", op(3));
  await assert.rejects(
    f.coordinator.execute("2", {
      action: "read",
      path: "a",
      workspaceId: oldId,
      operationId: op(4),
    }),
    { status: 404 },
  );
  await assert.rejects(f.coordinator.artifact("2", oldId), { status: 404 });
  await f.coordinator.ownerAction("1", oldId, "cancel", op(5));
  await f.expire(oldId);
  assert.equal((await f.coordinator.artifact("1", oldId)).patch, "saved patch");
  await f.coordinator.execute("1", { action: "status", operationId: op(6) });
  await assert.rejects(
    f.coordinator.execute("1", { action: "export", operationId: op(7) }),
  );
  assert.equal(f.counts.opens, 1);
});
test("closed expired guests can start fresh while old artifacts remain owned", async () => {
  const f = fixture();
  await f.coordinator.open("1", oldId);
  await f.coordinator.execute("1", {
    action: "read",
    path: "a",
    operationId: op(1),
  });
  await f.expire(oldId);
  assert.equal(
    ((await f.coordinator.status("1", oldId)) as any).canAutoReplace,
    false,
  );
  await assert.rejects(
    f.coordinator.execute("1", {
      action: "read",
      path: "a",
      workspaceId: oldId,
      operationId: op(2),
    }),
    /closed/,
  );
  await f.coordinator.execute("1", {
    action: "read",
    path: "a",
    operationId: op(3),
  });
  assert.notEqual(f.data.get("workspace-session:1"), oldId);
  assert.equal(f.counts.opens, 2);
  assert.equal((await f.coordinator.artifact("1", oldId)).patch, "saved patch");
  for (const action of [
    { action: "edit", path: "a", oldText: "", newText: "work" },
    { action: "exec", argv: ["npm", "test"] },
  ]) {
    const g = fixture();
    await g.coordinator.open("1", oldId);
    await g.coordinator.execute("1", { ...action, operationId: op(1) } as any);
    await g.expire(oldId);
    const result = (await g.coordinator.execute("1", {
      action: "read",
      path: "a",
      operationId: op(2),
    })) as any;
    assert.equal(result.freshWorkspace.previousWorkspaceId, oldId);
    assert.equal(g.counts.opens, 2);
  }
  const legacy = fixture();
  await legacy.coordinator.open("1", oldId);
  legacy.guests.get(oldId)!.data.get("state").untouched = undefined;
  await legacy.expire(oldId);
  const result = (await legacy.coordinator.execute("1", {
    action: "read",
    path: "a",
    operationId: op(1),
  })) as any;
  assert.equal(result.freshWorkspace.previousWorkspaceId, oldId);
});
test("startup failure and interrupted initialization never clone or dispatch again automatically", async () => {
  const f = fixture();
  f.failOpen();
  const phases: string[] = [];
  const input = {
    action: "exec" as const,
    argv: ["npm", "test"],
    operationId: op(1),
  };
  await assert.rejects(
    f.coordinator.execute("1", input, async (phase) => {
      phases.push(phase);
    }),
    /startup failed/,
  );
  assert.deepEqual(phases, ["starting", "failed"]);
  await assert.rejects(f.create().execute("1", input), /not active/);
  await assert.rejects(
    f.coordinator.execute("1", { ...input, operationId: op(2) }),
    /closed/,
  );
  assert.deepEqual(f.counts, { opens: 1, dispatches: 0, reads: 0, edits: 0 });
  const g = fixture();
  await g.coordinator.open("1", oldId);
  g.guests.get(oldId)!.data.get("state").phase = "initializing";
  await assert.rejects(g.create().execute("1", input), /closed|startup failed/);
  assert.equal(g.counts.opens, 1);
  assert.equal(g.counts.dispatches, 0);
});
test("cancellation during startup wins; explicit later open is required to resume", async () => {
  const f = fixture(),
    gate = f.hold(),
    input = {
      action: "exec" as const,
      argv: ["npm", "test"],
      operationId: op(1),
    };
  const starting = f.coordinator.execute("1", input);
  const rejected = assert.rejects(starting, /cancelled/);
  await gate.entered;
  const id = f.data.get("workspace-session:1");
  await f.coordinator.ownerAction("1", id, "cancel", op(2));
  await rejected;
  gate.release();
  assert.equal(f.counts.dispatches, 0);
  await assert.rejects(
    f.create().execute("1", { ...input, operationId: op(3) }),
    /stopped/,
  );
  await f.coordinator.open("1", oldId);
  await f.coordinator.execute("1", { ...input, operationId: op(4) });
  assert.equal(f.counts.dispatches, 1);
  // The original call remains pinned to the old guest even after a deliberate new open.
  await assert.rejects(f.create().execute("1", input), /not active/);
  assert.equal(f.counts.dispatches, 1);
});
test("cancel racing a manual reservation cannot be cleared by that pending open", async () => {
  const f = fixture();
  await f.coordinator.open("1", oldId);
  await f.expire(oldId);
  const held = deferred(),
    entered = deferred();
  f.check(async () => {
    entered.resolve();
    await held.promise;
  });
  const opening = f.coordinator.open(
    "1",
    "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
  );
  const rejected = assert.rejects(opening, /stopped/);
  await entered.promise;
  await f.coordinator.ownerAction("1", oldId, "cancel", op(1));
  held.resolve();
  await rejected;
  assert.equal(f.counts.opens, 1);
});
test("bindings survive coordinator restart, refuse changed input and never replay an ambiguous dispatch", async () => {
  const f = fixture();
  f.failDispatch();
  const input = {
    action: "exec" as const,
    argv: ["sh", "-c", "touch file"],
    operationId: op(1),
  };
  await f.coordinator.execute("1", input);
  const original = f.data.get("workspace-session:1");
  await f.expire(original);
  await f.coordinator.open("1", oldId);
  await f.create().execute("1", input);
  assert.equal(f.counts.dispatches, 1);
  assert.equal(f.data.get("workspace-session:1"), oldId);
  await assert.rejects(
    f.create().execute("1", { ...input, argv: ["different"] }),
    /already used/,
  );
  assert.equal(f.counts.dispatches, 1);
});
test("global admission allows one active guest and invalid inputs cannot create one", async () => {
  const f = fixture();
  await assert.rejects(
    f.coordinator.execute("1", {
      action: "read",
      path: "a",
      operationId: "bad",
    }),
    { status: 400 },
  );
  assert.equal(f.counts.opens, 0);
  await f.coordinator.execute("1", {
    action: "read",
    path: "a",
    operationId: op(1),
  });
  await assert.rejects(
    f.coordinator.execute("2", {
      action: "exec",
      argv: ["npm", "test"],
      operationId: op(2),
    }),
    /active workspace/,
  );
  assert.equal(f.counts.opens, 1);
});
test("concurrent different chats cannot open two guests and cancelled startup stays stopped across reconstruction", async () => {
  const f = fixture(),
    gate = f.hold();
  const first = f.coordinator.execute("1", {
    action: "read",
    path: "a",
    operationId: op(1),
  });
  const rejected = assert.rejects(first, /cancelled/);
  await gate.entered;
  await assert.rejects(
    f.coordinator.execute("2", {
      action: "read",
      path: "a",
      operationId: op(2),
    }),
    /active workspace/,
  );
  const id = f.data.get("workspace-session:1");
  await f.coordinator.ownerAction("1", id, "cancel", op(3));
  await rejected;
  gate.release();
  await assert.rejects(
    f.create().execute("1", { action: "read", path: "a", operationId: op(4) }),
    /stopped/,
  );
  assert.equal(f.counts.opens, 1);
  assert.equal(f.counts.reads, 0);
});
test("a failure in the original operation after ready is not reported as startup failure", async () => {
  const f = fixture(),
    phases: string[] = [];
  await assert.rejects(
    f.coordinator.execute(
      "1",
      { action: "exec", argv: [], operationId: op(1) },
      async (phase) => {
        phases.push(phase);
      },
    ),
    /Invalid argv/,
  );
  assert.deepEqual(phases, ["starting", "ready"]);
  assert.equal(f.counts.dispatches, 0);
});
test("cancelling an old guest does not block a newer workspace for the same owner", async () => {
  const f = fixture();
  await f.coordinator.open("1", oldId);
  await f.expire(oldId);
  const next = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
  await f.coordinator.open("1", next);
  await f.coordinator.ownerAction("1", oldId, "cancel", op(1));
  await f.coordinator.execute("1", {
    action: "read",
    path: "a",
    operationId: op(2),
  });
  assert.equal(f.counts.reads, 1);
  assert.equal(f.data.get("workspace-session:1"), next);
});
test("an activation paused after ready stays cancelled across an explicit manual reopen", async () => {
  const f = fixture(),
    entered = deferred(),
    held = deferred();
  const starting = f.coordinator.execute(
    "1",
    { action: "exec", argv: ["npm", "test"], operationId: op(1) },
    async (phase) => {
      if (phase === "ready") {
        entered.resolve();
        await held.promise;
      }
    },
  );
  const rejected = assert.rejects(starting, /cancelled/);
  await entered.promise;
  const id = f.data.get("workspace-session:1");
  await f.coordinator.ownerAction("1", id, "cancel", op(2));
  await f.expire(id);
  await f.coordinator.open("1", oldId);
  held.resolve();
  await rejected;
  assert.equal(f.counts.dispatches, 0);
  await f.coordinator.execute("1", {
    action: "read",
    path: "a",
    operationId: op(3),
  });
  assert.equal(f.counts.reads, 1);
});
test("idempotent owner open of the same ready guest joins without cancelling an activating tool", async () => {
  const f = fixture(),
    entered = deferred(),
    held = deferred();
  const starting = f.coordinator.execute(
    "1",
    { action: "exec", argv: ["npm", "test"], operationId: op(1) },
    async (phase) => {
      if (phase === "ready") {
        entered.resolve();
        await held.promise;
      }
    },
  );
  await entered.promise;
  const id = f.data.get("workspace-session:1");
  assert.equal((await f.coordinator.open("1", id)).phase, "ready");
  held.resolve();
  await starting;
  assert.equal(f.counts.dispatches, 1);
  assert.equal(f.counts.opens, 1);
});
test("cancellation during automatic replacement reservation prevents a new guest", async () => {
  const f = fixture();
  await f.coordinator.open("1", oldId);
  await f.expire(oldId);
  let checks = 0;
  const entered = deferred(),
    held = deferred();
  f.check(async () => {
    if (++checks === 2) {
      entered.resolve();
      await held.promise;
    }
  });
  const starting = f.coordinator.execute("1", {
    action: "exec",
    argv: ["npm", "test"],
    operationId: op(1),
  });
  const rejected = assert.rejects(starting, /stopped/);
  await entered.promise;
  await f.coordinator.ownerAction("1", oldId, "cancel", op(2));
  held.resolve();
  await rejected;
  assert.equal(f.counts.opens, 1);
  assert.equal(f.counts.dispatches, 0);
  assert.equal(f.data.get("workspace-session:1"), oldId);
});
test("legacy closed guest from conversation 293 starts fresh without restoring or overwriting its predecessor", async () => {
  const f = fixture();
  await f.coordinator.open("1", oldId);
  await f.coordinator.execute("1", {
    action: "exec",
    argv: ["ls"],
    operationId: op(1),
  });
  await f.expire(oldId);
  const state = f.guests.get(oldId)!.data.get("state");
  delete state.untouched;
  delete state.stopReason;
  const before = structuredClone(f.guests.get(oldId)!.data),
    phases: any[] = [];
  const result = (await f.coordinator.execute(
    "1",
    { action: "read", path: "src/index.ts", operationId: op(2) },
    async (phase, fresh) => {
      phases.push([phase, fresh]);
    },
  )) as any;
  const next = f.data.get("workspace-session:1");
  assert.notEqual(next, oldId);
  assert.equal(result.text, "source");
  assert.equal(result.freshWorkspace.previousWorkspaceId, oldId);
  assert.match(result.freshWorkspace.notice, /Old edits were not restored/);
  assert.match(result.freshWorkspace.artifactUrl, new RegExp(oldId));
  assert.deepEqual(f.guests.get(oldId)!.data, before);
  assert.deepEqual(phases, [
    ["starting", true],
    ["ready", true],
  ]);
  assert.equal(f.data.get("workspace-owner:" + oldId), "1");
  assert.equal((await f.coordinator.artifact("1", oldId)).patch, "saved patch");
  await assert.rejects(
    f.coordinator.execute("1", {
      action: "read",
      workspaceId: oldId,
      path: "a",
      operationId: op(3),
    }),
    /explicit|closed/i,
  );
  const retry = (await f.create().execute("1", {
    action: "read",
    path: "src/index.ts",
    operationId: op(2),
  })) as any;
  assert.equal(retry.freshWorkspace.previousWorkspaceId, oldId);
  assert.equal(f.counts.opens, 2);
  assert.equal(f.counts.reads, 1);
});
test("concurrent tools share a fresh successor and its durable predecessor reference", async () => {
  const f = fixture();
  await f.coordinator.open("1", oldId);
  await f.expire(oldId);
  const gate = f.hold();
  const a = f.coordinator.execute("1", {
    action: "read",
    path: "a",
    operationId: op(1),
  });
  await gate.entered;
  const b = f.coordinator.execute("1", {
    action: "read",
    path: "b",
    operationId: op(2),
  });
  gate.release();
  const results = (await Promise.all([a, b])) as any[];
  assert.equal(f.counts.opens, 2);
  assert.ok(
    results.every((r) => r.freshWorkspace.previousWorkspaceId === oldId),
  );
  assert.equal(
    (await f.create().current("1")).predecessor?.previousWorkspaceId,
    oldId,
  );
});
test("cancelled or failed fresh startup retains the predecessor without dispatch or repeated cloning", async () => {
  for (const cancel of [true, false]) {
    const f = fixture();
    await f.coordinator.open("1", oldId);
    await f.expire(oldId);
    const before = structuredClone(f.guests.get(oldId)!.data);
    let gate: ReturnType<typeof f.hold> | undefined;
    if (cancel) gate = f.hold();
    else f.failOpen();
    const input = {
      action: "exec" as const,
      argv: ["npm", "test"],
      operationId: op(1),
    };
    const running = f.coordinator.execute("1", input);
    const rejected = assert.rejects(
      running,
      /retained.*contents were not verified/,
    );
    if (cancel) {
      await gate!.entered;
      await f.coordinator.ownerAction(
        "1",
        f.data.get("workspace-session:1"),
        "cancel",
        op(2),
      );
      gate!.release();
    }
    await rejected;
    assert.equal(f.counts.dispatches, 0);
    assert.deepEqual(f.guests.get(oldId)!.data, before);
    assert.equal(
      (await f.create().current("1")).predecessor?.previousWorkspaceId,
      oldId,
    );
    await assert.rejects(
      f.create().execute("1", { ...input, operationId: op(3) }),
    );
    assert.equal(f.counts.opens, 2);
  }
});
test("saved closed-status pattern guides a normal read into fresh activation without opening on status", async () => {
  const f = fixture();
  await f.coordinator.open("1", oldId);
  await f.coordinator.execute("1", {
    action: "exec",
    argv: ["ls"],
    operationId: op(1),
  });
  await f.expire(oldId);
  const state = f.guests.get(oldId)!.data.get("state");
  delete state.untouched;
  delete state.stopReason;
  const status = (await f.coordinator.execute("1", {
    action: "status",
    operationId: op(2),
  })) as any;
  assert.equal(status.phase, "closed");
  assert.equal(status.canAutoReplace, true);
  assert.equal(status.activation.mode, "automatic");
  assert.match(status.activation.nextStep, /workspace_read/);
  assert.match(status.activation.nextStep, /omit workspaceId/);
  assert.equal(status.process.state, "none");
  assert.equal(f.counts.opens, 1);
  await f.coordinator.execute("1", {
    action: "read",
    path: "package.json",
    operationId: op(3),
  });
  assert.equal(f.counts.opens, 2);
});
test("absent workspace is a normal actionable status; process lookup never creates or invents a run", async () => {
  const f = fixture();
  const status = (await f.coordinator.execute("1", {
    action: "status",
    operationId: op(1),
  })) as any;
  assert.equal(status.phase, "absent");
  assert.equal(status.activation.mode, "automatic");
  assert.equal(status.process.state, "none");
  assert.deepEqual(status.runs, {});
  const missing = (await f.coordinator.execute("1", {
    action: "status",
    runId: op(9),
    operationId: op(2),
  })) as any;
  assert.equal(missing.process.state, "not_found");
  assert.equal(missing.process.runId, op(9));
  assert.equal(f.counts.opens, 0);
});
test("status distinguishes explicit history, stopped work and missing processes without undoing stops", async () => {
  const f = fixture();
  await f.coordinator.open("1", oldId);
  await f.coordinator.execute("1", {
    action: "exec",
    argv: ["ls"],
    operationId: op(1),
  });
  await f.expire(oldId);
  const explicit = (await f.coordinator.execute("1", {
    action: "status",
    workspaceId: oldId,
    runId: op(1),
    operationId: op(2),
  })) as any;
  assert.equal(explicit.activation.mode, "explicit_target_closed");
  assert.equal(explicit.process.state, "done");
  assert.equal(explicit.process.id, op(1));
  assert.equal(explicit.canAutoReplace, false);
  const missing = (await f.coordinator.execute("1", {
    action: "status",
    runId: op(9),
    operationId: op(3),
  })) as any;
  assert.equal(missing.process.state, "not_found");
  assert.equal(missing.activation.mode, "automatic");
  await f.coordinator.ownerAction("1", oldId, "cancel", op(4));
  const stopped = (await f.coordinator.execute("1", {
    action: "status",
    operationId: op(5),
  })) as any;
  assert.equal(stopped.activation.mode, "owner_open");
  assert.equal(stopped.canAutoReplace, false);
  await assert.rejects(
    f.coordinator.execute("1", {
      action: "read",
      path: "a",
      operationId: op(6),
    }),
    /stopped/,
  );
  assert.equal(f.counts.opens, 1);
});
test("repeated owner UI status polling never opens a guest or creates a run", async () => {
  const f = fixture();
  await f.coordinator.open("1", oldId);
  await f.expire(oldId);
  for (let i = 0; i < 5; i++) {
    const s = (await f.coordinator.status("1", oldId)) as any;
    assert.equal(s.phase, "closed");
    assert.equal(s.process.state, "none");
    assert.deepEqual(s.runs, {});
  }
  assert.equal(f.counts.opens, 1);
  assert.equal(f.counts.dispatches, 0);
});
test("explicit stopped current status requires owner open while an older cancelled target does not block new work", async () => {
  const f = fixture();
  await f.coordinator.open("1", oldId);
  await f.coordinator.ownerAction("1", oldId, "cancel", op(1));
  await f.expire(oldId);
  const stopped = (await f.coordinator.execute("1", {
    action: "status",
    workspaceId: oldId,
    operationId: op(2),
  })) as any;
  assert.equal(stopped.activation.mode, "owner_open");
  assert.ok(!stopped.activation.nextStep.includes("omit workspaceId"));
  const next = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
  await f.coordinator.open("1", next);
  const historical = (await f.coordinator.execute("1", {
    action: "status",
    workspaceId: oldId,
    operationId: op(3),
  })) as any;
  assert.equal(historical.activation.mode, "explicit_target_closed");
  assert.equal(historical.id, oldId);
  const current = (await f.coordinator.execute("1", {
    action: "status",
    operationId: op(4),
  })) as any;
  assert.equal(current.id, next);
  assert.equal(current.activation.mode, "ready");
  assert.equal(f.counts.opens, 2);
});
test("closed legacy process records are historical interrupted observations, never live processes", async () => {
  const f = fixture();
  await f.coordinator.open("1", oldId);
  await f.coordinator.execute("1", {
    action: "exec",
    argv: ["ls"],
    operationId: op(1),
  });
  await f.expire(oldId);
  const state = f.guests.get(oldId)!.data.get("state");
  state.runs[op(1)].state = "running";
  // Native status normally normalizes this; hold the serialized closed legacy record to test projection defensively.
  const original = f.guests
    .get(oldId)!
    .controller.request.bind(f.guests.get(oldId)!.controller);
  f.guests.get(oldId)!.controller.request = async (r: any) =>
    r.action === "status" ? structuredClone(state) : original(r);
  const result = (await f.coordinator.execute("1", {
    action: "status",
    runId: op(1),
    operationId: op(2),
  })) as any;
  assert.equal(result.process.state, "interrupted");
  assert.equal(result.runs[op(1)].state, "interrupted");
  assert.equal(result.active, undefined);
  assert.equal(state.runs[op(1)].state, "running");
  assert.equal(f.counts.opens, 1);
});
test("waiting through coordinator does not block cancellation, regular status or guest lifecycle", async () => {
  const { waitForWorkspaceRun } = await import("../src/workspace-wait");
  const f = fixture();
  await f.coordinator.execute("1", {
    action: "exec",
    argv: ["npm", "ci"],
    operationId: op(1),
  });
  const id = f.data.get("workspace-session:1");
  const guest = f.guests.get(id)!.controller;
  // Keep this native fixture process running until cancellation, independently of the waiter.
  const state = f.guests.get(id)!.data.get("state");
  state.active = op(1);
  state.runs[op(1)].state = "running";
  const original = guest.request.bind(guest);
  let held = true;
  guest.request = async (r: any) =>
    r.action === "status" && held
      ? { ...structuredClone(state), process: undefined }
      : original(r);
  let checked = 0;
  const result = await waitForWorkspaceRun(
    () =>
      f.coordinator.execute("1", {
        action: "status",
        workspaceId: id,
        runId: op(1),
        operationId: op(2),
      }),
    { workspaceId: id, runId: op(1) },
    {
      now: () => checked * 2000,
      sleep: async () => {
        checked++;
        const immediate = (await f.coordinator.status("1", id)) as any;
        assert.equal(immediate.phase, "ready");
        held = false;
        await f.coordinator.ownerAction("1", id, "cancel", op(3));
      },
    },
  );
  assert.equal(result.outcome, "stopping");
  assert.equal(checked, 1);
  assert.equal(f.counts.dispatches, 1);
  assert.equal(f.counts.opens, 1);
  await f.expire(id);
  assert.equal(((await f.coordinator.status("1", id)) as any).phase, "closed");
});
