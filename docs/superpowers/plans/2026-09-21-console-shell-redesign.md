# Console Shell Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Post-implementation note — where this plan and the shipped code differ

This plan was written before any of the modules below existed, and its embedded code samples
are illustrative sketches, not the final interfaces. Every implementing agent reported following
its task brief and the running test suite over this doc when the two disagreed, which is the
right call — a plan is a starting hypothesis, the code and its tests are the record of what was
actually learned along the way. This section is that record. It is added once, at Task 10, and
is not retroactively kept in sync with the samples below it: read the "as shipped" column and
its module, not the task bodies' `ts`/`tsx` fences, for the true interface.

| Doc sample | As shipped | Authoritative module |
|---|---|---|
| `SETTINGS_TABS: readonly SettingsTab[]` (flat array of ids), `new Set<string>(SETTINGS_TABS)` in `router.ts` | `SETTINGS_TABS: readonly SettingsTabEntry[]`, each entry `{ id, label, minRole }`; `visibleTabs`/`resolveTab` filter on `minRole`, not a hand-kept admin `Set` | `src/console/settings/tabs.ts` |
| `AccountBox({ email, onSignOut, onOpenSettings })` — caller supplies the email and owns sign-out | `AccountBox({ onOpenSettings })` — self-fetches the session via `sessionApi.me()` and calls `sessionApi.signOut()` itself | `src/console/shell/AccountBox.tsx` |
| Expansion persistence as `loadExpanded`/`saveExpanded` inside `files/tree.ts`, keyed `mobrain:tree-expanded:` | A separate module, `readExpanded`/`writeExpanded`/`pruneExpanded`, keyed `mobrain:console:expanded:` — kept out of `files/tree.ts` deliberately, so that module stays pure and DOM-free | `src/console/files/expanded.ts` |
| `SettingsModal`/`SettingsPanel` merged into one component taking `{ tab, isAdmin, onClose, onSelectTab }`; no exported decision functions | Split: `SettingsModal` is shell mechanics only (`{ label, onClose, children }`), `SettingsPanel` mounts the tab nav and lazy pages; `SettingsModal` exports two pure decision functions, `shouldCloseOnEscape` and `shouldCloseOnBackdropClick` | `src/console/settings/SettingsModal.tsx`, `src/console/settings/SettingsPanel.tsx` |
| CSS: `.sidebar-row`, `.tree-row`, `.settings-card`, `.settings-layout`, `.settings-close` | `.account-box`, `.source-switcher`, `.file-tree`, `.settings-backdrop`, `.settings-modal`, `.settings-page-header`, `.settings-body` | `src/console/styles.css` |
| `SourceProvider({ spaces, fromUrl, onNavigate, children })` — spaces passed in, navigation via callback | `SourceProvider({ fromUrl, children })` — fetches `filesApi.list()` itself; `AppShell` reacts to `setCurrent`/`current` rather than being called back through `onNavigate` | `src/console/SourceContext.tsx` |
| Test file `test/unit/console-source-context.test.ts` | `test/unit/console-source.test.ts` | — |

None of this changes what shipped or what the tests assert; it exists so a reader of this plan
does not mistake a first-draft sketch for the interface the console actually runs.

**Goal:** Turn the console's editor from one of eleven flat nav items into the landing screen —
a file tree plus an editor pane driven by one app-wide Source selection — and move every
administrative page (Sources, Schema, Members, Access, Schedules, Health, Spend, Runs, Upgrades)
behind a single settings modal reachable by URL.

**Architecture:** Three new leaf/pure modules carry the decisions so they stay unit-testable
without a DOM, exactly as `App.tsx:phaseFor` and `Files.tsx`'s twenty-odd helpers already do:
(1) `router.ts` owns URL parse/format/redirect, with `popstate`/`pushState` isolated to its one
hook; (2) `settings/tabs.ts` owns the tab registry and role filtering as a leaf module the router
can import type-only without pulling in any lazy-loaded page; (3) `files/tree.ts` owns turning
`gitTree`'s flat, sorted file list into a collapsible folder tree. `App.tsx` shrinks to a phase
gate; `AppShell.tsx` is new and owns the sidebar/main split. `Files.tsx` is deleted, its render
split into `shell/FileTree.tsx` (the tree) and `pages/Editor.tsx` (the right column), its pure
helpers moving with their behaviour, unchanged.

**Tech Stack:** Bun, TypeScript, React 19 + Tailwind 4 (console), `bun test`, CodeMirror 6 (the
vendored `src/console/editor/vendor/baalda/` port).

**Spec:** `docs/superpowers/specs/2026-09-21-console-shell-redesign-design.md` — the design this
plan implements. Read it first: it records the exact file:line citations for what changes and
why, and states out loud which obvious alternatives (an empty-folder placeholder, a locked
non-admin tab, `localeCompare` sorting) are wrong and why.

## Global Constraints

- **No backend change, anywhere, in any task.** Every route, table and ops contract this plan
  touches is read-only from the console's side. `gitTree` (`src/ops/git.ts:375-390`) and
  `src/control/routes/files.ts` are consumed exactly as they exist today.
