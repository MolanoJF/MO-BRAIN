/**
 * Bring existing notes into a Space: a git repo, an uploaded folder, or pages
 * another integration fetched (Notion). Shared by every caller that may
 * manage the Space; the route decides WHICH Space, this decides what happens.
 *
 * One commit by the person, then the same `sync` + capped `embed` the editor
 * uses, then the source's own status so the reply can say how many pages the
 * brain now holds and how much of it is embedded. A preview (`dryRun`) runs
 * the same plan on gbrain-ops and writes nothing.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, schema } from './db/client.ts';
import { actorIdentity } from './actor.ts';
import { callOps, gitImport, type ImportOutcome, type ImportRequest } from './opsClient.ts';
import { resolveGithubToken } from './credentials.ts';
import { syncAndEmbed, type IndexStep } from '../agent/reindex.ts';
import { normalizeImportPath, type ImportFile } from '../contracts/importPlan.ts';

export type ImportSpace = { id: string; sourceId: string; ownerMembershipId: string | null };

export type ImportResult = { status: number; body: object };

/** Published per-token prices for the embedding models the wizard offers. Unknown model, no estimate. */
const EMBED_USD_PER_MTOK: Record<string, number> = {
  'openai:text-embedding-3-small': 0.02,
  'openai:text-embedding-3-large': 0.13,
};

type SourceStatus = {
  source_id?: string; total_pages?: number; total_chunks?: number;
  embedded_chunks?: number; embed_coverage_pct?: number;
};

/** gbrain's own per-source dashboard. Null when it cannot be read: unknown is not zero. */
export async function sourceIndexStatus(sourceId: string): Promise<{
  pages: number; chunks: number; embeddedChunks: number; coveragePct: number;
} | null> {
  try {
    const r = await callOps<{ sources?: SourceStatus[] }>('sources.status', {}, { json: true, timeoutMs: 60_000 });
    const s = r.ok ? r.json?.sources?.find((x) => x.source_id === sourceId) : undefined;
    if (!s || typeof s.total_pages !== 'number') return null;
    return {
      pages: s.total_pages,
      chunks: s.total_chunks ?? 0,
      embeddedChunks: s.embedded_chunks ?? 0,
      coveragePct: s.embed_coverage_pct ?? 0,
    };
  } catch {
    return null;
  }
}

function stepSummary(step: IndexStep | null) {
  return step ? { exitCode: step.exitCode, classification: step.classification } : null;
}

/** `github.com/owner/repo` for a commit message and the audit row; never the token. */
function describeRemote(url: URL): string {
  return `${url.host}${url.pathname.replace(/\.git$/, '')}`;
}

export async function importIntoSpaceFor(
  ctx: { userId: string; orgId: string },
  space: ImportSpace,
  body: any,
): Promise<ImportResult> {
  const dryRun = body?.dryRun === true;
  const prefix = typeof body?.prefix === 'string' ? body.prefix.trim() : '';
  if (prefix && normalizeImportPath('x.md', prefix) === null) {
    return { status: 400, body: { error: 'prefix must be a folder path inside the Space' } };
  }

  let source: ImportRequest['source'];
  let origin: string;
  if (body?.kind === 'git') {
    let url: URL;
    try { url = new URL(String(body.url ?? '').trim()); } catch {
      return { status: 400, body: { error: 'url must be an https:// git URL' } };
    }
    if (url.protocol !== 'https:') return { status: 400, body: { error: 'url must be an https:// git URL' } };
    const ref = typeof body.ref === 'string' && body.ref.trim() ? body.ref.trim() : undefined;
    // A stored GitHub token is offered to github.com only: sending it to any
    // other host would hand it to whoever runs that host.
    const resolved = url.host === 'github.com'
      ? await resolveGithubToken({ orgId: ctx.orgId, space: { ownerMembershipId: space.ownerMembershipId } })
      : null;
    source = { kind: 'git', url: url.toString(), ...(resolved ? { token: resolved.token } : {}), ...(ref ? { ref } : {}) };
    origin = `${describeRemote(url)}${ref ? `@${ref}` : ''}`;
  } else if (body?.kind === 'files') {
    if (!Array.isArray(body.files)) return { status: 400, body: { error: 'files must be an array' } };
    const files: ImportFile[] = body.files
      .filter((f: any) => typeof f?.path === 'string' && typeof f?.content === 'string')
      .map((f: any) => ({ path: f.path, content: f.content }));
    if (files.length === 0) return { status: 400, body: { error: 'no files to import' } };
    source = { kind: 'files', files };
    const label = typeof body.label === 'string' ? body.label.replace(/[\r\n]+/g, ' ').trim().slice(0, 120) : '';
    origin = label || 'uploaded folder';
  } else {
    return { status: 400, body: { error: "kind must be 'git' or 'files'" } };
  }

  const actor = await actorIdentity(ctx.userId);
  let outcome: ImportOutcome;
  try {
    outcome = await gitImport({
      sourceId: space.sourceId, source, prefix, actor, message: `import: ${origin}`, dryRun,
    });
  } catch (e) {
    return { status: 400, body: { error: e instanceof Error ? e.message : String(e) } };
  }

  const [brain] = await getDb().select({ model: schema.brains.embeddingModel }).from(schema.brains)
    .where(eq(schema.brains.organizationId, ctx.orgId));
  const rate = brain?.model ? EMBED_USD_PER_MTOK[brain.model] : undefined;
  const estUsd = rate === undefined ? null : Math.round(outcome.plan.estTokens / 1e6 * rate * 1000) / 1000;

  if (dryRun) return { status: 200, body: { ok: true, dryRun: true, from: origin, ...outcome, estUsd } };

  // Nothing changed is a successful import of an already-current snapshot.
  const index = outcome.sha ? await syncAndEmbed(space.sourceId, { callOps }) : null;
  const status = await sourceIndexStatus(space.sourceId);

  await getDb().insert(schema.auditLog).values({
    id: randomUUID(), organizationId: ctx.orgId, actor: ctx.userId, action: 'source.import',
    target: space.sourceId, before: null,
    // S3c: counts and the origin only — never content, never a token.
    after: {
      kind: body.kind, origin, sha: outcome.sha, kept: outcome.plan.kept, added: outcome.added,
      updated: outcome.updated, skipped: outcome.plan.skipped.length,
      redacted: outcome.plan.redactions.reduce((n, r) => n + r.count, 0),
      sync: index?.sync.classification ?? null, embed: index?.embed?.classification ?? null,
    },
  });

  return {
    status: 200,
    body: {
      ok: true, from: origin, ...outcome, estUsd,
      index: index ? { sync: stepSummary(index.sync), embed: stepSummary(index.embed) } : null,
      sourceStatus: status,
    },
  };
}
