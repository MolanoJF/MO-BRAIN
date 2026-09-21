// The console's markdown editor: a small, self-hosted CodeMirror 6 setup built
// on the vendored Baalda port (`./vendor/baalda/`). The Files page consumes
// exactly this module — `mountMarkdownEditor()` returns a handle whose lifetime
// it owns, and `markdownExtensions()` exposes the assembled extension set so it
// stays inspectable (and testable without a DOM).

import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { indentOnInput, indentUnit } from "@codemirror/language";
import { searchKeymap } from "@codemirror/search";
import {
  Annotation,
  Compartment,
  EditorState,
  type Extension,
} from "@codemirror/state";
import { drawSelection, dropCursor, EditorView, keymap } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { codeFenceFlair } from "./vendor/baalda/codeFence.ts";
import { codeLanguages } from "./vendor/baalda/codeLanguages.ts";
import { frontmatterDecorations } from "./vendor/baalda/frontmatter.ts";
import { livePreview } from "./vendor/baalda/livePreview.ts";
import { ofmDecorations, ofmMarkdown } from "./vendor/baalda/ofm/index.ts";
import { tableAtomicRanges } from "./vendor/baalda/table/atomic.ts";
import { checkboxes, taskKeymap } from "./vendor/baalda/tasks.ts";
import { consoleEditorTheme } from "./theme.ts";

export type EditorMode = "read" | "edit";

export interface MarkdownEditorOptions {
  parent: HTMLElement;
  doc: string;
  /** Default `'read'`. */
  mode?: EditorMode;
  onChange?: (value: string) => void;
}

export interface MarkdownEditorHandle {
  getValue(): string;
  setValue(next: string): void;
  setMode(mode: EditorMode): void;
  focus(): void;
  destroy(): void;
}

/**
 * Marks a transaction dispatched by the handle itself (currently `setValue`),
 * so the public `onChange` does not fire for programmatic replacements — a
 * Files page loading a file must not immediately see it as a user edit.
 */
const programmatic = Annotation.define<boolean>();

/** `'read'` ⇒ not editable and read-only; `'edit'` ⇒ editable + read-write. */
function modeFacets(mode: EditorMode): Extension[] {
  const readOnly = mode === "read";
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

/**
 * Everything except the mode facets, so a live view can reconfigure its mode
 * through a Compartment without rebuilding the buffer.
 */
function baseExtensions(onChange?: (value: string) => void): Extension[] {
  return [
    history(),
    drawSelection(),
    dropCursor(),
    EditorView.lineWrapping,
    indentOnInput(),
    indentUnit.of("  "),
    EditorState.allowMultipleSelections.of(true),
    taskKeymap(),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),

    // GFM adds tables, task lists, strikethrough and autolinks; `ofmMarkdown`
    // adds Obsidian's `==highlight==`, `%%comment%%` and `#tag` on top.
    markdown({
      base: markdownLanguage,
      extensions: [GFM, ...ofmMarkdown],
      codeLanguages,
    }),

    // Frontmatter first: livePreview reads its range so nothing else decorates
    // inside it (see vendor/baalda/frontmatter.ts).
    frontmatterDecorations,
    // Inline live preview: hide markers off the caret, render bullets, links,
    // images, HTML blocks and tables — the raw markdown stays in the buffer.
    livePreview(),
    // A table is always rendered, so the caret must never walk into one.
    tableAtomicRanges,
    // Clickable `- [ ]` task checkboxes.
    checkboxes,
    // A copy button on every fenced code block.
    codeFenceFlair,
    // Callout tinting + tag pills.
    ...ofmDecorations,
    // The console's token-based theme + syntax highlighting.
    consoleEditorTheme,

    ...(onChange
      ? [
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            if (update.transactions.some((tr) => tr.annotation(programmatic))) return;
            onChange(update.state.doc.toString());
          }),
        ]
      : []),
  ];
}

/** The assembled extension set for a mode. Exported so it is inspectable/testable. */
export function markdownExtensions(
  mode: EditorMode,
  onChange?: (value: string) => void,
): Extension[] {
  return [...baseExtensions(onChange), ...modeFacets(mode)];
}

/**
 * Mount the editor into `options.parent` and return a handle. The caller owns
 * the handle; `destroy()` is idempotent and releases the DOM CodeMirror owns.
 */
export function mountMarkdownEditor(options: MarkdownEditorOptions): MarkdownEditorHandle {
  const mode = options.mode ?? "read";
  const modeCompartment = new Compartment();
  let destroyed = false;
  let lastValue = options.doc;

  const state = EditorState.create({
    doc: options.doc,
    extensions: [
      ...baseExtensions(options.onChange),
      modeCompartment.of(modeFacets(mode)),
    ],
  });
  const view = new EditorView({ state, parent: options.parent });

  return {
    getValue(): string {
      return destroyed ? lastValue : view.state.doc.toString();
    },
    setValue(next: string): void {
      lastValue = next;
      if (destroyed) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
        annotations: programmatic.of(true),
      });
      lastValue = view.state.doc.toString();
    },
    setMode(next: EditorMode): void {
      if (destroyed) return;
      view.dispatch({ effects: modeCompartment.reconfigure(modeFacets(next)) });
    },
    focus(): void {
      if (!destroyed) view.focus();
    },
    destroy(): void {
      if (destroyed) return;
      lastValue = view.state.doc.toString();
      destroyed = true;
      view.destroy();
    },
  };
}

export { consoleEditorTheme } from "./theme.ts";
