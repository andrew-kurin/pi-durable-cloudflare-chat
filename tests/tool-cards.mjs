import { chromium } from "playwright-core";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { ChatProjection } from "../src/projector.ts";
const out = ".runtime/tool-cards/previews";
await mkdir(out, { recursive: true });
const p = new ChatProjection();
const specs = [
  [
    "workspace_exec",
    { argv: ["npm", "test"], cwd: "/workspace/project" },
    { error: "Workspace is not active: create a new task explicitly" },
    true,
  ],
  [
    "web_search",
    { query: "durable chat recovery" },
    {
      results: [
        {
          title: "Recovery guide",
          url: "https://example.com/guide?q=recovery",
          excerpt: "Persist each message once; reconnect to the saved run.",
        },
      ],
    },
  ],
  [
    "github_read",
    { repo: "owner/project", kind: "file", path: "src/token.ts" },
    {
      text: "export const retries = 1;",
      url: "https://github.com/owner/project/blob/main/src/token.ts",
    },
  ],
  [
    "workspace_logs",
    { runId: "run-1", stream: "stdout" },
    { text: "18 tests passed\n" + "ordinary long log line\n".repeat(800) },
  ],
  ["workspace_read", { path: "empty.txt" }, { text: "" }],
  ["workspace_status", { runId: "run-2" }, undefined],
];
p.entry({
  id: "user",
  kind: "pi.user",
  model: [{ role: "user", content: "Check the recorded task results." }],
});
for (const [i, [name, args, data, error]] of specs.entries()) {
  p.entry({
    id: "call-" + i,
    kind: "pi.assistant",
    model: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "DO_NOT_DISPLAY_REASONING" },
          { type: "toolCall", id: "tool-" + i, name, arguments: args },
        ],
      },
    ],
  });
  if (data !== undefined)
    p.entry({
      id: "result-" + i,
      kind: "pi.tool-result",
      model: [
        {
          role: "toolResult",
          toolCallId: "tool-" + i,
          toolName: name,
          isError: !!error,
          durationMs: 50,
          content: [{ type: "text", text: JSON.stringify({ data }) }],
        },
      ],
    });
}
p.entry({
  id: "answer",
  kind: "pi.assistant",
  model: [
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "The command could not start because the workspace is closed. The other recorded results are shown below.",
        },
      ],
    },
  ],
});
p.apply({
  type: "tool_execution_start",
  toolCallId: "tool-5",
  toolName: "workspace_status",
  args: { runId: "run-2" },
});
const view = { ...p.view(), historyProtocol: 2 };
let modelCalls = 0;
const errors = [];
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_EXECUTABLE ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
try {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.streams = [];
    window.EventSource = class {
      constructor() {
        window.streams.push(this);
        queueMicrotask(() => this.onopen?.());
      }
      close() {}
    };
  });
  await page.route("**/*", async (route) => {
    const u = new URL(route.request().url());
    assert.equal(u.origin, "https://chat.example.test");
    if (u.pathname.startsWith("/api/submit")) {
      modelCalls++;
      throw Error("No inference allowed");
    }
    if (u.pathname === "/api/sessions")
      return route.fulfill({
        json: [{ id: "1", title: "Review tool results" }],
      });
    if (u.pathname === "/api/status")
      return route.fulfill({
        json: {
          modelEnabled: true,
          connected: true,
          model: { provider: "xai", modelId: "grok-4.7" },
        },
      });
    if (u.pathname === "/api/events/close")
      return route.fulfill({ json: { closed: true } });
    if (u.pathname === "/favicon.ico") return route.fulfill({ status: 404 });
    const file = u.pathname === "/" ? "index.html" : u.pathname.slice(1);
    return route.fulfill({
      body: await readFile("public/" + file),
      contentType: file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : "text/html",
    });
  });
  await page.goto("https://chat.example.test");
  await page.waitForFunction(() => window.streams.length);
  await page.evaluate(
    (v) => window.streams.at(-1).onmessage({ data: JSON.stringify(v) }),
    view,
  );
  assert.equal(
    await page.locator(".completed-tools,.tool-technical").count(),
    0,
  );
  assert.equal(await page.locator(".tool-row").count(), 6);
  assert.equal(await page.locator(".message script,.message img").count(), 0);
  assert.ok(
    !(await page.locator("#messages").textContent()).includes(
      "DO_NOT_DISPLAY_REASONING",
    ),
  );
  const failed = page.locator(".tool-row[data-state=error]");
  assert.match(
    await failed.locator("summary").textContent(),
    /npm test.*Workspace is not active/,
  );
  await failed.locator("summary").focus();
  await page.keyboard.press("Enter");
  assert.equal(await failed.getAttribute("open"), "");
  assert.equal(
    await failed
      .locator("summary")
      .evaluate((e) => getComputedStyle(e).listStyleType),
    "none",
  );
  assert.match(
    await failed.locator(".tool-output").textContent(),
    /Workspace is not active/,
  );
  for (const [name, width, height] of [
    ["mobile", 390, 844],
    ["narrow", 320, 720],
    ["desktop", 1280, 900],
  ]) {
    await page.setViewportSize({ width, height });
    await failed.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    assert.ok(
      (await failed
        .locator("summary")
        .evaluate((e) => e.getBoundingClientRect().height)) >= 44,
    );
    await page.screenshot({ path: out + "/" + name + "-tool-error.png" });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const logs = page
    .locator(".tool-row")
    .filter({ has: page.locator(".tool-context", { hasText: "run-1" }) });
  await logs.locator("summary").click();
  const output = logs.locator(".tool-output");
  assert.equal(await output.getAttribute("tabindex"), "0");
  await output.scrollIntoViewIfNeeded();
  await output.focus();
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(
    () =>
      document.activeElement?.classList.contains("tool-output") &&
      document.activeElement.scrollTop > 0,
  );
  assert.match(await logs.textContent(), /Display excerpt truncated/);
  await page.screenshot({ path: out + "/mobile-tool-logs.png" });
  const activation = new ChatProjection();
  activation.entry({
    id: "activation",
    kind: "pi.assistant",
    model: [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "auto",
            name: "workspace_exec",
            arguments: { argv: ["npm", "test"] },
          },
        ],
      },
    ],
  });
  activation.apply({
    type: "tool_execution_start",
    toolCallId: "auto",
    toolName: "workspace_exec",
    args: { argv: ["npm", "test"] },
  });
  for (const [phase, label] of [
    ["starting", "Starting workspace…"],
    ["ready", "Workspace ready. Running tool…"],
    ["failed", "Workspace activation failed."],
  ]) {
    activation.apply({
      type: "tool_execution_update",
      toolCallId: "auto",
      toolName: "workspace_exec",
      details: { workspaceActivation: phase },
    });
    await page.evaluate(
      (v) => window.streams.at(-1).onmessage({ data: JSON.stringify(v) }),
      { ...activation.view(), historyProtocol: 2 },
    );
    const row = page.locator(".tool-row");
    assert.equal(await row.count(), 1);
    assert.ok((await row.locator("summary").textContent()).includes(label));
    if(phase === "failed") assert.equal(await row.getAttribute("data-state"), "error");
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: out + "/workspace-" + phase + ".png" });
  }
  activation.entry({
    id: "auto-error",
    kind: "pi.tool-result",
    model: [
      {
        role: "toolResult",
        toolCallId: "auto",
        toolName: "workspace_exec",
        isError: true,
        content: [
          {
            type: "text",
            text: "Workspace startup failed; no tool operation ran. Open a workspace explicitly to try again.",
          },
        ],
      },
    ],
  });
  await page.evaluate(
    (v) => window.streams.at(-1).onmessage({ data: JSON.stringify(v) }),
    { ...activation.view(), historyProtocol: 2 },
  );
  assert.match(
    await page.locator(".tool-row[data-state=error]>summary").textContent(),
    /Workspace startup failed/,
  );
  assert.equal(modelCalls, 0);
  assert.deepEqual(errors, []);
  await writeFile(
    out + "/checks.json",
    JSON.stringify(
      {
        passed: true,
        modelCalls,
        errors,
        checks:
          "native projected inputs/results; one disclosure; keyboard Enter and output scrolling; status/error/empty/long; mobile/narrow/desktop; no hidden reasoning",
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS informative tool cards: mobile, narrow, desktop, keyboard; zero inference",
  );
} finally {
  await browser.close();
}
