import { useSource } from '../SourceContext.tsx';
import { spacePickerLabel, emptyStateText } from '../files/tree.ts';

/**
 * A native `<select>` styled with the existing `.field` class, deliberately —
 * a native select is keyboard-accessible and screen-reader-correct for free,
 * and every other control in this console that offers a fixed set of choices
 * already reaches for `.field` rather than a hand-rolled popover.
 */
export function SourceSwitcher() {
  const { spaces, current, setCurrent, loading, error } = useSource();

  if (error !== null) {
    return <div className="source-switcher text-danger">{error}</div>;
  }
  if (!loading && spaces.length === 0) {
    return <div className="source-switcher text-muted">{emptyStateText}</div>;
  }

  return (
    <div className="source-switcher">
      <select
        className="field"
        aria-label="Source"
        value={current?.sourceId ?? ''}
        disabled={loading || spaces.length === 0}
        onChange={(e) => setCurrent(e.target.value)}
      >
        {current === null && <option value="" disabled>Select a Source…</option>}
        {spaces.map((space) => (
          <option key={space.sourceId} value={space.sourceId}>
            {spacePickerLabel(space)}
          </option>
        ))}
      </select>
    </div>
  );
}
