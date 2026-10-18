import { expect, test } from 'bun:test';
import { collectorMarkdown, collectorSlug, putPageArgv } from '../../src/server/collectors/pages.ts';
import { frontmatterOf } from '../../src/server/gbrain/pages.ts';

test('slug comes from the title', () => {
  expect(collectorSlug('Work email (Gmail)')).toBe('system/collectors/work-email-gmail');
});

test('markdown round-trips through frontmatterOf', () => {
  const md = collectorMarkdown({ title: 'Mail', kind: 'email', enabled: true, cadence: '2h', harness: 'claude-code',
    allowed_tools: ['mcp__claude_ai_Gmail__*'], target_source: 'p-ada', backfill_days: 90, tool_hint: 'claude.ai Gmail' }, 'Skip newsletters.');
  const { frontmatter, body } = frontmatterOf(md);
  expect(frontmatter).toMatchObject({ type: 'collector', kind: 'email', cadence: '2h', allowed_tools: ['mcp__claude_ai_Gmail__*'] });
  expect(body.trim()).toBe('Skip newsletters.');
});

test('put argv names the slug and the source; content goes on stdin', () => {
  expect(putPageArgv('system/collectors/mail', 'p-ada')).toEqual(['put', 'system/collectors/mail', '--source', 'p-ada', '--force']);
});
