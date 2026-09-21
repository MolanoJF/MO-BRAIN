# Baalda editor port — provenance and local changes

**Upstream:** https://github.com/naveedharri/baalda
**Pinned commit:** `c08bbf287cde6ecbb45501b703a925029309674b`
**Upstream source path:** `app/apps/desktop/src/lib/editor/` (the repo is a
monorepo rooted at `app/`; the editor is **not** a published npm package).
**License:** Apache-2.0 (see `NOTICE`).

Clone command used:

```
git clone --depth 1 https://github.com/naveedharri/baalda \
  C:\Users\juanp\AppData\Local\Temp\opencode\baalda
git -C <dir> rev-parse HEAD   # c08bbf287cde6ecbb45501b703a925029309674b
```

The clone succeeded, so every `.ts`/`.tsx` file below is a real port of upstream
source at that SHA — nothing in this directory was authored from scratch except
where explicitly called out as *written by us*.

## Vendored files

| File | Upstream file | State |
| --- | --- | --- |
| `livePreview.ts` | `livePreview.ts` | Ported, three seams (below) |
| `reveal.ts` | `reveal.ts` | Verbatim |
| `tasks.ts` | `tasks.ts` | Ported; strictness fixes only |
| `frontmatter.ts` | `frontmatter.ts` | Ported; import path only |
| `frontmatter/parse.ts` | `lib/frontmatter/parse.ts` | Ported; import path only |
| `urlSafety.ts` | `urlSafety.ts` | Verbatim |
| `fenceKind.ts` | `fenceKind.ts` | Ported; mermaid dropped |
| `codeFence.ts` | `codeFence.ts` | Ported; clipboard seam |
| `codeLanguages.ts` | `codeLanguages.ts` | Ported; language list trimmed |
| `clipboard.ts` | `lib/clipboard.ts` | Ported; Tauri seam |
| `preview.ts` | `lib/preview.ts` | Verbatim |
| `ofm/tags.ts` | `ofm/tags.ts` | Verbatim |
| `ofm/highlight.ts` | `ofm/highlight.ts` | Verbatim |
| `ofm/comment.ts` | `ofm/comment.ts` | Verbatim |
| `ofm/hashtag.ts` | `ofm/hashtag.ts` | Verbatim |
| `ofm/callout.ts` | `ofm/callout.ts` | Ported; strictness fixes only |
| `ofm/index.ts` | `ofm/index.ts` | Verbatim |
| `table/parse.ts` | `table/parse.ts` | Verbatim |
| `table/edit.ts` | `table/edit.ts` | Verbatim |
| `table/render.ts` | `table/render.ts` | Verbatim |
| `table/atomic.ts` | `table/atomic.ts` | Verbatim |
| `table/TableWidget.ts` | `table/TableWidget.tsx` | **Reimplemented** (see below) |

## Dropped upstream modules (and why)

The plan's explicit "do not port" list:

- `remoteCursors.ts` — Yjs/`y-codemirror.next` collaboration; no CRDT in this slice.
- `mermaid/` (`MermaidWidget.ts`, `renderer.ts`, `sanitize.ts`, `cache.ts`) —
  drops the whole mermaid render branch. Recorded here so nobody later wonders
  where the diagram support went.
- `paste.ts` — image/URL paste into the vault; needs attachment storage.
- `slash.ts` — slash-command block menu; not part of the console surface.
- `htmlToMarkdown.ts` — HTML→Markdown paste conversion.
- `noteHeader.ts` — inline note title + Properties panel; the console has its own
  Files header. `frontmatter/parse.ts` is still kept because
  `frontmatterView()`'s `invalid` branch uses it (the Properties panel is never
  mounted, so `propertiesMode` stays `"source"`).
- `folding.ts` — fold placeholder + hover chevrons.
- `indentGuides.ts` — per-indent list rules.
- `formatting.ts` — Mod-b/i/… inline formatting keymap.

Additional drops decided during this port:

- `blocks.ts` — upstream's blockquote/list line decorations. **Not in the plan's
  port list and deliberately omitted.** `livePreview.ts`'s own reference to
  `./blocks` only appears in a comment (`cm-blockquote`), so no code depends on it.
- `lists.ts`, `selection.ts`, `titlePlan.ts`, `headerFocus.ts`, `activeNoteBinding.ts`,
  `activeView.ts`, `effectDispatch.ts`, `reactWidget.ts`, `commands.ts` — supporting
  modules for features this port does not include.
- `wikilinks.ts` — **dropped: gbrain does not use `[[wikilinks]]`.** See the
  "Wikilinks finding" section below.
