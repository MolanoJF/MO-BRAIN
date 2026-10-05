/**
 * The write-through evidence a `page.delete --purge` receipt carries, named
 * once for both pins (inv-051-b).
 *
 * 0.50.5.0 prints `write_through:{removed, path}`. 0.51 replaced that with the
 * generic `write_through:{written}` (plus `persistence.file_written`), even
 * though the verb still unlinks the page's markdown synchronously. Callers
 * that need the file effect must not assume one vocabulary.
 */
export type PurgeWriteThrough = {
  removed?: boolean;
  path?: string;
  written?: boolean;
  fileWritten?: boolean;
};

/** `persistence.file_written` is a sibling of `write_through`, not a field in it. */
export function parsePurgeWriteThrough(receipt: unknown): PurgeWriteThrough | null {
  const body = receipt as { write_through?: unknown; persistence?: unknown } | null | undefined;
  const wt = body?.write_through;
  if (!wt || typeof wt !== 'object') return null;
  const o = wt as Record<string, unknown>;
  const out: PurgeWriteThrough = {};
  if (typeof o.removed === 'boolean') out.removed = o.removed;
  if (typeof o.path === 'string') out.path = o.path;
  if (typeof o.written === 'boolean') out.written = o.written;
  const p = body?.persistence;
  if (p && typeof p === 'object') {
    const fileWritten = (p as Record<string, unknown>).file_written;
    if (typeof fileWritten === 'boolean') out.fileWritten = fileWritten;
  }
  return Object.keys(out).length > 0 ? out : null;
}
