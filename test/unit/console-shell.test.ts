import { test, expect, describe } from 'bun:test';
import { sourceNavigation } from '../../src/console/AppShell.tsx';

/**
 * `AppShell`'s URL-sync decision: whether a Source resolution or change
 * should `replace` the address bar, `push` a new entry, or do nothing.
 *
 * This exists because the decision used to live entirely inside two
 * `useEffect`s with untracked refs, and the untracked half of the state
 * (`lastSourceId`) was never updated on the settings-route branch of the
 * first effect. The result: opening `/settings/members` on a cold load
 * resolved the Source, the first effect correctly no-opped (a settings
 * route is not the editor), but `lastSourceId` was left at `null`, so the
 * second effect saw `'my-brain' !== null` and pushed `{kind:'editor'}` a
 * beat later — the settings modal closed itself right after opening. The
 * same gap left `/` cold loads with a duplicate history entry: the `replace`
 * effect and the `push` effect both fired for the same Source. Extracting
 * the decision as this pure function is what makes both cases testable
 * without a DOM.
 */

describe('sourceNavigation: replace, push, or nothing', () => {
  test('still loading: never navigates', () => {
    expect(sourceNavigation({
      loading: true,
      routeKind: 'editor',
      routeSourceId: null,
      resolvedSourceId: 'my-brain',
      reflectedInitial: false,
      lastSourceId: null,
    })).toEqual({ action: 'none' });
  });

  test('a pasted settings URL must not bounce to the editor: settings cold load never navigates', () => {
    // The exact regression: Source resolution finishing while sitting on a
    // settings route used to leave `lastSourceId` stale, so a later render
    // read the resolved id as "changed" and pushed the editor route,
    // closing the modal it had just opened.
    expect(sourceNavigation({
      loading: false,
      routeKind: 'settings',
      routeSourceId: null,
      resolvedSourceId: 'my-brain',
      reflectedInitial: false,
      lastSourceId: null,
    })).toEqual({ action: 'none' });
  });

  test('editor cold load with no Source in the URL: replaces to the resolved Source', () => {
    expect(sourceNavigation({
      loading: false,
      routeKind: 'editor',
      routeSourceId: null,
      resolvedSourceId: 'my-brain',
      reflectedInitial: false,
      lastSourceId: null,
    })).toEqual({ action: 'replace', sourceId: 'my-brain' });
  });

  test('editor cold load where the URL already names the resolved Source: no navigation, no duplicate history entry', () => {
    expect(sourceNavigation({
      loading: false,
      routeKind: 'editor',
      routeSourceId: 'my-brain',
      resolvedSourceId: 'my-brain',
      reflectedInitial: false,
      lastSourceId: null,
    })).toEqual({ action: 'none' });
  });

  test('a real Source switch after the initial reflection: pushes, so back returns to the previous Source', () => {
    expect(sourceNavigation({
      loading: false,
      routeKind: 'editor',
      routeSourceId: 'my-brain',
      resolvedSourceId: 'other-brain',
      reflectedInitial: true,
      lastSourceId: 'my-brain',
    })).toEqual({ action: 'push', sourceId: 'other-brain' });
  });

  test('an unchanged id after initial reflection: no navigation', () => {
    expect(sourceNavigation({
      loading: false,
      routeKind: 'editor',
      routeSourceId: 'my-brain',
      resolvedSourceId: 'my-brain',
      reflectedInitial: true,
      lastSourceId: 'my-brain',
    })).toEqual({ action: 'none' });
  });

  test('claim routes never navigate on Source resolution', () => {
    expect(sourceNavigation({
      loading: false,
      routeKind: 'claim',
      routeSourceId: null,
      resolvedSourceId: 'my-brain',
      reflectedInitial: false,
      lastSourceId: null,
    })).toEqual({ action: 'none' });
  });
});
