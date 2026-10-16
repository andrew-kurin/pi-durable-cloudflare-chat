import {
  modelErrorDiagnostic,
  modelErrorInfo,
  type SavedFailure,
} from "./model-error";
import type { AgentEvent, EntryRecord } from "@earendil-works/pi-durable";
import {
  toolLabel,
  stateDetail,
  resultSummary,
  inputContext,
  type ToolActivity,
  type ToolState,
  type ToolLinkage,
} from "./tool-activity";
export function entryText(entry: EntryRecord) {
  return (entry.model ?? [])
    .flatMap((m) =>
      typeof m.content === "string"
        ? [m.content]
        : m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])),
    )
    .join("\n");
}
export class ChatProjection {
  messages: {
    id: string;
    role: string;
    text: string;
    failure?: SavedFailure;
  }[] = [];
  partial: Record<number, string> = {};
  busy = false;
  activity = "";
  private entries: { id: string; kind: string; turnId?: string }[] = [];
  private turnId?: string;
  private failed = false;
  private readonly failureText =
    "Sol could not finish this response. Saved tool results remain available; check workspace status before retrying commands.";
  private tools = new Map<
    string,
    ToolActivity & { messageId?: string; resultId?: string; name: string }
  >();
  private tool(id: string, name: string, state: ToolState, messageId?: string) {
    if (typeof id !== "string" || !id || id.length > 200) return;
    const prior = this.tools.get(id);
    if (prior) {
      if (messageId) prior.messageId = messageId;
      return prior;
    }
    const row: ToolActivity & {
      messageId?: string;
      resultId?: string;
      name: string;
    } = {
      id,
      name,
      label: toolLabel(name),
      state,
      detail: stateDetail(state),
      messageId,
    };
    this.tools.set(id, row);
    return row;
  }
  private activation(row: ToolActivity, details: unknown) {
    if (["success", "error", "interrupted"].includes(row.state)) return;
    const phase =
      details && typeof details === "object" && "workspaceActivation" in details
        ? details.workspaceActivation
        : undefined;
    if (phase === "starting") row.summary = "Starting workspace…";
    if (phase === "ready") row.summary = "Workspace ready. Running tool…";
    if (phase === "failed") {
      row.summary = "Workspace activation failed.";
      row.state = "error";
      row.detail = "Workspace did not start; no tool operation ran.";
    }
  }
  private calls(entry: EntryRecord) {
    for (const m of entry.model ?? [])
      if (m.role === "assistant")
        for (const block of m.content)
          if (block.type === "toolCall") {
            const row = this.tool(
              block.id,
              block.name,
              "pending",
              String(entry.id),
            );
            if (row) Object.assign(row, inputContext(block.arguments));
          }
  }
  entry(entry: EntryRecord) {
    const entryId = String(entry.id);
    if (!this.entries.some((e) => e.id === entryId)) {
      if (entry.kind === "pi.user" || entry.kind === "pi.reset")
        this.turnId = entryId;
      else if (entry.head !== undefined && String(entry.head) === entryId)
        this.turnId = undefined;
      this.entries.push({ id: entryId, kind: entry.kind, turnId: this.turnId });
    }
    if (entry.kind === "pi.tool-result") {
      for (const m of entry.model ?? [])
        if (m.role === "toolResult") {
          const row = this.tool(m.toolCallId, m.toolName, "unavailable");
          const summary = resultSummary(entry, m.toolName);
          if (row && summary)
            Object.assign(row, summary, { resultId: entryId });
        }
      return;
    }
    this.calls(entry);
    if (!["pi.user", "pi.assistant"].includes(entry.kind)) return;
    const modelError =
      entry.kind === "pi.assistant" &&
      entry.model?.some(
        (m) => m.role === "assistant" && m.stopReason === "error",
      );
    if (entry.kind === "pi.user") this.failed = false;
    else if (modelError) this.failed = true;
    else if (entryText(entry).trim()) this.failed = false;
    const errorMessage = entry.model
      ?.filter((m) => m.role === "assistant")
      .find((m) => m.stopReason === "error")?.errorMessage;
    const item = {
      ...(modelError
        ? {
            failure: {
              kind: "model" as const,
              diagnostic: modelErrorInfo(errorMessage),
              recoveryAction: "check-status" as const,
            },
          }
        : {}),
      id: String(entry.id),
      role: entry.kind === "pi.user" ? "user" : "assistant",
      text: modelError
        ? this.failureText +
          " " +
          modelErrorDiagnostic(
            entry.model
              ?.filter((m) => m.role === "assistant")
              .find((m) => m.stopReason === "error")?.errorMessage,
          )
        : entryText(entry),
    };
    const at = this.messages.findIndex((m) => m.id === item.id);
    if (at < 0) this.messages.push(item);
    else this.messages[at] = item;
  }
  apply(e: AgentEvent) {
    if (e.type === "snapshot") {
      this.messages = [];
      this.entries = [];
      this.turnId = undefined;
      this.failed = false;
      this.tools.clear();
      e.entries.forEach((x) => this.entry(x));
      this.partial = {};
      e.generation?.message?.content.forEach((p, i) => {
        if (p.type === "text") this.partial[i] = p.text;
      });
      this.busy = !!e.run;
      for (const row of this.tools.values())
        if (row.state === "pending") {
          row.state = "unavailable";
          delete row.summary;
          row.detail = stateDetail(row.state);
        }
      for (const slot of e.tools) {
        const row = this.tool(slot.callId, slot.name, "unavailable");
        if (row && slot.status !== "done") {
          row.state = slot.status;
          row.detail = stateDetail(row.state);
          this.activation(row, slot.details);
        }
      }
      this.activity = [...this.tools.values()].some(
        (t) => t.state === "pending" || t.state === "running",
      )
        ? "Reading sources or working with Luna…"
        : "";
    }
    if (e.type === "run_start") {
      this.busy = true;
      this.failed = false;
      this.activity = "";
    }
    if (e.type === "run_end") {
      for (const row of this.tools.values())
        if (row.state === "pending" || row.state === "running") {
          row.state = "unavailable";
          delete row.summary;
          row.detail = stateDetail(row.state);
        }
      this.busy = false;
      this.partial = {};
      this.activity = this.failed ? this.failureText : "";
    }
    if (e.type === "message_start") {
      this.partial = {};
      e.message.content &&
        Array.isArray(e.message.content) &&
        e.message.content.forEach((p, i) => {
          if (p.type === "text") this.partial[i] = p.text;
        });
    }
    if (e.type === "message_update")
      for (const c of e.changes) {
        if (c.type === "text_delta")
          this.partial[c.contentIndex] =
            (this.partial[c.contentIndex] ?? "") + c.delta;
        else if (
          (c.type === "text_start" || c.type === "block") &&
          c.block.type === "text"
        )
          this.partial[c.contentIndex] = c.block.text;
        else if (c.type === "message") {
          this.partial = {};
          c.message.content.forEach((p, i) => {
            if (p.type === "text") this.partial[i] = p.text;
          });
        }
      }
    if (e.type === "message_end") {
      this.entry(e.entry);
      this.partial = {};
    }
    if (e.type === "entry_appended") this.entry(e.entry);
    if (e.type === "tool_execution_update") {
      const row = this.tools.get(e.toolCallId);
      if (row) this.activation(row, e.details);
      if (
        ![...this.tools.values()].some(
          (t) => t.state === "pending" || t.state === "running",
        )
      )
        this.activity = "";
    }
    if (e.type === "tool_execution_start") {
      const row = this.tool(e.toolCallId, e.toolName, "running");
      if (row && !["success", "error", "interrupted"].includes(row.state))
        Object.assign(row, inputContext(e.args));
      if (row && !["success", "error", "interrupted"].includes(row.state)) {
        row.state = "running";
        row.detail = stateDetail(row.state);
      }
    }
    if (e.type === "tool_execution_start")
      this.activity =
        e.toolName === "ask_luna"
          ? "Working with Luna…"
          : e.toolName === "web_search"
            ? "Searching the public web…"
            : e.toolName === "fetch_page"
              ? "Reading a public page…"
              : ["github_read", "github_search"].includes(e.toolName)
                ? "Reading public GitHub…"
                : "Working with a tool…";
    if (e.type === "tool_execution_end") {
      if (e.entry) this.entry(e.entry);
      else {
        const row = this.tool(e.toolCallId, e.toolName, "unavailable");
        if (row && !["success", "error", "interrupted"].includes(row.state)) {
          row.state = "unavailable";
          delete row.summary;
          row.detail = stateDetail(row.state);
        }
      }
      this.activity = [...this.tools.values()].some(
        (t) => t.state === "running" || t.state === "pending",
      )
        ? "Reading sources or working with Luna…"
        : "";
    }
    if (e.type === "task_failed") {
      this.failed = true;
      this.activity = this.failureText;
    }
  }
  view() {
    const messages = this.messages.map((m) => ({
      ...m,
      tools: [] as (ToolActivity & { roundId?: string })[],
    }));
    const byId = new Map(messages.map((m) => [m.id, m]));
    const positions = new Map(this.entries.map((e, i) => [e.id, i]));
    const partialTools: (ToolActivity & { roundId?: string })[] = [];
    const unattached: ToolActivity[] = [];
    for (const row of this.tools.values()) {
      const {
        id,
        label,
        state,
        detail,
        summary,
        sources,
        input,
        context,
        output,
        inputTruncated,
        outputTruncated,
      } = row;
      const item: ToolActivity & { roundId?: string; linkage: ToolLinkage } = {
        id,
        label,
        state,
        detail,
        ...(input !== undefined ? { input, context, inputTruncated } : {}),
        ...(output !== undefined ? { output, outputTruncated } : {}),
        ...(summary ? { summary } : {}),
        ...(sources ? { sources } : {}),
        linkage: "unlinked",
        ...(row.messageId ? { roundId: row.messageId } : {}),
      };
      const origin = row.messageId ? positions.get(row.messageId) : undefined;
      const result = row.resultId ? positions.get(row.resultId) : undefined;
      let target = row.messageId ? byId.get(row.messageId) : undefined;
      if (origin !== undefined)
        item.linkage =
          result === undefined
            ? "result_unavailable"
            : result <= origin
              ? "order_unavailable"
              : !this.entries[origin].turnId
                ? "turn_unavailable"
                : "no_following_response";
      // Exact call/result IDs establish the round; transcript boundaries constrain
      // placement. This is chronological response linkage, never sentence inference.
      if (
        origin !== undefined &&
        result !== undefined &&
        result > origin &&
        this.entries[origin].turnId
      ) {
        const turn = this.entries[origin].turnId;
        if (this.entries[result].turnId === turn) {
          const next = this.entries
            .slice(result + 1)
            .find(
              (e) =>
                e.turnId !== turn ||
                (e.kind === "pi.assistant" && !!byId.get(e.id)?.text.trim()),
            );
          if (next?.turnId === turn && next.kind === "pi.assistant") {
            target = byId.get(next.id);
            item.linkage = "following_response";
          } else if (
            !next &&
            this.busy &&
            this.turnId === turn &&
            Object.values(this.partial).some(Boolean)
          ) {
            item.linkage = "streaming_response";
            partialTools.push(item);
            continue;
          } else if (next?.turnId !== undefined && next.turnId !== turn)
            item.linkage = "user_boundary";
        } else item.linkage = "user_boundary";
      }
      if (target) target.tools.push(item);
      else unattached.push(item);
    }
    if (unattached.length)
      messages.push({
        id: "tool-activity",
        role: "assistant",
        text: "",
        tools: unattached,
      });
    return {
      projectionVersion: 2,
      messages,
      partial: Object.values(this.partial).join(""),
      partialTools,
      busy: this.busy,
      activity: this.activity,
    };
  }
}
