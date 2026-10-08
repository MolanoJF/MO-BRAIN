# Design system: where the look is set, and how to swap it

The console is styled by tokens. A component names a role (`bg-surface`,
`text-cta`, `rounded-[var(--radius-pill)]`), never a colour, radius or font, and
the value behind each name comes from one theme file. Changing the look is a
matter of editing that file. Changing a design system is a matter of adding a
file and changing one import.

## Where things live

| Path | What it holds |
|---|---|
| `src/console/styles/themes/molior.css` | The active theme: MOLIOR's colours (light and dark), shape, type, motion, and the Satoshi `@font-face` declarations |
| `src/console/styles/themes/qm.css` | qm's original values, kept as a second theme that proves the swap works |
| `src/console/styles/tokens.css` | The one line that picks the active theme, the Tailwind bridge (`@theme inline`), and the layout tokens that do not vary by theme |
| `src/console/styles.css` | Rules Tailwind cannot express: the editor chrome, tree rows, the settings modal, and the global focus ring |
| `src/console/ui/classes.ts` | The class string for every primitive. Pure and unit-tested |
| `src/console/ui/index.tsx` | The React primitives. Thin wrappers over `classes.ts`, with no styling decisions of their own |
| `src/console/fonts/` | The self-hosted font files and their NOTICE |
| `src/console/pages/DesignSystem.tsx` | The style guide, at `/design-system` once signed in. Every specimen is the real primitive |

## Changing a value

Edit the value in the active theme file. Keep the token name. Components read
names, so renaming one breaks every `var()` that reads it. The test suite will
catch a rename (rule 5 below).

What each token is for is written in `DESIGN_TOKENS` in `DesignSystem.tsx` and
in the comments of `molior.css`. Open `/design-system` in Light, Dark and System
after a change and check every specimen.

## Adding a theme

1. Copy `themes/molior.css` to `themes/<name>.css`.
2. Change the values. Keep every name, in both `:root` and `:root.dark`.
3. In `styles/tokens.css`, change the one import line to
   `@import "./themes/<name>.css";`.
4. Run the token and primitive tests:

   ```bash
   bun test test/unit/console-tokens.test.ts test/unit/console-ui.test.ts
   ```

5. Open `/design-system` in Light, Dark and System and check each specimen.

The token tests read every file in `styles/themes/`, whether or not it is
imported, so a half-finished theme fails before anyone switches to it:

- **Rule 2:** every colour in `:root` is redefined in `:root.dark`, and the reverse.
- **Rule 3:** no colour literal appears outside the `:root` and `:root.dark` blocks.
- **Rule 5:** every theme defines exactly the same `:root` token names.
- **Rule 4** builds the console and checks that every `--color-*` the TypeScript
  reads is in the bundle. It is the only rule that needs a build.

Rule 6 keeps corner radii out of `styles.css` and the class strings. The radius
is what a theme changes, so a pixel literal would stay the old shape.

qm is the working proof. Switching the import to `themes/qm.css` should still
render every page, with the tests green. Switch it back afterwards.

## Shape, type and motion

These are tokens, so a theme sets them:

- `--radius`, `--control-radius`, `--radius-pill` (the badge corner)
- `--shadow-overlay` (the only shadow in the console; the settings modal draws it)
- `--app-font`, `--app-font-mono`, `--label-font`
- `--heading-weight`, `--heading-size` (page titles), `--metric-size` (figures)
- `--label-tracking`, `--label-transform` (the eyebrow and table headers)
- `--control-height`, `--control-font` (buttons, fields and the table cells)
- `--ease`, `--duration`, `--hover-scale` (the button hover)

## Fonts

- Put the WOFF2 file in `src/console/fonts/`, and declare it with `@font-face`
  in the theme file that uses it. Vite fingerprints and bundles it.
- Satoshi has no 600 weight. `font-semibold` renders in Bold.
- JetBrains Mono is named in the mono stack but is not bundled. Where it is not
  installed, the uppercase labels use the system's `ui-monospace`.
- Check the licence before a release. `src/console/fonts/NOTICE` names the
  family and its licence, and the terms on Fontshare decide whether the font
  files can ship in the product.

## Focus and state

- The global focus ring is `--focus` (yellow in MOLIOR) with a 1px `--text`
  keyline on its outer edge. A yellow ring alone is under the 3:1 a focus
  indicator needs on the light page.
- Fields show focus with their border turning ink, not with a ring. That is
  the brand's field spec, and `styles.css` switches the ring off for them.
  Checkboxes and radios keep the ring.
- The button transition names its properties (colour, border, scale). It does
  not use the bare `transition`, which would also fade the focus ring in.
