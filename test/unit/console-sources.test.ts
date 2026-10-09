import { test, expect, describe } from 'bun:test';
import {
  sourcePackLabel, removeConfirmState, canConfirmRemove,
  validSourceId, addSourceError, canAddSource, renameSourceError, builtinDefaultText,
  pageCountText, lastSyncText, toggleRead, slugifySourceId, gitStatusText,
  SOURCE_ID, ISOLATION_NOTICE, NO_SOURCE_READBACK_NOTICE, BACKFILL_NOTICE,
} from '../../src/console/pages/Sources.tsx';
import { pickAfterReload } from '../../src/console/SourceContext.tsx';
import type { SourceSummary, SpaceSummary } from '../../src/console/api.ts';

/**
 * The Sources lane. Every assertion is a trust property, not a rendering
 * detail: an override must be named as the STORED setting (gbrain offers no
 * per-Space readback at 0.50.5.0, S6 Gate 2), the destructive remove must
 * require a seen impact preview, and an unlisted source must never read as
 * "0 pages".
 */

const source = (over: Partial<SourceSummary> = {}): SourceSummary => ({
  sourceId: 'customers',
  name: 'Customers',
  kind: 'primary',
  pack: 'gbrain-base-v2',
  tier: 'home-config',
  pageTypes: 19,
  linkVerbs: 17,
  inherited: true,
  pageCount: 12,
  lastSyncAt: '2026-09-17T06:12:52.152Z',
  federated: true,
  inGbrain: true,
  gitRemote: null,
  private: false,
  canManage: true,
  gitStatus: null,
  ...over,
});

describe('sourcePackLabel — inherited vs override copy', () => {
  test('an inherited row names the brain default, not a bare pack', () => {
    const label = sourcePackLabel(source({ inherited: true, pack: 'gbrain-base-v2' }));
    expect(label).toMatch(/inherits the brain default/i);
    expect(label).toContain('gbrain-base-v2');
  });

  test('an override is named as the STORED setting with its tier, never a resolved state', () => {
    // Gate 2: `schema active --source` ignores its argument, so we never read a
    // per-space pack back. An override is intent, and the label must say so.
    const label = sourcePackLabel(source({
      inherited: false, pack: 'gbrain-investor', tier: 'per-source-db',
    }));
    expect(label).toMatch(/stored/i);
    expect(label).toContain('gbrain-investor');
    expect(label).toContain('per-source-db');
    expect(label).not.toMatch(/inherits the brain default/i);
  });

  test('the no-readback notice states plainly that there is no per-Source readback', () => {
    expect(NO_SOURCE_READBACK_NOTICE).toMatch(/no per-Source pack readback/i);
    expect(NO_SOURCE_READBACK_NOTICE).toMatch(/stored setting/i);
  });
});

describe('the destructive remove gate — two clicks with a seen preview', () => {
  test('without a click the state is idle and cannot confirm', () => {
    expect(removeConfirmState(false, null)).toBe('idle');
    expect(canConfirmRemove(false, 'Pages: 3')).toBe(false);
  });

  test('after the first click but before the preview it is not confirmable', () => {
    expect(removeConfirmState(true, null)).toBe('awaiting-preview');
    expect(canConfirmRemove(true, null)).toBe(false);
  });

  test('an empty preview is not a confirmation', () => {
    expect(canConfirmRemove(true, '   ')).toBe(false);
  });

  test('a 409 impact preview makes the destructive call confirmable', () => {
    expect(removeConfirmState(true, 'Pages: 3  Chunks: 9')).toBe('confirmable');
    expect(canConfirmRemove(true, 'Pages: 3  Chunks: 9')).toBe(true);
  });
});

describe('the add-source validator — the server guard, client-side', () => {
  test('the guard is exactly the server regex', () => {
    expect(SOURCE_ID.source).toBe('^[a-z0-9][a-z0-9-]{0,62}$');
  });

  test('accepts the same ids the server accepts', () => {
    for (const id of ['a', 'customers', 'team-1', 'a'.repeat(63)]) {
      expect(validSourceId(id)).toBe(true);
    }
  });

  test('rejects the same ids the server rejects', () => {
    for (const id of ['', '-leading', 'Upper', 'has_underscore', 'has space', 'a'.repeat(64)]) {
      expect(validSourceId(id)).toBe(false);
    }
  });

  test('the validator names what is missing, and canAddSource agrees with it', () => {
    expect(addSourceError('', 'Name')).toMatch(/source id is required/i);
    expect(addSourceError('Bad Id', 'Name')).toMatch(/lowercase/i);
    expect(addSourceError('good-id', '')).toMatch(/name is required/i);
    expect(addSourceError('good-id', 'Name')).toBeNull();

    expect(canAddSource('good-id', 'Name')).toBe(true);
    expect(canAddSource('', 'Name')).toBe(false);
    expect(canAddSource('good-id', '')).toBe(false);
  });
});

