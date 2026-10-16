import type { EntryRecord } from "@earendil-works/pi-durable";
export type ToolState =
  | "pending"
  | "running"
  | "success"
  | "error"
  | "interrupted"
  | "unavailable";
export type ToolLinkage =
  | "following_response"
  | "streaming_response"
  | "user_boundary"
  | "turn_unavailable"
  | "result_unavailable"
  | "order_unavailable"
  | "no_following_response"
  | "unlinked";
export interface ToolSource {
  title: string;
  url: string;
}
export interface ToolActivity {
  id: string;
  label: string;
  state: ToolState;
  detail: string;
  summary?: string;
  sources?: ToolSource[];
  input?: string;
  context?: string;
  output?: string;
  inputTruncated?: boolean;
  outputTruncated?: boolean;
  linkage?: ToolLinkage;
}
const secretKey =
  /^(?:[a-z0-9]+[_-])*(?:password|passwd|api[_-]?key|x-api-key|access[_-]?token|refresh[_-]?token|x-auth-token|token|secret|client[_-]?secret|private[_-]?key|secret[_-]?access[_-]?key|access[_-]?key(?:[_-]?id)?|authorization|proxy-authorization|cookie|set-cookie|x-amz-signature|x-goog-signature|signature|sig)$/i;
/** UI-only masking: preserve ordinary commands, paths, queries and diagnostics.
 * Never use this as an external-request policy or log sanitizer.
 */
export function maskSecrets(text: string): string {
  return text
    .replace(/\bcurl\b[^\r\n;&|]*/g, (line) =>
      line.replace(
        /(^|\s)(-[ub])(?:\s+)?("[^"\n]*"|'[^'\n]*'|[^\s]+)/g,
        "$1$2 [redacted]",
      ),
    )
    .replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => {
      try {
        const u = new URL(raw);
        let changed = false;
        if (u.username || u.password) {
          u.username = "[redacted]";
          u.password = "";
          changed = true;
        }
        for (const key of [...u.searchParams.keys()])
          if (secretKey.test(key)) {
            u.searchParams.set(key, "[redacted]");
            changed = true;
          }
        const hash = new URLSearchParams(u.hash.slice(1));
        for (const key of [...hash.keys()])
          if (secretKey.test(key)) {
            hash.set(key, "[redacted]");
            u.hash = hash.toString();
            changed = true;
          }
        return changed ? u.href : raw;
      } catch {
        return raw;
      }
    })
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      "[redacted private key]",
    )
    .replace(
      /\b(?:gh[pousr]_|github_pat_|sk-|tvly-)[A-Za-z0-9_-]+/g,
      "[redacted]",
    )
    .replace(
      /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
      "[redacted authorization]",
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "[redacted token]",
    )
    .replace(
      /(?<![A-Za-z0-9_-])(["']?([A-Za-z_][A-Za-z0-9_-]*)["']?\s*(?:=|:)\s*)("(?:\\.|[^"\\])*"|'[^']*'|[^\s,;&}"']+)/g,
      (full, prefix, key) =>
        secretKey.test(key) ? prefix + "[redacted]" : full,
    )
    .replace(
      /((?:--)(?:password|passwd|api-key|access-token|refresh-token|token|client-secret|user|cookie))(\s+|=)("[^"\n]*"|'[^'\n]*'|\S+)/gi,
      "$1$2[redacted]",
    )
    .replace(
      /((?:authorization|proxy-authorization|set-cookie|cookie)\s*[:=]\s*)[^\r\n]+/gi,
      "$1[redacted]",
    )
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
function scrub(value: unknown, key = "", depth = 0): unknown {
  if (secretKey.test(key)) return "[redacted]";
  if (depth > 16) return "[Nested data omitted]";
  if (typeof value === "string") {
    if (/^[\s]*[\[{]/.test(value))
      try {
        return scrub(JSON.parse(value), key, depth + 1);
      } catch {}
    return maskSecrets(value);
  }
  if (Array.isArray(value)) {
    const curl =
      key === "argv" &&
      typeof value[0] === "string" &&
      /(?:^|\/)curl$/.test(value[0]);
    const flag = (v: unknown) =>
      typeof v === "string" &&
      (/^(?:--(?:password|passwd|api-key|access-token|refresh-token|token|client-secret|user|cookie))$/i.test(
        v,
      ) ||
        (curl && /^-[ub]$/.test(v)));
    return value.map((item, i) => {
      if (key === "argv" && i && flag(value[i - 1])) return "[redacted]";
      if (key === "argv" && typeof item === "string") {
        const attached =
          item.match(
            /^(--(?:password|passwd|api-key|access-token|refresh-token|token|client-secret|user|cookie)=)(.+)$/i,
          ) ?? (curl ? item.match(/^(-[ub])(.+)$/) : null);
        if (attached) return attached[1] + "[redacted]";
      }
      return scrub(item, "", depth + 1);
    });
  }
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, scrub(v, k, depth + 1)]),
    );
  return value;
}
function display(value: unknown, max = 12000) {
  let text: string;
  try {
    const safe = scrub(value);
    text =
      typeof safe === "string" ? safe : (JSON.stringify(safe, null, 2) ?? "");
  } catch {
    text = "[Unable to display recorded data]";
  }
  return { text: text.slice(0, max), truncated: text.length > max };
}
export function safeMetadata(value: unknown, max = 140) {
  return typeof value === "string"
    ? maskSecrets(value).replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}
function source(value: unknown): ToolSource | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.url !== "string") return null;
  try {
    const u = new URL(item.url);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      !u.hostname.includes(".") ||
      /[\[\]:]/.test(u.hostname) ||
      /^[\d.]+$/.test(u.hostname) ||
      /(?:^|\.)(?:localhost|local|internal|lan|test|invalid|onion)(?:\.|$)/.test(
        u.hostname,
      ) ||
      /\.(?:localdomain|home\.arpa|nip\.io|sslip\.io)$/.test(u.hostname) ||
      maskSecrets(u.href) !== u.href ||
      [...u.searchParams.keys()].some((k) => secretKey.test(k))
    )
      return null;
    return { url: u.href, title: safeMetadata(item.title) || u.hostname };
  } catch {
    return null;
  }
}
const labels: Record<string, string> = {
  web_search: "Web search",
  fetch_page: "Read web page",
  github_search: "Search GitHub",
  github_read: "Read GitHub",
  ask_luna: "Delegate task",
  workspace_read: "Read file",
  workspace_edit: "Edit file",
  workspace_exec: "Start command",
  workspace_status: "Workspace status",
  workspace_logs: "Read logs",
  workspace_cancel: "Cancel workspace",
  workspace_export: "Export patch",
};
export const toolLabel = (name: string) =>
  Object.hasOwn(labels, name) ? labels[name] : "Tool";