- **Every pure decision is a named, exported function, tested without a DOM.** This repo has no
  DOM test harness (`test/unit/console-files.test.ts`'s own header states it). A decision or a
  piece of operator-facing copy that only exists inside JSX is untested by construction — it
  does not go in JSX first.
- **Moved code is moved, not rewritten.** Tasks 3 and 7 relocate `Files.tsx` helpers and its
  save/reload logic into new files. Their existing behaviour and existing test assertions travel
  with them; do not "improve" wording or gating logic as a side effect of moving it — that is a
  separate change with its own review.
- **`localStorage` reads and writes are wrapped, never trusted.** A private window, a blocked
  origin, or a first-ever visit all mean "read nothing, write nothing, do not throw." Every
  `localStorage` touch in this plan (Source memory, tree expansion state) goes through a
  try/catch that treats failure as "no preference," matching how `pickSource` (Task 4) treats a
  stale remembered Source.
- **Sort order is code-unit, never `localeCompare`.** `Files.tsx:36-38`'s `comparePaths` already
  states why — stability across browsers and locales — and `files/tree.ts` (Task 3) keeps that
  rule, now applied per directory level.
- **Do not touch `src/console/editor/vendor/baalda/`.** It is a pinned vendor port
  (`c08bbf287cde6ecbb45501b703a925029309674b`); this plan's `pages/Editor.tsx` consumes
  `mountMarkdownEditor()` through the public `src/console/editor/index.ts` surface only.

---

## File Structure

**Created:**
- `src/console/router.ts` — `Route` union, `parseRoute`, `routeToPath`, `legacyRedirect`,
  `useRoute()`.
- `src/console/settings/tabs.ts` — `SettingsTab` union, ordered tab registry, `visibleTabs`.
- `src/console/files/tree.ts` — `TreeItem`, `buildTree`, `flattenTree`, `toggleExpanded`, plus
  the pure helpers moved from `Files.tsx` per Task 3.
- `src/console/SourceContext.tsx` — `pickSource`, `SourceProvider`, `useSource()`.
- `src/console/settings/SettingsModal.tsx` — portal, backdrop, Esc, click-away, focus restore.
- `src/console/settings/SettingsPanel.tsx` — tab nav + lazy-loaded page host.
- `src/console/shell/AccountBox.tsx` — email, sign out, settings button.
- `src/console/shell/SourceSwitcher.tsx` — the app-wide Source picker.
- `src/console/shell/FileTree.tsx` — collapsible tree rows.
- `src/console/pages/Editor.tsx` — the editor pane, carved out of `Files.tsx`'s right column.
- `src/console/AppShell.tsx` — the sidebar/main split, route-driven.
- `test/unit/console-router.test.ts`
- `test/unit/console-tree.test.ts`
- `test/unit/console-settings-tabs.test.ts`
- `test/unit/console-source-context.test.ts`

**Modified:**
- `src/console/App.tsx` — shrinks to the phase gate; `phaseFor` (`App.tsx:46-54`) and the `Phase`
  type (`App.tsx:19`) kept verbatim; nav (`App.tsx:119-136`) and page switch
  (`App.tsx:138-148`) deleted; `isAdmin` threaded from the wizard probe's 403 branch.
- `src/console/api.ts` — add `sessionApi.signOut()`; fix the stale `routes/spaces.ts` citation
  and the stale "read-only" claim at `api.ts:72-78`.
- `src/console/styles.css` — add `.shell`, `.sidebar`, `.sidebar-row`, `.tree-row`,
  `.settings-*` primitives; palette (`styles.css:3-16`) untouched.
- `test/unit/console-app.test.ts` — cold-load-route block (lines 50-66) removed in favor of
  `console-router.test.ts`; `phaseFor` block (lines 14-48) untouched.
- `test/unit/console-files.test.ts` — imports retargeted to `files/tree.ts` /
  `pages/Editor.tsx`; `treeToNodes` cases replaced by `buildTree`/`flattenTree` cases.
- `docs/product-overview.md` — §4.3 (lines 113-127) updated to the new routes and to "Source."

**Deleted:**
- `src/console/pages/Files.tsx` — fully absorbed into `files/tree.ts`, `shell/FileTree.tsx`, and
  `pages/Editor.tsx`.

---

### Task 1: `router.ts` — parse, format, legacy redirects

Pure parse/format, no DOM, no React import in the parse/format functions themselves.

**Files:**
- Create: `src/console/router.ts`
- Create: `test/unit/console-router.test.ts`

**Interfaces:**
- Consumes: `SettingsTab` from `settings/tabs.ts` (Task 2) — type-only, so this task can be
  written first against a local placeholder union and re-pointed once Task 2 lands, OR done after
  Task 2. This plan orders it first because `parseRoute`'s shape is the thing every later task
  depends on; the placeholder union costs one line to delete.
- Produces: `Route`, `parseRoute(pathname: string): Route`, `routeToPath(route: Route): string`,
  `legacyRedirect(pathname: string): string | null`, `useRoute(): [Route, (r: Route) => void]`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/console-router.test.ts`:

```ts
import { test, expect, describe } from 'bun:test';
import { parseRoute, routeToPath, legacyRedirect } from '../../src/console/router.ts';

describe('parseRoute', () => {
  test('root with no Source chosen yet', () => {
    expect(parseRoute('/')).toEqual({ kind: 'editor', sourceId: null, path: null });
  });

  test('a Source with no file open', () => {
    expect(parseRoute('/s/my-brain')).toEqual({ kind: 'editor', sourceId: 'my-brain', path: null });
  });

  test('a Source with a nested file path, slashes preserved', () => {
    expect(parseRoute('/s/my-brain/product/specs/auth.md'))
      .toEqual({ kind: 'editor', sourceId: 'my-brain', path: 'product/specs/auth.md' });
  });

  test('a settings tab', () => {
    expect(parseRoute('/settings/members')).toEqual({ kind: 'settings', tab: 'members' });
  });

  test('a claim token', () => {
    expect(parseRoute('/claim/abc123')).toEqual({ kind: 'claim', token: 'abc123' });
  });

  test('an unrecognised settings tab falls back to the editor root rather than throwing', () => {
    expect(parseRoute('/settings/nope')).toEqual({ kind: 'editor', sourceId: null, path: null });
  });
});

describe('routeToPath is parseRoute\'s inverse', () => {
  test('round-trips every kind', () => {
    const routes = [
      { kind: 'editor' as const, sourceId: null, path: null },
      { kind: 'editor' as const, sourceId: 'my-brain', path: null },
      { kind: 'editor' as const, sourceId: 'my-brain', path: 'product/specs/auth.md' },
      { kind: 'settings' as const, tab: 'members' as const },
    ];
    for (const r of routes) expect(parseRoute(routeToPath(r))).toEqual(r);
  });
});

describe('legacyRedirect — bookmarked cold-load routes survive', () => {
  test('the five admin pages redirect into settings', () => {
    expect(legacyRedirect('/sources')).toBe('/settings/sources');
    expect(legacyRedirect('/schedules')).toBe('/settings/schedules');
    expect(legacyRedirect('/runs')).toBe('/settings/runs');
    expect(legacyRedirect('/spend')).toBe('/settings/spend');
    expect(legacyRedirect('/upgrades')).toBe('/settings/upgrades');
  });

  test('a trailing slash is the same route', () => {
    expect(legacyRedirect('/sources/')).toBe('/settings/sources');
  });

  test('/files redirects to the editor root, not to a settings tab', () => {
    expect(legacyRedirect('/files')).toBe('/');
  });

  test('a route that needs no redirect answers null', () => {
    expect(legacyRedirect('/s/my-brain')).toBeNull();
    expect(legacyRedirect('/settings/members')).toBeNull();
  });

  test('the bookmark property parseRoute alone cannot give: /settings/sources parses AND /sources still lands there', () => {
    expect(parseRoute('/settings/sources')).toEqual({ kind: 'settings', tab: 'sources' });
    expect(legacyRedirect('/sources')).toBe(routeToPath(parseRoute('/settings/sources')));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/console-router.test.ts`
Expected: FAIL — `Cannot find module '../../src/console/router.ts'` (the file does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/console/router.ts`:

```ts
import { type SettingsTab, SETTINGS_TABS } from './settings/tabs.ts';

/**
 * The SPA's real routes. `router.ts` replaces the old `pageFromPath`
 * (`App.tsx:63-72`), which was read once at mount and never written back —
 * clicking a nav item never touched `window.location`, so the URL and the
 * back button were inert once the app was up. This module fixes that: parse
 * and format are pure so they are testable without a DOM, and only the
 * `useRoute()` hook touches `popstate` / `pushState`.
 */
export type Route =
  | { kind: 'editor'; sourceId: string | null; path: string | null }
  | { kind: 'settings'; tab: SettingsTab }
  | { kind: 'claim'; token: string };

const SETTINGS_TAB_SET = new Set<string>(SETTINGS_TABS);

function trimSlashes(pathname: string): string {
  return pathname.replace(/\/+$/, '');
}

export function parseRoute(pathname: string): Route {
  const path = trimSlashes(pathname);
  const claim = path.match(/^\/claim\/([^/]+)/);
  if (claim?.[1]) return { kind: 'claim', token: decodeURIComponent(claim[1]) };

  const settings = path.match(/^\/settings\/([^/]+)$/);
  if (settings?.[1] && SETTINGS_TAB_SET.has(settings[1])) {
    return { kind: 'settings', tab: settings[1] as SettingsTab };
  }
  // An unrecognised or missing tab is not an error state worth its own screen:
  // it falls back to the editor root, same as a cold link to a removed tab.
  if (path === '/settings' || settings) return { kind: 'editor', sourceId: null, path: null };

  const withPath = path.match(/^\/s\/([^/]+)\/(.+)$/);
  if (withPath) {
    return {
      kind: 'editor',
      sourceId: decodeURIComponent(withPath[1]!),
      path: withPath[2]!.split('/').map(decodeURIComponent).join('/'),
    };
  }
  const sourceOnly = path.match(/^\/s\/([^/]+)$/);
  if (sourceOnly) return { kind: 'editor', sourceId: decodeURIComponent(sourceOnly[1]!), path: null };

  return { kind: 'editor', sourceId: null, path: null };
}

export function routeToPath(route: Route): string {
  if (route.kind === 'claim') return `/claim/${encodeURIComponent(route.token)}`;
  if (route.kind === 'settings') return `/settings/${route.tab}`;
  if (route.sourceId === null) return '/';
  if (route.path === null) return `/s/${encodeURIComponent(route.sourceId)}`;
  return `/s/${encodeURIComponent(route.sourceId)}/${route.path.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Every cold-load route `pageFromPath` (`App.tsx:63-72`) used to serve
 * directly, now mapped into the shell's URLs. REQUIRED, not cosmetic:
 * `/sources`, `/schedules`, `/runs`, `/spend`, `/upgrades` and `/files` are
 * live routes today (`test/unit/console-app.test.ts:51-61`) and somebody has
 * at least one bookmarked. Returns `null` when the path needs no redirect.
 */
export function legacyRedirect(pathname: string): string | null {
  const path = trimSlashes(pathname);
  const admin: Record<string, SettingsTab> = {
    '/sources': 'sources', '/schedules': 'schedules', '/runs': 'runs',
    '/spend': 'spend', '/upgrades': 'upgrades',
  };
  if (path in admin) return `/settings/${admin[path]}`;
  if (path === '/files') return '/';
  return null;
}
```

`useRoute()` (the `popstate`/`pushState` hook) is added alongside these in the same file at
Task 8, once `AppShell` exists to consume it — adding it now would be an unused export with no
caller, which this plan's TDD steps have nothing to assert against yet.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/console-router.test.ts`
Expected: PASS. (This step will itself fail until Task 2's `settings/tabs.ts` exists, since
`router.ts` imports `SETTINGS_TABS` from it — see the note in Step 3; if doing Task 1 strictly
before Task 2, stub `settings/tabs.ts` with just the union and `SETTINGS_TABS` array first, or
reorder and do Task 2 before Task 1's Step 3/4.)

- [ ] **Step 5: Commit**

```bash
git add src/console/router.ts test/unit/console-router.test.ts
git commit -m "$(cat <<'EOF'
feat(console): a real router, so the URL and the back button are no longer inert

pageFromPath (App.tsx:63-72) was read once at mount and never written back —
clicking a nav item never touched window.location. router.ts replaces it with
pure parse/format plus legacy redirects for the five bookmarked admin routes
and /files, so a cold link into the old shell still lands somewhere real.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `settings/tabs.ts` — the tab registry and role filtering

**Files:**
- Create: `src/console/settings/tabs.ts`
- Create: `test/unit/console-settings-tabs.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SettingsTab`, `SETTINGS_TABS: readonly SettingsTab[]` (registry order, admin tabs
  first per the design doc's table), `visibleTabs(isAdmin: boolean): SettingsTab[]`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/console-settings-tabs.test.ts`:

```ts
import { test, expect } from 'bun:test';
import { SETTINGS_TABS, visibleTabs } from '../../src/console/settings/tabs.ts';

test('the registry lists all nine tabs, in the design doc\'s table order', () => {
  expect(SETTINGS_TABS).toEqual([
    'sources', 'schema', 'members', 'access', 'schedules', 'health', 'spend', 'runs', 'upgrades',
  ]);
});

test('an admin sees every tab', () => {
  expect(visibleTabs(true)).toEqual([...SETTINGS_TABS]);
});

test('a non-admin sees exactly the four viewer-role tabs, in registry order', () => {
  expect(visibleTabs(false)).toEqual(['schedules', 'health', 'runs', 'upgrades']);
});

test('a non-admin never sees an admin-only tab', () => {
  const admin = ['sources', 'schema', 'members', 'access', 'spend'];
  for (const tab of admin) expect(visibleTabs(false)).not.toContain(tab);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/console-settings-tabs.test.ts`
Expected: FAIL — `Cannot find module '../../src/console/settings/tabs.ts'`.

- [ ] **Step 3: Write the implementation**

Create `src/console/settings/tabs.ts`:

```ts
/**
 * A leaf module — no React import, no page import. `router.ts` needs this
 * union at parse time; having the router import a lazy-loaded settings page
 * even type-only is an import cycle waiting to happen. Mirrors upstream
 * baalda's `lib/settingsTabs.ts` for the same reason.
 */
export type SettingsTab =
  | 'sources' | 'schema' | 'members' | 'access' | 'schedules'
  | 'health' | 'spend' | 'runs' | 'upgrades';

/** Registry order = display order in the settings nav. */
export const SETTINGS_TABS: readonly SettingsTab[] = [
  'sources', 'schema', 'members', 'access', 'schedules', 'health', 'spend', 'runs', 'upgrades',
];

/** Sources, Schema, Members, Access, Spend require the admin role — the same
 *  signal App.tsx's phaseFor already draws from the wizard probe's 403. */
const ADMIN_ONLY: ReadonlySet<SettingsTab> = new Set(['sources', 'schema', 'members', 'access', 'spend']);

/**
 * Non-admin tabs are HIDDEN, not locked: there is no disabled/greyed state to
 * design for, because a member never sees the tab exists.
 */
export function visibleTabs(isAdmin: boolean): SettingsTab[] {
  return SETTINGS_TABS.filter((tab) => isAdmin || !ADMIN_ONLY.has(tab));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/console-settings-tabs.test.ts test/unit/console-router.test.ts`
Expected: PASS for both (this also unblocks Task 1's Step 4).

- [ ] **Step 5: Commit**

```bash
git add src/console/settings/tabs.ts test/unit/console-settings-tabs.test.ts
git commit -m "$(cat <<'EOF'
feat(console): settings tab registry, admin tabs hidden not locked for members

A leaf module on purpose: router.ts needs the SettingsTab union without
pulling any lazy-loaded settings page into an import cycle. visibleTabs reuses
the same admin signal phaseFor already draws from the wizard probe's 403 —
no new endpoint, no new column.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `files/tree.ts` — collapsible folders, and the moved helpers

**Files:**
- Create: `src/console/files/tree.ts`
- Modify: `test/unit/console-files.test.ts` (retarget imports; replace `treeToNodes` cases)
- Modify: `src/console/pages/Files.tsx` (helpers removed here; the file itself is deleted at
  Task 10, once `pages/Editor.tsx` exists to take over its render — leaving the removed helpers'
  call sites intact via a temporary re-export is NOT worth the churn given Task 10 lands soon
  after; instead this task copies the helpers into `files/tree.ts` and leaves `Files.tsx`'s own
  copies in place until Task 10 deletes the whole file. `console-files.test.ts` is repointed to
  the new module in this task so the test suite never asserts against two copies at once.)

**Interfaces:**
- Consumes: `FileEntry` from `api.ts` (`api.ts:81`).
- Produces: `TreeItem`, `buildTree(entries: FileEntry[]): TreeItem[]`,
  `flattenTree(items: TreeItem[], expanded: ReadonlySet<string>): Row[]`,
  `toggleExpanded(expanded: ReadonlySet<string>, path: string): Set<string>`, plus `fileKind`,
  `baseName`, `pathDepth`, `indentFor`, `canEdit`, `isDirty`, `staleNotice`, `saveButtonLabel`,
  `bypassVisible`, `errorText`, `accessNotice`, `BYPASS_NOTICE`, moved verbatim from `Files.tsx`.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/console-files.test.ts` (new `describe` blocks; the file's existing imports at
lines 1-10 are retargeted to `files/tree.ts` in Step 3 below, alongside these additions):

```ts
import { buildTree, flattenTree, toggleExpanded, type TreeItem } from '../../src/console/files/tree.ts';

describe('buildTree — synthesizing folders from a flat, files-only list', () => {
  test('folders sort before files at each level; within a group, code-unit order', () => {
    const tree = buildTree([
      entry('roadmap.md'), entry('product/specs/auth.md'), entry('product/README.md'),
      entry('notes/README.md'),
    ]);
    expect(tree.map((n) => n.kind === 'folder' ? n.name : n.name))
      .toEqual(['notes', 'product', 'roadmap.md']);
  });

  test('an empty folder cannot appear: the backend walk never emits a directory entry', () => {
    // No entry() call names a bare directory — buildTree has nothing to
    // synthesize a folder node from. This is deliberate, not a gap: see the
    // design doc's "empty and error states" table.
    const tree = buildTree([entry('a/b.md')]);
    const folder = tree.find((n) => n.kind === 'folder') as Extract<TreeItem, { kind: 'folder' }>;
    expect(folder.children).toHaveLength(1);
    expect(folder.children[0]!.kind).toBe('file');
  });

  test('nested depth is preserved through multiple folder levels', () => {
    const tree = buildTree([entry('product/specs/auth.md')]);
    const product = tree[0] as Extract<TreeItem, { kind: 'folder' }>;
    const specs = product.children[0] as Extract<TreeItem, { kind: 'folder' }>;
    expect(product.name).toBe('product');
    expect(specs.name).toBe('specs');
    expect(specs.children[0]!.name).toBe('auth.md');
  });
});

describe('flattenTree — the visible rows for a given expansion state', () => {
  test('a collapsed folder hides its children', () => {
    const tree = buildTree([entry('product/specs/auth.md'), entry('roadmap.md')]);
    const rows = flattenTree(tree, new Set());
    expect(rows.map((r) => r.name)).toEqual(['product', 'roadmap.md']);
  });

  test('expanding a folder reveals its direct children only', () => {
    const tree = buildTree([entry('product/specs/auth.md'), entry('roadmap.md')]);
    const rows = flattenTree(tree, new Set(['product']));
    expect(rows.map((r) => r.name)).toEqual(['product', 'specs', 'roadmap.md']);
  });
});

describe('toggleExpanded', () => {
  test('toggling an unexpanded path expands it, and back again', () => {
    const first = toggleExpanded(new Set(), 'product');
    expect(first.has('product')).toBe(true);
    const second = toggleExpanded(first, 'product');
    expect(second.has('product')).toBe(false);
  });

  test('never mutates the input set', () => {
    const original = new Set(['product']);
    toggleExpanded(original, 'notes');
    expect(original.has('notes')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/console-files.test.ts`
Expected: FAIL — `Cannot find module '../../src/console/files/tree.ts'`.

- [ ] **Step 3: Write the implementation**

Create `src/console/files/tree.ts` by copying, verbatim, these blocks from `src/console/pages/Files.tsx`:
`fileKind` (`Files.tsx:22-25`), the `comparePaths` helper (`Files.tsx:36-38`), `baseName`
(`Files.tsx:41-44`), `pathDepth` (`Files.tsx:47-49`), `accessNotice` (`Files.tsx:77-81`),
`BYPASS_NOTICE` (`Files.tsx:88-89`), `errorText` (`Files.tsx:98-102`), `indentFor`
(`Files.tsx:105-107`), `canEdit` (`Files.tsx:118-120`), `saveButtonLabel` (`Files.tsx:128-130`),
`staleNotice` (`Files.tsx:150-154`), `bypassVisible` (`Files.tsx:158-160`), `isDirty`
(`Files.tsx:163-165`) — same names, same bodies, same doc comments. Then add:

```ts
import type { FileEntry } from '../api.ts';

export type FileKind = 'markdown' | 'other';

export type TreeItem =
  | { kind: 'folder'; path: string; name: string; children: TreeItem[] }
  | { kind: 'file'; path: string; name: string; fileKind: FileKind };

/**
 * `gitTree` (src/ops/git.ts:375-390) emits FILES ONLY, sorted, `.git/`
 * excluded — no directory entry ever appears. This synthesizes folder nodes
 * from the path segments; a folder with zero files is therefore never
 * synthesized, because nothing in `entries` names it. That is upstream
 * behaviour, not a bug in this layer.
 */
export function buildTree(entries: FileEntry[]): TreeItem[] {
  const root: TreeItem[] = [];
  const folders = new Map<string, Extract<TreeItem, { kind: 'folder' }>>();

  const sorted = [...entries].sort((a, b) => comparePaths(a.path, b.path));
  for (const entry of sorted) {
    const segments = entry.path.split('/');
    let siblings = root;
    let prefix = '';
    for (let i = 0; i < segments.length - 1; i++) {
      prefix = prefix === '' ? segments[i]! : `${prefix}/${segments[i]}`;
      let folder = folders.get(prefix);
      if (!folder) {
        folder = { kind: 'folder', path: prefix, name: segments[i]!, children: [] };
        folders.set(prefix, folder);
        siblings.push(folder);
      }
      siblings = folder.children;
    }
    siblings.push({ kind: 'file', path: entry.path, name: baseName(entry.path), fileKind: fileKind(entry.path) });
  }
  return sortTree(root);
}

/** Folders before files at each level; within a group, code-unit order —
 *  never localeCompare (Files.tsx:35-38's own rule, stable across browsers
 *  and locales). Applied recursively so every level is sorted, not just root. */
function sortTree(items: TreeItem[]): TreeItem[] {
  const sorted = [...items].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return comparePaths(a.path, b.path);
  });
  for (const item of sorted) if (item.kind === 'folder') item.children = sortTree(item.children);
  return sorted;
}

export type Row = { path: string; name: string; depth: number; kind: 'folder' | 'file'; fileKind?: FileKind; expanded?: boolean };

/** The rows a sidebar actually paints, given which folders are open. */
export function flattenTree(items: TreeItem[], expanded: ReadonlySet<string>, depth = 0): Row[] {
  const rows: Row[] = [];
  for (const item of items) {
    if (item.kind === 'folder') {
      rows.push({ path: item.path, name: item.name, depth, kind: 'folder', expanded: expanded.has(item.path) });
      if (expanded.has(item.path)) rows.push(...flattenTree(item.children, expanded, depth + 1));
    } else {
      rows.push({ path: item.path, name: item.name, depth, kind: 'file', fileKind: item.fileKind });
    }
  }
  return rows;
}

/** Never mutates its input — callers hold the previous Set in React state. */
export function toggleExpanded(expanded: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(expanded);
  if (next.has(path)) next.delete(path); else next.add(path);
  return next;
}

const TREE_STORAGE_PREFIX = 'mobrain:tree-expanded:';

/** Wrapped, never trusted: a private window or a blocked origin means "no
 *  preference," never a throw. A remembered path absent from the current
 *  entries is dropped silently rather than surfaced as an error. */
export function loadExpanded(sourceId: string, entries: FileEntry[]): Set<string> {
  try {
    const raw = localStorage.getItem(TREE_STORAGE_PREFIX + sourceId);
    if (!raw) return new Set();
    const known = new Set(entries.map((e) => e.path));
    const saved: string[] = JSON.parse(raw);
    return new Set(saved.filter((p) => [...known].some((k) => k.startsWith(p))));
  } catch {
    return new Set();
  }
}

export function saveExpanded(sourceId: string, expanded: ReadonlySet<string>): void {
  try { localStorage.setItem(TREE_STORAGE_PREFIX + sourceId, JSON.stringify([...expanded])); }
  catch { /* private window, quota, or a blocked origin — losing this preference is fine */ }
}
```

Then, in `test/unit/console-files.test.ts`, retarget the import block (lines 1-10) so
`fileKind`, `accessNotice`, `errorText`, `canEdit`, `saveButtonLabel`, `staleNotice`,
`bypassVisible`, `isDirty`, `BYPASS_NOTICE`, `baseName`, `pathDepth`, `indentFor` come from
`../../src/console/files/tree.ts` instead of `../../src/console/pages/Files.tsx`, and remove the
`treeToNodes` import and its `describe` block (`treeToNodes` is superseded by
`buildTree`/`flattenTree`, already covered by the new blocks added in Step 1).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/console-files.test.ts`
Expected: PASS, all cases including the moved-helper assertions that predate this task.

- [ ] **Step 5: Commit**

```bash
git add src/console/files/tree.ts test/unit/console-files.test.ts
git commit -m "$(cat <<'EOF'
feat(console): real collapsible folders, built client-side from gitTree's flat list

gitTree emits files only, sorted, .git/ excluded — buildTree synthesizes
folder nodes from the path segments, so an empty folder is invisible by
construction (upstream behaviour, not a bug). Folders sort before files at
each level, code-unit order throughout, matching Files.tsx's existing
comparePaths rule. The save/access/dirty helpers move here unchanged, ahead
of Files.tsx's deletion in Task 10.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `SourceContext.tsx` — `pickSource`, then the provider

**Files:**
- Create: `src/console/SourceContext.tsx`
- Create: `test/unit/console-source-context.test.ts`

**Interfaces:**
- Consumes: `SpaceSummary` from `api.ts` (`api.ts:80`).
- Produces: `pickSource(spaces, fromUrl, remembered): SpaceSummary | null`, `SourceProvider`,
  `useSource(): { current: SpaceSummary | null; spaces: SpaceSummary[]; setCurrent: (id: string) => void }`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/console-source-context.test.ts`:

```ts
import { test, expect, describe } from 'bun:test';
import { pickSource } from '../../src/console/SourceContext.tsx';
import type { SpaceSummary } from '../../src/console/api.ts';

const space = (sourceId: string): SpaceSummary => ({ id: sourceId, sourceId, name: sourceId, access: 'write' });

describe('pickSource — URL wins, then localStorage, then first, then null', () => {
  const spaces = [space('a'), space('b')];

  test('the URL Source wins even over a remembered one', () => {
    expect(pickSource(spaces, 'b', 'a')).toEqual(space('b'));
  });

  test('a remembered Source is used when the URL names none', () => {
    expect(pickSource(spaces, null, 'b')).toEqual(space('b'));
  });

  test('the first Source is used when neither the URL nor localStorage says', () => {
    expect(pickSource(spaces, null, null)).toEqual(space('a'));
  });

  test('a stale remembered Source (archived, or DELETEd) is discarded without error', () => {
    expect(pickSource(spaces, null, 'gone')).toEqual(space('a'));
  });

  test('an unknown URL Source falls through to the remembered one', () => {
    expect(pickSource(spaces, 'gone', 'b')).toEqual(space('b'));
  });

  test('zero Sources is null, not a throw', () => {
    expect(pickSource([], null, null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/console-source-context.test.ts`
Expected: FAIL — `Cannot find module '../../src/console/SourceContext.tsx'`.

- [ ] **Step 3: Write the implementation**

Create `src/console/SourceContext.tsx`:

```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { SpaceSummary } from './api.ts';

const REMEMBERED_KEY = 'mobrain:current-source';

/**
 * The single biggest gap the old shell had: Files.tsx:181 held sourceId in a
 * local useState that died on every page switch, and no other page shared it.
 * Resolution order, as a pure function so it is testable without mounting
 * anything: URL wins, then localStorage, then the first entry, then null. A
 * remembered Source no longer in the list — archived, or removed via
 * DELETE /api/sources/:id — is discarded without an error: a stale
 * preference, not a failure.
 */
export function pickSource(
  spaces: SpaceSummary[],
  fromUrl: string | null,
  remembered: string | null,
): SpaceSummary | null {
  if (fromUrl !== null) {
    const found = spaces.find((s) => s.sourceId === fromUrl);
    if (found) return found;
  }
  if (remembered !== null) {
    const found = spaces.find((s) => s.sourceId === remembered);
    if (found) return found;
  }
  return spaces[0] ?? null;
}

function rememberSource(sourceId: string): void {
  try { localStorage.setItem(REMEMBERED_KEY, sourceId); } catch { /* no preference kept */ }
}

function readRemembered(): string | null {
  try { return localStorage.getItem(REMEMBERED_KEY); } catch { return null; }
}

type SourceCtx = {
  current: SpaceSummary | null;
  spaces: SpaceSummary[];
  setCurrent: (sourceId: string) => void;
};

const Ctx = createContext<SourceCtx | null>(null);

export function SourceProvider({
  spaces, fromUrl, onNavigate, children,
}: {
  spaces: SpaceSummary[];
  fromUrl: string | null;
  onNavigate: (sourceId: string) => void;
  children: ReactNode;
}) {
  const [currentId, setCurrentId] = useState<string | null>(
    () => pickSource(spaces, fromUrl, readRemembered())?.sourceId ?? null,
  );

  useEffect(() => {
    const picked = pickSource(spaces, fromUrl, readRemembered());
    setCurrentId(picked?.sourceId ?? null);
  }, [spaces, fromUrl]);

  const setCurrent = (sourceId: string) => {
    rememberSource(sourceId);
    setCurrentId(sourceId);
    onNavigate(sourceId);
  };

  const current = spaces.find((s) => s.sourceId === currentId) ?? null;
  return <Ctx.Provider value={{ current, spaces, setCurrent }}>{children}</Ctx.Provider>;
}

export function useSource(): SourceCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSource() called outside <SourceProvider>');
  return ctx;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/console-source-context.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/console/SourceContext.tsx test/unit/console-source-context.test.ts
git commit -m "$(cat <<'EOF'
feat(console): one app-wide Source selection, owned once instead of per-page

Files.tsx:181 held sourceId in a local useState that died on every page
switch, and no other page shared it. pickSource resolves URL, then
localStorage, then the first Source, then null — a stale remembered Source
(archived or DELETEd) is discarded quietly, never surfaced as an error.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `settings/SettingsModal.tsx` + `SettingsPanel.tsx` — mounting the nine pages, lazily

**Files:**
- Create: `src/console/settings/SettingsModal.tsx`
- Create: `src/console/settings/SettingsPanel.tsx`

**Interfaces:**
- Consumes: `visibleTabs`, `SettingsTab` (Task 2).
- Produces: `<SettingsModal tab={SettingsTab} isAdmin={boolean} onClose={() => void} onSelectTab={(t: SettingsTab) => void} />`.

This task has no new pure-function surface — the modal's testable behaviour (Esc precedence,
click-away requiring press-and-release on the backdrop, focus restore) is DOM interaction the
repo's existing test setup cannot exercise (no DOM harness, per Global Constraints), so it is
verified in the manual pass of the plan's Verification section rather than with a `bun test`
step here. Prose the modal renders (tab labels) is already covered by Task 2's registry test.

- [ ] **Step 1: Write `SettingsModal.tsx`**

```tsx
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { SettingsPanel } from './SettingsPanel.tsx';
import type { SettingsTab } from './tabs.ts';

/**
 * Ported from upstream baalda's VaultSettingsDialog.tsx, which documents each
 * mechanic's reason — kept here for the same reasons:
 *  - portalled to <body>: opened from a sidebar leaf, and a fixed backdrop
 *    rendered inside that subtree is one ancestor transform away from being
 *    clipped to a sidebar-sized box.
 *  - click-away requires press AND release on the backdrop, so selecting text
 *    in a field and releasing outside does not close settings.
 *  - Esc defers to anything stacked above it (.modal-backdrop, .context-menu)
 *    — Sources.tsx and Runs.tsx both render their own confirm dialogs.
 *  - opacity-only animation: a settled transform would make the card a
 *    containing block and trap those confirms' position: fixed.
 */
export function SettingsModal({
  tab, isAdmin, onClose, onSelectTab,
}: {
  tab: SettingsTab;
  isAdmin: boolean;
  onClose: () => void;
  onSelectTab: (t: SettingsTab) => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<Element | null>(null);
  const pressedOnBackdrop = useRef(false);

  useEffect(() => {
    openerRef.current = document.activeElement;
    closeRef.current?.focus();
    return () => { (openerRef.current as HTMLElement | null)?.focus?.(); };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('.modal-backdrop:last-of-type') !== backdropRef.current) return;
      if (document.querySelector('.context-menu')) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const backdropRef = useRef<HTMLDivElement | null>(null);

  return createPortal(
    <div
      ref={backdropRef}
      className="modal-backdrop settings-backdrop"
      onMouseDown={(e) => { pressedOnBackdrop.current = e.target === e.currentTarget; }}
      onMouseUp={(e) => { if (pressedOnBackdrop.current && e.target === e.currentTarget) onClose(); }}
    >
      <div className="settings-card card" role="dialog" aria-modal="true">
        <button ref={closeRef} className="nav-item settings-close" onClick={onClose} aria-label="Close settings">
          Close
        </button>
        <SettingsPanel tab={tab} isAdmin={isAdmin} onSelectTab={onSelectTab} />
      </div>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 2: Write `SettingsPanel.tsx`**

```tsx
import { lazy, Suspense } from 'react';
import { visibleTabs, type SettingsTab } from './tabs.ts';

// lazy(): Schedules.tsx (1,487 lines) and Runs.tsx (1,026 lines) are ~40% of
// the console's page code; none of it belongs in the shell's first paint.
const PAGES: Record<SettingsTab, ReturnType<typeof lazy>> = {
  sources: lazy(() => import('../pages/Sources.tsx').then((m) => ({ default: m.Sources }))),
  schema: lazy(() => import('../pages/Schema.tsx').then((m) => ({ default: m.Schema }))),
  members: lazy(() => import('../pages/Members.tsx').then((m) => ({ default: m.Members }))),
  access: lazy(() => import('../pages/Access.tsx').then((m) => ({ default: m.Access }))),
  schedules: lazy(() => import('../pages/Schedules.tsx').then((m) => ({ default: m.Schedules }))),
  health: lazy(() => import('../pages/Health.tsx').then((m) => ({ default: m.Health }))),
  spend: lazy(() => import('../pages/Spend.tsx').then((m) => ({ default: m.Spend }))),
  runs: lazy(() => import('../pages/Runs.tsx').then((m) => ({ default: m.Runs }))),
  upgrades: lazy(() => import('../pages/Upgrades.tsx').then((m) => ({ default: m.Upgrades }))),
};

const LABEL: Record<SettingsTab, string> = {
  sources: 'Sources', schema: 'Schema', members: 'Members', access: 'Access',
  schedules: 'Schedules', health: 'Health', spend: 'Spend', runs: 'Runs', upgrades: 'Upgrades',
};

export function SettingsPanel({
  tab, isAdmin, onSelectTab,
}: { tab: SettingsTab; isAdmin: boolean; onSelectTab: (t: SettingsTab) => void }) {
  const Page = PAGES[tab];
  return (
    <div className="settings-layout">
      <nav className="settings-nav">
        {visibleTabs(isAdmin).map((t) => (
          <button key={t} className={`nav-item ${t === tab ? 'text-ok' : ''}`} onClick={() => onSelectTab(t)}>
            {LABEL[t]}
          </button>
        ))}
      </nav>
      <section className="settings-content">
        <Suspense fallback={<div className="p-6 text-muted">Loading…</div>}>
          <Page />
        </Suspense>
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no new errors attributable to `settings/SettingsModal.tsx` or `settings/SettingsPanel.tsx`.

- [ ] **Step 4: Commit**

```bash
git add src/console/settings/SettingsModal.tsx src/console/settings/SettingsPanel.tsx
git commit -m "$(cat <<'EOF'
feat(console): settings modal hosting the nine admin pages, lazily

Portalled to <body>, click-away on press-and-release, Esc deferring to any
stacked confirm dialog (Sources.tsx / Runs.tsx both render their own),
opacity-only animation so those confirms' position: fixed is never trapped
inside a transformed card. Pages mount unchanged behind React.lazy — Schedules
and Runs alone are ~40% of the console's page code and do not belong in the
shell's first paint.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `shell/AccountBox.tsx` + `shell/SourceSwitcher.tsx` + `shell/FileTree.tsx`

**Files:**
- Create: `src/console/shell/AccountBox.tsx`
- Create: `src/console/shell/SourceSwitcher.tsx`
- Create: `src/console/shell/FileTree.tsx`
- Modify: `src/console/api.ts` — add `sessionApi.signOut()`

**Interfaces:**
- Consumes: `useSource()` (Task 4), `buildTree`/`flattenTree`/`toggleExpanded`/`loadExpanded`/
  `saveExpanded` (Task 3), `sessionApi` (`api.ts:59-70`, extended here).
- Produces: `<AccountBox email={string} onSignOut={() => void} onOpenSettings={() => void} />`,
  `<SourceSwitcher />`, `<FileTree onPick={(path: string) => void} selected={string | null} />`.

- [ ] **Step 1: Write the failing test for `sessionApi.signOut()`**

Add to `test/unit/console-app.test.ts` (or a new small block near the existing `sessionApi`
usage) — since `sessionApi.signOut()` is a thin wrapper with no branching logic of its own
(unlike `sessionApi.me()`, which degrades a non-2xx response to `null`), its contract is
asserted by the type system plus the existing `api.post` test coverage already in this suite,
not a new bespoke test. Confirm this directly:

Run: `bunx tsc --noEmit`
Expected (before Step 2's implementation): a type error at any call site referencing
`sessionApi.signOut` — there is none yet, so this step instead just confirms the symbol does not
exist:

```bash
grep -n "signOut" src/console/api.ts
```
Expected: no match.

- [ ] **Step 2: Add `sessionApi.signOut()`**

In `src/console/api.ts`, extend the `sessionApi` object (`api.ts:59-70`):

```ts
export const sessionApi = {
  me: async (): Promise<SessionUser | null> => { /* unchanged, api.ts:60-69 */ },
  /** Better Auth's own sign-out route. The console has had no sign-out until
   *  now — an account box showing an email with no way to leave it would be a
   *  conspicuous hole. */
  signOut: (): Promise<{ ok: boolean }> => api.post<{ ok: boolean }>('/auth/sign-out'),
};
```

Run: `grep -n "signOut" src/console/api.ts`
Expected: the new line is present.

- [ ] **Step 3: Write `shell/AccountBox.tsx`, `SourceSwitcher.tsx`, `FileTree.tsx`**

```tsx
// src/console/shell/AccountBox.tsx
export function AccountBox({
  email, onSignOut, onOpenSettings,
}: { email: string; onSignOut: () => void; onOpenSettings: () => void }) {
  return (
    <div className="sidebar-row flex items-center justify-between">
      <span className="text-sm truncate">{email}</span>
      <div className="flex gap-1">
        <button className="nav-item" onClick={onOpenSettings} aria-label="Settings">⚙</button>
        <button className="nav-item" onClick={onSignOut} aria-label="Sign out">Sign out</button>
      </div>
    </div>
  );
}
```

```tsx
// src/console/shell/SourceSwitcher.tsx
import { useSource } from '../SourceContext.tsx';

export function SourceSwitcher() {
  const { current, spaces, setCurrent } = useSource();
  if (spaces.length === 0) return <div className="sidebar-row text-sm text-muted">No Sources you can reach.</div>;
  return (
    <div className="sidebar-row">
      <select className="field" value={current?.sourceId ?? ''} onChange={(e) => setCurrent(e.target.value)}>
        {spaces.map((s) => <option key={s.sourceId} value={s.sourceId}>{s.name}</option>)}
      </select>
    </div>
  );
}
```

```tsx
// src/console/shell/FileTree.tsx
import { useEffect, useState } from 'react';
import { useSource } from '../SourceContext.tsx';
import { buildTree, flattenTree, toggleExpanded, loadExpanded, saveExpanded } from '../files/tree.ts';
import { filesApi, type FileEntry } from '../api.ts';
import { indentFor } from '../files/tree.ts';

export function FileTree({ selected, onPick }: { selected: string | null; onPick: (path: string) => void }) {
  const { current } = useSource();
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [treeError, setTreeError] = useState<string | null>(null);

  useEffect(() => {
    if (!current) { setEntries([]); return; }
    let cancelled = false;
    void filesApi.tree(current.sourceId)
      .then((tree) => {
        if (cancelled) return;
        setEntries(tree.entries);
        setExpanded(loadExpanded(current.sourceId, tree.entries));
        setTreeError(null);
      })
      .catch(() => { if (!cancelled) setTreeError('This Source could not be listed.'); });
    return () => { cancelled = true; };
  }, [current?.sourceId]);

  const toggle = (path: string) => {
    if (!current) return;
    const next = toggleExpanded(expanded, path);
    setExpanded(next);
    saveExpanded(current.sourceId, next);
  };

  if (!current) return null;
  if (treeError) return <div className="sidebar-row text-danger text-sm">{treeError}</div>;
  const rows = flattenTree(buildTree(entries), expanded);
  if (rows.length === 0) return <div className="sidebar-row text-sm text-muted">No files in this Source.</div>;

  return (
    <div className="sidebar-tree">
      {rows.map((row) => (
        <button
          key={row.path}
          className={`tree-row nav-item font-mono text-xs ${selected === row.path ? 'text-ok' : ''}`}
          style={{ paddingLeft: indentFor(row.depth) + 8 }}
          onClick={() => (row.kind === 'folder' ? toggle(row.path) : onPick(row.path))}
        >
          {row.kind === 'folder' ? (row.expanded ? '▼ ' : '▶ ') : ''}{row.name}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no new errors attributable to the three new files or the `api.ts` addition.

- [ ] **Step 5: Commit**

```bash
git add src/console/shell/AccountBox.tsx src/console/shell/SourceSwitcher.tsx src/console/shell/FileTree.tsx src/console/api.ts
git commit -m "$(cat <<'EOF'
feat(console): sidebar shell — account box, Source switcher, collapsible tree

Adds sessionApi.signOut() (POST /api/auth/sign-out) — the console has had no
sign-out until now, and an account box naming the signed-in email with no way
to leave it would be a conspicuous hole. FileTree renders flattenTree's rows
over per-sourceId persisted expansion state from files/tree.ts.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `pages/Editor.tsx` — carve the right column out of `Files.tsx`

**Files:**
- Create: `src/console/pages/Editor.tsx`
- Modify: `test/unit/console-files.test.ts` (the save/reload-adjacent helper assertions already
  cover the moved logic via Task 3's `files/tree.ts` imports; no new pure functions are
  introduced by this task, since `save()`/`reload()` are effectful and were never unit-tested
  directly — only the pure decisions around them, already covered)

**Interfaces:**
- Consumes: `mountMarkdownEditor` (`src/console/editor/index.ts`), `filesApi` (`api.ts:100-107`),
  `useSource()` (Task 4), the moved helpers from `files/tree.ts` (Task 3).
- Produces: `<Editor path={string | null} />`, reading `sourceId` from `useSource()` and `path`
  from the router (wired at Task 8).

Behaviour — stale save, the bypass disclosure, the dirty check, the read/edit mode toggle — is
MOVED, not changed. This task has no new TDD test of its own beyond what Task 3 already locked
down for the pure decisions; verification here is that the moved logic still passes the tests
that already exist for it.

- [ ] **Step 1: Confirm the pre-move baseline passes**

Run: `bun test test/unit/console-files.test.ts`
Expected: PASS (carried over from Task 3's Step 4 — this step exists so a later regression in
this task is attributable to the move, not to something already broken).

- [ ] **Step 2: Write `pages/Editor.tsx`**

Move, verbatim in logic, from `src/console/pages/Files.tsx`:
- State: `file`, `mode`, `baseline`, `draft`, `pending`, `reloading`, `saveResult`, `saveError`,
  `fileError` (`Files.tsx:184-194`, minus `spaces`/`sourceId`/`entries`/`path`/`error`/`treeError`
  /`loading`, which now live in `SourceContext` / `FileTree` / the router).
- Refs: `hostRef`, `editorRef` (`Files.tsx:197-198`).
- Effects: the file-load effect (`Files.tsx:230-244`), the mode-reset effect (`Files.tsx:248`),
  the editor mount effect (`Files.tsx:254-271`), the value/mode sync effect (`Files.tsx:273-278`)
  — each reading `sourceId` from `useSource().current?.sourceId` and `path` from this
  component's own `path` prop instead of local state.
- Functions: `save()` (`Files.tsx:299-323`), `reload()` (`Files.tsx:325-340`) — unchanged logic,
  `sourceId`/`path` substitutions only.
- Render: the right-hand `<section>` (`Files.tsx:393-440`), including the empty state "Pick a
  file to read it." (`Files.tsx:395`), the Edit/Save toggle (`Files.tsx:401-419`), and the
  save-result/stale/bypass notices (`Files.tsx:421-435`).

```tsx
import { useEffect, useRef, useState } from 'react';
import { filesApi, type FileContent, type FileSaveResult } from '../api.ts';
import { mountMarkdownEditor, type EditorMode, type MarkdownEditorHandle } from '../editor/index.ts';
import {
  canEdit, editToggleLabel, saveButtonLabel, saveSuccessText, saveFailureText,
  staleNotice, bypassVisible, isDirty, modeAfterSave, BYPASS_NOTICE, errorText, fileErrorMessage,
} from './editorHelpers.ts'; // re-exported from files/tree.ts + the two labels below
import { useSource } from '../SourceContext.tsx';

export function Editor({ path }: { path: string | null }) {
  const { current } = useSource();
  const sourceId = current?.sourceId ?? '';
  const access = current?.access ?? null;

  const [file, setFile] = useState<FileContent | null>(null);
  const [mode, setMode] = useState<EditorMode>('read');
  const [baseline, setBaseline] = useState('');
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [saveResult, setSaveResult] = useState<FileSaveResult | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<MarkdownEditorHandle | null>(null);

  useEffect(() => {
    if (sourceId === '' || path === null) return;
    let cancelled = false;
    void filesApi.file(sourceId, path)
      .then((body) => { if (cancelled) return; setFile(body); setBaseline(body.content); setDraft(body.content); })
      .catch((e) => { if (!cancelled) setFileError(errorText(e, fileErrorMessage)); });
    return () => { cancelled = true; };
  }, [sourceId, path]);

  useEffect(() => { setMode('read'); }, [path]);

  useEffect(() => {
    const parent = hostRef.current;
    if (path === null || parent === null) return;
    const handle = mountMarkdownEditor({
      parent, doc: file?.content ?? '', mode,
      onChange: (value) => setDraft(value),
    });
    editorRef.current = handle;
    return () => { handle.destroy(); if (editorRef.current === handle) editorRef.current = null; };
  }, [path]);

  useEffect(() => {
    const handle = editorRef.current;
    if (handle === null) return;
    if (file !== null) handle.setValue(file.content);
    handle.setMode(mode);
  }, [file, mode]);

  const dirty = isDirty(baseline, draft);

  const save = async () => {
    if (sourceId === '' || path === null || file === null || pending) return;
    const content = editorRef.current?.getValue() ?? draft;
    setPending(true); setSaveError(null); setSaveResult(null);
    try {
      const result = await filesApi.save(sourceId, path, { content, expectedSha: file.sha });
      setSaveResult(result);
      if (result.committed) {
        setFile((f) => (f === null ? f : { ...f, content, sha: result.sha }));
        setBaseline(content); setDraft(content); setMode(modeAfterSave());
      }
    } catch (e) {
      setSaveError(saveFailureText(errorText(e, 'the server did not say why.')));
    } finally { setPending(false); }
  };

  const reload = async () => {
    if (sourceId === '' || path === null || reloading) return;
    setReloading(true); setSaveError(null);
    try {
      const body = await filesApi.file(sourceId, path);
      setFile(body); setBaseline(body.content); setDraft(body.content); setSaveResult(null);
    } catch (e) {
      setSaveError(errorText(e, fileErrorMessage));
    } finally { setReloading(false); }
  };

  if (path === null) return <p className="text-sm text-muted p-6">Pick a file to read it.</p>;

  return (
    <div className="min-w-0 flex-1 space-y-2 p-6">
      <div className="text-xs text-muted font-mono">{path}</div>
      {fileError && <div className="text-danger text-sm">{fileError}</div>}
      {canEdit(access) && file !== null && (
        <div className="flex items-center gap-2">
          <button className="nav-item" onClick={() => setMode((m) => (m === 'edit' ? 'read' : 'edit'))}>
            {editToggleLabel(mode)}
          </button>
          {mode === 'edit' && (
            <button className="btn-primary" disabled={pending || !dirty || access !== 'write'} onClick={() => void save()}>
              {saveButtonLabel(pending)}
            </button>
          )}
        </div>
      )}
      {saveError && <div className="text-danger text-sm">{saveError}</div>}
      {saveResult !== null && saveResult.committed && <div className="text-sm text-ok">{saveSuccessText(saveResult.sha)}</div>}
      {bypassVisible(saveResult) && <div className="text-sm text-warning">{BYPASS_NOTICE}</div>}
      {saveResult !== null && !saveResult.committed && (
        <div className="space-y-1">
          <div className="text-sm text-warning">{staleNotice(saveResult.sha)}</div>
          <button className="nav-item" disabled={reloading} onClick={() => void reload()}>{reloading ? 'Reloading…' : 'Reload'}</button>
        </div>
      )}
      <div ref={hostRef} className="markdown-editor" style={{ height: '70vh' }} />
    </div>
  );
}
```

`editToggleLabel`, `saveSuccessText`, `saveFailureText`, `modeAfterSave`, `fileErrorMessage`
(`Files.tsx:123-125, 134-136, 140-142, 169-171, 95`) move into `files/tree.ts` alongside Task 3's
other moved helpers — Task 3's file listing above did not enumerate these because Task 3 was
scoped to the tree; this task adds them to the same file rather than inventing a second helpers
module, and Task 3's commit message did not claim completeness beyond the tree helpers. Update
`files/tree.ts` accordingly before this task's typecheck step.

- [ ] **Step 3: Run tests and typecheck**

Run: `bun test test/unit/console-files.test.ts && bunx tsc --noEmit`
Expected: PASS; no new type errors.

- [ ] **Step 4: Commit**

```bash
git add src/console/pages/Editor.tsx src/console/files/tree.ts
git commit -m "$(cat <<'EOF'
feat(console): editor pane carved out of Files.tsx's right column

Save, reload, the stale-save notice, the bypass disclosure, and the dirty
check move unchanged — only their sourceId/path source changes, from local
state to SourceContext and the router. Files.tsx itself is deleted in a later
task once nothing references it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `AppShell.tsx` + the new `App.tsx` — wire routes, phases, `isAdmin`

**Files:**
- Create: `src/console/AppShell.tsx`
- Modify: `src/console/App.tsx`
- Modify: `src/console/router.ts` (add `useRoute()`)
- Modify: `test/unit/console-app.test.ts`

**Interfaces:**
- Consumes: `parseRoute`/`routeToPath`/`legacyRedirect` (Task 1), `visibleTabs` (Task 2),
  `SourceProvider`/`useSource` (Task 4), `SettingsModal` (Task 5), `AccountBox`/`SourceSwitcher`/
  `FileTree` (Task 6), `Editor` (Task 7).
- Produces: `useRoute(): [Route, (r: Route) => void]` in `router.ts`; `<AppShell isAdmin={boolean} />`.

- [ ] **Step 1: Update the failing test**

Edit `test/unit/console-app.test.ts`: remove the `describe('cold-load routes survive a page
load', …)` block (lines 50-66) — its property now lives in `test/unit/console-router.test.ts`
(Task 1, already passing). Leave the `phaseFor` describe block (lines 14-48) and the sign-in
error block (lines 69-100) exactly as they are; `App.tsx` still exports `phaseFor`.

Run: `bun test test/unit/console-app.test.ts`
Expected: FAIL at this point only if `App.tsx` has already been edited to remove
`pageFromPath` before this test edit lands — sequence the file edit (Step 2) after this test
edit is saved, so the failure mode is legibly "`pageFromPath` is not exported" rather than a
stale import silently passing.

- [ ] **Step 2: Add `useRoute()` to `router.ts`**

```ts
import { useEffect, useState } from 'react';

export function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(() => {
    const redirected = legacyRedirect(window.location.pathname);
    if (redirected) history.replaceState(null, '', redirected);
    return parseRoute(redirected ?? window.location.pathname);
  });

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = (next: Route) => {
    const path = routeToPath(next);
    if (path !== window.location.pathname) history.pushState(null, '', path);
    setRoute(next);
  };

  return [route, navigate];
}
```

- [ ] **Step 3: Rewrite `App.tsx` as a phase gate**

Keep verbatim: the `Phase` type (`App.tsx:19`), `WizardProbe` (`App.tsx:27`), `phaseFor`
(`App.tsx:46-54`) with its doc comment, `claimTokenFromPath` (`App.tsx:74-78`). Delete: the
`Page` type (`App.tsx:20`), `pageFromPath` (`App.tsx:63-72` — its property now lives in
`router.ts`), the `<nav>` block (`App.tsx:119-136`), the page-switch `<main>` block
(`App.tsx:138-148`). Add: an `isAdmin` boolean set from the wizard probe's 403 branch, and render
`<AppShell isAdmin={isAdmin} />` in place of the deleted nav/page-switch markup once `phase ===
'ready'`.

```tsx
// inside App(), replacing the old refresh()'s discarded probe result:
const [isAdmin, setIsAdmin] = useState(false);

const refresh = async () => {
  const { bootstrapped } = await api.get<{ bootstrapped: boolean }>('/bootstrap');
  if (!bootstrapped) return setPhase('bootstrap');
  let probe: WizardProbe;
  try {
    const state = await api.get<{ lifecycle: string }>('/wizard/state');
    probe = { status: 200, lifecycle: state.lifecycle };
  } catch (err) {
    probe = err instanceof ApiError ? { status: err.status } : { status: 'unreachable' };
  }
  // The same 403 phaseFor already reads as "a session, not an admin" —
  // threaded through instead of discarded after choosing the phase.
  setIsAdmin(probe.status !== 403 && probe.status !== 401 && probe.status !== 'unreachable');
  setPhase(phaseFor(bootstrapped, probe));
};
// ... phase === 'ready' now renders <AppShell isAdmin={isAdmin} /> instead of the old nav/page split.
```

- [ ] **Step 4: Write `AppShell.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { useRoute } from './router.ts';
import { SourceProvider } from './SourceContext.tsx';
import { AccountBox } from './shell/AccountBox.tsx';
import { SourceSwitcher } from './shell/SourceSwitcher.tsx';
import { FileTree } from './shell/FileTree.tsx';
import { Editor } from './pages/Editor.tsx';
import { SettingsModal } from './settings/SettingsModal.tsx';
import { visibleTabs } from './settings/tabs.ts';
import { filesApi, sessionApi, type SpaceSummary } from './api.ts';

export function AppShell({ isAdmin }: { isAdmin: boolean }) {
  const [route, navigate] = useRoute();
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [email, setEmail] = useState('');

  useEffect(() => { void filesApi.list().then((b) => setSpaces(b.spaces)); }, []);
  useEffect(() => { void sessionApi.me().then((u) => setEmail(u?.email ?? '')); }, []);

  const fromUrl = route.kind === 'editor' ? route.sourceId : null;
  const openPath = route.kind === 'editor' ? route.path : null;

  return (
    <SourceProvider spaces={spaces} fromUrl={fromUrl} onNavigate={(sourceId) => navigate({ kind: 'editor', sourceId, path: null })}>
      <div className="shell flex min-h-screen">
        <aside className="sidebar">
          <AccountBox
            email={email}
            onSignOut={() => void sessionApi.signOut().then(() => window.location.reload())}
            onOpenSettings={() => navigate({ kind: 'settings', tab: visibleTabs(isAdmin)[0]! })}
          />
          <SourceSwitcher />
          <FileTree
            selected={openPath}
            onPick={(path) => navigate({ kind: 'editor', sourceId: fromUrl, path })}
          />
        </aside>
        <main className="flex-1">
          <Editor path={openPath} />
        </main>
        {route.kind === 'settings' && (
          <SettingsModal
            tab={visibleTabs(isAdmin).includes(route.tab) ? route.tab : visibleTabs(isAdmin)[0]!}
            isAdmin={isAdmin}
            onClose={() => navigate({ kind: 'editor', sourceId: fromUrl, path: openPath })}
            onSelectTab={(tab) => navigate({ kind: 'settings', tab })}
          />
        )}
      </div>
    </SourceProvider>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/unit/console-app.test.ts test/unit/console-router.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the whole unit suite and typecheck**

Run: `bun run test:unit && bunx tsc --noEmit`
Expected: PASS; no new type errors.

- [ ] **Step 7: Commit**

```bash
git add src/console/App.tsx src/console/AppShell.tsx src/console/router.ts test/unit/console-app.test.ts
git commit -m "$(cat <<'EOF'
feat(console): App.tsx is a phase gate only; AppShell owns the sidebar/main split

phaseFor and the Phase type are untouched — this only deletes the eleven-item
nav and the page switch, replacing them with route-driven AppShell. The wizard
probe's 403 (already "a session, not an admin" per phaseFor's own comment) is
threaded into isAdmin instead of discarded after choosing the phase.
useRoute() adds popstate/pushState around Task 1's pure parseRoute/routeToPath,
applying legacyRedirect before the first paint.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: `styles.css` — shell and settings primitives

**Files:**
- Modify: `src/console/styles.css`

**Interfaces:**
- Consumes: nothing.
- Produces: `.shell`, `.sidebar`, `.sidebar-row`, `.sidebar-tree`, `.tree-row`, `.settings-backdrop`,
  `.settings-card`, `.settings-layout`, `.settings-nav`, `.settings-content`, `.settings-close`.

No unit test: this is layout CSS with no operator-facing copy of its own (every string it wraps
was already asserted in Tasks 3/6/7's tests). Verification is the manual pass in this plan's
Verification section, plus the redeploy smoke check.

- [ ] **Step 1: Add the rules**

Append to `src/console/styles.css`, after the existing `.nav-item` rules (`styles.css:40-41`):

```css
/* ---- Shell layout (console shell redesign) ---- */
.shell { --sidebar-w: 260px; }
.sidebar {
  width: var(--sidebar-w); flex-shrink: 0;
  border-right: 1px solid var(--color-subtle);
  display: flex; flex-direction: column;
}
.sidebar-row {
  padding: 10px 12px; border-bottom: 1px solid var(--color-subtle);
}
.sidebar-tree { overflow-y: auto; flex: 1; padding: 6px 0; }
.tree-row { font-size: 12px; }

/* ---- Settings modal ---- */
.settings-backdrop {
  position: fixed; inset: 0; background: rgba(0, 0, 0, .6);
  display: flex; align-items: center; justify-content: center;
  opacity: 1; transition: opacity .15s ease;
}
.settings-card {
  width: min(960px, 92vw); height: min(720px, 88vh);
  display: flex; flex-direction: column; overflow: hidden; position: relative;
}
.settings-close { position: absolute; top: 8px; right: 8px; }
.settings-layout { display: flex; flex: 1; min-height: 0; }
.settings-nav { width: 180px; flex-shrink: 0; border-right: 1px solid var(--color-subtle); padding: 8px; }
.settings-content { flex: 1; overflow-y: auto; padding: 24px; }
```

- [ ] **Step 2: Typecheck and lint**

Run: `bun run lint:forbidden`
Expected: PASS — no forbidden pattern introduced.

- [ ] **Step 3: Commit**

```bash
git add src/console/styles.css
git commit -m "$(cat <<'EOF'
style(console): shell and settings modal primitives

Sidebar width reads from --sidebar-w from day one, unset by anything yet, so
upstream's drag-to-resize can drop in later without touching every rule that
currently hardcodes a width. Palette untouched — this is layout only.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Delete `Files.tsx`, fix the stale `api.ts` comments, update the docs

**Files:**
- Delete: `src/console/pages/Files.tsx`
- Modify: `src/console/api.ts` (lines 72-78)
- Modify: `docs/product-overview.md` (§4.3, lines 113-127)

**Interfaces:**
- Consumes: nothing new — this task removes the last references to the old module and its two
  stale doc comments.

- [ ] **Step 1: Confirm nothing still imports `Files.tsx`**

Run:
```bash
grep -rn "pages/Files" src/ test/ | grep -v "docs/superpowers"
```
Expected: no matches (Task 3 retargeted `console-files.test.ts`'s helper imports to
`files/tree.ts`; Task 8's `AppShell.tsx` imports `pages/Editor.tsx`, not `pages/Files.tsx`).

- [ ] **Step 2: Delete the file**

```bash
git rm src/console/pages/Files.tsx
```

- [ ] **Step 3: Fix the two stale `api.ts` comments**

In `src/console/api.ts`, replace lines 72-78:

```ts
/**
 * The Files surface (`src/control/routes/spaces.ts`). Types mirror the routes'
 * projections exactly: the Space list carries each Connection's access so the
 * picker can say read-only vs can-edit without a second, admin-only call, and
 * the tree carries only the entries an operator may browse. Stage 2's PUT is
 * not wired here yet — this client is read-only.
 */
```

with:

```ts
/**
 * The Files surface (`src/control/routes/files.ts`). Types mirror the routes'
 * projections exactly: the Space list carries each Connection's access so the
 * picker can say read-only vs can-edit without a second, admin-only call, and
 * the tree carries only the entries an operator may browse. `filesApi.save`
 * below is a PUT with a stale-sha conflict check — this client has not been
 * read-only since Stage 2.
 */
```

- [ ] **Step 4: Update `docs/product-overview.md` §4.3**

Replace the table at lines 115-126 (dropping the `/connect` row folded into Access by fcba38a,
and updating the route column to the new shell's URLs):

```markdown
| Page | Route | What it's for |
|---|---|---|
| Sign in / Bootstrap | `/` | Auth, and first-admin creation |
| Editor | `/`, `/s/:sourceId`, `/s/:sourceId/:path` | Browse and edit the markdown in a Source |
| Settings — Members | `/settings/members` | Invite/offboard people, assign roles |
| Settings — Access | `/settings/access` | Each member's Connection to the brain |
| Settings — Schedules | `/settings/schedules` | Create/pause/inspect recurring jobs, read alerts |
| Settings — Runs | `/settings/runs` | The agent-runner's run history, cost, and revert button |
| Settings — Spend | `/settings/spend` | Metered usage by member/org, with coverage caveats stated up front |
| Settings — Upgrades | `/settings/upgrades` | Check for a new gbrain version, plan/run/roll back |
| Settings — Health | `/settings/health` | Live component health, pin match, runner state |
| Settings — Sources | `/settings/sources` | Add/rename/archive Sources |
| Settings — Schema | `/settings/schema` | Choose and apply a schema pack |
| Claim | `/claim/:token` | Accepting an invite / pairing link |
| Wizard | (post-bootstrap) | First-run setup: pick search mode, see isolation notice, add a Source |
```

Also replace any remaining "Space" wording in this section with "Source," matching the rest of
the post-fcba38a codebase.

- [ ] **Step 5: Run the whole unit suite, lint, and typecheck**

Run: `bun run test:unit && bun run lint:forbidden && bunx tsc --noEmit`
Expected: PASS; no reference to the deleted file remains anywhere in the type graph.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore(console): delete Files.tsx, fix two stale api.ts comments, update the shell docs

Files.tsx's tree and save/reload logic finished moving to files/tree.ts,
shell/FileTree.tsx and pages/Editor.tsx in earlier tasks; nothing imports it
anymore. api.ts named a routes/spaces.ts that has never existed (the real
file is routes/files.ts) and called the client read-only two lines above a
PUT. product-overview.md's page table still listed a /connect page fcba38a
already folded into Access.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Verification

After all ten tasks:

```bash
bun run test:unit
bun run lint:forbidden
bunx tsc --noEmit
bash scripts/redeploy.sh
```

`redeploy.sh` proves its own work (exit 14 unless the served bytes match `dist/console/index.html`)
and prints the URL. Report its EPHEMERAL warning verbatim — the control-plane image still carries
the old console, and this patch is lost on any container replacement until `--full` bakes it in.

Then at `https://localhost:8443/` (hard-reload Ctrl+Shift+R):

1. Sign in → land in the editor, not a nav list. Sidebar shows the account box, the Source
   switcher, and a collapsible tree.
2. Collapse a folder, reload → it is still collapsed.
3. Open a file, edit, save → commits. Save again with a stale sha → the stale notice, and
   nothing written.
4. Switch Source → URL becomes `/s/<id>`, tree reloads, open file clears. Back button returns to
   the previous Source.
5. ⚙ → settings modal, editor dimmed behind it. Esc closes. `/settings/members` pasted into a
   fresh tab opens straight onto Members.
6. Visit `/sources` → redirects to `/settings/sources`.
7. Sign in as a `member` → four tabs (Schedules, Health, Runs, Upgrades). `/settings/spend` falls
   back rather than showing an empty panel.
8. On a deployment with `lifecycle !== 'ready'` → the Wizard gate, not an empty editor.
9. Sign out from the account box → lands back on the sign-in page, and a second sign-in restores
   the previously remembered Source.

## Out of scope, and why

- **Backend changes.** Every route, table and contract is untouched — the whole plan is a
  console-only reshuffle of already-shipped API surface.
- **Create / rename / delete files.** No such route exists (`src/control/routes/files.ts` is
  read plus conditional overwrite only); adding one is a separate, backend-touching feature.
- **Multiple editor tabs.** Upstream has `TabBar.tsx`; one open file is what `Files.tsx` does
  today and what `pages/Editor.tsx` (Task 7) continues to do.
- **Sidebar resizing.** Upstream's `useSidebarWidth` is ~40 lines. Task 9 reads the sidebar's
  width from a `--sidebar-w` CSS variable from day one specifically so this drops in later
  without another pass through every rule.
- **Light mode.** The palette in `styles.css` (`styles.css:3-16`) is hardcoded dark with no
  `dark:` variants anywhere in the codebase.
- **Search, backlinks, graph view.** Upstream surfaces this repo has never ported, and porting
  them is unrelated to inverting the shell's altitude.
- **Restyling the nine settings pages.** `Sources.tsx`, `Schema.tsx`, `Members.tsx`, `Access.tsx`,
  `Schedules.tsx`, `Health.tsx`, `Spend.tsx`, `Runs.tsx`, `Upgrades.tsx` all mount as they are
  today (Task 5); each already wraps itself in `max-w-* space-y-*` with its own `<h1>`, matching
  what `Files.tsx:343-349` did.