describe('page counts and sync times never lie about an unlisted source', () => {
  test('a source gbrain does not list is not "0 pages"', () => {
    expect(pageCountText(source({ inGbrain: false, pageCount: null }), true)).toMatch(/not listed/i);
    expect(pageCountText(source({ inGbrain: false, pageCount: null }), true)).not.toContain('0 page');
  });

  test('a failed sources.list is not "0 pages" either', () => {
    expect(pageCountText(source({ inGbrain: true, pageCount: 5 }), false)).toMatch(/not listed/i);
  });

  test('a real 0 and an unknown count read differently', () => {
    expect(pageCountText(source({ pageCount: 0 }), true)).toBe('0 pages');
    expect(pageCountText(source({ pageCount: 1 }), true)).toBe('1 page');
    expect(pageCountText(source({ pageCount: null }), true)).toMatch(/unknown/i);
  });

  test('last sync says never rather than inventing a time', () => {
    expect(lastSyncText(source({ lastSyncAt: null }), true)).toMatch(/never/i);
    expect(lastSyncText(source({ inGbrain: false, lastSyncAt: null }), true)).toMatch(/never/i);
    expect(lastSyncText(source({ lastSyncAt: '2026-09-17T06:12:52.152Z' }), true)).toMatch(/last sync/i);
  });
});

describe('the backfill copy is additive-only', () => {
  test('it says blank types are filled and never reclassified', () => {
    expect(BACKFILL_NOTICE).toMatch(/no type yet/i);
    expect(BACKFILL_NOTICE).toMatch(/never reclassif/i);
    expect(BACKFILL_NOTICE).not.toMatch(/reclassifies existing|overwrites/i);
  });

  test('the isolation notice is the server wording', () => {
    expect(ISOLATION_NOTICE).toMatch(/NOT access boundaries/);
    expect(ISOLATION_NOTICE).toMatch(/its own Source/i);
  });
});

describe('renameSourceError', () => {
  test('a blank name is refused', () => {
    expect(renameSourceError('Customers', '')).toBe('A name is required.');
    expect(renameSourceError('Customers', '   ')).toBe('A name is required.');
  });

  test('an unchanged name is refused, ignoring surrounding whitespace', () => {
    expect(renameSourceError('Customers', 'Customers')).toMatch(/already the name/i);
    expect(renameSourceError('Customers', ' Customers ')).toMatch(/already the name/i);
  });

  test('a different name is accepted', () => {
    expect(renameSourceError('Customers', 'Clients')).toBeNull();
  });
});

describe('slugifySourceId — the one-field New source form', () => {
  test('lowercases and hyphenates, and satisfies the server guard', () => {
    expect(slugifySourceId('Company KB', [])).toBe('company-kb');
    expect(validSourceId(slugifySourceId('  Ünï  Wiki!! ', [])!)).toBe(true);
  });
  test('never collides with an existing id', () => {
    expect(slugifySourceId('Notes', ['notes'])).toBe('notes-2');
    expect(slugifySourceId('Notes', ['notes', 'notes-2'])).toBe('notes-3');
  });
  test('a name with nothing to build an id from is refused', () => {
    expect(slugifySourceId('!!!', [])).toBeNull();
  });
  test('a very long name still yields a valid id', () => {
    expect(validSourceId(slugifySourceId('a'.repeat(200), [])!)).toBe(true);
  });
});

describe('gitStatusText — one honest line', () => {
  test('no remote says so', () => {
    expect(gitStatusText(source())).toBe('No git remote');
  });
  test('a remote whose state could not be read is just connected, not "up to date"', () => {
    expect(gitStatusText(source({ gitRemote: 'https://github.com/a/b.git' }))).toBe('Git connected');
  });
  test('drift is counted, clean is up to date', () => {
    const remote = 'https://github.com/a/b.git';
    expect(gitStatusText(source({ gitRemote: remote, gitStatus: { branch: 'main', uncommittedFiles: 0, unpushedCommits: 0 } })))
      .toBe('Git up to date');
    expect(gitStatusText(source({ gitRemote: remote, gitStatus: { branch: 'main', uncommittedFiles: 2, unpushedCommits: 1 } })))
      .toBe('Git: 2 uncommitted, 1 unpushed');
  });
});

describe('toggleRead — which company Sources the agent reads', () => {
  test('adds or removes one id, keeping order stable', () => {
    expect(toggleRead([], 'a')).toEqual(['a']);
    expect(toggleRead(['a', 'b'], 'a')).toEqual(['b']);
    expect(toggleRead(['b'], 'a')).toEqual(['b', 'a']);
  });
});

describe('builtinDefaultText', () => {
  test('names the page count and says the pages are not in any Space', () => {
    expect(builtinDefaultText(7)).toBe(
      "gbrain's built-in `default` source holds 7 pages that aren't in any Space. They aren't shown in the console.",
    );
    expect(builtinDefaultText(1)).toContain('1 page that');
  });
});

describe('pickAfterReload — a rename must not move the selection', () => {
  const sp = (sourceId: string, name = sourceId): SpaceSummary =>
    ({ id: sourceId, sourceId, name, access: 'write', zone: 'company' });

  test('keeps the current Source, with its fresh name, when it still exists', () => {
    const picked = pickAfterReload([sp('a'), sp('b', 'Renamed')], 'b', null, 'a');
    expect(picked?.name).toBe('Renamed');
  });

  test('re-picks with the first-load rule when the current Source is gone', () => {
    expect(pickAfterReload([sp('a'), sp('c')], 'b', null, 'c')?.sourceId).toBe('c');
    expect(pickAfterReload([sp('a')], 'b', null, null)?.sourceId).toBe('a');
    expect(pickAfterReload([], 'b', null, null)).toBeNull();
  });
});