export const stateDetail = (state: ToolState) =>
  ({
    pending: "Waiting to start.",
    running: "Working…",
    success: "Completed.",
    error: "Failed.",
    interrupted: "Interrupted before completion.",
    unavailable: "No recorded result is available.",
  })[state];
export function inputContext(
  args: unknown,
): Pick<ToolActivity, "input" | "context" | "inputTruncated"> {
  if (args === undefined) return {};
  let value = display(args, 4000);
  let context = "";
  const clean = scrub(args);
  if (clean && typeof clean === "object") {
    const item = clean as Record<string, unknown>;
    if (Array.isArray(item.argv)) {
      const command = item.argv
        .map((v) =>
          typeof v === "string"
            ? /\s/.test(v)
              ? JSON.stringify(v)
              : v
            : String(v),
        )
        .join(" ");
      context =
        command + (typeof item.cwd === "string" ? " · " + item.cwd : "");
      const { argv, cwd, ...options } = item;
      value = display(
        command +
          (typeof cwd === "string" ? "\nDirectory: " + cwd : "") +
          (Object.keys(options).length
            ? "\n" + JSON.stringify(options, null, 2)
            : ""),
        4000,
      );
    } else
      context = [
        "query",
        "url",
        "repo",
        "path",
        "ref",
        "number",
        "runId",
        "stream",
        "task",
      ]
        .filter(
          (k) => typeof item[k] === "string" || typeof item[k] === "number",
        )
        .map((k) => String(item[k]))
        .join(" · ");
  }
  return {
    input: value.text,
    context: safeMetadata(context, 360),
    ...(value.truncated ? { inputTruncated: true } : {}),
  };
}

export function resultSummary(
  entry: EntryRecord,
  _name: string,
): Pick<
  ToolActivity,
  "state" | "detail" | "summary" | "sources" | "output" | "outputTruncated"
