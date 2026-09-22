# Console design system — design

**Goal:** Give the console a design system it did not have. Today's styling is nine flat hex
colours, five hand-rolled composite classes, and no scale for type, spacing, radius, shadow or
motion. `Tone`/`TONE_CLASS` is copy-pasted verbatim into three pages. Dark mode is a lie: the
document is hardcoded `class="dark"` and nothing reads the class. This design ports qm's
front-end style system — the same colours, the same 32px control rhythm, the same radii — into a
two-tier token layer, eighteen primitives, a real light/dark/system switcher, a `/design-system`
route that renders every primitive from the production components, and a token-discipline test
that keeps the whole thing from rotting back into hardcoded hex.

The reference is qm (`C:\Users\juanp\Desktop\qm`), specifically its **admin kit**
(`qm/plugins/admin`) rather than its chat SPA — §1 argues that choice. The work landed in nine
commits on `feat/console-shell-redesign`, `03982f4..ffd64ca`, over 42 files: 3,974 insertions,
1,015 deletions.

**Problem before this work** (all line references below are against `1b1b3be`, the commit this
branch's design-system work starts from — the current tree no longer contains them):

- `src/console/styles.css` was 156 lines. Its palette (`styles.css:3-16`) was a plain Tailwind v4
  `@theme` block holding nine literal hex colours (`--color-bg: #0b0c0e` through
  `--color-danger: #f87171`) plus two font stacks and `--spacing`. Plain `@theme` *copies* each
  declared value into every utility it generates, so `.bg-bg` carried `#0b0c0e` as a literal.
  Redefining `--color-bg` at runtime therefore changed nothing, which is the precise mechanical
  reason the console could not switch themes — not an unfinished feature, a wrong keyword.
- Five hand-written single-property rules (`styles.css:20-24`: `.text-muted`, `.text-ok`,
  `.text-warning`, `.text-danger`, `.border-subtle`) duplicated what Tailwind would have
  generated from the same token names anyway, plus `.border-warning` (`styles.css:25`), a
  *composite* (`border: 1px solid …`) with no utility equivalent.
- Five composite classes carried the console's whole visual identity: `.card`, `.field`,
  `.nav-item`, `.btn-primary` and `.border-warning`, roughly 137 live call sites between them.
  There was no `Button`, no `Card`, no `Badge`, no `Table`; the markup was written inline across
  23 `.tsx` files.
- `Tone`/`TONE_CLASS` existed three times. `pages/Schedules.tsx:17,19` declared and exported the
  union; `pages/Runs.tsx:6,22` imported `Tone` *from Schedules* and then declared its own
  `TONE_CLASS` map anyway; `pages/Health.tsx:23` declared a third, typed `Record<string, string>`
  rather than `Record<Tone, string>`.
- `src/console/index.html:2` was `<html lang="en" class="dark">`. Nothing read that class — the
  `@theme` literals were already dark — so it was decoration on a decision nothing could change.
- `src/console/editor/theme.ts` built its CodeMirror theme out of `var(--color-*)` strings handed
  to CodeMirror at runtime and hardcoded `{ dark: true }` on the `EditorView.theme` call.

**Non-goals (explicitly out of scope):**

- **Any backend change.** No route, table, contract or refusal body is touched. Where a page's
  two-click flow looks like a UI affordance and is actually a server contract (§6.1, §6.2), the
  flow is left alone and only its class names change.
- **Redesigning any page.** This restyles. `Access.tsx`'s permission logic, `Runs.tsx`'s honesty
  rules (a `null` `costUsd` renders "not priced", never `$0.00`; the agent's closing message stays
  labelled a self-report), and every pure function below the component boundary are untouched.
- **A component tree.** `ui/` is one module plus one file for `Icon`, mirroring qm's
  `plugins/admin/ui/shared.ts`. A dozen primitives in a dozen files is a filing system, not an
  abstraction.
- **`clsx` / `tailwind-merge`.** qm builds class strings by template-literal concatenation and so
  does `ui/classes.ts`; §3 argues that the rule which makes merging unnecessary is worth more
  than the library that papers over its absence.
- **Sidebar resizing, multiple editor tabs, search/backlinks/graph view.** Deferred by the shell
  redesign spec (`docs/superpowers/specs/2026-09-21-console-shell-redesign-design.md`) and still
  deferred. Light mode was on that same deferred list and is the one item this design takes off it.

---

## What already exists and gets reused

- **The pure-helper convention.** `App.tsx`'s `phaseFor`, `router.ts`'s `parseRoute`,
  `AppShell.tsx`'s `sourceNavigation`: every decision an operator can observe is a named,
  exported, DOM-free function, because this repo has no DOM test harness — no jsdom, no
  testing-library. That convention is the entire reason `ui/` is split into `classes.ts` and
  `index.tsx` (§3).
- **`src/console/router.ts`.** The `Route` union and its pure `parseRoute`/`routeToPath` pair
  already existed; the design-system route is one arm in each (`router.ts:18`, `router.ts:52`,
  `router.ts:89`) and one branch in `AppShell.tsx:167`.
- **`src/console/settings/tabs.ts`.** The registry, `visibleTabs`, `isSettingsTab` and
  `resolveTab` already existed. `appearance` is one more entry (`tabs.ts:54`), and its position in
  the list is load-bearing — see §6.3.
- **`src/console/editor/index.ts`'s `Compartment` discipline.** `mountMarkdownEditor` already
  reconfigured the editor's *mode* through a CodeMirror `Compartment`
  (`editor/index.ts:140,155,173-176`) rather than remounting. The theme flip is the same mechanism
  applied a second time (`editor/index.ts:146,154,177-180`), for a stronger reason (§4.3).
- **`src/console/settings/SettingsModal.tsx`'s mechanics.** Press-and-release backdrop check,
  stacked-surface Esc deferral, focus capture and restore, opacity-only animation and the
  containing-block reason for it. Every one of those exists because a simpler version broke
  something. `Dialog` (`ui/index.tsx:420-489`) generalizes the shell and changes none of them.
- **qm's admin kit** at `C:\Users\juanp\Desktop\qm\plugins\admin` — `public/index.html`'s
  `:root`/`:root.dark` blocks, `public/admin-components.css`, `ui/shared.ts`, `ui/design.ts` — as
  a read-only reference, the same way `gbrain` is read-only.

---

## 1. Where the system comes from, and why the admin kit

qm has **no React and no Tailwind in its own source**. Its UI is two Vite/Lit plugins that author
plain global CSS driven by CSS custom properties. There are two candidate surfaces:

| Surface | Path | What it is |
|---|---|---|
| Chat SPA | `qm/plugins/web-ui/` — `src/shell.css`, 12,618 lines | shadcn/oklch token vocabulary, theme runtime, `icon()` helper |
| **Admin console** | `qm/plugins/admin/` — `public/index.html`, `public/admin-components.css` (1,904 lines), `ui/shared.ts`, `ui/design.ts` | **the direct analog of Mobrain's console** |

**The admin kit is what got ported**, for three reasons that all point the same way. It is an
admin console styling an admin console, so its inventory is the inventory this console needs —
tables, dense rows, badges, pagers — rather than a chat transcript's. Its token names already
lined up with Mobrain's own: `--bg`, `--surface`, `--subtle`, `--text`, `--muted`, `--border`,
`--ok`, `--warn`, `--danger`. And its dark values are hand-tuned to the same hue-250 OKLCH family
as the chat SPA's (`--surface: oklch(0.205 0.024 250)` is exactly `shell.css`'s `--card`), so
porting the admin kit still lands on qm's brand palette rather than on a second one.

