import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  createCredentialStore, startSubscriptionLogin, SUBSCRIPTION_VERIFICATION_URI,
  type CredentialStorage, type SubscriptionLoginStatus,
} from "../src/credentials.ts";
import type { Credential, Models } from "@earendil-works/pi-ai";

// Synthetic test key and credentials only. These are never sent to a provider.
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const credential = (access = "fake-access"): Credential => ({
  type: "oauth", access, refresh: "fake-refresh", expires: Date.now() + 3600000,
});
class FakeStorage implements CredentialStorage {
  values = new Map<string, unknown>();
  async get<T>(key: string) { return structuredClone(this.values.get(key)) as T | undefined; }
  async put<T>(key: string, value: T) { this.values.set(key, structuredClone(value)); }
  async delete(key: string) { return this.values.delete(key); }
  async list<T>({ prefix = "" } = {}) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix))) as Map<string, T>;
  }
}

test("requires a 32-byte base64 secret and stores only encrypted credential envelopes", async () => {
  const storage = new FakeStorage();
  assert.throws(() => createCredentialStore(storage, ""), /encryption secret/);
  assert.throws(() => createCredentialStore(storage, "not-a-key"), /encryption secret/);
  const store = createCredentialStore(storage, KEY);
  const expected = credential();
  await store.modify("openai-codex", async () => expected);
  assert.deepEqual(await store.read("openai-codex"), expected);
  assert.deepEqual(await store.list(), [{ providerId: "openai-codex", type: "oauth" }]);
  assert.equal(JSON.stringify([...storage.values]).includes("fake-access"), false);
  assert.equal(JSON.stringify([...storage.values]).includes("fake-refresh"), false);
  const first = [...storage.values.values()][0];
  await store.modify("openai-codex", async (current) => current);
  assert.notDeepEqual([...storage.values.values()][0], first, "each write uses a fresh IV");
  assert.deepEqual(await store.modify("openai-codex", async () => undefined), expected);
  await store.delete("openai-codex");
  assert.equal(await store.read("openai-codex"), undefined);
});

test("ciphertext is authenticated and bound to its provider", async () => {
  const storage = new FakeStorage();
  const store = createCredentialStore(storage, KEY);
  await store.modify("openai-codex", async () => credential());
  const value = storage.values.get("credentials:v1:openai-codex");
  storage.values.set("credentials:v1:other", value);
  await assert.rejects(store.read("other"), /decrypt/);
  const wrong = createCredentialStore(storage, btoa(String.fromCharCode(...new Uint8Array(32).fill(8))));
  await assert.rejects(wrong.read("openai-codex"), /decrypt/);
});

test("refresh and delete serialize across separate adapters for the same DO storage", async () => {
  const storage = new FakeStorage();
  const one = createCredentialStore(storage, KEY);
  const two = createCredentialStore(storage, KEY);
  await one.modify("openai-codex", async () => credential("old"));
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let refreshCount = 0;
  const refresh = (store: ReturnType<typeof createCredentialStore>) => store.modify("openai-codex", async (current) => {
    if (current?.type === "oauth" && current.access === "old") {
      refreshCount++;
      await blocked;
      return credential("new");
    }
    return current;
  });
  const first = refresh(one);
  const second = refresh(two);
  release();
  await Promise.all([first, second]);
  assert.equal(refreshCount, 1);
  assert.equal((await two.read("openai-codex"))?.type, "oauth");
  const pending = one.modify("openai-codex", async () => credential("final"));
  const deletion = two.delete("openai-codex");
  await Promise.all([pending, deletion]);
  assert.equal(await one.read("openai-codex"), undefined);
});

test("a failed mutation does not poison the queue, and aborted writes preserve credentials", async () => {
  const storage = new FakeStorage();
  const store = createCredentialStore(storage, KEY);
  await assert.rejects(store.modify("openai-codex", async () => { throw new Error("synthetic failure"); }));
  const expected = credential();
  await store.modify("openai-codex", async () => expected);
  const controller = new AbortController();
  await assert.rejects(store.modify("openai-codex", async () => {
    controller.abort();
    return credential("must-not-save");
  }, { signal: controller.signal }));
  assert.deepEqual(await store.read("openai-codex"), expected);
});

