import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
  Models,
} from "@earendil-works/pi-ai";

/** The DurableObjectStorage methods used here, also convenient for offline tests. */
export interface CredentialStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options?: { prefix?: string }): Promise<Map<string, T>>;
}

const PREFIX = "credentials:v1:";
const HOST_ID_KEY = "subscription:host-id:v1";
const PROVIDER_ID = "openai-codex";
export const SUBSCRIPTION_VERIFICATION_URI = "https://auth.openai.com/codex/device";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
type Envelope = { version: 1; iv: string; ciphertext: string };

// Every adapter over this DO storage shares its queue. Never put an OAuth
// refresh inside storage.transaction(): transactions can retry their callback,
// whereas exchanging a rotating refresh token must happen only once.
const queues = new WeakMap<CredentialStorage, Map<string, Promise<void>>>();
const activeLogins = new WeakSet<CredentialStorage>();

function serialized<T>(
  storage: CredentialStorage,
  key: string,
  action: () => Promise<T>,
  options?: AuthOperationOptions,
): Promise<T> {
  let queue = queues.get(storage);
  if (!queue) queues.set(storage, (queue = new Map()));
  const previous = queue.get(key) ?? Promise.resolve();
  const operation = previous.then(() => {
    options?.signal?.throwIfAborted();
    return action();
  });
  const tail = operation.then(() => undefined, () => undefined);
  queue.set(key, tail);
  void tail.then(() => {
    if (queue.get(key) === tail) queue.delete(key);
  });
  return operation;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function credentialKey(providerId: string): string {
  if (!providerId || providerId.length > 128) throw new Error("Invalid credential provider.");
  return PREFIX + encodeURIComponent(providerId);
}

function validateCredential(value: unknown): asserts value is Credential {
  if (!value || typeof value !== "object") throw new Error("Invalid credential record.");
  const credential = value as Partial<Credential>;
  if (credential.type === "oauth") {
    if (typeof credential.access !== "string" || typeof credential.refresh !== "string" ||
      typeof credential.expires !== "number" || !Number.isFinite(credential.expires)) {
      throw new Error("Invalid credential record.");
    }
  } else if (credential.type !== "api_key") {
    throw new Error("Invalid credential record.");
  }
}

/**
 * A DO-local encrypted store. Pass this exact store to createModels({ credentials }).
 * base64Key must be a Cloudflare secret containing exactly 32 random bytes in
 * standard base64; no fallback key is generated. Keep one DO per owner and route
 * every credential mutation through it. Do not log returned credentials/errors.
 */
export function createCredentialStore(storage: CredentialStorage, base64Key: string): CredentialStore {
  let keyBytes: Uint8Array<ArrayBuffer>;
  try {
    const encoded = base64Key?.trim();
    if (!encoded) throw new Error();
    keyBytes = decodeBase64(encoded);
    if (keyBytes.length !== 32 || encodeBase64(keyBytes) !== encoded) throw new Error();
  } catch {
    throw new Error("A valid 32-byte base64 credential encryption secret is required.");
  }
  const key = crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt", "decrypt"]);

  async function read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const storageKey = credentialKey(providerId);
    const envelope = await storage.get<Envelope>(storageKey);
    if (envelope === undefined) return undefined;
    if (envelope?.version !== 1 || typeof envelope.iv !== "string" ||
      typeof envelope.ciphertext !== "string") throw new Error("Invalid encrypted credential record.");
    try {
      const iv = decodeBase64(envelope.iv);
      if (iv.length !== 12) throw new Error();
      const cleartext = await crypto.subtle.decrypt({
        name: "AES-GCM", iv, additionalData: encoder.encode(storageKey), tagLength: 128,
      }, await key, decodeBase64(envelope.ciphertext));
      const credential: unknown = JSON.parse(decoder.decode(cleartext));
      validateCredential(credential);
      options?.signal?.throwIfAborted();
      return credential;
    } catch {
      options?.signal?.throwIfAborted();
      throw new Error("Could not decrypt the credential record.");
    }
  }

  return {
    read,
    async list(options) {
      options?.signal?.throwIfAborted();
      const records = await storage.list<Envelope>({ prefix: PREFIX });
      const metadata: CredentialInfo[] = [];
      for (const storageKey of records.keys()) {
        const providerId = decodeURIComponent(storageKey.slice(PREFIX.length));
        const credential = await read(providerId, options);
        if (credential) metadata.push({ providerId, type: credential.type });
      }
      return metadata;
    },
    modify(providerId, update, options) {
      const storageKey = credentialKey(providerId);
      return serialized(storage, storageKey, async () => {
        const current = await read(providerId, options);
        const next = await update(current);
        options?.signal?.throwIfAborted();
        // pi-ai's undefined return means leave unchanged, not delete.
        if (next === undefined) return current;
        validateCredential(next);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await crypto.subtle.encrypt({
          name: "AES-GCM", iv, additionalData: encoder.encode(storageKey), tagLength: 128,
        }, await key, encoder.encode(JSON.stringify(next)));
        options?.signal?.throwIfAborted();
        await storage.put<Envelope>(storageKey, {
          version: 1, iv: encodeBase64(iv), ciphertext: encodeBase64(new Uint8Array(ciphertext)),
        });
        return next;
      }, options);
    },
    delete(providerId, options) {
      const storageKey = credentialKey(providerId);
      return serialized(storage, storageKey, async () => {
        await storage.delete(storageKey);
      }, options);
    },
  };
}

