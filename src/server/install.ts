import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BEGIN = '<!-- mobrain:begin -->';
const END = '<!-- mobrain:end -->';

export function mergeResolver(gbrain: string, mobrainBlock: string): string {
  const stripped = gbrain.replace(new RegExp(`\\n*${BEGIN}[\\s\\S]*?${END}\\n?`), '\n').replace(/\n+$/, '\n');
  return `${stripped}\n${BEGIN}\n${mobrainBlock.trim()}\n${END}\n`;
}

let cached: Uint8Array<ArrayBuffer> | null = null;

/** gbrain's pinned skills + Mo-brain's skills, one resolver, as a .tar.gz. Built once per process. */
export async function skillsBundle(gbrainSkillsDir: string, mobrainSkillsDir: string): Promise<Uint8Array<ArrayBuffer>> {
  if (cached) return cached;
  const work = await mkdtemp(join(tmpdir(), 'mb-skills-'));
  try {
    const out = join(work, 'out');
    await mkdir(out);
    await cp(gbrainSkillsDir, out, { recursive: true });
    await cp(mobrainSkillsDir, out, { recursive: true, filter: (src) => !src.endsWith('RESOLVER.mobrain.md') });
    const merged = mergeResolver(
      await readFile(join(gbrainSkillsDir, 'RESOLVER.md'), 'utf8'),
      await readFile(join(mobrainSkillsDir, 'RESOLVER.mobrain.md'), 'utf8'),
    );
    await writeFile(join(out, 'RESOLVER.md'), merged);
    const tgz = join(work, 'skills.tar.gz');
    const p = Bun.spawn(['tar', '-czf', tgz, '-C', out, '.']);
    if ((await p.exited) !== 0) throw new Error('tar failed');
    cached = new Uint8Array(await Bun.file(tgz).arrayBuffer());
    return cached;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
