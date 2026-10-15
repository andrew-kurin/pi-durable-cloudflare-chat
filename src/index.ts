import { HistoryFeed } from "./history-feed";
import { WorkspaceCoordinator } from "./workspace-coordinator";
import { ChatCatalog } from "./chat-catalog";
import { RequestError, jsonObject } from "./http-input";
import { logTechnicalError } from "./error-log";
import { DurableObject } from "cloudflare:workers";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { newChatModel } from "./chat-model";
import { createModels } from "@earendil-works/pi-ai/models";
import { createWorkerCodexProvider } from "./oauth-loader";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { authorize, secured, type AccessConfig } from "./auth";
import { guardModels } from "./model-guard";
import { delegation } from "./delegate";
import { readTools } from "./read-tools";
import { workspaceTools } from "./workspace-tools";
import { TaskWorkspace } from "./workspace-container";
import workspaceSmoke from "./workspace-smoke";
import {
  createWorkerGrokProvider,
  grokCatalog,
  startGrokSubscriptionLogin,
  runGrokToolCheck,
  GROK_CHECK_BUDGET,
  type GrokLoginStatus,
  type GrokCheckResult,
} from "./grok-subscription";
export { TaskWorkspace };
import {
  runSearchCheck,
  searchCheckStatus,
  previousSearchCheckStatus,
  runGithubCheck,
  githubCheckStatus,
} from "./search-check";
import {
  createCredentialStore,
  startSubscriptionLogin,
  type SubscriptionLoginStatus,
} from "./credentials";
declare const PI_DEPLOYMENT_MODE: string;
const deploymentMode =
  typeof PI_DEPLOYMENT_MODE === "undefined" ? "local" : PI_DEPLOYMENT_MODE;
