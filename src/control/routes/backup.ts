import { Hono } from 'hono';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requireAdmin } from './auth.ts';
import { runBackup } from '../../../scripts/backup.ts';

export const backup = new Hono();
const ROOT = process.env.BACKUP_DIR ?? '/srv/backups';

backup.post('/backup', async (c) => {
  try { await requireAdmin(c); } catch (r) { return r as Response; }
  const dir = join(ROOT, new Date().toISOString().replace(/[:.]/g, '-'));
  try { return c.json(await runBackup(dir)); }
  catch (e) { return c.json({ error: e instanceof Error ? e.message : 'backup_failed' }, 500); }
});

backup.get('/backup', async (c) => {
  try { await requireAdmin(c); } catch (r) { return r as Response; }
  try {
    const dirs = await readdir(ROOT);
    const out = [];
    for (const d of dirs) {
      try { out.push(JSON.parse(await readFile(join(ROOT, d, 'manifest.json'), 'utf8'))); } catch {}
    }
    return c.json({ backups: out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
  } catch { return c.json({ backups: [] }); }
});
