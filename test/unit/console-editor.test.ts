import { describe, expect, test } from 'bun:test';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { Text } from '@codemirror/state';
import { fenceRenderKind } from '../../src/console/editor/vendor/baalda/fenceKind.ts';
import { isDangerousUrl } from '../../src/console/editor/vendor/baalda/urlSafety.ts';
import { previewKind } from '../../src/console/editor/vendor/baalda/preview.ts';
import { findFrontmatter } from '../../src/console/editor/vendor/baalda/frontmatter.ts';
import { calloutTypeAt } from '../../src/console/editor/vendor/baalda/ofm/callout.ts';
import {
  escapeCellText,
  planFillCell,
  planSetCell,
} from '../../src/console/editor/vendor/baalda/table/edit.ts';
import {
  displayRowCount,
  parseTable,
  rowOf,
} from '../../src/console/editor/vendor/baalda/table/parse.ts';
import { markdownExtensions } from '../../src/console/editor/index.ts';
import { isDarkClassName } from '../../src/console/theme.ts';

describe('console editor — pure helpers', () => {
  test('fenceRenderKind keeps html and drops mermaid (degraded to code)', () => {
    expect(fenceRenderKind('html')).toBe('html');
    expect(fenceRenderKind('htm title=x')).toBe('html');
    expect(fenceRenderKind('mermaid')).toBeNull();
    expect(fenceRenderKind('mmd')).toBeNull();
    expect(fenceRenderKind('js')).toBeNull();
    expect(fenceRenderKind('')).toBeNull();
  });

  test('isDangerousUrl strips whitespace/control chars before checking', () => {
    expect(isDangerousUrl('java\tscript:alert(1)')).toBe(true);
    expect(isDangerousUrl('vbscript:x')).toBe(true);
    expect(isDangerousUrl('data:text/html,x')).toBe(true);
    expect(isDangerousUrl('data:image/png;base64,x')).toBe(false);
    expect(isDangerousUrl('https://example.com')).toBe(false);
    expect(isDangerousUrl('mailto:a@b.c')).toBe(false);
  });

  test('previewKind classifies images, pdfs and everything else', () => {
    expect(previewKind('a/b/pic.PNG')).toBe('image');
    expect(previewKind('shot.heic')).toBe('image');
    expect(previewKind('doc.pdf')).toBe('pdf');
    expect(previewKind('note.md')).toBeNull();
    expect(previewKind('README')).toBeNull();
  });

  test('findFrontmatter finds the leading --- block only', () => {
    const fm = findFrontmatter(Text.of(['---', 'title: Hi', '---', 'body']));
    expect(fm).not.toBeNull();
    expect(fm!.openLine).toBe(1);
    expect(fm!.closeLine).toBe(3);
    expect(findFrontmatter(Text.of(['body', '---', 'x: 1', '---']))).toBeNull();
  });

  test('calloutTypeAt folds a family onto its token', () => {
    const state = EditorState.create({ doc: '> [!warning] Careful' });
    expect(calloutTypeAt(state, 0)).toBe('warning');
    const state2 = EditorState.create({ doc: '> [!success] Nice' });
    expect(calloutTypeAt(state2, 0)).toBe('tip');
  });
});

describe('console editor — table planners', () => {
  const doc = Text.of(['| a | b |', '| --- | ---: |', '| 1 | 2 |']);
  const model = parseTable(doc, 0, doc.length);

  test('parses rows, delimiter and alignment', () => {
    expect(model.columns).toBe(2);
    expect(displayRowCount(model)).toBe(2);
    expect(model.aligns).toEqual([null, 'right']);
    expect(rowOf(model, 0)!.cells[0]!.raw).toBe('a');
    expect(rowOf(model, 1)!.cells[1]!.raw).toBe('2');
  });

  test('planSetCell replaces only the trimmed cell span', () => {
    const cell = rowOf(model, 0)!.cells[0]!;
    const changes = planSetCell(cell, 'title');
    expect(changes).toHaveLength(1);
    const change = changes[0]!;
    const source = doc.toString();
    const applied = source.slice(0, change.from) + change.insert + source.slice(change.to);
    expect(applied).toBe('| title | b |\n| --- | ---: |\n| 1 | 2 |');
    expect(source.slice(change.from, change.to)).toBe('a');
  });

  test('planFillCell grows a ragged row instead of reflowing others', () => {
    const ragged = Text.of(['| a |', '| --- |', '| 1 | 2 |']);
    const m = parseTable(ragged, 0, ragged.length);
    const row = rowOf(m, 1)!;
    const changes = planFillCell(row, 2, '');
    const source = ragged.toString();
    const applied = changes.reduce(
      (acc, ch) => acc.slice(0, ch.from) + ch.insert + acc.slice(ch.to),
      source,
    );
    expect(applied).toBe('| a |\n| --- |\n| 1 | 2 |  |');
  });

  test('escapeCellText escapes pipes but not an existing escape', () => {
    expect(escapeCellText('a|b')).toBe('a\\|b');
    expect(escapeCellText('a\\|b')).toBe('a\\|b');
    expect(escapeCellText('a\nb')).toBe('a b');
  });
});