interface Env extends AccessConfig {
  ASSETS: Fetcher;
  Assistant: DurableObjectNamespace<Assistant>;
  CREDENTIAL_ENCRYPTION_KEY: string;
  ENABLE_MODEL: string;
  ENABLE_SUBSCRIPTION_LOGIN: string;
  ENABLE_GROK_SUBSCRIPTION?: string;
  GROK_CHAT_MODEL?: string;
  TAVILY_API_KEY?: string;
  ENABLE_WEB_SEARCH?: string;
  ENABLE_WEB_SEARCH_TEST?: string;
  ENABLE_WORKSPACE?: string;
  ENABLE_WORKSPACE_SMOKE?: string;
  WORKSPACE_REPOSITORY?: string;
  WORKSPACE_IMAGE?: string;
  Workspaces?: DurableObjectNamespace<TaskWorkspace>;
}
export class Assistant extends DurableObject<Env> {
  private workspaces = new WorkspaceCoordinator(
    this.ctx.storage,
    this.env,
    (id) => this.chatCatalog.requireActive(id),
  );
  private workspaceEnabled() {
    return this.workspaces.enabled();
  }
  private credentials = createCredentialStore(
    this.ctx.storage,
    this.env.CREDENTIAL_ENCRYPTION_KEY,
  );
  private models = guardModels(
    createModels({
      credentials: this.credentials,
      authContext: {
        env: async () => undefined,
        fileExists: async () => false,
      },
    }),
    async () => {
      if (this.env.ENABLE_MODEL !== "true") throw new Error("Model disabled");
      await this.ctx.storage.transaction(async (tx) => {
        const day = new Date().toISOString().slice(0, 10);
        const count = await tx.get<{ day: string; count: number }>(
          "model-quota",
        );
        const used = count?.day === day ? count.count : 0;
        if (used >= 150) throw new Error("Daily model request limit");
        await tx.put("model-quota", { day, count: used + 1 });
      });
    },
  );
  private loginStatus: SubscriptionLoginStatus = { status: "disabled" };
  private loginActive = false;
  private grokLoginActive = false;
  private grokLoginStatus: GrokLoginStatus = { status: "disabled" };
  private grokModels() {
    const models = createModels({
      credentials: this.credentials,
      authContext: {
        env: async () => undefined,
        fileExists: async () => false,
      },
    });
    models.setProvider(createWorkerGrokProvider());
    return models;
  }
  private async sessionModel(sid: string) {
    return (
      (await (await this.harness.conversation(sid)).agent(BACKGROUND_CONTEXT))
        .model ?? { provider: "openai-codex", modelId: "gpt-6-sol" }
    );
  }
  private admission: Promise<unknown> = Promise.resolve();
  harness = new PiHarness({
    harness: ({ storage, context }) => {
      const registry = createRegistry();
      registry.install(delegation());
      if (this.workspaceEnabled())
        registry.install(
          workspaceTools({
            request: (session, r) => this.workspaces.execute(session, r),
          }),
        );
      registry.install(readTools(this.ctx.storage, this.env));
      const provider = createWorkerCodexProvider();
      this.models.setProvider(provider);
      this.models.setProvider(createWorkerGrokProvider());
      return Harness.open(
        storage,
        {
          models: this.models,
          registry,
          settings: {
            compaction: { enabled: false },
            progress: { partialIntervalMs: 250, outputIntervalMs: 500 },
            retry: { enabled: true, maxRetries: 1, baseDelayMs: 1000 },
            stream: { transport: "sse", timeoutMs: 120000, maxRetries: 0 },
          },
        },
        context,
      );
    },
    defaults: {
      model: { provider: "openai-codex", id: "gpt-6-sol" },
      thinkingLevel: "low",
    },
  });
  private chatCatalog = new ChatCatalog(
    this.ctx.storage,
    this.harness,
    async () => {
      const model =
        this.env.ENABLE_GROK_SUBSCRIPTION === "true"
          ? newChatModel(this.env.GROK_CHAT_MODEL)
          : { provider: "openai-codex", modelId: "gpt-6-sol" };
      if (
        model.provider === "xai" &&
        !(await this.credentials.list()).some(
          (x) => x.providerId === "xai" && x.type === "oauth",
        )
      )
        throw new RequestError(503, "Connect Grok before creating a new chat");
      return model;
    },
    (sid) => this.workspaces.assertChatCanBeTrashed(sid),
  );
  private history = new HistoryFeed(
    this.harness,
    this.ctx.storage,
    this.chatCatalog,
  );
  lifecycle = Lifecycle.install(this).use(this.harness);
  async fetch(request: Request): Promise<Response> {
    try {
      await authorize(request, this.env);
    } catch {
      return new Response("Forbidden", { status: 403 });
    }
    // Cancellation/extension must reach the workspace even while setup is awaiting I/O.
    if (
      request.method === "POST" &&
      new URL(request.url).pathname === "/api/events/close"
    )
      return this.handle(request);
    if (
      request.method === "POST" &&
      /^\/api\/workspaces\/[a-f0-9-]{36}(?:\/extend)?$/.test(
        new URL(request.url).pathname,
      )
    )
      return this.handle(request);
    if (request.method === "POST") {
      const work = this.admission.then(() => this.handle(request));
      this.admission = work.then(
        () => undefined,
        () => undefined,
      );
      return work;
    }
    return this.handle(request);
  }
  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const sid = url.searchParams.get("session") ?? "1";
    if (!/^\d{1,12}$/.test(sid))
      return Response.json({ error: "Invalid session" }, { status: 400 });
    try {
      if (
        path === "/api/status" ||
        path === "/api/events" ||
        path === "/api/submit" ||
        path === "/api/session-title" ||
        path.startsWith("/api/workspaces")
      )
        await this.chatCatalog.requireActive(sid);
      if (path.startsWith("/api/grok/")) {
        if (this.env.ENABLE_GROK_SUBSCRIPTION !== "true")
          return Response.json(
            { error: "Grok setup is not enabled" },
            { status: 404 },
          );
        if (path === "/api/grok/status" && request.method === "GET")
          return Response.json({
            connected: (await this.credentials.list()).some(
              (c) => c.providerId === "xai" && c.type === "oauth",
            ),
            login: this.grokLoginStatus,
            models: grokCatalog(),
            budget: GROK_CHECK_BUDGET,
            check:
              (await this.ctx.storage.get<{
                state: string;
                report: GrokCheckResult;
              }>("grok-tool-check:v1")) ?? null,
          });
        if (
          request.method !== "POST" ||
          !["/api/grok/login", "/api/grok/check"].includes(path)
        )
          return Response.json({ error: "Not found" }, { status: 404 });
        const raw = await request.text();
        if (raw.length > 100)
          return Response.json(
            { error: "Invalid setup action" },
            { status: 400 },
          );
        let body: unknown;
        try {
          body = jsonObject(raw);
        } catch {
          return Response.json(
            { error: "Invalid setup action" },
            { status: 400 },
          );
        }
        if (!body || typeof body !== "object" || Array.isArray(body))
          return Response.json(
            { error: "Invalid setup action" },
            { status: 400 },
          );
        if (path === "/api/grok/login") {
          if (Object.keys(body).length !== 0)
            return Response.json(
              { error: "Invalid setup action" },
              { status: 400 },
            );
          if (
            (await this.credentials.list()).some((c) => c.providerId === "xai")
          )
            return Response.json(
              { error: "Grok is already configured" },
              { status: 409 },
            );
          if (this.grokLoginActive)
            return Response.json(
              { error: "Grok sign-in is already running" },
              { status: 409 },
            );
          this.grokLoginActive = true;
          const abort = new AbortController();
          const onAbort = () => abort.abort();
          request.signal.addEventListener("abort", onAbort, { once: true });
          if (request.signal.aborted) onAbort();
          const stream = new ReadableStream<Uint8Array>({
            start: (controller) => {
              const job = startGrokSubscriptionLogin(
                this.grokModels(),
                this.ctx.storage,
                (status) => {
                  this.grokLoginStatus = status;
                  try {
                    controller.enqueue(
                      new TextEncoder().encode(JSON.stringify(status) + "\n"),
                    );
                  } catch {
                    abort.abort();
                  }
                },
                { enabled: true, signal: abort.signal },
              ).finally(() => {
                this.grokLoginActive = false;
                request.signal.removeEventListener("abort", onAbort);
                try {
                  controller.close();
                } catch {}
              });
              this.ctx.waitUntil(job);
            },
            cancel: () => abort.abort(),
          });
          return new Response(stream, {
            headers: {
              "Content-Type": "application/x-ndjson",
              "Cache-Control": "no-store",
            },
          });
        }
        const action = body as Record<string, unknown>;
        if (
          Object.keys(action).length !== 2 ||
          action.approved !== true ||
          typeof action.model !== "string" ||
          !grokCatalog().some((m) => m.id === action.model)
        )
          return Response.json(
            { error: "Approve the fixed test and select a listed model" },
            { status: 400 },
          );
        if (
          (await this.harness.sessions.list()).some((session) => session.busy)
        )
          return Response.json(
            { error: "Wait for the current chat request to finish" },
            { status: 409 },
          );
        const result = await runGrokToolCheck(
          this.grokModels(),
          this.credentials,
          action.model,
          { approved: true, storage: this.ctx.storage, signal: request.signal },
        );
        // Non-secret terminal evidence is SQL-readable; credential KV is never exported.
        if (result.status === "passed" || result.status === "failed") {
          this.ctx.storage.sql.exec(
            "CREATE TABLE IF NOT EXISTS app_grok_check_results (id TEXT PRIMARY KEY, recorded_at INTEGER NOT NULL, result TEXT NOT NULL CHECK(json_valid(result)))",
          );
          this.ctx.storage.sql.exec(
            "INSERT INTO app_grok_check_results (id,recorded_at,result) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING",
            "v1",
            Date.now(),
            JSON.stringify(result),
          );
        }
        return Response.json(result);
      }
      if (path === "/api/status" && request.method === "GET") {
        const model = await this.sessionModel(sid);
        return Response.json({
          model,
          delegateModel:
            model.provider === "xai"
              ? model
              : { provider: "openai-codex", modelId: "gpt-6-luna" },
          newChatModel:
            this.env.ENABLE_GROK_SUBSCRIPTION === "true"
              ? newChatModel(this.env.GROK_CHAT_MODEL)
              : { provider: "openai-codex", modelId: "gpt-6-sol" },
          deploymentMode,
          modelEnabled: this.env.ENABLE_MODEL === "true",
          canLogin:
            model.provider === "openai-codex" &&
            this.env.ENABLE_SUBSCRIPTION_LOGIN === "true",
          connected: (await this.credentials.list()).some(
            (x) => x.providerId === model.provider && x.type === "oauth",
          ),
          login: this.loginStatus,
          webSearchEnabled: this.env.ENABLE_WEB_SEARCH === "true",
          searchKeyPresent: !!this.env.TAVILY_API_KEY,
          canCheckSearch:
            this.env.ENABLE_WEB_SEARCH_TEST === "true" &&
            this.env.ENABLE_WEB_SEARCH !== "true" &&
            !!this.env.TAVILY_API_KEY,
          searchCheck: await searchCheckStatus(this.ctx.storage),
          previousSearchCheck: await previousSearchCheckStatus(
            this.ctx.storage,
          ),
          githubCheck: await githubCheckStatus(this.ctx.storage),
          workspaceEnabled: this.workspaceEnabled(),
          workspaceRepository: this.workspaceEnabled()
            ? this.env.WORKSPACE_REPOSITORY
            : undefined,
        });
      }
      if (path === "/api/workspaces" && request.method === "GET") {
        if (!this.workspaceEnabled())
          return Response.json(
            { error: "Workspace disabled" },
            { status: 403 },
          );
        return Response.json(await this.workspaces.current(sid));
      }
      if (path === "/api/workspaces" && request.method === "POST") {
        if (!this.workspaceEnabled())
          return Response.json(
            { error: "Workspace disabled" },
            { status: 403 },
          );
        const raw = await request.text();
        if (raw.length > 1000)
          return Response.json(
            { error: "Invalid workspace request" },
            { status: 400 },
          );
        const b = jsonObject(raw);
        if (
          typeof b.workspaceId !== "string" ||
          !/^[a-f0-9-]{36}$/.test(b.workspaceId)
        )
          return Response.json(
            { error: "Invalid workspace ID" },
            { status: 400 },
          );
        return Response.json(await this.workspaces.open(sid, b.workspaceId));
      }
      const workspaceRoute =
        /^\/api\/workspaces\/([a-f0-9-]{36})(?:\/(artifact|extend))?$/.exec(
          path,
        );
      if (workspaceRoute) {
        if (!this.workspaceEnabled())
          return Response.json(
            { error: "Workspace disabled" },
            { status: 403 },
          );
        const [, id, operation] = workspaceRoute;
        if (operation === "artifact" && request.method === "GET")
          return Response.json(
            await this.workspaces.artifact(
              sid,
              id,
              url.searchParams.get("export") ?? undefined,
            ),
            {
              headers: {
                "Content-Disposition": `attachment; filename="workspace-${id}.json"`,
              },
            },
          );
        if (operation === "extend" && request.method === "POST") {
          const raw = await request.text();
          if (raw.length > 1000)
            return Response.json(
              { error: "Invalid extension" },
              { status: 400 },
            );
          const b = jsonObject(raw);
          if (
            (b.target !== "task" && b.target !== "command") ||
            typeof b.minutes !== "number"
          )
            return Response.json(
              { error: "Invalid extension target" },
              { status: 400 },
            );
          return Response.json(
            await this.workspaces.extend(sid, id, b.target, b.minutes),
          );
        }
        if (!operation && request.method === "GET")
          return Response.json(await this.workspaces.status(sid, id));
        if (!operation && request.method === "POST") {
          const raw = await request.text();
          if (raw.length > 1000)
            return Response.json(
              { error: "Invalid owner action" },
              { status: 400 },
            );
          const b = jsonObject(raw);
          if (
            (b.action !== "cancel" && b.action !== "export") ||
            typeof b.operationId !== "string"
          )
            return Response.json(
              {
                error: "Use typed model tools for workspace files and commands",
              },
              { status: 400 },
            );
          return Response.json(
            await this.workspaces.ownerAction(sid, id, b.action, b.operationId),
          );
        }
        return Response.json({ error: "Method not allowed" }, { status: 405 });
      }
      if (path === "/api/search-check" && request.method === "POST") {
        if (
          this.env.ENABLE_WEB_SEARCH_TEST !== "true" ||
          this.env.ENABLE_WEB_SEARCH === "true" ||
          !this.env.TAVILY_API_KEY
        )
          return Response.json(
            { error: "Search check is not enabled" },
            { status: 403 },
          );
        const body = await request.text();
        if (body !== '{"action":"run-approved-search-check"}')
          return Response.json(
            { error: "Invalid search check" },
            { status: 400 },
          );
        const search = await runSearchCheck(this.ctx.storage, this.env);
        const github =
          search.status === "passed"
            ? await runGithubCheck(this.ctx.storage)
            : await githubCheckStatus(this.ctx.storage);
        return Response.json({ search, github });
      }
      if (path === "/api/login" && request.method === "POST") {
        if (this.env.ENABLE_SUBSCRIPTION_LOGIN !== "true")
          return Response.json(
            { error: "Subscription setup is not enabled" },
            { status: 403 },
          );
        if (
          (await this.credentials.list()).some(
            (x) => x.providerId === "openai-codex",
          )
        )
          return Response.json(
            { error: "Subscription is already connected." },
            { status: 409 },
          );
        if (this.loginActive) return Response.json(this.loginStatus);
        await this.harness.pi();
        this.loginActive = true;
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), 5 * 60 * 1000);
        request.signal.addEventListener("abort", () => abort.abort(), {
          once: true,
        });
        const body = new ReadableStream<Uint8Array>({
          start: (controller) => {
            const job = startSubscriptionLogin(
              this.models,
              this.ctx.storage,
              (s) => {
                this.loginStatus = s;
                try {
                  controller.enqueue(
                    new TextEncoder().encode(JSON.stringify(s) + "\n"),
                  );
                } catch {
                  abort.abort();
                }
              },
              { enabled: true, runtimeSupported: true, signal: abort.signal },
            ).finally(() => {
              clearTimeout(timer);
              this.loginActive = false;
              try {
                controller.close();
              } catch {}
            });
            this.ctx.waitUntil(job);
          },
          cancel: () => {
            abort.abort();
          },
        });
        return new Response(body, {
          headers: {
            "Content-Type": "application/x-ndjson",
            "Cache-Control": "no-store",
          },
        });
      }
      if (path === "/api/sessions" && request.method === "GET")
        return Response.json(
          await this.chatCatalog.list(url.searchParams.get("deleted") === "1"),
        );
      if (path === "/api/session-trash" && request.method === "POST") {
        const raw = await request.text();
        if (raw.length > 100)
          return Response.json(
            { error: "Invalid chat action" },
            { status: 400 },
          );
        const body = jsonObject(raw);
        if (
          Object.keys(body).length !== 1 ||
          (body.action !== "delete" && body.action !== "restore")
        )
          return Response.json(
            { error: "Use delete or restore" },
            { status: 400 },
          );
        return Response.json(
          await (body.action === "delete"
            ? this.chatCatalog.trash(sid)
            : this.chatCatalog.restore(sid)),
        );
      }
      if (path === "/api/session-title" && request.method === "POST") {
        const raw = await request.text();
        if (raw.length > 1000)
          return Response.json({ error: "Title too long" }, { status: 400 });
        const b = jsonObject(raw);
        if (
          typeof b.title !== "string" ||
          !b.title.trim() ||
          b.title.length > 80 ||
          /[\x00-\x1f\x7f]/.test(b.title)
        )
          return Response.json(
            { error: "Use a title of 1–80 characters" },
            { status: 400 },
          );
        await this.chatCatalog.requireActive(sid);
        return Response.json(
          await this.chatCatalog.rename(sid, b.title.trim()),
        );
      }
      if (path === "/api/sessions" && request.method === "POST")
        return Response.json(await this.chatCatalog.create());
      if (path === "/api/submit" && request.method === "POST") {
        if (this.env.ENABLE_MODEL !== "true")
          return Response.json(
            { error: "Model access is not enabled yet" },
            { status: 503 },
          );
        const model = await this.sessionModel(sid);
        if (
          model.provider === "xai" &&
          this.env.ENABLE_GROK_SUBSCRIPTION !== "true"
        )
          return Response.json(
            { error: "Grok access is disabled" },
            { status: 503 },
          );
        if (
          !(await this.credentials.list()).some(
            (x) => x.providerId === model.provider && x.type === "oauth",
          )
        )
          return Response.json(
            { error: "Connect your subscription first" },
            { status: 503 },
          );
        const raw = await request.text();
        if (raw.length > 20000)
          return Response.json({ error: "Message too long" }, { status: 413 });
        const b = jsonObject(raw);
        if (
          typeof b.text !== "string" ||
          !b.text.trim() ||
          b.text.length > 12000 ||
          typeof b.operationId !== "string" ||
          !/^[-a-zA-Z0-9]{8,80}$/.test(b.operationId)
        )
          return Response.json({ error: "Invalid message" }, { status: 400 });
        const key = `admission:${sid}:${b.operationId}`;
        const digest = Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(b.text),
            ),
          ),
        )
          .map((x) => x.toString(16).padStart(2, "0"))
          .join("");
        const prior = await this.ctx.storage.get<{
          digest: string;
          receipt?: unknown;
        }>(key);
        if (prior && prior.digest !== digest)
          return Response.json(
            { error: "Operation ID already used" },
            { status: 409 },
          );
        if (prior?.receipt) return Response.json(prior.receipt);
        if (!prior) {
          if ((await this.harness.sessions.list()).some((s) => s.busy))
            return Response.json(
              { error: "Wait for the current request to finish" },
              { status: 409 },
            );
          const reserved = await this.ctx.storage.transaction(async (tx) => {
            const today = new Date().toISOString().slice(0, 10);
            const daily = await tx.get<{ day: string; count: number }>("quota");
            const count = daily?.day === today ? daily.count : 0;
            if (count >= 50) return false;
            await tx.put("quota", { day: today, count: count + 1 });
            await tx.put(key, { digest });
            return true;
          });
          if (!reserved)
            return Response.json(
              { error: "Daily limit of 50 messages reached" },
              { status: 429 },
            );
        }
        const receipt = await this.harness.submit(b.text, {
          session: sid,
          operationId: b.operationId,
        });
        await this.ctx.storage.put(key, { digest, receipt });
        await this.chatCatalog.autoTitle(sid, b.text);
        return Response.json(receipt);
      }
      if (path === "/api/abort" && request.method === "POST")
        return Response.json({
          aborted: await this.harness.abort({ session: sid }),
        });
      if (path === "/api/events/close" && request.method === "POST") {
        const id = url.searchParams.get("stream");
        if (!id || !/^[a-f0-9-]{36}$/.test(id))
          return Response.json({ error: "Invalid stream" }, { status: 400 });
        return await this.history.close(id);
      }
      if (path === "/api/events" && request.method === "GET")
        return url.searchParams.get("snapshot") === "1"
          ? await this.history.snapshot(sid, url)
          : await this.history.subscribe(request, sid);
      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (error) {
      if (error instanceof RequestError)
        return Response.json(
          { error: error.message },
          { status: error.status },
        );
      logTechnicalError("request", error, crypto.randomUUID());
      return Response.json(
        { error: "Request unavailable. Your saved chat is unchanged." },
        { status: 500 },
      );
    }
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      await authorize(request, env);
    } catch {
      return secured(
        new Response(
          "Private chat. Cloudflare Access sign-in and owner configuration are required.",
          { status: 403 },
        ),
      );
    }
    const url = new URL(request.url);
    if (
      url.pathname === "/grok-setup" ||
      url.pathname === "/grok-setup.html" ||
      url.pathname === "/grok-setup.js"
    ) {
      if (env.ENABLE_GROK_SUBSCRIPTION !== "true")
        return secured(new Response("Not found", { status: 404 }));
    }
    if (
      url.pathname === "/workspace-smoke" ||
      url.pathname === "/smoke.js" ||
      url.pathname.startsWith("/api/smoke")
    ) {
      if (env.ENABLE_WORKSPACE_SMOKE !== "true")
        return secured(new Response("Not found", { status: 404 }));
      if (url.pathname === "/workspace-smoke") url.pathname = "/";
      return workspaceSmoke.fetch(new Request(url, request), env);
    }
    if (url.pathname.startsWith("/api/")) {
      try {
        return secured(
          await env.Assistant.getByName("private-owner-v1").fetch(request),
        );
      } catch {
        return secured(
          Response.json(
            { error: "Private chat configuration is incomplete." },
            { status: 503 },
          ),
        );
      }
    }
    if (!["GET", "HEAD"].includes(request.method))
      return secured(new Response("Method not allowed", { status: 405 }));
    return secured(await env.ASSETS.fetch(request));
  },
};