test("login is opt-in, selects headless device login, hides raw events and retains host identity", async () => {
  const storage = new FakeStorage();
  const statuses: SubscriptionLoginStatus[] = [];
  const hosts: string[] = [];
  let calls = 0;
  const models: Pick<Models, "login"> = { login: async (provider, type, interaction, options) => {
    calls++;
    assert.equal(provider, "openai-codex");
    assert.equal(type, "oauth");
    hosts.push(options!.getDeviceId!());
    assert.equal(await interaction.prompt({ type: "select", message: "choose", options: [
      { id: "browser", label: "browser" }, { id: "device_code", label: "device" },
    ] }), "device_code");
    interaction.notify({ type: "info", message: "fake-secret-do-not-expose" });
    interaction.notify({ type: "auth_url", url: "https://example.invalid/?token=fake-secret" });
    interaction.notify({ type: "device_code", userCode: "TEST-1234", verificationUri: SUBSCRIPTION_VERIFICATION_URI });
    return credential();
  } };
  assert.deepEqual(await startSubscriptionLogin(models, storage, (s) => statuses.push(s)), { status: "disabled" });
  assert.deepEqual(await startSubscriptionLogin(models, storage, (s) => statuses.push(s), { enabled: true }), { status: "unsupported" });
  assert.equal(calls, 0);
  for (let index = 0; index < 2; index++) {
    assert.deepEqual(await startSubscriptionLogin(models, storage, (s) => statuses.push(s), {
      enabled: true, runtimeSupported: true,
    }), { status: "connected" });
  }
  assert.equal(hosts[0], hosts[1]);
  assert.equal(JSON.stringify(statuses).includes("fake-secret"), false);
  assert.equal(JSON.stringify(statuses).includes("fake-access"), false);
  assert.deepEqual(statuses.filter((s) => s.status === "device_code")[0], {
    status: "device_code", userCode: "TEST-1234", verificationUri: SUBSCRIPTION_VERIFICATION_URI,
  });
});

test("login sanitizes errors and rejects unexpected verification destinations", async () => {
  const storage = new FakeStorage();
  const statuses: SubscriptionLoginStatus[] = [];
  const models: Pick<Models, "login"> = { login: async (_provider, _type, interaction) => {
    interaction.notify({ type: "device_code", userCode: "TEST-1234", verificationUri: "https://attacker.invalid" });
    throw new Error("fake-token-should-never-leak");
  } };
  const result = await startSubscriptionLogin(models, storage, (s) => statuses.push(s), { enabled: true, runtimeSupported: true });
  assert.deepEqual(result, { status: "failed" });
  assert.deepEqual(statuses, [{ status: "starting" }, { status: "failed" }]);
});

test("concurrent login is rejected, abort is sanitized, and a later attempt can run", async () => {
  const storage = new FakeStorage();
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const models: Pick<Models, "login"> = { login: async (_provider, _type, interaction) => {
    started();
    await new Promise<void>((_resolve, reject) => {
      interaction.signal!.addEventListener("abort", () => reject(new Error("sensitive-provider-error")), { once: true });
    });
    return credential();
  } };
  const statuses: SubscriptionLoginStatus[] = [];
  const first = startSubscriptionLogin(models, storage, (s) => statuses.push(s), {
    enabled: true, runtimeSupported: true, signal: controller.signal,
  });
  await ready;
  assert.deepEqual(await startSubscriptionLogin(models, storage, () => {}, {
    enabled: true, runtimeSupported: true,
  }), { status: "busy" });
  controller.abort();
  assert.deepEqual(await first, { status: "cancelled" });
  assert.deepEqual(statuses, [{ status: "starting" }, { status: "cancelled" }]);
  assert.deepEqual(await startSubscriptionLogin({ login: async () => credential() }, storage, () => {}, {
    enabled: true, runtimeSupported: true,
  }), { status: "connected" });
});