Because qm is Lit plus hand-written global CSS, **what was portable was the styling system and
three patterns, not a component architecture**:

1. **Primitives as small functions in one shared module** — qm's `plugins/admin/ui/shared.ts`
   (`badge()`, `card()`, `table()`, `pager()`, `denseList()`), with class names built by plain
   template-literal concatenation. qm has no `clsx` and no `tailwind-merge` anywhere.
2. **A living style guide as a real route** — `plugins/admin/ui/design.ts`, served at
   `/design-system`, built from the production primitives, fronted by a `DESIGN_TOKENS` table.
3. **A token-discipline test** — `plugins/web-ui/test/css-vars.test.ts`, which parses the CSS as
   text and asserts that every no-fallback `var(--x)` names a property something defines.

Everything below the token values is therefore a translation, not a copy. qm writes semantic CSS
rules because it has no Tailwind; this repo has Tailwind, so the same computed values are
assembled as utility strings in pure functions instead of as a second stylesheet (§3).

## 2. `src/console/styles/tokens.css` (new) — the two-tier token layer

158 lines, two tiers, and the split is the whole reason theming works.

**Tier 1 — raw values, redefined per theme on `<html>`.** `:root` (`tokens.css:24-63`) and
`:root.dark` (`tokens.css:65-91`) carry qm's admin values verbatim: `--bg`, `--surface`,
`--subtle`, `--sidebar-active`, `--text`, `--muted`, `--border`, `--ink`, the `--danger`/`--ok`/
`--warn` trio, the four-token warning family (`--warn-text`, `--warn-strong`, `--warn-border`,
`--warn-surface`), the CTA triple (`--cta`, `--cta-hover`, `--cta-foreground`), `--trigger`,
`--scrim`, `--radius`, `--shadow`, `--sidebar-w`, `--maxw`, `--readw`. `color-scheme` is declared
in both blocks and is not decoration: it is what makes native scrollbars, form controls and the
caret follow the theme.

qm's control/section scale (`admin-components.css:1-9`) is declared once, theme-independent, at
`tokens.css:96-103`: `--control-height: 32px`, `--control-radius: 6px`, `--control-font: 13px`,
`--section-font: 14px`, `--section-gap: 24px`, `--control-gap: 8px`. This is the closest thing qm
has to a type and spacing scale and the reason every one of its controls lines up.

Two of qm's own blocks needed restating to survive the pairing invariant (§7, rule 2), and both
restatements are visually verbatim rather than re-tuned. qm's dark block defines
`--sidebar-active` and its light block does not, relying on nothing reading it in light mode;
`tokens.css:34` writes it out at the value qm's light sidebar actually paints. Symmetrically,
qm's light block defines `--trigger` and its dark block inherits it; `tokens.css:88` writes out
the same purple. The alternative was an exception list in the test, and an exception list is how
a pairing check stops being a check.

**Tier 2 — the Tailwind bridge, and the one keyword the whole port rests on.**

```css
@theme inline {
  --color-bg: var(--bg);
  …
}
```

