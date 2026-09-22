// The console editor's chrome + syntax colours, mapped onto the same CSS custom
// properties the rest of the console uses (see `src/console/styles/tokens.css`).
// Deliberately small: Baalda's `theme.ts` is ~36 KB of bespoke tokens, and this
// console already HAS a token set — the editor should look like one more surface
// of the app, not a second design system.
//
// Because every colour here is a `var()` rather than a literal, the editor
// re-themes for free: `:root.dark` swaps the token and CodeMirror repaints with
// no code change. That only holds while the names stay real, which is what
// `test/unit/console-tokens.test.ts` checks — it scans this file as well as the
// CSS precisely because the `--color-accent` -> `--color-cta` rename broke 12
// references here and a CSS-only scan would have missed every one of them.

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { hashtagTag, highlightTag } from "./vendor/baalda/ofm/tags.ts";

/**
 * Editor chrome. `dark: true` tells CodeMirror the base colour scheme so its
 * focus/selection defaults assume a dark background.
 */
const chrome = EditorView.theme(
  {
    "&": {
      backgroundColor: "var(--color-bg)",
      color: "var(--color-text)",
      fontFamily: "var(--font-sans)",
      height: "100%",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      fontFamily: "var(--font-mono)",
      fontSize: "var(--control-font)",
      lineHeight: "1.65",
    },
    ".cm-content": {
      padding: "var(--control-gap) calc(var(--control-gap) * 2)",
      caretColor: "var(--color-cta)",
    },
    ".cm-line": { position: "relative" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-cta)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "color-mix(in srgb, var(--color-cta) 30%, transparent)",
    },
    ".cm-activeLine": {
      backgroundColor: "color-mix(in srgb, var(--color-subtle) 55%, transparent)",
    },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "var(--color-muted)",
      border: "none",
    },
    ".cm-activeLineGutter": { backgroundColor: "transparent" },

    // ---- Live-preview widget classes (see vendor/baalda/livePreview.ts) ----
    ".cm-md-link": {
      color: "var(--color-cta)",
      textDecoration: "underline",
      textUnderlineOffset: "2px",
      cursor: "pointer",
    },
    ".cm-bullet": { color: "var(--color-muted)" },
    ".cm-hashtag": {
      color: "var(--color-cta)",
      background: "color-mix(in srgb, var(--color-cta) 15%, transparent)",
      // Not --control-radius: this is a 2px-padded inline chip inside a line of
      // prose, and the 6px control radius on a box that short reads as a pill.
      borderRadius: "3px",
      padding: "0 2px",
    },
    ".cm-task-checkbox": {
      accentColor: "var(--color-cta)",
      verticalAlign: "middle",
      marginRight: "4px",
    },
    ".cm-fence-copy": {
      position: "absolute",
      top: "2px",
      right: "0",
      fontSize: "11px",
      lineHeight: "1.4",
      padding: "1px 6px",
      color: "var(--color-muted)",
      background: "var(--color-surface)",
      border: "1px solid var(--color-subtle)",
      borderRadius: "var(--control-radius)",
      cursor: "pointer",
      opacity: "0",
      transition: "opacity .12s ease",
    },
    ".cm-line:hover .cm-fence-copy": { opacity: "1" },
    ".cm-frontmatter": { color: "var(--color-muted)" },
    ".cm-frontmatter-fence": {
      color: "var(--color-subtle)",
      fontFamily: "var(--font-mono)",
    },
    ".cm-block-inset": { paddingLeft: "16px" },

    // ---- Callouts (see vendor/baalda/ofm/callout.ts) -----------------------
    ".cm-callout": {
      borderLeft: "3px solid var(--color-muted)",
      paddingLeft: "10px",
      backgroundColor: "color-mix(in srgb, var(--color-muted) 8%, transparent)",
    },
    '.cm-callout[data-callout="note"]': { borderLeftColor: "var(--color-cta)" },
    '.cm-callout[data-callout="tip"]': { borderLeftColor: "var(--color-ok)" },
    '.cm-callout[data-callout="warning"]': { borderLeftColor: "var(--color-warning)" },
    '.cm-callout[data-callout="danger"]': { borderLeftColor: "var(--color-danger)" },
    ".cm-callout-title": { fontWeight: "600" },
    ".cm-callout-icon": {
      display: "inline-flex",
      alignItems: "center",
      gap: "5px",
      color: "inherit",
      marginRight: "4px",
    },
  },
  // Seeds CodeMirror's own selection and focus defaults for a dark background.
  // It is a half-truth now that light mode exists, and knowingly left alone:
  // every colour above already comes from a token and re-themes on its own, so
  // this only affects CodeMirror's built-in fallbacks. Making it follow the
  // theme means rebuilding the extension whenever the theme changes, which is
  // an Editor-lifecycle change and belongs to Phase 2.
  { dark: true }
);

/**
 * Syntax colours. One palette, sourced from the console tokens; `defaultHighlightStyle`
 * is never imported (it ships hardcoded colours that ignore the app theme).
 */
const highlight = HighlightStyle.define([
  {
    tag: t.heading1,
    fontFamily: "var(--font-sans)",
    fontSize: "1.75em",
    fontWeight: "700",
    color: "var(--color-text)",
  },
  {
    tag: t.heading2,
    fontFamily: "var(--font-sans)",
    fontSize: "1.35em",
    fontWeight: "700",
    color: "var(--color-text)",
  },
  {
    tag: t.heading3,
    fontFamily: "var(--font-sans)",
    fontSize: "1.12em",
    fontWeight: "650",
    color: "var(--color-text)",
  },
  {
    tag: [t.heading4, t.heading5, t.heading6],
    fontFamily: "var(--font-sans)",
    fontWeight: "650",
    color: "var(--color-text)",
  },
  { tag: t.strong, fontWeight: "700", color: "var(--color-text)" },
  { tag: t.emphasis, fontStyle: "italic", color: "var(--color-text)" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--color-muted)" },
  {
    tag: [t.link, t.url],
    color: "var(--color-cta)",
    textDecoration: "underline",
    textUnderlineOffset: "2px",
  },
  {
    tag: t.monospace,
    fontFamily: "var(--font-mono)",
    fontSize: "0.9em",
    color: "var(--color-text)",
    background: "var(--color-subtle)",
    padding: "0.1em 0.35em",
    borderRadius: "var(--control-radius)",
  },
  { tag: t.quote, color: "var(--color-muted)", fontStyle: "italic" },
  // No `t.list` rule on purpose: `@lezer/markdown` inherits it to every
  // descendant, so colouring it paints the item's TEXT rather than its marker.
  { tag: t.keyword, color: "var(--color-cta)" },
  { tag: [t.string, t.special(t.string)], color: "var(--color-ok)" },
  { tag: [t.number, t.bool, t.atom], color: "var(--color-warning)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--color-text)" },
  { tag: t.variableName, color: "var(--color-text)" },
  { tag: t.function(t.variableName), color: "var(--color-cta)" },
  { tag: [t.operator, t.punctuation], color: "var(--color-muted)" },
  { tag: t.meta, color: "var(--color-muted)" },
  { tag: [t.processingInstruction, t.contentSeparator], color: "var(--color-muted)" },
  { tag: t.labelName, color: "var(--color-muted)" },
  { tag: t.comment, color: "var(--color-muted)", fontStyle: "italic" },
  {
    tag: highlightTag,
    background: "color-mix(in srgb, var(--color-warning) 22%, transparent)",
    borderRadius: "2px",
  },
  { tag: hashtagTag, color: "var(--color-cta)" },
]);

export const consoleEditorTheme: Extension = [chrome, syntaxHighlighting(highlight)];