> | null {
  const message = entry.model?.find((m) => m.role === "toolResult");
  if (!message || message.role !== "toolResult") return null;
  let state: ToolState = message.isError ? "error" : "success";
  const diagnostics = (
    entry.data as
      | { diagnostics?: { code?: string; message?: string }[] }
      | undefined
  )?.diagnostics;
  if (
    diagnostics?.some((d) => d.code === "interrupted" || d.code === "aborted")
  )
    state = "interrupted";
  const raw = message.content
    .filter((p) => p.type === "text")
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("\n");
  let data: unknown = raw;
  try {
    const parsed = JSON.parse(raw);
    data =
      parsed && typeof parsed === "object" && "data" in parsed
        ? parsed.data
        : parsed;
  } catch {}
  if (
    data &&
    typeof data === "object" &&
    typeof (data as any).error === "string"
  )
    state = "error";
  const record =
    data && typeof data === "object"
      ? (data as Record<string, unknown>)
      : undefined;
  const visible =
    typeof record?.text === "string"
      ? record.text
      : typeof record?.error === "string"
        ? record.error
        : typeof record?.body === "string"
          ? record.body
          : data;
  const fresh =
    _name.startsWith("workspace_") &&
    record?.freshWorkspace &&
    typeof record.freshWorkspace === "object"
      ? (record.freshWorkspace as Record<string, unknown>)
      : undefined;
  const freshness = fresh
    ? "Fresh workspace. Old edits were not restored."
    : "";
  const value = display(
    fresh
      ? display(visible).text +
          "\n\n" +
          freshness +
          "\nPrevious artifact reference (contents not verified): " +
          safeMetadata(fresh.artifactUrl, 300)
      : visible,
  );
  const diagnostic = diagnostics
    ?.slice(0, 8)
    .map((d) =>
      [d.code, d.message].filter((x) => typeof x === "string").join(": "),
    )
    .filter(Boolean)
    .join("\n");
  const output = display(
    value.text + (diagnostic ? "\n" + maskSecrets(diagnostic) : ""),
  );
  let summary = output.text.replace(/\s+/g, " ").trim().slice(0, 220);
  let sources: ToolSource[] = [];
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const candidates = Array.isArray(record.results)
      ? record.results
      : Array.isArray(record.entries)
        ? record.entries
        : [record];
    sources = candidates
      .slice(0, 5)
      .map(source)
      .filter((s): s is ToolSource => !!s);
    if (Array.isArray(record.results))
      summary =
        record.results.length +
        " " +
        (record.results.length === 1 ? "result" : "results") +
        (sources[0] ? " · " + sources[0].title : "");
    else if (Array.isArray(record.entries))
      summary =
        record.entries.length +
        " directory " +
        (record.entries.length === 1 ? "entry" : "entries");
    else if (typeof record.phase === "string")
      summary =
        "Workspace " +
        safeMetadata(record.phase) +
        (record.active && record.runs && typeof record.runs === "object"
          ? " · " +
            safeMetadata((record.runs as any)[String(record.active)]?.state)
          : "");
    else if (typeof record.error === "string")
      summary = safeMetadata(record.error, 220);
    else if (typeof record.text === "string")
      summary = safeMetadata(record.text, 220);
  }
  if (
    _name === "workspace_status" &&
    record &&
    ["absent", "closed", "ready", "initializing", "stopping"].includes(
      String(record.phase),
    )
  ) {
    const mode = (record.activation as any)?.mode;
    const process = (record.process as any)?.state;
    summary =
      "Workspace " +
      record.phase +
      ". " +
      (process === "none"
        ? "No active process. "
        : process === "not_found"
          ? "Requested process not found. "
          : ["running", "dispatching", "done", "interrupted"].includes(process)
            ? "Process " + process + ". "
            : "") +
      (mode === "automatic"
        ? "New project work activates automatically."
        : mode === "owner_open"
          ? "Owner open required after stop or setup failure."
          : mode === "explicit_target_closed"
            ? "Explicit target remains closed."
            : "");
  }
  let detail = stateDetail(state);
  if (data && typeof data === "object" && (data as any).truncated === true)
    detail += " Result was truncated by the tool.";
  if (Number.isFinite(message.durationMs) && message.durationMs! >= 0)
    detail +=
      " Duration: " +
      Math.round(Math.min(message.durationMs!, 86400000)) / 1000 +
      "s.";
  return {
    state,
    detail,
    summary:
      (freshness ? freshness + " " : "") +
      (summary ||
        (state === "success"
          ? "Completed with no text output."
          : stateDetail(state))),
    output: output.text,
    ...(value.truncated || output.truncated ? { outputTruncated: true } : {}),
    ...(sources.length ? { sources } : {}),
  };
}