export type SubscriptionLoginStatus =
  | { status: "disabled" | "unsupported" | "starting" | "connected" | "cancelled" | "failed" | "busy" }
  | { status: "device_code"; userCode: string; verificationUri: typeof SUBSCRIPTION_VERIFICATION_URI };

export interface SubscriptionLoginOptions {
  /** Caller maps its environment flag to true only for the exact string "true". */
  enabled?: boolean;
  /** Enable only with the statically bundled, Worker-tested Codex OAuth provider. */
  runtimeSupported?: boolean;
  signal?: AbortSignal;
}

async function getStableHostId(storage: CredentialStorage): Promise<string> {
  return serialized(storage, HOST_ID_KEY, async () => {
    const existing = await storage.get<string>(HOST_ID_KEY);
    if (typeof existing === "string" && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
    if (existing !== undefined) throw new Error("Invalid installation identity.");
    const id = crypto.randomUUID();
    await storage.put(HOST_ID_KEY, id);
    return id;
  });
}

/**
 * Owner-only server-side login; authenticate with Access before invoking this.
 * Keep the request alive (for example SSE) until this settles, and pass its abort
 * signal. No tokens, upstream messages, errors, auth URLs or raw events escape.
 * Models.login persists success through the encrypted CredentialStore itself.
 */
export async function startSubscriptionLogin(
  models: Pick<Models, "login">,
  storage: CredentialStorage,
  onPublicStatus: (status: SubscriptionLoginStatus) => void,
  options: SubscriptionLoginOptions = {},
): Promise<SubscriptionLoginStatus> {
  const emit = (status: SubscriptionLoginStatus) => {
    onPublicStatus(status);
    return status;
  };
  if (!options.enabled) return emit({ status: "disabled" });
  if (!options.runtimeSupported) return emit({ status: "unsupported" });
  if (activeLogins.has(storage)) return emit({ status: "busy" });
  activeLogins.add(storage);
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timeout = setTimeout(abort, 15 * 60 * 1000);
  try {
    controller.signal.throwIfAborted();
    emit({ status: "starting" });
    const hostId = await getStableHostId(storage);
    await models.login(PROVIDER_ID, "oauth", {
      signal: controller.signal,
      prompt: async (prompt) => {
        controller.signal.throwIfAborted();
        if (prompt.type === "select" && prompt.options.some((option) => option.id === "device_code")) {
          return "device_code";
        }
        throw new Error("Only device code login is supported.");
      },
      notify: (event) => {
        if (event.type !== "device_code") return;
        if (event.verificationUri !== SUBSCRIPTION_VERIFICATION_URI ||
          !/^[A-Z0-9-]{4,32}$/.test(event.userCode)) {
          throw new Error("Invalid device code response.");
        }
        emit({ status: "device_code", userCode: event.userCode, verificationUri: SUBSCRIPTION_VERIFICATION_URI });
      },
    }, { getDeviceId: () => hostId, agentName: "pi-cloudflare-chat" });
    return emit({ status: "connected" });
  } catch {
    return emit({ status: options.signal?.aborted ? "cancelled" : "failed" });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
    activeLogins.delete(storage);
  }
}
