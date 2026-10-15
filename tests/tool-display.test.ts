import { test } from "node:test";
import assert from "node:assert/strict";
import { inputContext, resultSummary, maskSecrets } from "../src/tool-activity";
const output = (value: unknown, isError = false) =>
  resultSummary(
    {
      model: [
        {
          role: "toolResult",
          toolCallId: "x",
          toolName: "workspace_logs",
          isError,
          content: [
            {
              type: "text",
              text:
                typeof value === "string"
                  ? value
                  : JSON.stringify({ data: value }),
            },
          ],
        },
      ],
    } as never,
    "workspace_logs",
  )!;
test("normal commands, queries, file content and recorded errors survive display projection", () => {
  for (const args of [
    { argv: ["npm", "test"], cwd: "src/auth" },
    { query: "Cloudflare recovery best practices" },
    { repo: "owner/project", path: "src/token.ts" },
    { path: "README.md" },
    { task: "Compare the two results" },
  ]) {
    const result = inputContext(args);
    assert.ok(result.context);
    assert.ok(result.input);
    assert.ok(!result.input!.includes("redacted"));
  }
  const result = output(
    "Workspace is not active: create a new task explicitly",
    true,
  );
  assert.equal(result.state, "error");
  assert.match(result.summary!, /Workspace is not active/);
  assert.match(
    output({ text: "Tests passed: 18" }).output!,
    /Tests passed: 18/,
  );
  assert.equal(output("").output, "");
  assert.equal(output("x".repeat(20000)).outputTruncated, true);
});
test("actual credentials are masked in argv, headers, structured and serialized output and encoded URLs", () => {
  const cases = [
    {
      argv: [
        "curl",
        "-u",
        "user:PASS_SECRET",
        "--cookie",
        "session=COOKIE_SECRET",
        "https://example.com",
      ],
    },
    {
      headers: {
        Authorization: 'Digest username="user", response="DIGEST_SECRET"',
        Cookie: "COOKIE_SECRET",
      },
    },
    { query: "https://example.com/?api%5Fkey=URL_SECRET&q=ordinary" },
  ];
  for (const value of cases) {
    const row = inputContext(value);
    for (const secret of [
      "PASS_SECRET",
      "COOKIE_SECRET",
      "DIGEST_SECRET",
      "URL_SECRET",
    ])
      assert.ok(!JSON.stringify(row).includes(secret), JSON.stringify(row));
  }
  for (const raw of [
    'Authorization: Digest username="user", response="DIGEST_SECRET"',
    "Cookie=session=COOKIE_SECRET; other=OTHER_SECRET",
    '{"headers":{"Cookie":"COOKIE_SECRET"}}',
    "https://example.com/?api%5Fkey=URL_SECRET",
    'password="TWO WORDS"',
    "Bearer BEARER_SECRET",
    "-----BEGIN RSA PRIVATE KEY-----\nKEY_SECRET\n-----END RSA PRIVATE KEY-----",
  ]) {
    const row = output(raw);
    for (const secret of [
      "DIGEST_SECRET",
      "COOKIE_SECRET",
      "OTHER_SECRET",
      "URL_SECRET",
      "TWO WORDS",
      "BEARER_SECRET",
      "KEY_SECRET",
    ])
      assert.ok(!JSON.stringify(row).includes(secret), JSON.stringify(row));
  }
  assert.equal(
    maskSecrets("Error reading /workspace/src/token.ts: file not found"),
    "Error reading /workspace/src/token.ts: file not found",
  );
});

test("credential flag forms are masked without hiding unrelated git short flags", () => {
  for (const argv of [
    ["curl", "-uuser:PASS_SECRET", "-bsession=COOKIE_SECRET"],
    ["curl", "--user=user:PASS_SECRET", "--cookie=session=COOKIE_SECRET"],
  ]) {
    const row = inputContext({ argv });
    assert.ok(!JSON.stringify(row).includes("PASS_SECRET"));
    assert.ok(!JSON.stringify(row).includes("COOKIE_SECRET"));
  }
  const git = inputContext({
    argv: ["git", "checkout", "-b", "feature/tool-cards"],
  });
  assert.match(git.context!, /feature\/tool-cards/);
  assert.ok(!git.context!.includes("redacted"));
});

test("credential environment fields are masked while ordinary file and token count fields stay visible", () => {
  const row = output({
    env: {
      OPENAI_API_KEY: "ENV_KEY_SECRET",
      DB_PASSWORD: "DB_PASS_SECRET",
      GITHUB_TOKEN: "ENV_TOKEN_SECRET",
    },
    path: "src/token.ts",
    token_count: 42,
  });
  for (const value of ["ENV_KEY_SECRET", "DB_PASS_SECRET", "ENV_TOKEN_SECRET"])
    assert.ok(!JSON.stringify(row).includes(value));
  assert.match(row.output!, /src\/token.ts/);
  assert.match(row.output!, /42/);
});

test("credential assignment recognition matches field masking without crossing shell command boundaries", () => {
  for (const key of [
    "AWS_SECRET_ACCESS_KEY",
    "PRIVATE_KEY",
    "X-Amz-Signature",
  ]) {
    assert.ok(
      !maskSecrets(key + "=ASSIGNMENT_SECRET").includes("ASSIGNMENT_SECRET"),
    );
    assert.ok(
      !JSON.stringify(output({ text: key + "=ASSIGNMENT_SECRET" })).includes(
        "ASSIGNMENT_SECRET",
      ),
    );
    assert.ok(
      !JSON.stringify(
        inputContext({
          argv: ["env", key + "=ASSIGNMENT_SECRET", "npm", "test"],
        }),
      ).includes("ASSIGNMENT_SECRET"),
    );
  }
  const row = inputContext({
    argv: [
      "sh",
      "-c",
      "curl -u user:PASS_SECRET https://example.com; git checkout -b feature",
    ],
  });
  assert.ok(!JSON.stringify(row).includes("PASS_SECRET"));
  assert.match(row.context!, /git checkout -b feature/);
});
