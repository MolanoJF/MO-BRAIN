/**
 * What an import into a Space keeps, skips and redacts.
 *
 * One plan for every way content arrives (a git repo, an uploaded folder, a
 * Notion workspace), so the three cannot disagree about what lands in the
 * brain. Pure and browser-safe: the console runs it to preview an upload
 * before a byte leaves the page, and gbrain-ops runs it again on what it is
 * about to commit, so the preview is never the only gate.
 *
 * Secrets are redacted, not refused: an exported notes folder or an email
 * digest often quotes a key, and refusing the whole import over one quoted
 * line leaves the person with nothing. The report names every file and kind
 * so the person can see what changed.
 */

export type ImportFile = { path: string; content: string };

export type SkipReason = 'hidden' | 'not_markdown' | 'too_large' | 'binary' | 'invalid_path';

export type ImportPlan = {
  files: ImportFile[];
  skipped: { path: string; reason: SkipReason }[];
  redactions: { path: string; kind: string; count: number }[];
  totalBytes: number;
  /** ~4 bytes per token: an estimate for the embedding cost, never a bill. */
  estTokens: number;
};

export const IMPORT_MAX_FILE_BYTES = 1_000_000;
export const IMPORT_MAX_FILES = 5_000;
export const IMPORT_MAX_TOTAL_BYTES = 50_000_000;

const MARKDOWN = /\.(md|markdown)$/i;

/**
 * Order matters: the Anthropic shape is tried before the OpenAI one, whose
 * `sk-` prefix would otherwise claim it.
 */
export const SECRET_PATTERNS: readonly { kind: string; re: RegExp }[] = [
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'openai-key', re: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g },
  { kind: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/g },
  { kind: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'stripe-key', re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{20,}/g },
  { kind: 'notion-token', re: /\b(?:secret_|ntn_)[A-Za-z0-9]{40,}/g },
];

/** Replace every known secret shape. `found` maps kind -> occurrences. */
export function redactSecrets(text: string): { text: string; found: Map<string, number> } {
  const found = new Map<string, number>();
  let out = text;
  for (const { kind, re } of SECRET_PATTERNS) {
    out = out.replace(re, () => {
      found.set(kind, (found.get(kind) ?? 0) + 1);
      return `[REDACTED:${kind}]`;
    });
  }
  return { text: out, found };
}

/**
 * A path relative to the Space root, with `/` separators, or null when it
 * cannot be one (absolute, `..`, empty segments, control characters).
 * `prefix` is a folder inside the Space the import lands under.
 */
export function normalizeImportPath(raw: string, prefix = ''): string | null {
  const clean = (p: string) => p.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+|\/+$/g, '');
  const joined = [clean(prefix), clean(raw)].filter(Boolean).join('/');
  if (!joined || /[\x00-\x1f]/.test(joined)) return null;
  const parts = joined.split('/');
  if (parts.some((s) => s === '' || s === '.' || s === '..')) return null;
  return joined;
}

const byteLength = (s: string) => new TextEncoder().encode(s).length;

/**
 * Throws when the input is over the hard caps, so a caller can refuse before
 * doing any work; everything else is a per-file skip in the report.
 */
export function planImport(input: readonly ImportFile[], opts: { prefix?: string } = {}): ImportPlan {
  if (input.length > IMPORT_MAX_FILES) {
    throw new Error(`too many files: ${input.length} (limit ${IMPORT_MAX_FILES})`);
  }
  const plan: ImportPlan = { files: [], skipped: [], redactions: [], totalBytes: 0, estTokens: 0 };
  const seen = new Set<string>();

  for (const f of input) {
    const rel = normalizeImportPath(f.path);
    if (rel === null) { plan.skipped.push({ path: f.path, reason: 'invalid_path' }); continue; }
    const segments = rel.split('/');
    if (segments.some((s) => s.startsWith('.') || s === 'node_modules')) {
      plan.skipped.push({ path: rel, reason: 'hidden' });
      continue;
    }
    if (!MARKDOWN.test(rel)) { plan.skipped.push({ path: rel, reason: 'not_markdown' }); continue; }
    if (f.content.includes('\u0000')) { plan.skipped.push({ path: rel, reason: 'binary' }); continue; }
    if (byteLength(f.content) > IMPORT_MAX_FILE_BYTES) {
      plan.skipped.push({ path: rel, reason: 'too_large' });
      continue;
    }

    const path = normalizeImportPath(rel, opts.prefix ?? '');
    if (path === null || seen.has(path)) { plan.skipped.push({ path: rel, reason: 'invalid_path' }); continue; }
    seen.add(path);

    const { text, found } = redactSecrets(f.content);
    for (const [kind, count] of found) plan.redactions.push({ path, kind, count });
    const bytes = byteLength(text);
    plan.totalBytes += bytes;
    plan.files.push({ path, content: text });
  }

  if (plan.totalBytes > IMPORT_MAX_TOTAL_BYTES) {
    throw new Error(`import too large: ${plan.totalBytes} bytes (limit ${IMPORT_MAX_TOTAL_BYTES})`);
  }
  plan.estTokens = Math.ceil(plan.totalBytes / 4);
  return plan;
}
