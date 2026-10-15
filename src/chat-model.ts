import { grokCatalog } from "./grok-subscription";
export const DEFAULT_GROK_MODEL = "grok-4.7";
export function newChatModel(selected = DEFAULT_GROK_MODEL) {
  if (!grokCatalog().some((m) => m.id === selected))
    throw Error("Unsupported Grok chat model");
  return { provider: "xai", modelId: selected };
}

export interface ChatModel {
  provider: string;
  modelId: string;
}
export const CODEX_CHAT_MODEL = {
  provider: "openai-codex",
  modelId: "gpt-6-sol",
} as const;
export function delegateModel(
  model: ChatModel,
  fallback: ChatModel = { provider: "openai-codex", modelId: "gpt-6-luna" },
): ChatModel {
  return model.provider === "xai" ? model : fallback;
}
