/**
 * The editable GFM table — imperative DOM.
 *
 * PORTING NOTE (see ../../PORTING.md): upstream ships this widget as a React
 * component (`TableWidget.tsx`) built on `../reactWidget`, `../../menuPlacement`
 * and the `../../ipc` bridge. Those pieces are outside the files this port may
 * vendor, and the plan calls for a pure-CodeMirror table with no new deps, so
 * the widget is reimplemented here as a plain `WidgetType`. The behaviour that
 * matters is kept: a table is ALWAYS the rendered table, a click opens a cell's
 * raw markdown in an input, and every commit is one ordinary editor transaction
 * built from the pure planners in `./edit`. The cell context menu and the
 * keyboard cell-to-cell navigation are dropped.
 *
 * Rendering reads the widget's own `source` string (offsets relative to 0).
 * Committing re-derives the table from the LIVE document at the widget's
 * current position (`view.posAtDOM(host)` → `tableAt`), so a change above the
 * table cannot make a cell edit land at a stale offset.
 */

import { syntaxTree } from "@codemirror/language";
import { Text, Transaction, type EditorState } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import {
  planFillCell,
  planInsertColumn,
  planInsertRow,
  type SpanChange,
} from "./edit";
import { displayRowCount, parseTable, rowOf, type TableModel } from "./parse";
import { renderCellInto } from "./render";

/** Shared with the other block replace widgets — see `BLOCK_INSET_CLASS`. */
const INSET = "cm-block-inset";

export interface TableWidgetOptions {
  /** Follow a link clicked inside a cell. */
  onNavigate?: (target: string) => void;
  readOnly?: boolean;
}

/** Derived, not imported: `@lezer/common` is a declared dep, but this keeps
 *  the upstream derivation. */
type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;

/** The table covering `pos` in the live document, re-parsed with live offsets. */
export function tableAt(state: EditorState, pos: number): TableModel | null {
  const tree = syntaxTree(state);
  for (const at of [pos, pos + 1]) {
    if (at > state.doc.length) continue;
    let node: SyntaxNode | null = tree.resolveInner(at, 1);
    while (node) {
      if (node.name === "Table") return parseTable(state.doc, node.from, node.to);
      node = node.parent;
    }
  }
  return null;
}

function dispatchChanges(view: EditorView, changes: SpanChange[]): void {
  if (changes.length === 0) return;
  view.dispatch({
    changes: [...changes].sort((a, b) => a.from - b.from),
    // No selection change: the caret stays wherever the document had it, so a
    // cell edit cannot scroll the note or move somebody's place.
    annotations: Transaction.userEvent.of("input.table"),
    scrollIntoView: false,
  });
}

/** Follow a web link without navigating the whole console away. */
function openExternal(href: string): void {
  try {
    window.open(href, "_blank", "noopener,noreferrer");
  } catch {
    /* popup blocked — the cell text still shows the URL */
  }
}

export class TableWidget extends WidgetType {
  constructor(
    readonly source: string,
    private readonly opts: TableWidgetOptions,
  ) {
    super();
  }

  override eq(other: TableWidget): boolean {
    return other.source === this.source && other.opts.readOnly === this.opts.readOnly;
  }

  override get estimatedHeight(): number {
    return 34 * Math.max(1, this.source.split("\n").length - 1) + 24;
  }

  toDOM(view: EditorView): HTMLElement {
    const host = document.createElement("div");
    host.className = `cm-md-table ${INSET}`;
    new TableBody(host, view, this.source, this.opts);
    return host;
  }

  override ignoreEvent(): boolean {
    // Let the widget's own DOM (inputs, buttons, links) own its events.
    return true;
  }
}

/** Owns one mounted table's DOM and its single open cell. */
class TableBody {
  private readonly model: TableModel;
  private editing: { row: number; col: number } | null = null;
  private draft = "";

  constructor(
    private readonly host: HTMLElement,
    private readonly view: EditorView,
    private readonly source: string,
    private readonly opts: TableWidgetOptions,
  ) {
    // Rendered from the widget's own source, never from live offsets — the DOM
    // outlives a document change, so a captured offset can be stale by click.
    // `Text.of` makes the same parser usable off-document.
    this.model = parseTable(Text.of(source.split("\n")), 0, source.length);
    this.render();
  }

  /** The table as the DOCUMENT has it right now, at this widget's position. */
  private liveModel(): TableModel | null {
    try {
      return tableAt(this.view.state, this.view.posAtDOM(this.host));
    } catch {
      return null;
    }
  }

