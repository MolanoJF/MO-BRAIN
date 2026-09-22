import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { validateDraft } from '../../src/control/schemaDraft.ts';

test('every example draft passes the same gate the import route uses', () => {
  for (const f of readdirSync('skills/mobrain-schema-designer/examples')) {
    const r = validateDraft(JSON.parse(readFileSync(`skills/mobrain-schema-designer/examples/${f}`, 'utf8')));
    expect({ f, ok: r.ok, errors: r.ok ? [] : r.errors }).toEqual({ f, ok: true, errors: [] });
  }
});

test('the skill never instructs a mutation', () => {
  const skill = readFileSync('skills/mobrain-schema-designer/SKILL.md', 'utf8');
  for (const forbidden of ['schema_apply_mutations', 'add-type', 'schema use', 'config set', 'put_page']) {
    expect(skill).not.toContain(forbidden);
  }
});
