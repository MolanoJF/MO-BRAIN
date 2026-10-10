import { describe, expect, test } from 'bun:test';
import {
  IMPORT_MAX_FILE_BYTES, IMPORT_MAX_FILES, normalizeImportPath, planImport, redactSecrets,
} from '../../src/contracts/importPlan.ts';

describe('redactSecrets', () => {
  test('an Anthropic key is redacted as anthropic, not as an OpenAI key', () => {
    const r = redactSecrets('key: sk-ant-api03-5IeEz---fEPckJSSDd18YFfxxBeX4N end');
    expect(r.text).toBe('key: [REDACTED:anthropic-key] end');
    expect([...r.found]).toEqual([['anthropic-key', 1]]);
  });

  test('every listed shape is caught', () => {
    const samples = [
      'sk-proj-' + 'a'.repeat(40),
      'ghp_' + 'A'.repeat(36),
      'github_pat_' + 'B'.repeat(60),
      'xoxb-1234567890-abcdef',
      'AKIA' + 'ABCDEFGHIJKLMNOP',
      'AIza' + 'x'.repeat(35),
      'sk_live_' + 'c'.repeat(24),
      'ntn_' + 'd'.repeat(46),
      '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
    ];
    for (const s of samples) {
      const r = redactSecrets(`x ${s} y`);
      expect(r.text).not.toContain(s);
      expect(r.text).toMatch(/^x \[REDACTED:[a-z-]+\] y$/);
    }
  });

  test('ordinary prose is left alone', () => {
    const prose = 'Ask about the sk- prefix and the ghp token naming, and task-ant-hill.';
    expect(redactSecrets(prose)).toEqual({ text: prose, found: new Map() });
  });
});

describe('normalizeImportPath', () => {
  test('accepts relative paths and joins a prefix', () => {
    expect(normalizeImportPath('./people/ana.md')).toBe('people/ana.md');
    expect(normalizeImportPath('people\\ana.md', 'notion/')).toBe('notion/people/ana.md');
  });

  test('refuses traversal, empty segments and control characters', () => {
    for (const bad of ['../x.md', 'a/../../x.md', 'a//b.md', '', 'a/\u0007.md']) {
      expect(normalizeImportPath(bad)).toBeNull();
    }
  });
});

describe('planImport', () => {
  test('keeps markdown, skips the rest with a reason, and reports redactions', () => {
    const plan = planImport([
      { path: 'people/ana.md', content: '# Ana' },
      { path: '.git/config', content: '[core]' },
      { path: '.obsidian/app.json', content: '{}' },
      { path: 'scripts/run.sh', content: 'echo' },
      { path: 'img.md', content: 'a\u0000b' },
      { path: 'big.md', content: 'x'.repeat(IMPORT_MAX_FILE_BYTES + 1) },
      { path: '../escape.md', content: 'no' },
      { path: 'inbox/digest.md', content: 'leaked sk-ant-api03-abcdefghijklmnopqrstuvwxyz twice sk-ant-api03-abcdefghijklmnopqrstuvwxyz' },
    ]);
    expect(plan.files.map((f) => f.path)).toEqual(['people/ana.md', 'inbox/digest.md']);
    expect(plan.files[1]!.content).not.toContain('sk-ant-');
    expect(plan.skipped).toEqual([
      { path: '.git/config', reason: 'hidden' },
      { path: '.obsidian/app.json', reason: 'hidden' },
      { path: 'scripts/run.sh', reason: 'not_markdown' },
      { path: 'img.md', reason: 'binary' },
      { path: 'big.md', reason: 'too_large' },
      { path: '../escape.md', reason: 'invalid_path' },
    ]);
    expect(plan.redactions).toEqual([{ path: 'inbox/digest.md', kind: 'anthropic-key', count: 2 }]);
    expect(plan.estTokens).toBe(Math.ceil(plan.totalBytes / 4));
  });

  test('paths that become one page slug are reported, and all are still kept', () => {
    const plan = planImport([
      { path: 'atoms/scope-creep.md', content: 'a' },
      { path: 'atoms/scope-creep-.md', content: 'b' },
      { path: 'concepts/AIOS.md', content: 'c' },
      { path: 'concepts/aios.md', content: 'd' },
      { path: 'people/ana.md', content: 'e' },
    ]);
    expect(plan.files).toHaveLength(5);
    expect(plan.collisions).toEqual([
      ['atoms/scope-creep.md', 'atoms/scope-creep-.md'],
      ['concepts/AIOS.md', 'concepts/aios.md'],
    ]);
  });

  test('a prefix moves every kept file under that folder', () => {
    const plan = planImport([{ path: 'a.md', content: 'a' }], { prefix: 'notion' });
    expect(plan.files[0]!.path).toBe('notion/a.md');
  });

  test('refuses an input over the file cap before doing any work', () => {
    const many = Array.from({ length: IMPORT_MAX_FILES + 1 }, (_, i) => ({ path: `${i}.md`, content: '' }));
    expect(() => planImport(many)).toThrow(/too many files/);
  });
});