`@theme inline` (`tokens.css:129-158`) is the entire mechanism. Plain `@theme` copies each
declared value into every generated utility, so `.bg-bg` would carry the literal and redefining
`--bg` at runtime would change nothing — exactly the state described under **Problem before this
work**. `inline` keeps the `var()` reference in the emitted rule, so `.bg-bg` compiles to
`background-color: var(--bg)` and re-resolves the instant `:root.dark` swaps the tier-1 value.
`@custom-variant dark (&:where(.dark, .dark *))` at `tokens.css:18` gives Tailwind's `dark:`
variant the same class to key off.

**Keeping the `--color-*` spellings was worth more than tidying them.** The bridge deliberately
re-uses the names ~260 existing call sites already write — `text-muted`, `text-ok`,
`text-warning`, `text-danger`, `border-subtle` — so all of them re-theme with no edit at all, and
the five hand-written rules at the old `styles.css:20-24` were deleted rather than ported. (The
plan estimated ~240; the commit that landed it counted ~260. Neither number is load-bearing; the
property is that the count of *edited* call sites is zero.) The one rename is
`--color-accent` → `--color-cta`, and it has live references: `editor/theme.ts` held twelve and
`styles.css`'s `.tree-row.is-selected` held another. All moved in the same commit and **no
back-compat alias was kept** — a dead alias is how a token vocabulary ends up with two names for
one colour.

`.border-warning` could not survive as a colour utility, because it was a composite. Its ~21 call
sites are all standing warning blocks and genuinely became `Notice` during the migration, not a
find-and-replace.

**`@import "tailwindcss"` deliberately stays in `styles.css:1`, not here.** Tailwind v4 anchors
automatic source detection at the directory of the file holding that import; moving it into
`styles/` would scan only `styles/` and generate zero utilities for the 23 `.tsx` files one level
up. `tokens.css` holds only the two tiers and is imported immediately after (`styles.css:2`).
The comment at `tokens.css:11-15` records this so nobody tidies it later.

What remains in `styles.css` (172 lines) is the set of genuine one-offs Tailwind cannot express:
the CodeMirror editor chrome, the GFM table widget, the shell layout, the settings modal, and the
global focus ring (`styles.css:163`, `outline: 2px solid var(--color-cta)`). It names **zero**
colours of its own — the last literal, the settings backdrop's `rgba(0, 0, 0, .6)`, became
`--scrim` used at `color-mix(in srgb, var(--scrim) 60%, transparent)` (`styles.css:130`). The
alpha lives at the call site rather than in the token so the token stays a colour something else
can reuse at a different strength, and the scrim is its own near-black per theme rather than a
mix of `--text`, which inverts and would have painted white over the page in dark mode.

## 3. `src/console/ui/` (new) — eighteen primitives, split in two

`ui/index.tsx` exports eighteen components — `Button`, `NavItem`, `Link`, `IconButton`,
`ConfirmButton`, `Field`, `Input`, `Select`, `Textarea`, `Card`, `Badge`, `TableWrap`, `Table`,
`Empty`, `Notice`, `Toolbar`, `Spinner`, `Dialog` — plus `Icon`, re-exported from `ui/Icon.tsx`
(`ui/index.tsx:27`).

**Why the split.** `ui/classes.ts` is pure: it imports nothing, touches no React and no DOM, and
holds every styling decision as an exported function (`toneClass`, `buttonClass`, `navItemClass`,
`linkClass`, `badgeClass`, `fieldClass`, `noticeClass`, `tableClass`). `ui/index.tsx` is a thin
wrapper over those and decides nothing a test would want to assert. That is not a preference: this
repo has no DOM harness, so **a decision made inside a component is a decision no test can
reach**. The same reasoning put `confirmPress` and `confirmDisarmsOnBlur`
(`ui/classes.ts:390-392`, `ui/classes.ts:404-406`) in the pure module even though neither returns
a class string — the first press of a destructive control never deleting anything is exactly the
kind of claim that deserves an assertion.

**Rule 1: every class name is a whole literal.** Never `` `text-${tone}` ``. Tailwind finds the
classes it must generate by scanning these files as plain text, so a spliced name produces no CSS
at all: the class appears in the DOM and styles nothing, which is a silent failure rather than a
loud one. `test/unit/console-ui.test.ts:403-429` asserts it directly.

**Rule 2: no two utilities in one returned string may set the same property.** The order of names
in a `class` attribute does not decide the winner — the order Tailwind emits them in does, and
that is not something a call site can see. So `BUTTON_CHROME` (`ui/classes.ts:95-100`) carries no
colour at all, and each entry of `BUTTON_VARIANT` (`ui/classes.ts:107-132`) supplies exactly one
background, one border colour and one text colour. This is also why the module does not want
`tailwind-merge`: with rule 2 held, there is nothing to merge.

Rule 2 is what turned two would-be `className` overrides into named props rather than escape
hatches. `ButtonLayout` (`ui/classes.ts:68`, `BUTTON_JUSTIFY` at `ui/classes.ts:138-142`) exists
because the chrome used to hardcode `justify-center`, so `Schema.tsx`'s disclosure row — label
left, badge right — could not ask for `justify-between` and rely on winning, and worked around it
with a `<span className="flex w-full justify-between">` inside the button. `NoticeLayout`
(`ui/classes.ts:267`, `NOTICE_LAYOUT` at `ui/classes.ts:269-280`) exists for the same reason at a
larger scale — see §6.4.

