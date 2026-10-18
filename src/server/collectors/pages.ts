import { stringify } from 'yaml';
import { slugFor } from '../people/rules.ts';
import { PREFIX } from './service.ts';

export function collectorSlug(title: string): string {
  return `${PREFIX}${slugFor(title)}`;
}

export function collectorMarkdown(fields: Record<string, unknown>, notes: string): string {
  return `---\n${stringify({ type: 'collector', ...fields }).trimEnd()}\n---\n${notes.trim()}\n`;
}

/** Trusted local write. Probe P7: `--source` writes stdin into that source (`--help` documents `--source-id`; `--source` is the flag that worked). The writing client cannot read the page back unless that source is in its federated read. */
export function putPageArgv(slug: string, source: string): string[] {
  // --force: gbrain 0.60.230 refuses an overwrite without --expected-revision (revision_required). This write is the collector API's own, so it replaces the page.
  return ['put', slug, '--source', source, '--force'];
}
