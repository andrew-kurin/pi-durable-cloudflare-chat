import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatCatalog } from "../src/chat-catalog";
import { HistoryFeed } from "../src/history-feed";
import { WorkspaceCoordinator } from "../src/workspace-coordinator";
function store() {
  const data = new Map<string, unknown>();
  const storage = {
    data,
    get: async <T>(key: string) => data.get(key) as T | undefined,
    put: async (key: string, value: unknown) => {
      data.set(key, value);
    },
    delete: async (key: string) => data.delete(key),
    transaction: async (work: any) => work(storage),
  };
  return storage;
}
test("catalog scans all pages, rejects delegated chats and keeps metadata precedence private", async () => {
  const s = store();
  let pages = 0;
  const harness = {
    storage: async () => ({
      scanConversations: async (_filter: any, _limit: any, cursor: any) => {
        pages++;
        return cursor
          ? { items: [{ id: "2" }, { id: "3", owner: { taskId: "task" } }] }
          : {
              items: [
                { id: "1" },
                { id: "4", parent: { conversationId: "1" } },
              ],
              next: "next",
            };
      },
    }),
    sessions: {
      list: async () => ["1", "2", "3", "4"].map((id) => ({ id, busy: false })),
    },
    pending: async () => [],
  };
  const catalog = new ChatCatalog(
    s as any,
    harness as any,
    async () => ({ provider: "test", modelId: "fake" }),
    async () => {},
  );
  await s.put("chat-auto-title:2", "Automatic");
  await s.put("chat-title:2", "Custom");
  assert.deepEqual(
    (await catalog.list()).map((c) => [c.id, c.title]),
    [
      ["2", "Custom"],
      ["1", ""],
    ],
  );
  assert.equal(pages, 2);
  await assert.rejects(catalog.requireActive("3"), { status: 404 });
  await catalog.trash("2");
  await assert.rejects(catalog.requireActive("2"), { status: 410 });
  await catalog.restore("2");
  assert.equal((await catalog.requireActive("2")).id, "2");
  assert.equal(await catalog.title("2"), "Custom");
});
test("history setup failures release leases and close-before-open avoids subscription", async () => {
  let calls = 0;
  const feed = new HistoryFeed(
    {
      session: () => ({
        events: async () => {
          calls++;
          throw Error("Synthetic setup failure");
        },
      }),
    } as any,
    { title: async () => undefined },
  );
  for (let i = 0; i < 5; i++)
    await assert.rejects(
      feed.subscribe(
        new Request(
          "https://chat.example.test/api/events?stream=" +
            i.toString(16).padStart(8, "0") +
            "-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
        ),
        "1",
      ),
      /Synthetic setup failure/,
    );
  const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  await feed.close(id);
  assert.equal(
    (
      await feed.subscribe(
        new Request("https://chat.example.test/api/events?stream=" + id),
        "1",
      )
    ).status,
    204,
  );
  assert.equal(calls, 5);
});
test("workspace coordinator reserves identity before setup and denies foreign artifact access", async () => {
  const s = store();
  const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  let opened = 0,
    artifacts = 0;
  const stub = {
    open: async () => {
      opened++;
      assert.equal(s.data.get("workspace-owner:" + id), "1");
      assert.equal(s.data.get("workspace-session:1"), id);
      assert.equal(s.data.get("workspace-active"), id);
      return { phase: "ready" };
    },
    artifact: async () => {
      artifacts++;
      return {};
    },
    request: async () => ({ phase: "closed" }),
  };
  const config = {
    ENABLE_WORKSPACE: "true",
    WORKSPACE_IMAGE: "fixture",
    WORKSPACE_REPOSITORY: "owner/project",
    Workspaces: { getByName: () => stub },
  };
  const coordinator = new WorkspaceCoordinator(
    s as any,
    config as any,
    async (id) => {
      assert.equal(id, "1");
    },
  );
  await coordinator.open("1", id);
  assert.equal(opened, 1);
  await assert.rejects(coordinator.artifact("2", id), { status: 404 });
  assert.equal(artifacts, 0);
  await coordinator.artifact("1", id);
  assert.equal(artifacts, 1);
});