**The one deliberate exception is `tableClass`** (`ui/classes.ts:365-377`), and it is deliberate
precisely because rule 2 has no answer for per-column alignment. `TABLE_CHROME`'s
`[&_th]:text-left` compiles to `.\[\&_th\]\:text-left th`, specificity (0,1,1), which outranks a
plain `.text-right` (0,1,0) written on the `th` itself. `Spend`'s money column silently drifted
left, and `Spend.tsx` and `Schema.tsx` each grew a hand-written descendant variant to
out-specify it — two call sites reasoning about specificity, and a third that would have got it
wrong. The override literals (`ui/classes.ts:331-351`) each carry a `:nth-child()`, so their
compiled selectors are (0,2,1) and win on the cascade rather than on emit order. A column past
`TABLE_MAX_COLUMNS` (`ui/classes.ts:355`, currently 8; the widest table in the console has five)
**throws** rather than being ignored, because being ignored is the exact failure the function
exists to remove.

**The specs are qm's, translated to utilities.** `--spacing` is 4px, so `px-3 py-1.5` is exactly
qm's `padding: 6px 12px`. `enabled:hover:` is used throughout rather than a bare `hover:` because
qm scopes every button hover with `:hover:not(:disabled)` — a disabled control that lights up on
hover reads as clickable and is not. `primary`'s disabled state drops to the flat
`subtle`/`muted` pair at full opacity rather than the shared `opacity: 0.45`, because a 45%-faded
solid CTA still looks like a live filled button. `danger` is red *text* on the standard chrome:
qm never fills a destructive button, so the dangerous action is never the loudest thing on screen.
`badgeClass` (`ui/classes.ts:220-226`) mixes its fill and border out of its own `color`, so a tone
only ever sets one property and the fill cannot drift out of step with the text.

One knowing deviation: `bg-current/7 border-current/14` mixes in oklab where qm's
`color-mix(in srgb, currentColor 7%, transparent)` mixes in sRGB. At 7% and 14% against the same
`currentColor` the two are not distinguishable, and the utility form keeps the class names whole
literals (rule 1) instead of an underscore-escaped `color-mix()` arbitrary value.

Two primitives exist because a `Button` genuinely could not be them. `navItemClass`
(`ui/classes.ts:169-177`) is `.nav-item` ported class for class: full width, left-aligned,
borderless, quiet until current. A caller cannot reach into `Button` with
`justify-start border-0` and rely on winning, so a nav rail gets a different primitive rather
than a prop that quietly undoes half of `Button`. It deliberately sets **no** font size — the old
`.nav-item` set none and inherited the page's, and pinning it to `--control-font` would have
shrunk the settings nav, which is a redesign. `linkClass` (`ui/classes.ts:199-207`) exists because
`buttonClass('link')` never worked on an anchor at all: its hover is `enabled:hover:underline`
and `:enabled` matches only form controls, so the underline never appeared. Its `notice` surface
is a real decision, not a convenience — on dark `--warn-surface` (an olive fill) `--cta` is a navy
that is all but invisible, so a link there inherits the notice's own guaranteed-legible copy
colour and carries a permanent underline instead.

`Icon` (`ui/Icon.tsx:21-37`) wraps every lucide node and pins three attributes once:
`strokeWidth={1.9}` (lucide's default 2 reads heavy beside 13px control text; 1.9 is qm's value),
`aria-hidden` + `focusable="false"` (every icon sits beside a label or inside a button that
carries an `aria-label`), and size as an explicit `width`/`height` prop rather than a CSS rule, so
an icon can never disagree with the box it sits in and reflow it a frame later.

## 4. Theming

### 4.1 `src/console/theme.ts` (new)

Ported from qm's `plugins/web-ui/src/settings.ts` and the admin toggle at
`qm/plugins/admin/public/index.html:6591-6600`, and split on the same line as everything else:
the decision is pure, and only the functions below it touch `document` or `localStorage`.

`resolveTheme(choice, prefersDark)` (`theme.ts:24-28`) is the pure core, and its shape encodes the
bug it guards against: an explicit choice always beats the OS, because `system` is a *third
answer*, not a fallback. Treating it as a fallback is how a user who picked Light gets dark anyway
at night. `storedTheme()` (`theme.ts:33-41`) reads the key `theme` — unprefixed, qm's own, so a
deployment serving both consoles on one origin agrees with itself — and reads anything
unrecognised, including a `localStorage` that throws, as `system`. `applyTheme`
(`theme.ts:53-58`) toggles **both** `.dark` and `.light` on `<html>`, exactly as qm does: `.dark`
is what the tokens and the Tailwind variant key off, and `.light` is what lets a rule say "only in
light mode" without spelling it `:not(.dark)`, which cannot be written as a Tailwind variant
selector.

`watchSystemTheme()` (`theme.ts:133-143`) keeps `system` honest through two listeners, because
there are two ways the right answer changes without this tab doing anything: the OS flips while
`system` is selected, and another tab of this console picks a theme, which arrives as a `storage`
event and must not leave two tabs disagreeing. `main.tsx:10` calls it once for the life of the
page.

The user-facing control is `pages/Appearance.tsx` — three `Button`s carrying `Sun`/`Moon`/
`Monitor`, `aria-pressed` on the current one — reached as the `appearance` settings tab. It seeds
its state from `storedTheme()` rather than holding it locally, because the tab is lazily mounted
and unmounted on every tab switch and component state alone would forget the selection the moment
somebody looked at Health and came back.

