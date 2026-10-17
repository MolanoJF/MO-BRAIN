import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const root = join(import.meta.dir, '..', '..');
const skillsDir = join(root, 'skills');
const skills = readdirSync(skillsDir).filter((d) => statSync(join(skillsDir, d)).isDirectory());
const usage = readFileSync(join(root, 'bin', 'mobrain'), 'utf8').split('cat >&2 <<\'EOF\'')[1]!.split('EOF')[0]!;

describe('Mo-brain skills', () => {
  test('exactly the five shipped skills', () => {
    expect(skills.sort()).toEqual(['mobrain-collect', 'mobrain-import', 'mobrain-install', 'mobrain-join', 'mobrain-schema']);
  });

  for (const s of skills) {
    const text = readFileSync(join(skillsDir, s, 'SKILL.md'), 'utf8');
    const fm = parse(/^---\n([\s\S]*?)\n---/.exec(text)![1]!) as { name: string; description: string; triggers?: string[] };

    test(`${s}: frontmatter name matches the folder and has a description and triggers`, () => {
      expect(fm.name).toBe(s);
      expect(fm.description.length).toBeGreaterThan(40);
      expect(fm.triggers?.length).toBeGreaterThan(0);
    });

    test(`${s}: every \`mobrain <command>\` it names exists in the CLI usage`, () => {
      const cmds = [...text.matchAll(/`mobrain ([a-z-]+)(?: ([a-z-]+))?/g)].map((m) => m[1]!);
      for (const c of new Set(cmds)) expect(usage).toContain(c);
    });
  }

  test('the resolver block routes to every skill', () => {
    const block = readFileSync(join(skillsDir, 'RESOLVER.mobrain.md'), 'utf8');
    for (const s of skills) expect(block).toContain(`${s}/SKILL.md`);
  });
});
