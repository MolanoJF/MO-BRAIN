import { test, expect, describe } from 'bun:test';
import { shouldCloseOnEscape, shouldCloseOnBackdropClick } from '../../src/console/settings/SettingsModal.tsx';

/**
 * `SettingsModal` has no new pure-function surface of its own beyond these two
 * decisions — everything else (portal target, focus-in/focus-out, the actual
 * mousedown/mouseup listeners) is DOM interaction the repo's test setup cannot
 * exercise: there is no happy-dom/jsdom/testing-library harness here, and this
 * task does not add one. So the two decisions that would otherwise be buried
 * in event handlers are pulled out as pure functions and tested here; the
 * wiring around them (which DOM events feed which argument) is covered by the
 * manual verification pass instead of by `bun test`.
 */

describe('Esc during settings: mine to close, or a stacked surface\'s to close first', () => {
  test('Esc closes settings when nothing is stacked above it', () => {
    expect(shouldCloseOnEscape(false)).toBe(true);
  });

  test('Esc does not close settings while a confirm dialog is stacked above it', () => {
    // Sources.tsx's archive/remove confirm and Runs.tsx's revert confirm both
    // render on top of the settings surface. An Esc meant to cancel that
    // confirm must not also close the settings modal underneath it.
    expect(shouldCloseOnEscape(true)).toBe(false);
  });
});

describe('click-away: closing needs a press AND a release on the backdrop', () => {
  test('a plain click that starts and ends on the backdrop closes the modal', () => {
    expect(shouldCloseOnBackdropClick(true, true)).toBe(true);
  });

  test('a text-selection drag that starts inside the card and is released on the backdrop does not close it', () => {
    // The regression this guards: selecting text in a settings field and
    // dragging the mouse-up past the card's edge fires a "click" whose target
    // is the backdrop, even though the press began on the card. Without
    // tracking the press separately, that drag would lose the operator's
    // in-progress edit.
    expect(shouldCloseOnBackdropClick(false, true)).toBe(false);
  });

  test('a press that starts on the backdrop but releases over the card does not close it', () => {
    expect(shouldCloseOnBackdropClick(true, false)).toBe(false);
  });

  test('a click entirely inside the card never closes the modal', () => {
    expect(shouldCloseOnBackdropClick(false, false)).toBe(false);
  });
});