### 4.2 The pre-paint script

`src/console/index.html:17-28` sets the theme class inline, before the stylesheet, in a plain
`<script>`. A module script runs after first paint, so a dark-mode operator would get a full white
flash on every cold load. It duplicates `resolveTheme`/`applyTheme` in about six lines on purpose:
it cannot import them, because no bundler has run yet, and the alternative to the duplication is
the flash. The old hardcoded `class="dark"` on `<html>` is gone.

### 4.3 The CodeMirror compartment

`editor/theme.ts` hardcoded `{ dark: true }` on its `EditorView.theme` call. That flag is not
cosmetic: CodeMirror reads it for selection-layer compositing, for the default caret and
drop-cursor colours, and for which base theme applies. Left `true` in light mode, the colours
re-painted from `var(--color-*)` while CodeMirror still believed it was on a dark surface. The
theme is now two built extensions, `chromeDark` and `chromeLight` (`editor/theme.ts:197-198`),
selected by `consoleEditorTheme(dark)` (`editor/theme.ts:216`).

**It swaps through a `Compartment`, not a remount** (`editor/index.ts:146,154`, exposed as
`setDark` at `editor/index.ts:177-180`). Remounting would also have worked, and would also have
discarded the operator's unsaved draft, caret and scroll on every theme flip. A compartment
reconfigure carries no changes, so `state.doc`, `state.selection` and the scroll element are the
same objects afterwards — the draft survives *by construction* rather than by careful
re-hydration. The mode already used this mechanism; the theme is the second user of it, for a
stronger reason.

Getting the flip into React needed one new thing, because `applyTheme` toggles a class
imperatively and a class toggle is invisible to React. `watchTheme` (`theme.ts:109-120`) is a
`MutationObserver` on `<html>`'s `class`, and it fires **only on a real transition** — `applyTheme`
rewrites both classes on every call, including the many that change nothing (a `storage` event
from another tab, an OS flip while an explicit choice is selected), and a subscriber that rebuilt
itself on each of those would be paying for noise. It lives in `theme.ts`, next to the code that
writes the class, rather than in the page that needed it first: a page component is the wrong
owner of a document-wide observer, and the second consumer would otherwise hand-roll a second one
watching the same attribute. `pages/Editor.tsx:51-52` subscribes; `pages/Editor.tsx:165` forwards
to `setDark`.

## 5. `src/console/pages/DesignSystem.tsx` (new) — the review surface

343 lines, ported from `qm/plugins/admin/ui/design.ts`. Eight sections — Tokens, Buttons, Fields,
Badges, Cards/notices/empties, the confirm gate, Tables, Dialog — each built from the **real
exported primitive**, never a copy of its markup. A style guide that reimplements what it
documents drifts from the thing it is supposed to prove, and the drift is invisible precisely
because the guide keeps looking correct. The `ConfirmButton` specimen is wired to real state so
the "Keep it" button beside it is a real one rather than a picture of one
(`pages/DesignSystem.tsx:83-85`).

The token table is qm's `DESIGN_TOKENS` verbatim, descriptions included — they are the vocabulary,
and paraphrasing them is how two people end up using `--subtle` for two different jobs — plus one
row qm does not have: `--scrim`, because it is the token that replaced the console's last colour
literal, and a scrim nobody can see listed is a scrim somebody re-hardcodes.

It is a **real route**, not a dev-only toggle: `router.ts:18`, `router.ts:52`, `router.ts:89`, and
`AppShell.tsx:167`. It replaces the editor in `<main>` rather than opening as a modal, because it
is a full page of specimens and has to be reviewable beside the real sidebar to show the
primitives at their actual widths. It exists as a route at all because this repo has no DOM test
harness: the unit tests can assert that `buttonClass('primary')` contains the CTA background, and
only this page can show that the CTA background is legible in both themes.

## 6. Decisions that went against the plan

Five places where the code as landed disagrees with the approved plan. In each, the plan's
instruction was a reasonable read of the code from outside, and implementing it would have changed
behaviour the restyle was not allowed to change.

### 6.1 `Runs.tsx`'s revert is not a `ConfirmButton`

The plan listed `Runs.tsx:842` among the three "press-twice confirms" that `ConfirmButton` would
absorb. It is not one. It reads like a two-click confirm and it isn't: the first click is a real
`POST` that reverts outright when the range holds only this run's own commits, and **only** a 409
`revert_concurrent_writers` (`pages/Runs.tsx:570`) puts the second button on screen. The second
step belongs to the control plane, not to this component.

Wrapping it would have cost two things. Every ordinary revert would have grown a click it does not
need, and the concurrent-writers path would have grown to four. Worse, it would have moved the
confirmation off the control plane and into the browser, where it is not a contract — the server
would still have accepted a first-click revert that the UI had decided to withhold. The argument
is recorded at the call site (`pages/Runs.tsx:857-865`) rather than only here, because the next
person to read that markup will see two buttons and reach for the primitive.

### 6.2 `Sources.tsx`'s remove is not a `ConfirmButton` — and this is the sharper case

