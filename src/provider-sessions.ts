import { openaiCheckReports, runOpenAIChecks, OPENAI_CHECK_MODELS, OPENAI_CHECK_BUDGET } from "./openai-compat-check";
import { createModels } from "@earendil-works/pi-ai/models";
import type { CredentialStore, Models } from "@earendil-works/pi-ai";
import { createWorkerCodexProvider } from "./oauth-loader";
import {
  createWorkerGrokProvider,
  grokCatalog,
  startGrokSubscriptionLogin,
  runGrokToolCheck,
  GROK_CHECK_BUDGET,
  type GrokLoginStatus,
  type GrokCheckResult,
} from "./grok-subscription";
import {
  startSubscriptionLogin,
  type SubscriptionLoginStatus,
  type CredentialStorage,
} from "./credentials";
import {
  newChatModel,
  CODEX_CHAT_MODEL,
  delegateModel,
  type ChatModel,
} from "./chat-model";
import { RequestError } from "./http-input";
export interface ProviderConfig {
  ENABLE_MODEL?: string;
  ENABLE_SUBSCRIPTION_LOGIN?: string;
  ENABLE_GROK_SUBSCRIPTION?: string;
  GROK_CHAT_MODEL?: string;
}
/** Static provider wiring never reads host environment/files or starts OAuth. */
export function createChatModels(credentials: CredentialStore) {
  const models = createModels({
    credentials,
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  models.setProvider(createWorkerCodexProvider());
  models.setProvider(createWorkerGrokProvider());
  return models;
}
type Store = CredentialStorage & Pick<DurableObjectStorage, "sql">;
type LoginOptions = {
  signal: AbortSignal;
  waitUntil: (job: Promise<unknown>) => void;
};
/** Owns provider availability and login lifetime, not encrypted storage or chat admission.
 * Fixed Grok probes intentionally use isolated, unguarded models and their own durable budget.
 */
export class ProviderSessions {
  private codexStatus: SubscriptionLoginStatus = { status: "disabled" };
  private grokStatus: GrokLoginStatus = { status: "disabled" };
  private codexActive = false;
  private grokActive = false;
  constructor(
    private config: ProviderConfig,
    private storage: Store,
    private credentials: CredentialStore,
    private chatModels: Pick<Models, "login">,
    private prepareCodexLogin: () => Promise<unknown>,
  ) {}
  private async connected(provider: string) {
    return (await this.credentials.list()).some(
      (c) => c.providerId === provider && c.type === "oauth",
    );
  }
  defaultChatModel() {
    return this.config.ENABLE_GROK_SUBSCRIPTION === "true"
      ? newChatModel(this.config.GROK_CHAT_MODEL)
      : { ...CODEX_CHAT_MODEL };
  }
  async newChatModel() {
    const model = this.defaultChatModel();
    if (model.provider === "xai" && !(await this.connected("xai")))
      throw new RequestError(503, "Connect Grok before creating a new chat");
    return model;
  }
  async status(model: ChatModel) {
    return {
      model,
      delegateModel: delegateModel(model),
      newChatModel: this.defaultChatModel(),
      modelEnabled: this.config.ENABLE_MODEL === "true",
      canLogin:
        model.provider === "openai-codex" &&
        this.config.ENABLE_SUBSCRIPTION_LOGIN === "true",
      connected: await this.connected(model.provider),
      login: this.codexStatus,
    };
  }
  async assertCanSubmit(resolveModel: () => Promise<ChatModel>) {
    if (this.config.ENABLE_MODEL !== "true")
      throw new RequestError(503, "Model access is not enabled yet");
    const model = await resolveModel();
    if (
      model.provider === "xai" &&
      this.config.ENABLE_GROK_SUBSCRIPTION !== "true"
    )
      throw new RequestError(503, "Grok access is disabled");
    if (!(await this.connected(model.provider)))
      throw new RequestError(503, "Connect your subscription first");
  }
  async openaiCheckStatus() {
    return { connected: await this.connected("openai-codex"), loginEnabled: this.config.ENABLE_SUBSCRIPTION_LOGIN === "true", models: OPENAI_CHECK_MODELS, budget: OPENAI_CHECK_BUDGET, reports: await openaiCheckReports(this.storage) };
  }
  async runApprovedOpenAICheck(signal: AbortSignal) {
    if (this.config.ENABLE_MODEL !== "true") throw new RequestError(403, "Model access is disabled");
    const models = createModels({ credentials: this.credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
    models.setProvider(createWorkerCodexProvider());
    const reports = await runOpenAIChecks(models, this.credentials, this.storage, { approved: true, signal });
    this.storage.sql.exec("CREATE TABLE IF NOT EXISTS app_openai_check_results (id TEXT PRIMARY KEY, recorded_at INTEGER NOT NULL, result TEXT NOT NULL CHECK(json_valid(result)))");
    for (const report of reports) if (report) this.storage.sql.exec("INSERT INTO app_openai_check_results (id,recorded_at,result) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET recorded_at=excluded.recorded_at,result=excluded.result", report.model, Date.now(), JSON.stringify(report));
    return reports;
  }
  private checkModels() {
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
  async grokSetupStatus() {
    return {
      connected: await this.connected("xai"),
      login: this.grokStatus,
      models: grokCatalog(),
      budget: GROK_CHECK_BUDGET,
      check:
        (await this.storage.get<{ state: string; report: GrokCheckResult }>(
          "grok-tool-check:v1",
        )) ?? null,
    };
  }
  async runApprovedGrokCheck(model: string, signal: AbortSignal) {
    if (this.config.ENABLE_GROK_SUBSCRIPTION !== "true")
      throw new RequestError(404, "Grok setup is not enabled");
    const result = await runGrokToolCheck(
      this.checkModels(),
      this.credentials,
      model,
      { approved: true, storage: this.storage, signal },
    );
    if (result.status === "passed" || result.status === "failed") {
      this.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS app_grok_check_results (id TEXT PRIMARY KEY, recorded_at INTEGER NOT NULL, result TEXT NOT NULL CHECK(json_valid(result)))",
      );
      this.storage.sql.exec(
        "INSERT INTO app_grok_check_results (id,recorded_at,result) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING",
        "v1",
        Date.now(),
        JSON.stringify(result),
      );
    }
    return result;
  }
  async startLogin(
    provider: "openai-codex" | "xai",
    options: LoginOptions,
  ): Promise<Response> {
    const grok = provider === "xai";
    if (
      grok
        ? this.config.ENABLE_GROK_SUBSCRIPTION !== "true"
        : this.config.ENABLE_SUBSCRIPTION_LOGIN !== "true"
    )
      throw new RequestError(
        grok ? 404 : 403,
        grok
          ? "Grok setup is not enabled"
          : "Subscription setup is not enabled",
      );
    if ((await this.credentials.list()).some((c) => c.providerId === provider))
      throw new RequestError(
        409,
        grok
          ? "Grok is already configured"
          : "Subscription is already connected.",
      );
    if (grok ? this.grokActive : this.codexActive) {
      if (grok) throw new RequestError(409, "Grok sign-in is already running");
      return Response.json(this.codexStatus);
    }
    if (grok) this.grokActive = true;
    else this.codexActive = true;
    try {
      if (!grok) await this.prepareCodexLogin();
    } catch (error) {
      this.codexActive = false;
      throw error;
    }
    const abort = new AbortController(),
      onAbort = () => abort.abort();
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) onAbort();
    const timer = grok ? undefined : setTimeout(onAbort, 5 * 60 * 1000);
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const notify = (status: SubscriptionLoginStatus | GrokLoginStatus) => {
          if (grok) this.grokStatus = status as GrokLoginStatus;
          else this.codexStatus = status as SubscriptionLoginStatus;
          try {
            controller.enqueue(
              new TextEncoder().encode(JSON.stringify(status) + "\n"),
            );
          } catch {
            abort.abort();
          }
        };
        const job = (
          grok
            ? startGrokSubscriptionLogin(
                this.checkModels(),
                this.storage,
                notify,
                { enabled: true, signal: abort.signal },
              )
            : startSubscriptionLogin(this.chatModels, this.storage, notify, {
                enabled: true,
                runtimeSupported: true,
                signal: abort.signal,
              })
        ).finally(() => {
          clearTimeout(timer);
          if (grok) this.grokActive = false;
          else this.codexActive = false;
          options.signal.removeEventListener("abort", onAbort);
          try {
            controller.close();
          } catch {}
        });
        options.waitUntil(job);
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
}
