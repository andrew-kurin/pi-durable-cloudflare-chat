import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
// pi-ai 1.3.0 deliberately hides this module from bundlers behind a variable
// dynamic import. Pin the package version and explicitly bundle only this flow.
// Device-code login never starts its Node callback server. nodejs_compat is
// required so the module's unused node:http import can be resolved in Workers.
import { openaiCodexOAuth } from "../node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js";

export function createWorkerCodexProvider() {
  const provider = openaiCodexProvider();
  return { ...provider, auth: { oauth: openaiCodexOAuth } };
}