The plan listed `Sources.tsx:245` for the same treatment, and the same objection applies with one
additional edge that makes it decisive: **the first click is a real removal.**
`requestRemove` (`pages/Sources.tsx:166`) sends `mode: 'remove'` with no `confirm`. A server that
does not demand confirmation removes the Source on that first click and the flow ends there.
"Confirm remove" and "Keep it" render *only* because the server answered 409
`confirmation_required` (`pages/Sources.tsx:174`) and handed back gbrain's own `--dry-run` impact
preview, and only a preview that actually arrived unlocks the destructive second call.

So adopting `ConfirmButton` would put a confirmation click in front of every ordinary archive and
remove, including the ones the server was happy to do immediately. It would let the second click
fire without the operator ever having been shown what the removal destroys, because a local armed
boolean skips the probe entirely. And its disarm-on-blur would silently discard a preview the
server had already produced. Archive is single-click for exactly the same reason — nothing
server-side asks it to confirm. Moving a server-side contract into local state makes the page lie
about who is deciding. The comment at `pages/Sources.tsx:288-313` says so; an earlier version of
it argued from the 409 probe alone and missed the decisive point, and commit `dd2a3d2` exists
solely to correct that.

### 6.3 `appearance` goes last in tab order

The plan already called this and the code holds it, but it is worth restating because it looks
like a cosmetic choice and is not. `resolveTab(null, isAdmin)` (`settings/tabs.ts:86-92`) returns
the *first visible tab*, so whatever sits at the top of `SETTINGS_TABS` is what opening settings
lands on. Putting a per-operator preference there would move every admin off Sources and every
member off Schedules, on the way to a tab most people open once, and would invalidate four
existing assertions. It is `minRole: 'viewer'` — visible to everyone — because the theme is a
property of the person looking at the screen, not of their permissions, and an admin-gated dark
mode is a member staring at the wrong one (`settings/tabs.ts:34-55`).

### 6.4 `Card` gets no `tone` prop; `Notice` gets a `layout` instead

The plan's Layer 2 table promised `<Card tone="warning">` for the multi-line warning blocks.
It is not there, and the absence is the decision. `Card tone="warning"` and `Notice` would paint
the same surface out of the same three tokens (`--warn-surface`, `--warn-border`, `--warn-text`),
and **two primitives painting one surface is how the two drift apart** — one of them gets a
padding fix, the other does not, and nothing looks wrong until they are seen side by side.

The migration paid for that gap before it was closed. Phase 1 shipped only `Notice`'s `row`
shape — a `flex items-start` row — so every multi-line warning became a row and then needed a
`<div className="w-full">` wrapper (about ten sites) or a `flex-col` passed through `className`
(about five) to get its children back onto separate lines. Both are the call site paying for a
missing variant, and `flex-col` passed that way is exactly the rule-2 coin flip `classes.ts`
forbids: `flex-row` and `flex-col` both set `flex-direction`. `layout="stack"`
(`ui/classes.ts:269-280`) is therefore the warning card the plan named, wearing the notice's skin,
with only ever one flex-direction emitted.

`stack` uses `items-start`, not `items-stretch`. Stretch is the tempting one — it is exactly what
the deleted `w-full` wrappers did — but a flex item is blockified, so a stretched `<a>` becomes a
full-width block and the dead space beside its text turns into a live click target. `items-start`
gives each child `fit-content`, which for a paragraph is still the full container width (prose
wraps either way) and for a link is the link. The one place a `w-full` survives is `Upgrades`'
checklist rows, moved onto the row itself: each draws a `border-b` under itself, so at
`fit-content` the dividers would have come out ragged at a different width per item, and
blockifying costs nothing there because the row is not a click target.

### 6.5 `ConfirmButton` gained a controlled mode after the fact

Phase 1 shipped only the uncontrolled form, and migrating the schedule-delete flow silently
dropped its "Keep it" button — leaving blur as the only way to disarm a destructive action, which
is not an affordance anyone can see. That is a copy and affordance change the migration was not
allowed to make. `ConfirmButton` (`ui/index.tsx:145-188`) now takes `onArm` plus optional
`armed`/`onCancel`; supplying `armed` makes it controlled, which is what lets the caller render
the explicit way out beside it. Blur-to-disarm is **off** while controlled
(`confirmDisarmsOnBlur`, `ui/classes.ts:404-406`), because reaching for the sibling "Keep it"
blurs the armed button and disarming there would yank the escape hatch out from under the pointer
— worse than the trap it was guarding against.

### 6.6 Two smaller as-built divergences

`SettingsModal.tsx` stays as a pass-through over `Dialog` rather than collapsing into `ui/`:
`test/unit/console-settings-modal.test.ts` asserts those predicates at the path `AppShell`
actually imports, which is the only place an assertion proves the *settings modal's* Esc and
click-away behaviour rather than the primitive's.

`Upgrades`' run state and `Access`'s connection state stay plain text rather than becoming
`Badge`s. Neither has a tone mapping anywhere in the console, and inventing one would colour
`rolled_back` as either a success or a failure when the page's whole argument is that it is
neither. `Upgrades` did gain one exported helper, `stepTone` (`pages/Upgrades.tsx:62`), because
its step chips genuinely became `Badge`s and the status-to-colour mapping was an inline ternary
chain; its test asserts the four statuses map to four **distinct** tones, since a failed migration
must never share a colour with a finished one.

## 7. Testing

