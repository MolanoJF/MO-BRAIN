# Console shell redesign — design

**Goal:** Invert the console's altitude. Today eleven flat nav items sit at the same level and
a `<select>` decides which Source is "current," forgetting that choice on every click. The
editor an operator actually spends the day in is one of those eleven items, buried. This design
makes the editor the landing screen — a file tree plus an editor pane, both driven by one
app-wide Source selection — and moves every administrative page behind a single settings button.
The reference is baalda (https://github.com/naveedharri/baalda), whose editor internals this
repo already vendors at `src/console/editor/vendor/baalda/` (pinned
`c08bbf287cde6ecbb45501b703a925029309674b`). What changes now is the *shell* around that editor:
upstream's `App.tsx` sidebar/main split and its `VaultSettingsDialog.tsx` settings modal.

**One correction to the brief.** The request framed this as happening "once the user signs up."
There is no signup — `README.md` states it outright: "no signup, no billing, and no provisioner
in this release." Account creation is `Bootstrap` (the first admin, exactly once per deployment,
`src/console/App.tsx:110-114`) plus `Claim` (an invited member picking up credentials at
`/claim/:token`, `src/console/App.tsx:74-78,108`). The design is unchanged in substance: the
editor is the landing screen the instant bootstrap or sign-in completes.

**Problem today:**
- `src/console/App.tsx:80-152` renders one flat `<nav>` of eleven buttons and switches on a
  `page` string (`type Page`, `App.tsx:20`) held in local `useState` (`App.tsx:84`). Clicking a
  nav item never touches `window.location` — `pageFromPath` (`App.tsx:63-72`) is read once at
  mount and never written back, so the URL and the back button are inert once the app is up.
- `src/console/pages/Files.tsx:181` holds `sourceId` in its own local `useState`, scoped to the
  `Files` component alone. Switching to any other page and back loses the selection; no other
  page shares it, because there is no shared owner.
- `src/console/api.ts:73` documents the Files surface as living in
  `src/control/routes/spaces.ts` — that file does not exist. The real route file is
  `src/control/routes/files.ts`. The same comment block (`api.ts:77`) calls the client
  "read-only," directly above `filesApi.save` (`api.ts:100-106`), which is a `PUT`. Both lines
  predate Stage 2's write path and were never updated.
