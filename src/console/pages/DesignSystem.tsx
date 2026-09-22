import { useState } from 'react';
import { CircleAlert, Monitor, Moon, RefreshCw, Sun, Trash2 } from 'lucide-react';
import {
  Badge, Button, Card, ConfirmButton, Dialog, Empty, Field, Icon, IconButton,
  Input, Notice, Select, Spinner, Table, TableWrap, Textarea, Toolbar,
  type ButtonVariant, type Tone,
} from '../ui/index.tsx';
import { setTheme, storedTheme, type ThemeChoice } from '../theme.ts';

/**
 * The living style guide, ported from `qm/plugins/admin/ui/design.ts`.
 *
 * Every specimen below is built from the REAL exported primitive, never a copy
 * of its markup. That is the whole point: a style guide that reimplements what
 * it documents drifts from the thing it is supposed to prove, and the drift is
 * invisible precisely because the guide keeps looking correct.
 *
 * It exists as a route because this repo has no DOM test harness. The unit
 * tests can assert that `buttonClass('primary')` contains the CTA background;
 * only this page can show that the CTA background is legible in both themes.
 */

/**
 * qm's `DESIGN_TOKENS` (`admin/ui/design.ts:11-23`), verbatim, including the
 * descriptions — they are the vocabulary, and paraphrasing them is how two
 * people end up using `--subtle` for two different jobs.
 */
const DESIGN_TOKENS: ReadonlyArray<readonly [string, string]> = [
  ['--bg', 'Page behind every surface'],
  ['--surface', 'Cards, dialogs, table bodies'],
  ['--subtle', 'Quiet control and inset backgrounds'],
  ['--border', 'Every hairline and divider'],
  ['--text', 'Primary copy'],
  ['--muted', 'Secondary copy and hints'],
  ['--cta', 'Primary actions and selected controls'],
  ['--ok', 'Confirmed and healthy'],
  ['--warn', 'Needs attention'],
  ['--danger', 'Destructive and failed'],
  ['--trigger', 'Automation and triggers'],
];

const TONES: readonly Tone[] = ['ok', 'warning', 'danger', 'muted', 'neutral'];
const VARIANTS: readonly ButtonVariant[] = ['primary', 'secondary', 'danger', 'link'];

const THEMES: ReadonlyArray<{ value: ThemeChoice; label: string; glyph: typeof Sun }> = [
  { value: 'light', label: 'Light', glyph: Sun },
  { value: 'dark', label: 'Dark', glyph: Moon },
  { value: 'system', label: 'System', glyph: Monitor },
];

function Section({ title, blurb, children }: { title: string; blurb: string; children: React.ReactNode }) {
  return (
    <section className="mb-[var(--section-gap)]">
      <h2 className="m-0 text-[length:var(--section-font)] font-medium leading-[1.5] text-text">{title}</h2>
      <p className="mt-1 mb-4 max-w-[70ch] text-[length:var(--control-font)] leading-[1.5] text-muted">{blurb}</p>
      {children}
    </section>
  );
}

/** A labelled specimen row, qm's `.spec` / `.spec-label` / `.spec-demo`. */
function Spec({ label, note, children }: { label: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-b border-border py-4 md:flex-row md:items-start md:gap-6">
      <div className="md:w-56 md:shrink-0">
        <div className="text-[length:var(--control-font)] font-medium text-text">{label}</div>
        {note !== undefined && <div className="text-xs leading-[1.5] text-muted">{note}</div>}
      </div>
      <div className="flex flex-wrap items-center gap-[var(--control-gap)]">{children}</div>
    </div>
  );
}

