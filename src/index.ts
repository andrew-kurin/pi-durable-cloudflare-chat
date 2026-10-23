import {ChangeProposals,type PublicationEnv} from './change-proposals';
import {changeTools} from './change-tools';
import { createWorkerRunnerProvider, runnerConfigured, type RunnerConfig } from "./model-runner-worker";
import { COMPACTION_POLICY,compactionLogs } from './compaction';
import { CODEX_CHAT_MODEL } from "./chat-model";
import { ProviderSessions, createChatModels } from "./provider-sessions";
import { HistoryFeed } from "./history-feed";
import { WorkspaceCoordinator } from "./workspace-coordinator";
import { ChatCatalog } from "./chat-catalog";
import { RequestError, discardBody, jsonObject, readBodyText } from "./http-input";
import { SubmissionAdmission, type ArrivedSubmission } from "./submission-admission";
import { logTechnicalError } from "./error-log";
import { DurableObject } from "cloudflare:workers";
import type { PiHarness } from "agents/harness/pi";
import {MaintenanceHarness} from "./maintenance-harness";
import {Maintenance,type MaintenanceEnv} from "./maintenance";
import { HarnessRecovery } from './harness-recovery';
import { Lifecycle } from "agents/lifecycle";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { authorize, secured, type AccessConfig } from "./auth";
import { guardModels } from "./model-guard";
import { delegation } from "./delegate";
import { readTools } from "./read-tools";
import { workspaceTools } from "./workspace-tools";
import { TaskWorkspace } from "./workspace-container";
import workspaceSmoke from "./workspace-smoke";
import { grokCatalog } from "./grok-subscription";
export { TaskWorkspace };
import {
  runSearchCheck,
  searchCheckStatus,
  previousSearchCheckStatus,
  runGithubCheck,
  githubCheckStatus,
} from "./search-check";
import { createCredentialStore } from "./credentials";
declare const PI_DEPLOYMENT_MODE: string;
const deploymentMode =
  typeof PI_DEPLOYMENT_MODE === "undefined" ? "local" : PI_DEPLOYMENT_MODE;