- `docs/product-overview.md` §4.3 (lines 113-127) lists a `/connect` page ("Each member wires up
  their own agent to the brain") that commit fcba38a already folded into Access, and calls the
  Source concept "Space" throughout — both stale against the current shell.
- The console has no sign-out. An account box that shows an email with no way to leave it is a
  conspicuous hole this design has to close even though nothing in the brief asked for it.

**Non-goals (explicitly out of scope for this design):**
- Any backend change. Every route, table and contract is untouched — see `gitTree`
  (`src/ops/git.ts:375-390`), which already returns a sorted flat file list with `.git/`
  excluded; the nested tree used by the new shell is built entirely on the client from that list.
- Create / rename / delete files. `src/control/routes/files.ts` is read plus conditional
  overwrite only; no such route exists to add a "new file" affordance to.
- Multiple open editor tabs, sidebar resizing, light mode, search/backlinks/graph view, or
  restyling the nine settings pages. Each is called out again in Out of scope at the end of this
  document, with the reason it is deferred rather than dropped.

---

## What already exists and gets reused

- `src/console/editor/index.ts` — `mountMarkdownEditor()` / `MarkdownEditorHandle`, mode
  switching via a `Compartment`, programmatic writes tagged with an `Annotation` so they never
  fire `onChange`, an idempotent `destroy()`. The new editor pane uses this exactly as
  `Files.tsx`'s mount effect (`Files.tsx:254-278`) does today.
- `src/console/api.ts` — every endpoint the settings tabs need is already typed: `filesApi.list /
  tree / file / save` (`api.ts:100-107`), `sessionApi.me()` (`api.ts:59-70`), and the eight admin
  clients (`schemaPacksApi`, `sourcesApi`, `scheduleApi`, `upgradeApi`, `runApi`, `spendApi`, plus
  the connections/members clients not shown above). All cookie-authenticated
  (`credentials: 'same-origin'`, `api.ts:19`, no bearer tokens), with `ApiError` carrying the
  parsed refusal body (`api.ts:3-14`).
- The nine settings pages — `Sources`, `Schema`, `Members`, `Access`, `Schedules`, `Health`,
  `Spend`, `Runs`, `Upgrades` — mount UNCHANGED. Each already wraps itself in a
  `max-w-* space-y-*` container with its own `<h1>` (the same shape `Files.tsx:343-349` uses);
  the settings modal hosts them as-is this slice.
- The pure-helper convention `App.tsx:phaseFor` (`App.tsx:46-54`) established: every decision an
  operator can observe is a named, exported, DOM-free function so `test/unit/` can assert it
  without a browser. `Files.tsx` alone exports twenty of these (`fileKind`, `baseName`,
  `pathDepth`, `treeToNodes`, `accessNotice`, `BYPASS_NOTICE`, `canEdit`, `editToggleLabel`,
  `saveButtonLabel`, `saveSuccessText`, `saveFailureText`, `staleNotice`, `bypassVisible`,
  `isDirty`, `modeAfterSave`, `indentFor`, `emptyStateText`, `treeErrorMessage`,
  `fileErrorMessage`, `errorText`, plus `spacePickerLabel`). Every new module below keeps that
  shape.

---

## 1. `src/console/router.ts` (new)

The shell reads `window.location.pathname` once at mount (`App.tsx:82`) and never writes it.
This file replaces that with a real, dependency-free router: parse/format are pure so they are
unit-testable without a DOM, and only the hook that wraps them touches `popstate` / `pushState`.

```ts
export type Route =
  | { kind: 'editor'; sourceId: string | null; path: string | null }
  | { kind: 'settings'; tab: SettingsTab }
  | { kind: 'claim'; token: string };
```

| URL | Route |
|---|---|
| `/` | editor, no Source chosen yet — resolved by `pickSource` (§4) |
| `/s/:sourceId` | editor, that Source, no file open |
| `/s/:sourceId/:path*` | editor, that Source, that file open |
| `/settings/:tab` | settings modal on that tab, editor rendered behind it |
| `/claim/:token` | claim takeover, unchanged from `claimTokenFromPath()` (`App.tsx:74-78`) |

Legacy redirects are REQUIRED, not cosmetic: `/sources`, `/schedules`, `/runs`, `/spend`,
`/upgrades` and `/files` are live cold-load routes today (`pageFromPath`, `App.tsx:63-72`, and
the bookmarked-route test at `test/unit/console-app.test.ts:51-61`) and somebody has at least one
bookmarked. `legacyRedirect(pathname)` maps the first five to `/settings/<tab>` and `/files` to
`/`; `App.tsx` applies the redirect with `history.replaceState` before the first paint, so the
address bar never flashes the old path.

`test/unit/console-app.test.ts:51-61` currently asserts `pageFromPath('/sources')` resolves and
survives a trailing slash. HANDOFF forbids weakening a test to make it pass — deleting
`pageFromPath` is not that, because its *subject* changed, not its trust property. The
replacement test in `console-router.test.ts` keeps the same property and strengthens it: it
asserts both that `/settings/sources` parses directly AND that the old bookmarked `/sources`
still lands there via `legacyRedirect`. The `phaseFor` block of `console-app.test.ts` (lines
14-48) is untouched by this file.

## 2. `src/console/settings/tabs.ts` (new)

A leaf module — no React import, no page import — for the same reason upstream's
`lib/settingsTabs.ts` is a leaf: `router.ts` needs the tab union at parse time, and having the
router import a lazy-loaded settings page even type-only is an import cycle waiting to happen.

```ts
export type SettingsTab =
  | 'sources' | 'schema' | 'members' | 'access' | 'schedules'
  | 'health' | 'spend' | 'runs' | 'upgrades';
```

| Tab | Page | Min role |
|---|---|---|
| Sources | `Sources.tsx` | admin |
| Schema | `Schema.tsx` | admin |
| Members | `Members.tsx` | admin |
| Access | `Access.tsx` | admin (calls `/connections`) |
| Schedules | `Schedules.tsx` | viewer |
| Health | `Health.tsx` | viewer |
| Spend | `Spend.tsx` | admin |
| Runs | `Runs.tsx` | viewer |
| Upgrades | `Upgrades.tsx` | viewer |

`visibleTabs(isAdmin: boolean): SettingsTab[]` returns all nine for an admin and
`['schedules', 'health', 'runs', 'upgrades']`, in that order, for anyone else. Non-admin tabs are
HIDDEN, not locked behind a disabled state — there is no partial-access affordance to design for.

Role, without a backend change: `App.tsx`'s `refresh()` already probes `GET /api/wizard/state`
and already treats its 403 as "a session, without the admin role" (`phaseFor`'s own comment,
`App.tsx:38-40`, and the branch at `App.tsx:49`). That is exactly the line this reuses — the
probe result becomes an `isAdmin` boolean threaded into `visibleTabs(isAdmin)`. No new endpoint,
no new column: the same signal `phaseFor` already trusts to distinguish "signed out" from "signed
in without the role."

A `/settings/sources` URL typed by a non-admin falls back to the first entry of
`visibleTabs(false)` (`'schedules'`) rather than rendering an empty panel.

## 3. `src/console/files/tree.ts` (new) — carved out of `Files.tsx`

`gitTree` (`src/ops/git.ts:375-390`) emits FILES ONLY — no directory entries — sorted in
code-unit order, `.git/` excluded. `Files.tsx`'s existing `treeToNodes` (`Files.tsx:57-66`)
already turns that flat list into a flat, indented row list using `comparePaths`
(`Files.tsx:36-38`, deliberately not `localeCompare` — "stable across browsers and locales") and
`pathDepth` (`Files.tsx:47-49`). This file keeps that sort and depth math but adds real
collapsible folders:

```ts
export type TreeItem =
  | { kind: 'folder'; path: string; name: string; children: TreeItem[] }
  | { kind: 'file'; path: string; name: string; fileKind: FileKind };

export function buildTree(entries: FileEntry[]): TreeItem[];
export function flattenTree(items: TreeItem[], expanded: ReadonlySet<string>): Row[];
export function toggleExpanded(expanded: ReadonlySet<string>, path: string): Set<string>;
```

Rules the tests lock down:
- Folders sort before files at each level; within a group, code-unit order — the same rule
  `comparePaths` already encodes, now applied per directory level rather than to the whole flat
  list.
- Empty folders are invisible, by construction: the backend walk (`walkWorkingTree`,
  `src/ops/git.ts`) never emits a directory entry, so a folder with zero files cannot appear in
  `entries` and `buildTree` cannot synthesize one. This is upstream (gbrain's working-tree walk)
  behaviour, not a bug in this layer — recorded here so nobody "fixes" it later by trying to
  detect empty directories client-side.
- Expansion state persists to `localStorage`, keyed per `sourceId` (switching Sources must not
  leak one Source's collapsed state onto another's tree). A remembered expanded path that no
  longer exists in the current `entries` is dropped silently on load — a stale UI preference, not
  an error to surface.
- `depth` still comes from separator count (`pathDepth`, unchanged), so `indentFor(depth)`
  (`Files.tsx:105-107`) is reused verbatim by the row renderer.

The following pure helpers move from `Files.tsx` to `files/tree.ts` and `pages/Editor.tsx`
UNCHANGED, with their existing tests in `test/unit/console-files.test.ts` following them:
`fileKind` (`Files.tsx:22-25`), `baseName` (`Files.tsx:41-44`), `pathDepth` (`Files.tsx:47-49`),
`indentFor` (`Files.tsx:105-107`), `canEdit` (`Files.tsx:118-120`), `isDirty`
(`Files.tsx:163-165`), `staleNotice` (`Files.tsx:150-154`), `saveButtonLabel`
(`Files.tsx:128-130`), `bypassVisible` (`Files.tsx:158-160`), `errorText` (`Files.tsx:98-102`),
`accessNotice` (`Files.tsx:77-81`), `BYPASS_NOTICE` (`Files.tsx:88-89`). `treeToNodes`
(`Files.tsx:57-66`) itself does NOT move — it is replaced by `buildTree`/`flattenTree`, which
supersede its flat-list-only behaviour.

## 4. `src/console/SourceContext.tsx` (new)

The single biggest structural gap today: `Files.tsx:181`'s `sourceId` dies with the component.
`SourceContext` owns it once, for the whole app, as a provider wrapping `AppShell`.

```ts
export function pickSource(
  spaces: SpaceSummary[],
  fromUrl: string | null,
  remembered: string | null,
): SpaceSummary | null;
```

Resolution order, as a pure function so it is testable without mounting anything: the URL's
`:sourceId` wins if it names a Source in `spaces`; otherwise the `localStorage`-remembered id, if
still present; otherwise the first entry of `spaces`; otherwise `null` (the zero-Sources empty
state, §7). A remembered Source no longer in the list — archived, or removed via
`DELETE /api/sources/:id` (`sourcesApi.remove`, `api.ts:239-240`) — is discarded without an
error: it is a stale preference, not a failure to report.

Changing the Source pushes `/s/:sourceId` through the router, so the back button walks Source
history the same way it will walk file history once `pages/Editor.tsx` starts pushing
`/s/:sourceId/:path`. The editor drops any open file on a Source change — a path that resolves in
one Source's tree means nothing in another's, so carrying it across would either 404 silently or,
worse, coincidentally resolve to an unrelated file.

## 5. `src/console/settings/SettingsModal.tsx` + `SettingsPanel.tsx` (new)

Modal mechanics, ported from upstream's `VaultSettingsDialog.tsx`, which documents each one's
reason and which this design keeps:
- Portalled to `<body>`. The modal is opened from a sidebar leaf (`AccountBox`, §6); a fixed
  backdrop rendered from inside the sidebar's DOM subtree is one ancestor `transform` away from
  being clipped to a sidebar-sized box instead of covering the viewport.
- Click-away requires press AND release on the backdrop itself, so selecting text in a settings
  field and dragging the release past the backdrop edge does not close the modal.
- Esc defers to anything stacked above the modal (`.modal-backdrop`, `.context-menu`) — both
  `Sources.tsx` and `Runs.tsx` render their own confirm dialogs on top of the settings surface,
  and an Esc meant for "cancel this delete" must not also close settings underneath it.
- Focus moves to the modal's close button on open and returns to whatever opened it (the ⚙
  button in `AccountBox`) on close — a keyboard user is never dropped back at the top of the page.
- Animation is opacity-only. A settled CSS `transform` on the modal card would make it a
  containing block for anything inside it that uses `position: fixed` — exactly the confirm
  dialogs `Sources.tsx`/`Runs.tsx` render — which would then be clipped to the card instead of
  covering the viewport.
- Each tab's page is `lazy()`-loaded. `Schedules.tsx` (1,487 lines) and `Runs.tsx` (1,026 lines)
  are roughly 40% of the console's page code; none of it belongs in the shell's first paint,
  which an operator hits every time they open a file, not just when they open settings.

`SettingsPanel.tsx` is the modal's interior: a `nav.settings-nav` listing `visibleTabs(isAdmin)`
and a `section.settings-content` that mounts the selected tab's page component unchanged.

## 6. `src/console/shell/AccountBox.tsx`, `SourceSwitcher.tsx`, `FileTree.tsx` (new)

- `AccountBox.tsx` — the true top-left corner of the window: the signed-in email from
  `sessionApi.me()` (`api.ts:59-70`), a sign-out button, and the ⚙ that navigates to
  `/settings/<first admin or first visible tab>`. Sign-out is one new endpoint,
  `sessionApi.signOut()` (`POST /api/auth/sign-out`), plus the existing `refresh()` — the console
  has no sign-out today, and shipping an account box with an email and no way to leave it would
  be a conspicuous, easily-noticed hole even though the brief never mentioned it.
- `SourceSwitcher.tsx` — the one app-wide Source picker, reading and writing `SourceContext`
  (§4). Replaces the per-page `<select>` at `Files.tsx:354-366`.
- `FileTree.tsx` — renders the rows `flattenTree` (§3) produces: a folder row toggles
  `expanded`/persists it, a file row calls `pickFile`-equivalent logic (moved from
  `Files.tsx:286-297`) and pushes `/s/:sourceId/:path`.

## 7. `src/console/pages/Editor.tsx` (new) — the right column carved out of `Files.tsx`

Everything from `Files.tsx:342-444`'s right-hand `<section>` (the file header, the Edit/Save
toggle at `Files.tsx:401-419`, the save-result/stale/bypass notices at `Files.tsx:421-435`, and
the editor mount `<div>` at `Files.tsx:437`), plus the state and effects that drive it
(`file`/`mode`/`baseline`/`draft`/`pending`/`saveResult`/`saveError`/`fileError`,
`Files.tsx:184-194`, and the mount/update effects at `Files.tsx:230-278`). Behaviour — stale
save, the bypass disclosure, the dirty check, the read/edit mode toggle — is MOVED, not changed:
`save()` (`Files.tsx:299-323`) and `reload()` (`Files.tsx:325-340`) keep their exact logic, just
reading `sourceId`/`path` from `SourceContext`/the router instead of local state.

