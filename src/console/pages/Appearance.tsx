import { useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { Button, Card, Icon } from '../ui/index.tsx';
import { setTheme, storedTheme, type ThemeChoice } from '../theme.ts';

/**
 * The Light / Dark / System control, ported from qm's settings panel
 * (`qm/plugins/web-ui/src/settings.ts`, `THEME_OPTIONS`) down to the three
 * glyphs.
 *
 * `System` is a third answer, not a default: it means "track the OS", and
 * `theme.ts` keeps a `matchMedia` listener alive so it keeps tracking after
 * this page is closed. The two explicit choices override the OS permanently,
 * which is why they are worth persisting at all.
 */
const OPTIONS: ReadonlyArray<{ value: ThemeChoice; label: string; glyph: typeof Sun }> = [
  { value: 'light', label: 'Light', glyph: Sun },
  { value: 'dark', label: 'Dark', glyph: Moon },
  { value: 'system', label: 'System', glyph: Monitor },
];

export function Appearance() {
  // Seeded from storage rather than held only here: this page is lazily
  // mounted and unmounted on every tab switch, so component state alone would
  // forget the selection the moment somebody looked at Health and came back.
  const [choice, setChoice] = useState<ThemeChoice>(() => storedTheme());

  const pick = (next: ThemeChoice) => {
    setChoice(next);
    setTheme(next);
  };

  return (
    <Card
      title="Theme"
      subtitle="Applies to this browser only. System follows your operating system and keeps following it."
    >
      <div className="flex flex-wrap gap-[var(--control-gap)]" role="group" aria-label="Theme">
        {OPTIONS.map((o) => (
          <Button
            key={o.value}
            variant={choice === o.value ? 'primary' : 'secondary'}
            aria-pressed={choice === o.value}
            onClick={() => pick(o.value)}
          >
            <Icon glyph={o.glyph} size={16} />
            {o.label}
          </Button>
        ))}
      </div>
    </Card>
  );
}
