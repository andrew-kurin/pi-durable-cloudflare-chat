/** Preserve diagnostic text, HTML, URLs and identifiers; redact credentials only.
 * Known stored credentials are matched before truncation, including URL encoding.
 */
export function redactDiagnosticCredentials(raw: string, secrets: string[] = []): string {
  let text = raw;
  for (const secret of secrets.filter(Boolean)) {
    for (const value of new Set([secret, encodeURIComponent(secret)])) {
      const normalizeEscapes = (input: string) => input.replace(/%[a-f0-9]{1,2}/gi, octet => octet.toUpperCase());
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%[a-f0-9]{2}/gi, octet => octet.split('').map(char => /[a-f]/i.test(char) ? '[' + char.toLowerCase() + char.toUpperCase() + ']' : char).join(''));
      text = text.replace(new RegExp(escaped, 'g'), '[credential redacted]');
      // A response interrupted part-way through a reflected credential is unsafe too.
      const normalized = normalizeEscapes(text), normalizedValue = normalizeEscapes(value);
      const start = normalized.lastIndexOf(normalizedValue.slice(0, 12));
      if (start >= 0 && normalizedValue.startsWith(normalized.slice(start))) text = text.slice(0, start) + '[partial credential redacted]';
    }
  }
  return text
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[authorization redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g, '[JWT redacted]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[private key redacted]')
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-|tvly-)[A-Za-z0-9_-]+/g, '[API credential redacted]')
    .replace(/(["']?(?:authorization|cookie|set-cookie|password|client_secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|device_code)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;<>}&]+)/gi, '$1[credential redacted]');
}