- `theme.ts` (36 KB) — replaced by our own `../../theme.ts`, mapped to the console
  design tokens (per the plan).

## Seams cut (plan requirement 5)

1. **`../ipc` (Tauri bridge) → gone.** Only `openExternal` and the `NoteTitle`
   type were used by the modules we ported.
   - `livePreview.ts` and `table/TableWidget.ts` now define a tiny local
     `openExternal(url)` that calls `window.open(url, "_blank", "noopener,noreferrer")`.
   - `wikilinks.ts` was the only consumer of `NoteTitle`; it is dropped, so the
     local `NoteTitle` type is unnecessary.

2. **`mermaid/MermaidWidget` → dropped; `table/TableWidget` → kept.**
   - `livePreview.ts` no longer imports `MermaidWidget`; the `kind === "mermaid"`
     branch is removed.
   - `fenceKind.ts` no longer reports `mermaid`/`mmd` (`FenceRender` is `"html"`
     only), so a ```mermaid fence degrades to a normal, highlighted, copyable
     code block everywhere.
   - `../preview` (`previewKind`) is vendored as the sibling `preview.ts`.
   - `../clipboard` (`copyText`) is vendored as the sibling `clipboard.ts`, with
     the Tauri plugin import removed (web Clipboard API + `execCommand` fallback).

3. **`TableWidget.tsx` → `TableWidget.ts` (written by us).** Upstream's widget is
   a React component built on `../reactWidget`, `../../menuPlacement` and
   `../../ipc`, none of which this port may include (and the plan calls for a pure
   CodeMirror table with no new deps). The port keeps every behaviour that
   matters — always-rendered table, click-a-cell-to-edit, one planner-built
   transaction per commit, add row/column, link handling — as a plain
   `WidgetType` using imperative DOM. The cell right-click context menu and the
   Enter/Tab cell-to-cell navigation are **not** reproduced; structural row/column
   edits are available through the two `+` buttons.

## Other local modifications

- **Import path rewrites.** Upstream's app-internal imports (`../ipc`,
  `../preview`, `../clipboard`, `../frontmatter/parse`) were rewritten to
  installed `@codemirror/*` / `@lezer/*` packages and sibling vendored files,
  using explicit `.ts` extensions as this repo's `allowImportingTsExtensions`
  requires. `frontmatter/parse.ts` imports `FrontmatterRange` from
  `../frontmatter` (upstream: `../editor/frontmatter`).
- **Strictness fixes for this repo's compiler settings.** This repo enables
  `noUncheckedIndexedAccess`; upstream appears not to. Array-index results from
  regex `exec` are accessed with `!` in `tasks.ts` (`m[1]`, `task[1]`) and
  `ofm/callout.ts` (`m[1]`, `m[3]`), and `ICON.note` gained a `?? ""` fallback.
  No logic changed.
- **`codeLanguages.ts` trimmed.** Upstream lists ~14 languages whose `load()` is
  a dynamic import of separate `@codemirror/lang-*` packages (javascript, python,
  rust, json, yaml, sql, css, html, go, java, cpp, shell, legacy-modes). Those
  packages are not in the dependency allowlist for this port, so the list is
  reduced to `markdown` only. Other fenced languages still render as plain
  code blocks; they simply have no nested grammar.
- **Doc comments** in `fenceKind.ts`, `clipboard.ts`, `codeFence.ts`,
  `codeLanguages.ts`, `livePreview.ts`, `table/render.ts` and `table/TableWidget.ts`
  were amended to point at the seams/drops above.
- **`ofm/hashtag.ts` `tagCompletions`** is kept (it is exported API of `ofm/`),
  but this console does not mount an `autocompletion()` config, so nothing calls
  it; only the always-on `hashtagPills` decoration is wired.

## Wikilinks finding (plan §1.5 / risk 3)

**gbrain does not use `[[wikilinks]]`.** `src/agent/tools.ts` exposes
`get_backlinks`, but that is a gbrain graph tool; graph edges are created with
the `add_link` **operation** (see `docs/slice-5-findings.md`), and note bodies use
ordinary `[text](url)` markdown links. A repo-wide search for `[[` finds only
array literals and POSIX shell `[[:space:]]` classes — no wikilink syntax.

Consequently `wikilinks.ts` is **not ported**, and the two places in
`livePreview.ts` that existed only to leave wikilink marks alone (the
`wikilinkRe()` viewport scan and the `inWiki()` guard) were removed. Rendering
links that mean nothing would be worse than not rendering them.