export function DesignSystem() {
  const [choice, setChoice] = useState<ThemeChoice>(() => storedTheme());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [invalid, setInvalid] = useState(false);

  const pickTheme = (next: ThemeChoice) => {
    setChoice(next);
    setTheme(next);
  };

  return (
    <div className="mx-auto w-full max-w-[var(--maxw)] p-6">
      <header className="mb-[var(--section-gap)]">
        <h1 className="m-0 text-[22px] font-medium leading-[1.4] tracking-[-0.025em] text-text">Design system</h1>
        <p className="mt-1 max-w-[70ch] text-[length:var(--control-font)] leading-[1.5] text-muted">
          Every primitive, variant and tone, rendered from the exported components in{' '}
          <code className="font-mono">src/console/ui</code>. Switch themes here and confirm each specimen still
          reads — a token that only works in one theme is the failure this page is built to catch.
        </p>
        <Toolbar className="mt-3">
          {THEMES.map((t) => (
            <Button
              key={t.value}
              variant={choice === t.value ? 'primary' : 'secondary'}
              aria-pressed={choice === t.value}
              onClick={() => pickTheme(t.value)}
            >
              <Icon glyph={t.glyph} size={16} />
              {t.label}
            </Button>
          ))}
        </Toolbar>
      </header>

      <Section title="Tokens" blurb="The tier-1 values every utility and primitive resolves through. The swatch is painted with the live token, so it changes with the theme above.">
        <TableWrap>
          <Table>
            <thead>
              <tr><th>Swatch</th><th>Token</th><th>What it is for</th></tr>
            </thead>
            <tbody>
              {DESIGN_TOKENS.map(([name, description]) => (
                <tr key={name}>
                  <td>
                    <span
                      className="inline-block h-6 w-10 rounded-[var(--control-radius)] border border-border"
                      style={{ background: `var(${name})` }}
                    />
                  </td>
                  <td className="font-mono">{name}</td>
                  <td className="text-muted">{description}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      </Section>

      <Section title="Buttons" blurb="One 32px control height, one radius, one 13px label. Primary is the only filled variant; destructive actions are red text on the standard chrome, never a red fill.">
        <Spec label="Variants" note="primary / secondary / danger / link">
          {VARIANTS.map((v) => (
            <Button key={v} variant={v}>{v}</Button>
          ))}
        </Spec>
        <Spec label="Disabled" note="primary drops to the subtle pair rather than fading; the rest fade to 45%">
          {VARIANTS.map((v) => (
            <Button key={v} variant={v} disabled>{v}</Button>
          ))}
        </Spec>
        <Spec label="With an icon" note="lucide at stroke-width 1.9, aria-hidden">
          <Button variant="primary"><Icon glyph={RefreshCw} size={16} />Run now</Button>
          <Button><Icon glyph={CircleAlert} size={16} />Details</Button>
        </Spec>
        <Spec label="IconButton" note="square on the control height; label becomes aria-label">
          <IconButton label="Refresh"><Icon glyph={RefreshCw} size={16} /></IconButton>
          <IconButton label="Delete" disabled><Icon glyph={Trash2} size={16} /></IconButton>
        </Spec>
        <Spec label="ConfirmButton" note="first press arms, second confirms, blur disarms">
          <ConfirmButton label="Delete" confirmLabel="Press again to delete" onConfirm={() => {}} />
        </Spec>
        <Spec label="Spinner">
          <Spinner />
          <Spinner size={24} />
        </Spec>
      </Section>

      <Section title="Fields" blurb="Inputs share the button's height, border, radius and surface, so a control row lines up whatever it is made of. Invalid sets the border and aria-invalid from one prop.">
        <Spec label="Input">
          <Field label="Source name" hint="Shown in the switcher." id="ds-name">
            <Input id="ds-name" defaultValue="my-brain" />
          </Field>
        </Spec>
        <Spec label="Invalid" note="border and aria-invalid move together">
          <Field label="Schedule" error={invalid ? 'Not a valid cron expression.' : undefined} id="ds-cron">
            <Input id="ds-cron" invalid={invalid} defaultValue="*/5 * * * *" onChange={() => setInvalid((v) => !v)} />
          </Field>
        </Spec>
        <Spec label="Select / Textarea / Disabled">
          <Select defaultValue="daily" aria-label="Cadence">
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </Select>
          <Textarea defaultValue="A prompt." aria-label="Prompt" />
          <Input disabled defaultValue="Read only" aria-label="Disabled input" />
        </Spec>
      </Section>

      <Section title="Badges" blurb="Tone sets the colour; the pill fill and border are mixed out of that same colour, so a tone can never disagree with its own background.">
        <Spec label="Every tone">
          {TONES.map((t) => (
            <Badge key={t} tone={t}>{t}</Badge>
          ))}
        </Spec>
      </Section>

      <Section title="Cards, notices and empties" blurb="A card is a surface with a hairline and a 24px vertical rhythm. A notice is the standing warning those 21 border-warning call sites are really made of.">
        <Spec label="Card">
          <Card
            title="Schedule"
            subtitle="Runs every weekday at 09:00 in the brain's timezone."
            foot={<><Button>Cancel</Button><Button variant="primary">Save</Button></>}
            footEnd
            className="w-full"
          >
            <Empty>Nothing has run yet.</Empty>
          </Card>
        </Spec>
        <Spec label="Notice" note="warning uses the dedicated warn triple; other tones tint from their own colour">
          <div className="flex w-full flex-col gap-2">
            {TONES.map((t) => (
              <Notice key={t} tone={t}>
                <Icon glyph={CircleAlert} size={16} />
                <span>This is a {t} notice.</span>
              </Notice>
            ))}
          </div>
        </Spec>
        <Spec label="Empty">
          <Empty>No runs in this window.</Empty>
        </Spec>
      </Section>

      <Section title="Tables" blurb="12px muted headers, 13px cells, hairline rows, and a wrapper that scrolls sideways without stealing the browser's back gesture.">
        <TableWrap>
          <Table>
            <thead>
              <tr><th>Run</th><th>State</th><th>Cost</th></tr>
            </thead>
            <tbody>
              <tr><td className="font-mono">a1b2c3d</td><td><Badge tone="ok">succeeded</Badge></td><td>$0.0412</td></tr>
              <tr><td className="font-mono">e4f5a6b</td><td><Badge tone="danger">failed</Badge></td><td>$0.0090</td></tr>
              <tr><td className="font-mono">c7d8e9f</td><td><Badge tone="muted">skipped</Badge></td><td className="text-muted">not priced</td></tr>
            </tbody>
          </Table>
        </TableWrap>
      </Section>

      <Section title="Dialog" blurb="The settings modal's shell, generalized. Esc closes it, a drag-select released past the card edge does not, and focus returns to whatever opened it.">
        <Spec label="Dialog">
          <Button variant="primary" onClick={() => setDialogOpen(true)}>Open dialog</Button>
        </Spec>
        {dialogOpen && (
          <Dialog label="Example dialog" onClose={() => setDialogOpen(false)} initialFocus=".ds-dialog-close">
            <div className="settings-page-header">
              <h2>Example dialog</h2>
              <Button className="ds-dialog-close" onClick={() => setDialogOpen(false)}>Close</Button>
            </div>
            <div className="p-6">
              <p className="text-[length:var(--control-font)] text-muted">
                Press Escape, or press inside this card and release outside it — only the first closes.
              </p>
            </div>
          </Dialog>
        )}
      </Section>
    </div>
  );
}
