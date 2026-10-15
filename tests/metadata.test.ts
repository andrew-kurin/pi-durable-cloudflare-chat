import { test } from "node:test";
import assert from "node:assert/strict";
import { resultSummary, safeMetadata } from "../src/tool-activity";
import { conversationTitle } from "../src/conversation-title";
const result = (data: unknown, name = "web_search") =>
  resultSummary(
    {
      model: [
        {
          role: "toolResult",
          toolCallId: "one",
          toolName: name,
          isError: false,
          content: [{ type: "text", text: JSON.stringify({ data }) }],
        },
      ],
    } as never,
    name,
  )!;
test("recorded output and normal source metadata are visible while credentials are masked", () => {
  const view = result({
    results: [
      {
        title: "Durable conversations",
        url: "https://example.com/guide?utm_source=test",
        excerpt: "Useful search excerpt",
      },
    ],
  });
  assert.match(view.summary!, /1 result · Durable conversations/);
  assert.equal(
    view.sources![0].url,
    "https://example.com/guide?utm_source=test",
  );
  assert.match(view.output!, /Useful search excerpt/);
  const repo = result(
    {
      url: "https://github.com/example/project",
      description: "A public project",
      text: "export const example = true;",
      sha: "abc",
    },
    "github_read",
  );
  assert.match(repo.output!, /export const example/);
  const delegate = result({ text: "Delegate conclusion" }, "ask_luna");
  assert.match(delegate.output!, /Delegate conclusion/);
});
test("display masks credential values without dropping ordinary diagnostic and path text", () => {
  assert.equal(
    safeMetadata("<script>inert</script>"),
    "<script>inert</script>",
  );
  assert.equal(safeMetadata("src/auth/token.ts"), "src/auth/token.ts");
  assert.match(safeMetadata("api_key=PRIVATE_VALUE"), /redacted/);
  assert.ok(!safeMetadata("api_key=PRIVATE_VALUE").includes("PRIVATE_VALUE"));
  const view = result({
    results: [
      "javascript:alert(1)",
      "https://user:pass@example.com",
      "https://example.com/?token=private",
      "https://127.0.0.1/a",
      "https://localhost/a",
    ].map((url) => ({ url, title: "test" })),
  });
  assert.equal(view.sources, undefined);
  assert.equal(safeMetadata("x".repeat(300)).length, 140);
  const long = resultSummary(
    {
      model: [
        {
          role: "toolResult",
          toolCallId: "c",
          toolName: "web_search",
          content: [{ type: "text", text: "x".repeat(17000) }],
        },
      ],
    } as never,
    "web_search",
  )!;
  assert.equal(long.output!.length, 12000);
  assert.equal(long.outputTruncated, true);
});
test("conversation titles are deterministic visible-text excerpts without URLs or secret patterns", () => {
  assert.equal(
    conversationTitle("  ## Compare **public tools**\nHTTPS://example.com  "),
    "Compare public tools",
  );
  assert.equal(conversationTitle("x".repeat(100)).length, 54);
  for (const text of [
    "token=private",
    "ghp_ABC123",
    "github_pat_ABC123",
    "api_key=private",
  ])
    assert.equal(conversationTitle(text), "");
  assert.equal(conversationTitle(undefined), "");
});
