import {copyControl,toolClipboardText} from './copy-control.js';
const states = {
  pending: "Pending",
  running: "Running",
  success: "Done",
  error: "Failed",
  interrupted: "Interrupted",
  unavailable: "Result unavailable",
};
function sourceUrl(raw) {
  try {
    const u = new URL(raw);
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
      [...u.searchParams.keys()].some((k) =>
        /^(?:password|api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|cookie|client[_-]?secret)$/i.test(
          k,
        ),
      ) ||
      /\b(?:github_pat_|gh[pousr]_|sk-|tvly-)/.test(u.href)
    )
      return null;
    return u.href;
  } catch {
    return null;
  }
}
// Compact only identifier-only context fields on workspace observation/control tools.
// Full inputs/results stay unchanged for inspection and native selection/copy.
function compactContext(label, context) {
  if (!["Wait for command", "Workspace status", "Process status", "Read logs", "Cancel workspace"].includes(label)) return context;
  return context.split(" · ").map(value => /^(?:[a-f0-9]{32,64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(value)
    ? value.slice(0, 8) + "…" + value.slice(-8) : value).join(" · ");
}
export function toolActivity(document, tools, expanded, onToggle, scope = '') {
  const list = document.createElement("div");
  list.className = "tool-activities";
  list.setAttribute("aria-label", "Tool activity");
  const rounds = new Map();
  for (const tool of tools.slice(0, 50)) {
    const key = tool?.roundId || "unlinked";
    if (!rounds.has(key)) rounds.set(key, []);
    rounds.get(key).push(tool);
  }
  let roundNumber = 0;
  for (const round of rounds.values()) {
    roundNumber++;
    const group = document.createElement("div");
    group.className = "tool-round";
    if (rounds.size > 1) {
      const caption = document.createElement("p");
      caption.className = "tool-round-label sr";
      caption.textContent = "Tool round " + roundNumber;
      group.append(caption);
    }
    for (const tool of round) {
      if (
        !tool ||
        typeof tool.id !== "string" ||
        !Object.hasOwn(states, tool.state)
      )
        continue;
      const row = document.createElement("details");
      row.className = "tool-row";
      row.dataset.state = tool.state;
      if (typeof tool.roundId === "string")
        row.dataset.originMessageId = tool.roundId.slice(0, 200);
      const linkage = [
        "following_response",
        "streaming_response",
        "user_boundary",
        "turn_unavailable",
        "result_unavailable",
        "order_unavailable",
        "no_following_response",
        "unlinked",
      ];
      if (linkage.includes(tool.linkage)) row.dataset.linkage = tool.linkage;
      row.open = expanded.has(tool.id);
      const summary = document.createElement("summary");
      summary.dataset.toolId = tool.id;
      const label = document.createElement("span");
      label.className = "tool-label";
      label.textContent =
        typeof tool.label === "string"
          ? tool.label.replace(/^Workspace · /, "").slice(0, 80)
          : "Tool";
      const state = document.createElement("span");
      state.className = "tool-state";
      state.textContent =
        tool.state === "success" && ["Workspace status", "Process status", "Wait for command"].includes(label.textContent)
          ? "Status checked"
          : tool.state === "success" && label.textContent === "Start command"
            ? "Request accepted"
            : states[tool.state];
      summary.append(label, state);
      if (typeof tool.context === "string" && tool.context) {
        const context = document.createElement("span");
        context.className = "tool-context";
        const fullContext = tool.context.slice(0, 360);
        context.textContent = compactContext(label.textContent, fullContext);
        if (context.textContent !== fullContext) {
          context.classList.add("tool-context-compact");
          context.title = fullContext;
          context.setAttribute("aria-label", fullContext);
        }
        summary.append(context);
      }
      const preview = document.createElement("span");
      preview.className = "tool-preview";
      preview.textContent =
        typeof tool.summary === "string" && tool.summary
          ? tool.summary.slice(0, 220)
          : tool.state === "pending"
            ? "Waiting to start."
            : tool.state === "running"
              ? "Waiting for a recorded result…"
              : typeof tool.detail === "string"
                ? tool.detail.slice(0, 220)
                : "No text result was recorded.";
      summary.append(preview);
      const evidence = document.createElement("div");
      evidence.className = "tool-evidence";
      const section = (heading, text, truncated) => {
        const title = document.createElement("h3");
        title.textContent = heading;
        const body = document.createElement("pre");
        body.className = "tool-" + heading.toLowerCase();
        body.textContent = text;
        if (text.length > 500) {
          body.tabIndex = 0;
          body.setAttribute("aria-label", "Tool " + heading.toLowerCase());
        }
        evidence.append(title, body);
        if (truncated) {
          const note = document.createElement("p");
          note.className = "tool-truncated";
          note.textContent = "Display excerpt truncated.";
          evidence.append(note);
        }
      };
      if (typeof tool.context === "string" && compactContext(label.textContent, tool.context) !== tool.context && !tool.input)
        section("Identifier", tool.context.slice(0, 360), tool.context.length > 360);
      if (typeof tool.input === "string" && tool.input)
        section("Input", tool.input.slice(0, 4000), tool.inputTruncated);
      if (typeof tool.output === "string" && tool.output.length)
        section("Output", tool.output.slice(0, 12000), tool.outputTruncated);
      const sources = Array.isArray(tool.sources)
        ? tool.sources.slice(0, 5)
        : [];
      for (const source of sources) {
        const url = sourceUrl(source?.url);
        if (!url) continue;
        const a = document.createElement("a");
        a.href = url;
        a.dataset.toolId = tool.id + ":source:" + sources.indexOf(source);
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent =
          typeof source.title === "string"
            ? source.title.slice(0, 140)
            : new URL(url).hostname;
        evidence.append(a);
      }
      const normalize = text => text.replace(/\s+/g, " ").trim();
      const rawDetail = typeof tool.detail === "string" ? tool.detail.slice(0, 500) : "";
      const detailText = rawDetail.replace(/^(?:Completed\.|Failed\.|Working…|Waiting to start\.)\s*/, "");
      if (detailText && ![preview.textContent, tool.summary, tool.output].some(text => typeof text === "string" && (normalize(text) === normalize(rawDetail) || normalize(text) === normalize(detailText)))) {
        const detail = document.createElement("p");
        detail.className = "tool-detail";
        detail.textContent = detailText;
        evidence.append(detail);
      }
      evidence.append(copyControl(document, JSON.stringify([scope, 'tool', tool.id]), toolClipboardText(tool), 'Copy tool details'));
      summary.addEventListener("click", () => onToggle(tool.id, !row.open));
      row.append(summary, evidence);
      row.addEventListener("toggle", () => onToggle(tool.id, row.open));
      group.append(row);
    }
    if (group.querySelector(".tool-row")) list.append(group);
  }
  return list;
}