  private render(): void {
    const { model } = this;
    const readOnly = this.opts.readOnly ?? false;
    const rowCount = displayRowCount(model);
    const columns = model.columns;

    this.host.textContent = "";
    const wrap = document.createElement("div");
    wrap.className = "cm-md-table-wrap";
    // Keep a press inside the table from starting a native selection on the
    // contenteditable host around the widget. Form controls are exempt.
    wrap.addEventListener("mousedown", (event) => {
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, button, a")) return;
      event.preventDefault();
    });

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (let c = 0; c < columns; c++) {
      const th = document.createElement("th");
      this.applyCellProps(th, 0, c);
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (let r = 1; r < rowCount; r++) {
      const tr = document.createElement("tr");
      for (let c = 0; c < columns; c++) {
        const td = document.createElement("td");
        this.applyCellProps(td, r, c);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);

    if (!readOnly) {
      const addColumn = document.createElement("button");
      addColumn.type = "button";
      addColumn.className = "cm-md-add-col";
      addColumn.textContent = "+";
      addColumn.setAttribute("aria-label", "Add column");
      addColumn.addEventListener("mousedown", (e) => e.preventDefault());
      addColumn.addEventListener("click", () => this.addColumn());
      wrap.appendChild(addColumn);
    }
    this.host.appendChild(wrap);

    if (!readOnly) {
      const addRow = document.createElement("button");
      addRow.type = "button";
      addRow.className = "cm-md-add-row";
      addRow.textContent = "+";
      addRow.setAttribute("aria-label", "Add row");
      addRow.addEventListener("mousedown", (e) => e.preventDefault());
      addRow.addEventListener("click", () => this.addRow());
      this.host.appendChild(addRow);
    }
  }

  /** Alignment, click handling and the open-cell flag for one `th`/`td`. */
  private applyCellProps(el: HTMLTableCellElement, row: number, col: number): void {
    const align = this.model.aligns[col];
    if (align) el.style.textAlign = align;
    if (this.editing?.row === row && this.editing.col === col) {
      el.classList.add("cm-md-cell-open");
    }
    el.addEventListener("click", (event) => this.onCellClick(event, row, col));
    el.appendChild(this.cellBody(row, col));
  }

  private cellRaw(row: number, col: number): string {
    return rowOf(this.model, row)?.cells[col]?.raw ?? "";
  }

  private cellBody(row: number, col: number): Node {
    const open = this.editing?.row === row && this.editing.col === col;
    if (!open) {
      const span = document.createElement("span");
      span.className = "cm-md-cell cm-md-cell-content";
      renderCellInto(span, this.cellRaw(row, col));
      return span;
    }

    const input = document.createElement("input");
    input.className = "cm-md-cell-input";
    input.value = this.draft;
    input.spellcheck = true;
    input.setAttribute("aria-label", `Row ${row + 1}, column ${col + 1}`);
    input.addEventListener("input", () => {
      this.draft = input.value;
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.editing = null;
        this.render();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        this.commit(row, col, this.draft);
        this.editing = null;
        this.render();
      }
    });
    input.addEventListener("blur", () => {
      // A removed input does not reliably fire blur, and a blur after an
      // explicit commit must not write a second time.
      if (this.editing?.row !== row || this.editing.col !== col) return;
      this.commit(row, col, this.draft);
      this.editing = null;
      this.render();
    });
    // Focus and place the caret at the end once the input is in the document.
    queueMicrotask(() => {
      if (!input.isConnected) return;
      input.focus({ preventScroll: true });
      const at = input.value.length;
      input.setSelectionRange(at, at);
    });
    return input;
  }

  private onCellClick(event: MouseEvent, row: number, col: number): void {
    const target = event.target as HTMLElement;
    const link = target.closest<HTMLElement>(".cm-md-link");
    if (link?.dataset.href) {
      event.preventDefault();
      openExternal(link.dataset.href);
      return;
    }
    const wiki = target.closest<HTMLElement>(".cm-wikilink");
    if (wiki?.dataset.target && this.opts.onNavigate) {
      event.preventDefault();
      this.opts.onNavigate(wiki.dataset.target);
      return;
    }
    if (this.opts.readOnly) return;
    this.editing = { row, col };
    this.draft = this.cellRaw(row, col);
    this.render();
  }

  /** Write `text` into (row, col) as one transaction against the live doc. */
  private commit(row: number, col: number, text: string): void {
    const live = this.liveModel();
    if (!live) return;
    const liveRow = rowOf(live, row);
    if (!liveRow) return;
    dispatchChanges(this.view, planFillCell(liveRow, col, text));
  }

  private addRow(): void {
    const live = this.liveModel();
    if (!live) return;
    dispatchChanges(this.view, planInsertRow(live, live.rows.length - 1));
  }

  private addColumn(): void {
    const live = this.liveModel();
    if (!live) return;
    dispatchChanges(this.view, planInsertColumn(live, live.columns - 1));
  }
}
