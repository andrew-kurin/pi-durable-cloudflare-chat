import { marked, type Token } from 'marked';

// Parse Markdown syntax, then create an explicit DOM allowlist. Never parse HTML.
function linkURL(value: string): string | null {
 if (!value || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
 try { const url = new URL(value); return !url.username && !url.password && ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}
export function renderMarkdown(document: Document, source: string): DocumentFragment {
 const root = document.createDocumentFragment();
 const element = (tag: string) => document.createElement(tag);
 const text = (parent: Node, value: string) => parent.appendChild(document.createTextNode(value));
 const render = (parent: Node, tokens: Token[] = []) => {
  for (const token of tokens) {
   switch (token.type) {
    case 'space': case 'def': break;
    case 'heading': { const node = element('h' + Math.min(6, Math.max(2, token.depth + 1))); render(node, token.tokens); parent.appendChild(node); break; }
    case 'paragraph': { const node = element('p'); render(node, token.tokens); parent.appendChild(node); break; }
    case 'text': { if (token.tokens) render(parent, token.tokens); else text(parent, token.text); break; }
    case 'escape': text(parent, token.text); break;
    case 'strong': case 'em': case 'del': { const node = element(token.type); render(node, token.tokens); parent.appendChild(node); break; }
    case 'codespan': { const node = element('code'); node.textContent = token.text; parent.appendChild(node); break; }
    case 'code': { const pre = element('pre'); const code = element('code'); code.textContent = token.text; pre.appendChild(code); pre.tabIndex = 0; pre.setAttribute('aria-label', 'Code block'); parent.appendChild(pre); break; }
    case 'br': case 'hr': parent.appendChild(element(token.type)); break;
    case 'blockquote': { const node = element('blockquote'); render(node, token.tokens); parent.appendChild(node); break; }
    case 'list': { const node = element(token.ordered ? 'ol' : 'ul'); if (token.ordered && Number.isSafeInteger(token.start) && token.start > 0) node.setAttribute('start', String(token.start)); for (const item of token.items) { const li = element('li'); if (item.task) text(li, item.checked ? '☑ ' : '☐ '); render(li, item.tokens); node.appendChild(li); } parent.appendChild(node); break; }
    case 'link': { const href = linkURL(token.href); if (!href) { render(parent, token.tokens); break; } const node = element('a'); node.setAttribute('href', href); node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); render(node, token.tokens); parent.appendChild(node); break; }
    case 'image': text(parent, '[Image: ' + (token.text || 'not loaded') + ']'); break;
    case 'table': { const wrapper = element('div'); wrapper.className = 'table-scroll'; wrapper.tabIndex = 0; wrapper.setAttribute('role', 'region'); wrapper.setAttribute('aria-label', 'Markdown table'); const table = element('table'); const head = element('thead'); const row = element('tr'); for (const cell of token.header) { const th = element('th'); th.setAttribute('scope', 'col'); render(th, cell.tokens); row.appendChild(th); } head.appendChild(row); table.appendChild(head); const body = element('tbody'); for (const cells of token.rows) { const tr = element('tr'); for (const cell of cells) { const td = element('td'); render(td, cell.tokens); tr.appendChild(td); } body.appendChild(tr); } table.appendChild(body); wrapper.appendChild(table); parent.appendChild(wrapper); break; }
    // Raw HTML and unknown syntax remain inert, visible text.
    default: text(parent, token.raw);
   }
  }
 };
 try { render(root, marked.lexer(source, { gfm: true, breaks: false })); }
 catch { root.replaceChildren(document.createTextNode(source)); }
 return root;
}