## 8. `src/console/App.tsx` (modified) + `src/console/AppShell.tsx` (new)

`App.tsx` becomes a phase gate ONLY: `claim -> bootstrap -> signin -> wizard -> shell`. The
eleven-button `<nav>` (`App.tsx:119-136`) and the page switch (`App.tsx:138-148`) are deleted
outright — `AppShell` replaces both. `phaseFor` (`App.tsx:46-54`) and the `Phase` type
(`App.tsx:19`) are kept VERBATIM: the wizard-gate logic this design's decisions section locks in
("stays a full-screen gate before the shell, shown while `lifecycle !== 'ready'`") is exactly
what `phaseFor` already computes. The wizard probe's 403 branch (`App.tsx:49`, `probe.status ===
403 -> 'ready'`) is threaded into the new `isAdmin` boolean `visibleTabs` needs (§2) instead of
being discarded after choosing the phase.

`AppShell.tsx` renders `<aside>` (`AccountBox` + `SourceSwitcher` + `FileTree`) and `<main>`
(`Editor.tsx`, or `SettingsModal` portalled on top of it when the route is `settings`), all
driven by `useRoute()` (§1) rather than a `page` string.

`test/unit/console-app.test.ts` is rewritten for the new URLs: the `phaseFor` describe block
(lines 14-48) is untouched; the cold-load-route block (lines 50-66) becomes
`test/unit/console-router.test.ts`'s legacy-redirect assertions, per §1.

## 9. `src/console/styles.css` (modified)

`styles.css` is 77 lines today, hand-rolled primitives on top of Tailwind's `@theme` (palette at
`styles.css:3-16`). This design adds `.shell`, `.sidebar`, `.sidebar-row`, `.tree-row`, and
`.settings-*` primitives in the same hand-rolled style as the existing `.nav-item`
(`styles.css:40-41`) and `.card` (`styles.css:29-32`) rules. The palette (`--color-bg` through
`--color-danger`, `styles.css:3-11`) is untouched — this is layout, not re-theming. The sidebar's
width is read from a `--sidebar-w` CSS custom property from day one even though nothing writes to
it yet, so upstream's `useSidebarWidth` (resize-by-drag) can be dropped in later without another
pass through every rule that currently hardcodes a width.

## 10. Deletions, stale-comment fixes, and the docs update

- `src/console/pages/Files.tsx` is deleted outright, its contents fully absorbed into
  `files/tree.ts`, `shell/FileTree.tsx`, and `pages/Editor.tsx` (§3, §6, §7).
- `src/console/api.ts:73` is corrected from `src/control/routes/spaces.ts` (does not exist) to
  `src/control/routes/files.ts` (the real route file). `api.ts:77`'s "this client is read-only"
  claim is deleted — `filesApi.save` two lines below it is a `PUT`, and has been since Stage 2.
- `docs/product-overview.md` §4.3 (lines 113-127) is updated: the `/connect` row is removed
  (folded into Access by fcba38a), the route column is updated to `/`, `/s/:sourceId`,
  `/s/:sourceId/:path`, and `/settings/:tab`, and "Space" references in that section become
  "Source" to match the rest of the post-fcba38a codebase.

---

## Sidebar layout

Three stacked rows, account box first — the true top-left corner of the window:

```
┌────────────────────┬──────────────────────────────┐
│ ● jf.molano@…   ⚙  │  product/specs/auth.md        │
├────────────────────┤  ──────────────────────────   │
│ My Brain        ▾  │                              │
├────────────────────┤  # Authentication            │
│ ▼ product/         │                              │
│   ▼ specs/         │  Better Auth handles the …   │
│       auth.md   ◀  │                              │
│       billing.md   │                              │
│     roadmap.md     │                              │
│ ▶ notes/           │                              │
│   README.md        │                              │
└────────────────────┴──────────────────────────────┘
```

## Empty and error states

Each is a named, exported, DOM-free function, matching the existing convention
(`staleNotice`/`treeErrorMessage`/the yet-to-exist `ISOLATION_NOTICE`-style constants):

| Condition | Screen |
|---|---|
| `lifecycle !== 'ready'` | Wizard takeover — `phaseFor` already returns `'wizard'` for this (`App.tsx:51`), unchanged |
| Ready, zero reachable Sources | "No Sources you can reach." Admins get a line pointing at Settings → Sources; members get "Ask an admin for access." |
| Source chosen, tree empty | "No files in this Source." — existing copy, `Files.tsx:378` |
| Tree listing failed | `treeErrorMessage` — existing copy, `Files.tsx:93` |
| No file selected | "Pick a file to read it." — existing copy, `Files.tsx:395` |

## Testing

- `test/unit/console-router.test.ts` — `Route` parse/format round-trips for every row in §1's
  table, plus `legacyRedirect` for each of the five admin routes and `/files`, plus the
  strengthened bookmark property described in §1 (`/settings/sources` parses directly, `/sources`
  redirects to it).
- `test/unit/console-tree.test.ts` — `buildTree`/`flattenTree` against the folder-before-file,
  code-unit-order, empty-folders-are-invisible, and expansion-persistence rules in §3; carries
  forward every existing `treeToNodes`-adjacent assertion from `test/unit/console-files.test.ts`
  that still applies to the moved helpers.
- `test/unit/console-settings-tabs.test.ts` — `visibleTabs(true)` returns all nine in table
  order; `visibleTabs(false)` returns exactly `['schedules', 'health', 'runs', 'upgrades']`; a
  non-admin `SettingsTab` not in that list is never rendered.
- `test/unit/console-app.test.ts` — the `phaseFor` block (lines 14-48) stays exactly as it is;
  the cold-load-route block (lines 50-66) is removed in favor of `console-router.test.ts`'s
  legacy-redirect assertions covering the same property.
- `test/unit/console-files.test.ts` — imports move to `files/tree.ts` and `pages/Editor.tsx`;
  every helper's existing assertions (fileKind casing, `staleNotice` wording, `bypassVisible`
  gating, etc.) travel with the code, unchanged in substance.
- Manual, against the running stack (`bash scripts/redeploy.sh`): sign in and land in the editor
  rather than a nav list; collapse a folder and reload to confirm persistence; edit and save a
  file, then save again against a stale sha to confirm the stale notice and that nothing is
  written; switch Source and confirm the URL, tree, and open file all update together and the
  back button restores the previous Source; open settings, confirm Esc closes it and a pasted
  `/settings/members` URL opens straight onto Members; sign in as a `member` and confirm exactly
  four tabs are visible and `/settings/spend` falls back rather than rendering empty; and, on a
  deployment with `lifecycle !== 'ready'`, confirm the Wizard gate still appears instead of an
  empty editor.