interface Env extends AccessConfig, RunnerConfig, MaintenanceEnv, PublicationEnv {
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
  private maintenance = new Maintenance(this.ctx.storage,this.env);
  private piOpened = false;
  private workspaces = new WorkspaceCoordinator(
    this.ctx.storage,
    this.env,
    (id) => this.chatCatalog.requireActive(id),
  );
  private changes = new ChangeProposals(this.ctx.storage,this.env,(session,id,artifact)=>this.workspaces.artifact(session,id,artifact),(input,init)=>this.maintenance.withActive(()=>globalThis.fetch(input,init)));
  private workspaceEnabled() {
    return this.workspaces.enabled();
  }
  private credentials = createCredentialStore(
    this.ctx.storage,
    this.env.CREDENTIAL_ENCRYPTION_KEY,
  );
  private models = guardModels(createChatModels(this.credentials,
    runnerConfigured(this.env) ? createWorkerRunnerProvider(this.env, this.ctx.storage, this.ctx.id.toString(), (input, init) => this.maintenance.withActive(()=>globalThis.fetch(input,init))) : undefined,
  ), async () => {
    await this.maintenance.assertActive();
    if (this.env.ENABLE_MODEL !== "true") throw new Error("Model disabled");
    await this.ctx.storage.transaction(async (tx) => {
      const day = new Date().toISOString().slice(0, 10);
      const count = await tx.get<{ day: string; count: number }>("model-quota");
      const used = count?.day === day ? count.count : 0;
      if (used >= 150) throw new Error("Daily model request limit");
      await tx.put("model-quota", { day, count: used + 1 });
    });
  },()=>this.maintenance.assertActive());
  private providers = new ProviderSessions(
    this.env,
    this.ctx.storage,
    this.credentials,
    this.models,
    () => this.harness.pi(),
  );
  private async sessionModel(sid: string) {
    return (
      (await (await this.harness.conversation(sid)).agent(BACKGROUND_CONTEXT))
        .model ?? { ...CODEX_CHAT_MODEL }
    );
  }
  private admission: Promise<unknown> = Promise.resolve();
  private harnessRecovery = new HarnessRecovery();
  harness = new MaintenanceHarness({
    harness: async ({ storage, context }) => {
      await this.maintenance.assertCanOpen();
      const registry = createRegistry();
      registry.install(delegation());
      registry.install(compactionLogs(this.env.WORKER_VERSION?.id));
      if (this.workspaceEnabled())
        registry.install(
          workspaceTools({
            request: (session, r, progress) => this.maintenance.withActive(()=>this.workspaces.execute(session,r,progress)),
          }),
        );
      if(this.workspaceEnabled()&&this.changes.enabled())registry.install(changeTools(this.changes));
      registry.install(readTools(this.ctx.storage, this.env, (input,init) => this.maintenance.withActive(()=>globalThis.fetch(input,init))));
      const opened = this.harnessRecovery.observe(await Harness.open(
        storage,
        {
          models: this.models,
          registry,
          settings: {
            compaction: COMPACTION_POLICY,
            progress: { partialIntervalMs: 250, outputIntervalMs: 500 },
            retry: { enabled: true, maxRetries: 1, baseDelayMs: 1000 },
            stream: { transport: "sse", timeoutMs: 120000, maxRetries: 0 },
          },
        },
        context,
      ));
      this.piOpened = true;return opened;
    },
    defaults: {
      model: runnerConfigured(this.env) ? { provider: "model-runner-siwc", id: "gpt-6.1-sol" } : { provider: "openai-codex", id: "gpt-6-sol" },
      thinkingLevel: "low",
    },
  },this.maintenance);
  private submissions = new SubmissionAdmission(this.ctx.storage, {
    isBusy: async () => (await this.harness.sessions.list()).some((s) => s.busy),
    captureIntent: sessionId => this.workspaces.submissionEpoch(sessionId),
    submit: async ({ sessionId, operationId, text }, epoch) => {
      await this.workspaces.admitNewWork(sessionId, operationId, epoch);
      return this.harness.submit(text, { session: sessionId, operationId });
    },
    abort: ({ sessionId, operationId }) => this.harness.abort({
      session: sessionId, operationId,
    }),
  });
  private chatCatalog = new ChatCatalog(
    this.ctx.storage,
    this.harness,
    () => this.providers.newChatModel(),
    (sid) => this.workspaces.assertChatCanBeTrashed(sid),
  );
  private history = new HistoryFeed(
    this.harness,
    this.chatCatalog,
  );
  lifecycle = Lifecycle.install(this).use(this.harness);
  async fetch(request: Request): Promise<Response> {
    try {
      await authorize(request, this.env);
    } catch {
      return new Response("Forbidden", { status: 403 });
    }
    if(new URL(request.url).pathname==='/api/maintenance') {
      try{return await this.maintenance.handle(request,{validate:async()=>{try{await this.harness.sessions.list();}catch(error){this.piOpened=false;await this.harness.dispose();throw error;}},...(this.piOpened?{stop:async(sessions:string[])=>{for(const session of sessions)await this.submissions.stop(session);}}:{})});}
      catch(error){return Response.json({error:error instanceof RequestError?error.message:'Maintenance operation unavailable; remain paused.'},{status:error instanceof RequestError?error.status:503});}
    }
    const maintenanceEpoch=await this.maintenance.arrival();
    try {await this.maintenance.assertActive();}catch(error){
      return Response.json({error:'Maintenance is paused. Open /maintenance.'},{status:423});
    }
    try {
      await this.harnessRecovery.prepare(() => this.harness.dispose());
    } catch (error) {
      logTechnicalError('request', error, crypto.randomUUID());
      return Response.json({error:'Chat storage is unavailable. Retry loading saved history.'},{status:503});
    }
    // Control requests must reach running work even while a mutation awaits I/O.
    if (
      request.method === "POST" &&
      ["/api/events/close", "/api/abort"].includes(new URL(request.url).pathname)
    )
      return this.activeRequest(request,maintenanceEpoch);
    if (
      request.method === "POST" &&
      /^\/api\/workspaces\/[a-f0-9-]{36}(?:\/extend)?$/.test(
        new URL(request.url).pathname,
      )
    )
      return this.activeRequest(request,maintenanceEpoch);
    if (request.method === "POST") {
      // Capture arrival generation before joining the queue, so Stop also cancels
      // submissions waiting behind an unrelated mutation.
      const url = new URL(request.url);
      const sid = url.searchParams.get("session") ?? "1";
      const submit = url.pathname === "/api/submit" && /^\d{1,12}$/.test(sid)
        ? this.submissions.atArrival(sid) : undefined;
      const work = this.admission.then(() => this.activeRequest(request,maintenanceEpoch,submit));
      this.admission = work.then(
        () => undefined,
        () => undefined,
      );
      return work;
    }
    return this.activeRequest(request,maintenanceEpoch);
  }
  private async activeRequest(request:Request,epoch:string,submit?:ArrivedSubmission<Awaited<ReturnType<PiHarness['submit']>>>):Promise<Response>{
    try{return await this.maintenance.withActive(()=>this.handle(request,submit),epoch);}
    catch(error){if(error instanceof RequestError)return Response.json({error:error.message,code:error.code},{status:error.status});throw error;}
  }
  private async handle(request: Request, submit?: ArrivedSubmission<Awaited<ReturnType<PiHarness["submit"]>>>): Promise<Response> {
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
        path.startsWith("/api/workspaces") || path.startsWith("/api/changes/")
      )
        await this.chatCatalog.requireActive(sid);
      const proposalRoute=/^\/api\/changes\/([a-f0-9]{64})(?:\/(authorize|review))?$/.exec(path);
      if(proposalRoute){
        const [,id,action]=proposalRoute;
        if(request.method==='GET'&&action==='review')return Response.json(await this.changes.review(sid,id));
        if(request.method==='GET'&&!action)return Response.json(await this.changes.status(sid,id));
        if(request.method==='POST'&&action==='authorize'){
          const body=jsonObject(await readBodyText(request,1000,{message:'Invalid proposal authorization'}));
          if(body.action!=='authorize_signed_draft_pr'||typeof body.patchSha256!=='string'||typeof body.treeSha!=='string')throw new RequestError(400,'Review the exact patch before authorizing a signed draft PR');
          return Response.json(await this.changes.authorize(sid,id,body.patchSha256,body.treeSha));
        }
        return Response.json({error:'Method not allowed'},{status:405});
      }
      if (path.startsWith("/api/grok/")) {
        if (this.env.ENABLE_GROK_SUBSCRIPTION !== "true")
          return Response.json(
            { error: "Grok setup is not enabled" },
            { status: 404 },
          );
        if (path === "/api/grok/status" && request.method === "GET")
          return Response.json(await this.providers.grokSetupStatus());
        if (
          request.method !== "POST" ||
          !["/api/grok/login", "/api/grok/check"].includes(path)
        )
          return Response.json({ error: "Not found" }, { status: 404 });
        const raw = await readBodyText(request, 100, { status: 400, message: "Invalid setup action" });
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
          return await this.providers.startLogin("xai", {
            signal: request.signal,
            waitUntil: (job) => this.ctx.waitUntil(job),
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
        return Response.json(
          await this.providers.runApprovedGrokCheck(
            action.model,
            request.signal,
          ),
        );
      }
      if (path === "/api/status" && request.method === "GET") {
        const model = await this.sessionModel(sid);
        return Response.json({
          ...(await this.providers.status(model)),
          deploymentMode,
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
        const raw = await readBodyText(request, 1000, { status: 400, message: "Invalid workspace request" });
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
          const raw = await readBodyText(request, 1000, { status: 400, message: "Invalid extension" });
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
          const raw = await readBodyText(request, 1000, { status: 400, message: "Invalid owner action" });
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
        const body = await readBodyText(request, 100, { status: 400, message: "Invalid search check" });
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
      if (path === "/api/login" && request.method === "POST")
        return await this.providers.startLogin("openai-codex", {
          signal: request.signal,
          waitUntil: (job) => this.ctx.waitUntil(job),
        });
      if (path === "/api/sessions" && request.method === "GET")
        return Response.json(
          await this.chatCatalog.list(url.searchParams.get("deleted") === "1"),
        );
      if (path === "/api/session-trash" && request.method === "POST") {
        const raw = await readBodyText(request, 100, { status: 400, message: "Invalid chat action" });
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
        const raw = await readBodyText(request, 1000, { status: 400, message: "Title too long" });
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
      if (path === "/api/sessions" && request.method === "POST") {
        await discardBody(request);
        return Response.json(await this.chatCatalog.create());
      }
      if (path === "/api/submit" && request.method === "POST") {
        await this.providers.assertCanSubmit(() => this.sessionModel(sid));
        const raw = await readBodyText(request, 20000, { status: 413, message: "Message too long" });
        const b = jsonObject(raw);
        if (
          typeof b.text !== "string" ||
          !b.text.trim() ||
          b.text.length > 12000 ||
          typeof b.operationId !== "string" ||
          !/^[-a-zA-Z0-9]{8,80}$/.test(b.operationId)
        )
          return Response.json({ error: "Invalid message" }, { status: 400 });
        if (!submit) throw new Error("Submission arrival missing");
        const receipt = await submit({ operationId: b.operationId, text: b.text });
        // Metadata failure must not turn an accepted message into a failed submit.
        // Replays retry missing metadata without dispatching the message again.
        try { await this.chatCatalog.autoTitle(sid, b.text); }
        catch (error) { logTechnicalError("auto_title", error, crypto.randomUUID()); }
        return Response.json(receipt);
      }
      if (path === "/api/abort" && request.method === "POST") {
        await discardBody(request);
        return Response.json({ aborted: await this.submissions.stop(sid) });
      }
      if (path === "/api/events/close" && request.method === "POST") {
        const id = url.searchParams.get("stream");
        if (!id || !/^[a-f0-9-]{36}$/.test(id))
          return Response.json({ error: "Invalid stream" }, { status: 400 });
        return await this.history.close(id);
      }
      if (path === "/api/events" && request.method === "GET")
        return url.searchParams.get("snapshot") === "1"
          ? await this.history.snapshot(request, sid)
          : await this.history.subscribe(request, sid);
      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (error) {
      if (error instanceof RequestError)
        return Response.json(
          { error: error.message, ...(error.code ? { code: error.code } : {}) },
          { status: error.status },
        );
      logTechnicalError("request", error, crypto.randomUUID());
      return Response.json(
        { error: "Request unavailable. Reload saved history and check workspace status before retrying." },
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
    if(url.pathname==='/changes'||url.pathname==='/changes.html'||url.pathname==='/changes.js'||url.pathname==='/changes.css'){if(env.ENABLE_HARNESS_PROPOSALS!=='true')return secured(new Response('Not found',{status:404}));if(url.pathname==='/changes')url.pathname='/changes.html';return secured(await env.ASSETS.fetch(new Request(url,request)));}
    if(url.pathname==='/maintenance'||url.pathname==='/maintenance.html'||url.pathname==='/maintenance.js')return secured(await env.ASSETS.fetch(new Request(url,request)));
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