**`test/unit/console-tokens.test.ts` (new, 269 lines)** — ported from
`qm/plugins/web-ui/test/css-vars.test.ts`, and extended. None of it renders anything; it reads the
console's CSS and TypeScript as text, which is what makes it possible at all here.

1. **Every no-fallback `var(--x)` names a property something defines**
   (`console-tokens.test.ts:84-114`). A `var(--x)` nothing defines resolves to nothing: a colour
   silently becomes transparent, a padding becomes zero, the page still renders, and nothing
   throws. qm scans only its CSS; this scans **the `.ts`/`.tsx` sources too**, because
   `editor/theme.ts` builds its CodeMirror theme out of `var(--color-*)` strings and the
   `--color-accent` → `--color-cta` rename broke all twelve of its references at once. A CSS-only
   scan would have passed that commit.
2. **Light and dark define the same colours** (`console-tokens.test.ts:116-141`), in both
   directions, plus a guard on the guard (both blocks must actually have been found, so a broken
   block regex cannot make the suite pass vacuously by comparing two empty maps) and a check that
   the two blocks genuinely differ — a theme that copies the other is not a theme. Light mode is
   the one nobody looks at daily, so this is the rule that keeps it from rotting.
3. **No colour literal outside the theme blocks** (`console-tokens.test.ts:143-163`). This is what
   stops the system drifting back to nine hardcoded colours. `styles.css` is held to the stronger
   form: it names no colour at all.
4. **Every `--color-*` a `.ts` reads survives into the built CSS**
   (`console-tokens.test.ts:165-247`) — **and this one must assert against build output, not
   source text.** Rule 1 calls a token "defined" because `tokens.css` writes its name, but
   `@theme inline` does not put a theme variable in the bundle for being declared: Tailwind emits
   one only when a utility it generates derives from it. `editor/theme.ts` reads nine of them
   (`--color-bg`, `--color-cta`, `--color-danger`, `--color-muted`, `--color-ok`, `--color-subtle`,
   `--color-surface`, `--color-text`, `--color-warning`) from JavaScript, handed to CodeMirror at
   runtime — entirely outside Tailwind's view. Today they survive because source detection reaches
   the `.ts` files; narrow `@source`, move the editor out of the scanned root, or let the
   directory fall under a gitignore rule, and every one resolves to nothing, CodeMirror paints a
   dead `var()` as no colour at all, the editor goes monochrome, and *every text-scanning rule
   above still passes*. This is not hypothetical: `--color-cta-foreground` dropped out of the
   emitted `:root` the moment `.btn-primary` died, which is the mechanism, observed live. So the
   test shells out to vite's own bin (via `process.execPath`, no shell in between — the repo path
   contains a space), builds into a disposable `dist/console-token-check`, and asserts the emitted
   CSS both declares every token and is a real stylesheet over 10,000 bytes, so a near-empty build
   cannot satisfy it vacuously. It is written against whatever the sources happen to reference
   rather than against a list, so it keeps holding for the next file that reads a token from
   TypeScript.

Plus a rule of its own: **the bridge is `@theme inline`** (`console-tokens.test.ts:249-268`).
Losing the keyword would silently restore the un-themeable console and every other rule would
still pass, so the test asserts both that `@theme inline` is present and that a bare `@theme {`
is not — and that every bridge entry points at a tier-1 token rather than a literal.

**`test/unit/console-ui.test.ts` (new, 456 lines)** — the primitives' observable decisions. Tone
mapping is injective and the four pre-existing tones keep the exact classes the pages already use;
`primary` is the only variant that fills; destructive is red text, never a red fill; every chromed
variant sits on the same control height and radius; hover is `enabled:`-scoped on every variant;
a nav row is full-width and left-aligned where a button is neither; no surface of `linkClass` uses
`enabled:`, and a notice link never paints itself `text-cta`; a notice emits exactly one
`flex-direction`; a right-aligned column out-specifies the header rule rather than racing it, and
a column past the last literal throws; the first press of a `ConfirmButton` arms and never
confirms, and blur disarms only while nothing else owns the armed state. Two structural describes
enforce the module's own rules across every function: **no returned class sets the same property
twice** (`console-ui.test.ts:373-401`) and **every generated class name is a whole literal**, with
no unresolved template hole (`console-ui.test.ts:403-429`). `resolveTheme` is asserted here too
(`console-ui.test.ts:431-455`): an explicit choice beats the OS in both directions, and the
function is total over the union.

**`test/unit/console-editor.test.ts:137-145`** asserts `state.facet(EditorView.darkTheme)` is
`true` or `false` as passed. That is precisely the assertion the old hardcoded `{ dark: true }`
would have failed, and one the `var()` colours cannot satisfy on their own.

**Existing suites.** `console-router.test.ts` gained the `/design-system` round trip;
`console-settings-tabs.test.ts` was extended for the tenth tab; `console-upgrades.test.ts` gained
`stepTone`'s distinctness assertion; `console-runs.test.ts` and `console-schedules.test.ts` had
their `Tone` imports re-pointed at `ui/classes.ts`. No assertion was weakened to pass, per
`HANDOFF.md`.

