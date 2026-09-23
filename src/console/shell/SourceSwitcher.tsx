import { useSource } from '../SourceContext.tsx';
import { spacePickerLabel, emptyStateText } from '../files/tree.ts';
import { Empty, Select } from '../ui/index.tsx';
import { groupByZone } from './zones.ts';

/**
 * A native `<select>`, now through the `Select` primitive rather than the
 * `.field` class it hand-rolled. The reason for the native element is
 * unchanged and still the point: a native select is keyboard-accessible and
 * screen-reader-correct for free, and `Select` is a thin wrapper over
 * `fieldClass()` — it adds the design system's height, radius and surface, and
 * nothing else.
 *
 * It carries `aria-label` rather than sitting inside a `Field`. `Field` renders
 * a visible `<label>`, and this control has never had one; inventing the text
 * for it would be new copy, which this phase does not write.
 */
export function SourceSwitcher() {
  const { spaces, current, setCurrent, loading, error } = useSource();

  if (error !== null) {
    return <div className="source-switcher text-danger">{error}</div>;
  }
  if (!loading && spaces.length === 0) {
    return (
      <div className="source-switcher">
        <Empty>{emptyStateText}</Empty>
      </div>
    );
  }

  return (
    <div className="source-switcher">
      <Select
        aria-label="Source"
        value={current?.sourceId ?? ''}
        disabled={loading || spaces.length === 0}
        onChange={(e) => setCurrent(e.target.value)}
      >
        {current === null && <option value="" disabled>Select a Source…</option>}
        {groupByZone(spaces).map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.spaces.map((space) => (
              <option key={space.sourceId} value={space.sourceId}>
                {spacePickerLabel(space)}
              </option>
            ))}
          </optgroup>
        ))}
      </Select>
    </div>
  );
}
