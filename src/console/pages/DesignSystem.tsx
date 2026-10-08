import { useState } from 'react';
import { CircleAlert, Monitor, Moon, RefreshCw, Sun, Trash2 } from 'lucide-react';
import {
  Badge, Button, Card, ConfirmButton, Dialog, Empty, Eyebrow, Field, Icon, IconButton,
  Input, Link, Metric, NavItem, Notice, PageTitle, ProgressBar, Select, SectionTitle, Spinner,
  Table, TableWrap, Textarea, Toolbar, type ButtonVariant, type Tone,
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
 * qm's `DESIGN_TOKENS` (`admin/ui/design.ts:11-23`), with the roles MOLIOR added
 * (accent, selected surface, focus). The descriptions are the vocabulary, and
 * paraphrasing them is how two people end up using `--subtle` for two jobs.
 */
const DESIGN_TOKENS: ReadonlyArray<readonly [string, string]> = [
  ['--bg', 'Page behind every surface'],
  ['--surface', 'Cards, dialogs, table bodies'],
  ['--subtle', 'Quiet control and inset backgrounds'],
  ['--border', 'Every hairline and divider'],
  ['--text', 'Primary copy'],
  ['--muted', 'Secondary copy and hints'],
  ['--cta', 'Primary actions'],
  ['--accent', 'Selection, progress and the spinner. Never a button fill'],
  ['--accent-foreground', 'Text sitting on the accent'],
  ['--selected-surface', 'The active row or card'],
  ['--focus', 'The keyboard focus ring'],
  ['--ok', 'Confirmed and healthy'],
  ['--warn', 'Needs attention'],
  ['--danger', 'Destructive and failed'],
  ['--trigger', 'Automation and triggers'],
  // Not one of qm's eleven. It is here because it is the token that replaced
  // the console's last colour literal, and a scrim nobody can see listed is a
  // scrim somebody re-hardcodes.
  ['--scrim', 'The dim behind a modal (used at 60%)'],
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
  const [navTab, setNavTab] = useState('sources');
  /** The controlled `ConfirmButton` specimen, armed from here so the "Keep it"
   *  button beside it is a real one rather than a picture of one. */
  const [armed, setArmed] = useState(false);

  const pickTheme = (next: ThemeChoice) => {
    setChoice(next);
    setTheme(next);
  };

  return (
    <div className="mx-auto w-full max-w-[var(--maxw)] p-6">
      <header className="mb-[var(--section-gap)]">
        <PageTitle>Design system</PageTitle>
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

      <Section title="Type" blurb="The headings, labels and figures the pages are built from. Each one reads a token, so a theme changes them together.">
        <Spec label="PageTitle" note="h1, one per page; --heading-size and --heading-weight">
          <PageTitle>Runs</PageTitle>
        </Spec>
        <Spec label="SectionTitle" note="h2 inside a page or a notice; it keeps the colour it sits in">
          <SectionTitle>Rollups</SectionTitle>
        </Spec>
        <Spec label="Eyebrow" note="the uppercase label; table headers are set in the same style">
          <Eyebrow>Per member</Eyebrow>
        </Spec>
        <Spec label="Metric" note="a large figure, with tabular numerals so a column lines up">
          <Metric>$12.40</Metric>
          <Metric>1,284</Metric>
        </Spec>
        <Spec label="ProgressBar" note="a 2px hairline track with the accent fill; the value is announced">
          <div className="w-64">
            <ProgressBar value={60} label="Example progress" />
          </div>
        </Spec>
      </Section>

      <Section title="Buttons" blurb="One control height, one radius and one label size, all set by the theme. Primary is the only filled variant; destructive actions are red text on the standard chrome, never a red fill.">
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
        <Spec label="Button layout" note="center is the default; between is a disclosure row, and the only justify-content the button emits">
          <Button className="w-64" layout="between">
            <span className="font-mono">▸ core</span>
            <Badge tone="ok">ACTIVE</Badge>
          </Button>
          <Button className="w-64" layout="start">Left-aligned label</Button>
        </Spec>
        <Spec label="ConfirmButton" note="uncontrolled: first press arms, second confirms, blur disarms">
          <ConfirmButton label="Delete" confirmLabel="Press again to delete" onConfirm={() => {}} />
        </Spec>
        <Spec
          label="ConfirmButton, controlled"
          note="the caller owns armed, so it can render the way out — blur no longer disarms, because reaching for Keep it blurs the button"
        >
          <ConfirmButton
            label="Delete"
            confirmLabel="Confirm delete"
            armed={armed}
            onArm={() => setArmed(true)}
            onCancel={() => setArmed(false)}
            onConfirm={() => setArmed(false)}
          />
          {armed && <Button onClick={() => setArmed(false)}>Keep it</Button>}
        </Spec>
        <Spec label="Spinner">
          <Spinner />
          <Spinner size={24} />
        </Spec>
      </Section>

      <Section title="Fields" blurb="Inputs share the button's height, border and radius, so a control row lines up whatever it is made of. Focus turns the border ink; invalid sets the border and aria-invalid from one prop.">
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

      <Section title="Cards, notices and empties" blurb="A card is a surface with a hairline and 24px of inset. A notice is the standing warning those 21 border-warning call sites are really made of.">
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
        <Spec
          label={'Notice layout="stack"'}
          note="the warning card the plan called <Card tone=&quot;warning&quot;>: stacked lines, no w-full wrapper, no flex-col passed through"
        >
          <Notice layout="stack" className="w-full">
            <div className="font-medium">3 open schedule alerts</div>
            <p>A stacked notice lays its children out as lines rather than as one row.</p>
            <Toolbar>
              <Button>Acknowledge</Button>
              <Button>Dismiss</Button>
            </Toolbar>
          </Notice>
        </Spec>
        <Spec label="Empty">
          <Empty>No runs in this window.</Empty>
        </Spec>
      </Section>

      <Section
        title="Navigation and links"
        blurb="Two shapes Button cannot take: a left-aligned borderless rail row, and a real anchor. Both exist because a Button wearing overrides cannot be relied on to win — see rule 2 in ui/classes.ts."
      >
        <Spec label="NavItem" note="the settings rail; active is the surface/CTA pair and carries aria-current">
          <nav className="w-56 rounded-[var(--radius)] border border-border bg-bg p-2" aria-label="Example sections">
            {['sources', 'schema', 'members'].map((t) => (
              <NavItem key={t} active={t === navTab} onClick={() => setNavTab(t)}>
                {t}
              </NavItem>
            ))}
          </nav>
        </Spec>
        <Spec label="Link" note='surface="page" is CTA-coloured and always underlined'>
          <Link href="#" onClick={(e) => e.preventDefault()}>Open Schedules to acknowledge →</Link>
        </Spec>
        <Spec
          label={'Link surface="notice"'}
          note="In some themes --cta loses contrast on --warn-surface, so a link there inherits the notice's own copy colour and keeps a permanent underline"
        >
          <Notice layout="stack" className="w-full">
            <p>Two links on the same fill. Switch to dark above and compare them.</p>
            <Link surface="notice" href="#" onClick={(e) => e.preventDefault()}>
              surface=&quot;notice&quot; — legible
            </Link>
            <Link href="#" onClick={(e) => e.preventDefault()}>
              surface=&quot;page&quot; — the failure this prop exists to prevent
            </Link>
          </Notice>
        </Spec>
      </Section>

      <Section title="Tables" blurb="Eyebrow headers, control-size cells, hairline rows, and a wrapper that scrolls sideways without stealing the browser's back gesture.">
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
        {/* The same three columns with `align`. A `text-right` written on the
            `th` itself would lose to the header rule's compiled selector, which
            is why this is a prop and not something a call site spells out. */}
        <p className="mt-4 mb-2 text-[length:var(--control-font)] text-muted">
          <code className="font-mono">align={'{'}['left', 'center', 'right']{'}'}</code> — positional, one entry per column.
        </p>
        <TableWrap>
          <Table align={['left', 'center', 'right']}>
            <thead>
              <tr><th>Run</th><th>State</th><th>Cost</th></tr>
            </thead>
            <tbody>
              <tr><td className="font-mono">a1b2c3d</td><td><Badge tone="ok">succeeded</Badge></td><td className="font-mono">$0.0412</td></tr>
              <tr><td className="font-mono">e4f5a6b</td><td><Badge tone="danger">failed</Badge></td><td className="font-mono">$0.0090</td></tr>
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
