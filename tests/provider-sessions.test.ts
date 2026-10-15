import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ProviderSessions,
  type ProviderConfig,
} from "../src/provider-sessions";
import { delegateModel } from "../src/chat-model";
function fixture(
  config: ProviderConfig = {},
  rows: any[] = [],
  login: Function = async () => {},
) {
  const data = new Map<string, unknown>();
  let prepared = 0;
  const jobs: Promise<unknown>[] = [];
  const storage = {
    get: async <T>(k: string) => data.get(k) as T | undefined,
    put: async (k: string, v: unknown) => {
      data.set(k, v);
    },
    delete: async (k: string) => data.delete(k),
    list: async () => new Map(),
    sql: { exec: () => [] },
  };
  const credentials = {
    list: async () => rows,
    read: async () => undefined,
    modify: async () => {},
    delete: async () => {},
  };
  const providers = new ProviderSessions(
    config,
    storage as any,
    credentials as any,
    { login } as any,
    async () => {
      prepared++;
    },
  );
  const options = (signal = new AbortController().signal) => ({
    signal,
    waitUntil: (p: Promise<unknown>) => jobs.push(p),
  });
  return {
    providers,
    config,
    rows,
    data,
    options,
    jobs,
    get prepared() {
      return prepared;
    },
  };
}
test("provider policy preserves old models, exact flags and OAuth-only connection status", async () => {
  const f = fixture(
    { ENABLE_MODEL: "true", ENABLE_GROK_SUBSCRIPTION: "true" },
    [{ providerId: "xai", type: "oauth", access: "DO_NOT_EXPOSE" }],
  );
  const old = { provider: "openai-codex", modelId: "gpt-6-astra" };
  const status = await f.providers.status(old);
  assert.deepEqual(status.model, old);
  assert.deepEqual(status.delegateModel, {
    provider: "openai-codex",
    modelId: "gpt-6-luna",
  });
  assert.equal(status.connected, false);
  assert.equal(status.newChatModel.provider, "xai");
  assert.deepEqual(await f.providers.newChatModel(), status.newChatModel);
  assert.ok(!JSON.stringify(status).includes("DO_NOT_EXPOSE"));
  const grok = { provider: "xai", modelId: "grok-4.6" };
  assert.deepEqual(delegateModel(grok), grok);
  assert.deepEqual((await f.providers.status(grok)).model, grok);
  f.rows[0].type = "api_key";
  assert.equal((await f.providers.status(grok)).connected, false);
  await assert.rejects(f.providers.newChatModel(), { status: 503 });
  f.config.ENABLE_GROK_SUBSCRIPTION = "TRUE";
  assert.deepEqual(await f.providers.newChatModel(), {
    provider: "openai-codex",
    modelId: "gpt-6-sol",
  });
});
test("disabled model access avoids model resolution; enabled access checks the selected provider", async () => {
  const f = fixture();
  let resolutions = 0;
  const resolve = async () => {
    resolutions++;
    return { provider: "xai", modelId: "grok-4.7" };
  };
  await assert.rejects(f.providers.assertCanSubmit(resolve), { status: 503 });
  assert.equal(resolutions, 0);
  f.config.ENABLE_MODEL = "true";
  await assert.rejects(
    f.providers.assertCanSubmit(resolve),
    /Grok access is disabled/,
  );
  f.config.ENABLE_GROK_SUBSCRIPTION = "true";
  await assert.rejects(
    f.providers.assertCanSubmit(resolve),
    /Connect your subscription/,
  );
  f.rows.push({ providerId: "xai", type: "oauth" });
  await f.providers.assertCanSubmit(resolve);
});
test("login flags and existing provider records deny new setup without side effects", async () => {
  let calls = 0;
  const f = fixture({}, [], async () => {
    calls++;
  });
  for (const provider of ["openai-codex", "xai"] as const)
    await assert.rejects(f.providers.startLogin(provider, f.options()));
  assert.equal(f.prepared, 0);
  assert.equal(calls, 0);
  f.config.ENABLE_SUBSCRIPTION_LOGIN = "true";
  f.rows.push({ providerId: "openai-codex", type: "api_key" });
  await assert.rejects(f.providers.startLogin("openai-codex", f.options()), {
    status: 409,
  });
  assert.equal(calls, 0);
  assert.equal(f.prepared, 0);
});
test("login cancellation releases provider session and does not expose raw errors", async () => {
  let calls = 0;
  const f = fixture(
    { ENABLE_SUBSCRIPTION_LOGIN: "true" },
    [],
    async (_provider: any, _method: any, options: any) => {
      calls++;
      options.signal.throwIfAborted();
      await new Promise((_, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(Error("PRIVATE_FAILURE")),
          { once: true },
        );
      });
    },
  );
  const abort = new AbortController();
  const response = await f.providers.startLogin(
    "openai-codex",
    f.options(abort.signal),
  );
  const reader = response.body!.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /starting/);
  const busy = await f.providers.startLogin("openai-codex", f.options());
  assert.equal(((await busy.json()) as any).status, "starting");
  assert.equal(calls, 1);
  abort.abort();
  let text = "";
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    text += new TextDecoder().decode(result.value);
  }
  await Promise.all(f.jobs);
  assert.match(text, /cancelled/);
  assert.ok(!text.includes("PRIVATE_FAILURE"));
  const secondAbort = new AbortController();
  const second = await f.providers.startLogin(
    "openai-codex",
    f.options(secondAbort.signal),
  );
  secondAbort.abort();
  await second.text();
  await Promise.all(f.jobs);
  assert.equal(calls, 2);
});
test("failed Codex preparation releases its claim for an explicit later attempt", async () => {
  const f = fixture({ ENABLE_SUBSCRIPTION_LOGIN: "true" });
  let fail = true;
  const providers = new ProviderSessions(
    f.config,
    { get: async () => undefined } as any,
    { list: async () => [] } as any,
    { login: async () => {} } as any,
    async () => {
      if (fail) throw Error("Synthetic prepare failure");
    },
  );
  await assert.rejects(
    providers.startLogin("openai-codex", f.options()),
    /Synthetic prepare failure/,
  );
  fail = false;
  const response = await providers.startLogin("openai-codex", f.options());
  assert.equal(response.status, 200);
  await response.text();
  await Promise.all(f.jobs);
});