describe('console editor — extension assembly (DOM-free)', () => {
  test('read mode is read-only and not editable', () => {
    const state = EditorState.create({
      doc: '# Hi',
      extensions: markdownExtensions('read'),
    });
    expect(state.readOnly).toBe(true);
    expect(state.facet(EditorView.editable)).toBe(false);
  });

  test('edit mode is read-write and editable', () => {
    const state = EditorState.create({
      doc: '# Hi',
      extensions: markdownExtensions('edit', () => {}),
    });
    expect(state.readOnly).toBe(false);
    expect(state.facet(EditorView.editable)).toBe(true);
  });

  test('the colour scheme reaches CodeMirror, not just the CSS', () => {
    // The point of threading `dark` at all. Every colour in `editor/theme.ts`
    // is a `var()` and repaints on its own, so a test that only looked at the
    // paint would pass with the flag stuck on `true` — which is exactly the
    // bug this replaced. `EditorView.darkTheme` is the facet CodeMirror reads
    // for its OWN defaults (base theme, selection compositing, caret), so it
    // is the one thing worth asserting.
    const light = EditorState.create({ doc: '# Hi', extensions: markdownExtensions('read', undefined, false) });
    const dark = EditorState.create({ doc: '# Hi', extensions: markdownExtensions('read', undefined, true) });
    expect(light.facet(EditorView.darkTheme)).toBe(false);
    expect(dark.facet(EditorView.darkTheme)).toBe(true);
  });

  test('omitting the flag means light, which is what a classless <html> paints', () => {
    // `tokens.css` puts the light palette in the bare `:root` block, so a
    // caller that says nothing must not get the dark defaults.
    const state = EditorState.create({ doc: '# Hi', extensions: markdownExtensions('read') });
    expect(state.facet(EditorView.darkTheme)).toBe(false);
  });

  test('a rich document assembles without a DOM and round-trips unchanged', () => {
    const source = [
      '---',
      'title: Demo',
      '---',
      '# Heading',
      '',
      '> [!warning] Careful',
      '> body',
      '',
      '- [ ] task',
      '- item with **bold** and ==mark== and #tag',
      '',
      '```html',
      '<b>raw</b>',
      '```',
      '',
      '```mermaid',
      'graph TD; A-->B;',
      '```',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      'A [link](https://example.com) and a `code` span.',
    ].join('\n');
    const state = EditorState.create({
      doc: source,
      extensions: markdownExtensions('read'),
    });
    expect(state.doc.toString()).toBe(source);
    expect(state.readOnly).toBe(true);
  });
});

/**
 * `isDarkClassName` is the editor's theme INPUT: it is the one reading that
 * turns the class `applyTheme` writes on `<html>` into the boolean
 * `markdownExtensions` takes above, so it is asserted here, beside the flag it
 * feeds, rather than with the rest of `theme.ts`.
 */
describe('console editor — reading the app theme off <html>', () => {
  test('the dark class, and only a whole class named dark', () => {
    expect(isDarkClassName('dark')).toBe(true);
    expect(isDarkClassName('h-full dark antialiased')).toBe(true);
    expect(isDarkClassName('light')).toBe(false);
    // A substring test would call all three of these dark.
    expect(isDarkClassName('darkroom-banner')).toBe(false);
    expect(isDarkClassName('is-dark')).toBe(false);
    expect(isDarkClassName('markdown-dark-preview')).toBe(false);
  });

  test('no class at all is light, because the bare :root block is light', () => {
    expect(isDarkClassName('')).toBe(false);
    expect(isDarkClassName('   ')).toBe(false);
  });

  test('dark wins when both are somehow present, as the cascade does', () => {
    // `:root.dark` in tokens.css is written after `:root` and overrides it, so
    // the reading has to agree with what the page would actually paint.
    expect(isDarkClassName('light dark')).toBe(true);
    expect(isDarkClassName('dark light')).toBe(true);
  });
});