test("statically bundled pi-ai device login and concurrent refresh work in workerd with fake fetch only", async () => {
  const worker = `
    import { DurableObject } from 'cloudflare:workers';
    import { createModels } from '@earendil-works/pi-ai/models';
    import { createCredentialStore, startSubscriptionLogin } from '../src/credentials.ts';
    import { createWorkerCodexProvider } from '../src/oauth-loader.ts';
    export class CredentialTestObject extends DurableObject { async fetch() {
      const storage = this.ctx.storage;
      const store = createCredentialStore(storage, ${JSON.stringify(KEY)});
      const models = createModels({ credentials: store, authContext: { env: async () => undefined, fileExists: async () => false } });
      models.setProvider(createWorkerCodexProvider());
      let exchanges = 0, refreshes = 0;
      const requests = [];
      const fakeAccess = 'fake.' + btoa(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })) + '.signature';
      // Any unexpected request throws; this worker cannot make a real OAuth call.
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.origin !== 'https://auth.openai.com') throw new Error('Unexpected test network destination');
        requests.push(url.pathname);
        if (url.pathname === '/api/accounts/deviceauth/usercode') return Response.json({ device_auth_id: 'fake-device', user_code: 'TEST-1234', interval: '0' });
        if (url.pathname === '/api/accounts/deviceauth/token') return Response.json({ authorization_code: 'fake-code', code_verifier: 'fake-verifier' });
        if (url.pathname === '/oauth/token') {
          const refresh = new URLSearchParams(init.body).get('grant_type') === 'refresh_token';
          if (refresh) refreshes++; else exchanges++;
          return Response.json({ access_token: fakeAccess, refresh_token: 'synthetic-refresh', expires_in: refresh ? 3600 : 0 });
        }
        throw new Error('Unexpected test endpoint');
      };
      const statuses = [];
      const result = await startSubscriptionLogin(models, storage, status => statuses.push(status), { enabled: true, runtimeSupported: true });
      const resolved = await Promise.all([models.getAuth('openai-codex'), models.getAuth('openai-codex')]);
      const data = await storage.list();
      return Response.json({ result, statuses, requests, exchanges, refreshes,
        validAuth: resolved.every(value => value.auth.apiKey === fakeAccess),
        encryptedAtRest: !JSON.stringify([...data]).includes('synthetic-refresh'),
        hostIdPersisted: [...data.keys()].includes('subscription:host-id:v1'),
      });
    } }
    export default { fetch(request, env) { return env.TEST.get(env.TEST.idFromName('test')).fetch(request); } };
  `;
  const bundle = await build({ stdin: { contents: worker, resolveDir: path.resolve("tests"), loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", external: ["node:*", "cloudflare:*"], logLevel: "silent" });
  const mf = new Miniflare(convertV4MiniflareOptions({cf:false, modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-10-11", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { TEST: "CredentialTestObject" } }));
  try {
    const response = await mf.dispatchFetch("http://localhost/test");
    assert.equal(response.status, 200);
    const result = await response.json() as any;
    assert.deepEqual(result.result, { status: "connected" });
    assert.deepEqual(result.statuses, [
      { status: "starting" },
      { status: "device_code", userCode: "TEST-1234", verificationUri: SUBSCRIPTION_VERIFICATION_URI },
      { status: "connected" },
    ]);
    assert.equal(result.exchanges, 1);
    assert.equal(result.refreshes, 1, "concurrent auth requests exchange the rotating refresh token once");
    assert.equal(result.validAuth, true);
    assert.equal(result.encryptedAtRest, true);
    assert.equal(result.hostIdPersisted, true);
    assert.equal(JSON.stringify(result.statuses).includes("synthetic"), false);
  } finally { await mf.dispose(); }
});