**One fix shipped without a test, knowingly.** Commit `68d7230` corrects a pre-existing data-loss
bug in `pages/Editor.tsx`: one effect keyed on `[file, mode]` unconditionally re-seeded the buffer
from `file.content`, so toggling Edit / Done editing with unsaved text reverted the visible
document — and because `setValue` is annotated `programmatic`, no `onChange` fired and React's
draft kept the typed text, leaving `isDirty` true, the Save button reading dirty, and `save()`
sending the reverted buffer back. The correction is two dependency arrays
(`pages/Editor.tsx:148-153` seeds on the file alone; `pages/Editor.tsx:158` reconfigures on the
mode). No test accompanies it because the only extractable helper would return `file.content`,
which is equally true of the buggy version and would lock nothing; proving it needs a harness that
can render, toggle the mode and read the buffer back, and this repo has none. The bug predates
this work and is not caused by it.

## 8. Verification status

**Browser verification has been done**, by the orchestrator, against the dev stack after
`scripts/redeploy.sh`. Everything below was **measured via computed styles**, not eyeballed.

Confirmed:

- **Theme switch, end to end.** `<html>`'s class goes `dark` → `light`; `body` background goes
  `oklch(0.165 0.022 250)` → `rgb(255, 255, 255)`; `body` colour goes `oklch(0.975 0.005 250)` →
  `rgb(24, 24, 27)`; and the choice persists to `localStorage.theme`.
- **`Button`, against qm's spec exactly.** Secondary computes to `min-height: 32px`,
  `padding: 6px 12px`, `border-radius: 6px`, `13px` / weight `500` / `line-height: 18px`,
  `#ffffff` on `#18181b` with an `#e5e5e5` border. Primary computes to `--cta`
  `oklch(0.27 0.062 250)` on `--cta-foreground` `oklch(0.99 0 0)`.
- **The rest of the scale.** `Badge` at `3px 9px`, rounded-full, `currentColor` at `/0.07` fill and
  `/0.14` border, `12px`. `th` at `10px 12px` / `12px` / `#667085`. `td` at `12px` / `13px`.
  Control tokens resolving to `32px` / `6px` / `13px`. `--scrim` present in both theme blocks.
- **`/design-system` renders in both themes**, and the lucide icons are live.

**Not yet verified in a browser.** Stated plainly, because the boundary matters more than the
list:

- The settings-modal mechanics — Esc closing it, a drag-select released past the card edge *not*
  closing it, and focus returning to the ⚙ that opened it.
- The editor save path, including a second save against a stale sha.
- `ConfirmButton`'s controlled "Keep it" restoration (§6.5).
- The nine settings tabs in light mode.

Everything in that second list has unit coverage for its *decision* — `shouldCloseOnEscape`,
`shouldCloseOnBackdropClick`, `confirmPress`, `confirmDisarmsOnBlur`, `staleNotice` — and no
coverage for its *rendering*, which is exactly the gap a repo with no DOM harness cannot close
from a test. The `/design-system` route exists to make that gap walkable rather than to pretend it
is closed.

## 9. Known gaps and deferred work

- **Card headings shrank.** `Card`'s title is `--section-font` (14px, `ui/index.tsx:284`), qm's
  value. Seventeen `<h2 className="text-lg font-semibold">` headings were removed across the
  migration and one added back, so roughly sixteen page headings that rendered at 18px now render
  at 14px. This is the visual-parity choice landing, not a regression, but it is the most visible
  single change in the restyle and the one most likely to read as a mistake. Two 18px headings
  survive outside a `Card` (`pages/Runs.tsx:825`, `pages/Spend.tsx:220`).
- **The sidebar widened 260 → 280px.** `.sidebar` used to render at the 260px fallback of
  `var(--sidebar-w, 260px)` because nothing defined the token. `tokens.css:60` now defines it at
  qm's 280px and the fallback was dropped (`styles.css:69-74`), so the token is the only source and
  the sidebar genuinely gained 20px.
- **Two pre-existing unit failures are environmental, not code.**
  `test/unit/scheduler-main.test.ts` and `test/unit/seed-space.test.ts` fail on this machine
  because they reach a host-side `localhost:5432`. `brainstand-postgres-1` exposes `5432/tcp` but
  publishes **no host port** — Caddy is the only service publishing ports, by design and by the
  rule in `HANDOFF.md` — so a host-side connection cannot succeed. Neither test touches the
  console, and neither is affected by this work.
- **`Dialog` still carries the settings modal's class names as defaults**
  (`ui/index.tsx:422-424`: `modal-backdrop settings-backdrop`, `settings-modal`,
  `.settings-close`). The CSS in `styles.css` is already the generic modal shell in everything but
  its name. Renaming is deferred until a second caller exists, so the rename and the second
  caller can be reviewed together.
- **`Dialog`'s stacked-surface Esc guard is inert today** (`ui/index.tsx:491-507`). Nothing in the
  console currently renders a `.modal-backdrop` or `.context-menu` above the settings modal —
  `Sources` and `Runs` both use inline two-click flows, not modals (§6.1, §6.2). It stays at the
  cost of two lines so the first surface that *does* stack does not silently break Esc.
- **`TABLE_MAX_COLUMNS` is 8 against a widest-table-of-5.** Past it, `tableClass` throws with a
  message naming the fix. Adding a ninth column means adding a ninth literal to `COLUMN_RIGHT` and
  `COLUMN_CENTER`; rule 1 forbids generating them.
- **`.icon-btn` survives in `styles.css:91-96`** and is deliberately not one of the five retired
  composite classes: it is `AccountBox`'s 28px transparent control, smaller than the 32px scale on
  purpose because it sits inside a 48px account row.