test("a pending Codex initialization has one login owner", async () => {
  const f = fixture({ ENABLE_SUBSCRIPTION_LOGIN: "true" });
  let release!: () => void,
    entered!: () => void,
    preparations = 0;
  const ready = new Promise<void>((r) => (entered = r));
  const providers = new ProviderSessions(
    f.config,
    { get: async () => undefined, put: async () => {} } as any,
    { list: async () => [] } as any,
    { login: async () => {} } as any,
    async () => {
      preparations++;
      entered();
      await new Promise<void>((r) => (release = r));
    },
  );
  const pending = providers.startLogin("openai-codex", f.options());
  await ready;
  const busy = await providers.startLogin("openai-codex", f.options());
  assert.equal(busy.headers.get("content-type"), "application/json");
  assert.equal(preparations, 1);
  release();
  const response = await pending;
  await response.text();
  await Promise.all(f.jobs);
});
test("cancelling the login response stream stops setup and publishes only sanitized status", async () => {
  const f = fixture(
    { ENABLE_SUBSCRIPTION_LOGIN: "true" },
    [],
    async (_provider: any, _method: any, options: any) => {
      options.signal.throwIfAborted();
      await new Promise((_, reject) =>
        options.signal.addEventListener(
          "abort",
          () => reject(Error("PRIVATE_CANCEL_DETAIL")),
          { once: true },
        ),
      );
    },
  );
  const response = await f.providers.startLogin("openai-codex", f.options());
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  await Promise.all(f.jobs);
  const status = await f.providers.status({
    provider: "openai-codex",
    modelId: "gpt-6-sol",
  });
  assert.equal(status.login.status, "cancelled");
  assert.ok(!JSON.stringify(status).includes("PRIVATE_CANCEL_DETAIL"));
});
