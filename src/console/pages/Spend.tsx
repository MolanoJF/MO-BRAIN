import { useEffect, useState } from 'react';
import { spendApi, type SpendReport, type SpendRow } from '../api.ts';
import { Card, Empty, Table, TableWrap } from '../ui/index.tsx';

/**
 * The cost page (D8, D9). The ORDER of the four sections is the argument:
 *
 *   1. What this page can and cannot see — first, because a dollar figure is a
 *      claim about coverage, and the coverage has to land before the number.
 *   2. Totals — our meter and gbrain's ledger as TWO figures. They meter
 *      different things; adding them would invent a number that exists nowhere.
 *   3. Per member / per schedule / per model — three tables, with the
 *      `unattributed` bucket styled as its own row rather than as a member.
 *   4. Unpriced calls — a count shown even when it is zero, because a page that
 *      mentions unpriced calls only when they exist teaches the reader that
 *      their absence is never worth stating.
 *
 * Two rules from `src/control/spend.ts` ride through here: a cost we could not
 * price is NULL and never `$0.00` (honesty rule 3), and `unattributed` is a
 * bucket, not a person (D9).
 */

const num = (n: number): string => n.toLocaleString('en-US');

/**
 * `Runs.tsx:34-38`'s money formatting, kept identical: a zero is `$0.00` and any
 * other amount carries four decimals. Never called with a NULL total — the
 * callers say "not priced" in words instead, because a NULL rendered as
 * `$0.00` is the honesty-rule-3 bug this page exists to avoid
 * (`Runs.tsx:159-161`).
 */
function money(amount: number): string {
  if (!Number.isFinite(amount)) return `unreadable amount (${amount})`;
  return amount === 0 ? '$0.00' : `$${amount.toFixed(4)}`;
}

/** A total that could not be priced is words, never a dollar figure. Ours is
 *  NULL when runs exist but none could be priced; the unread brain ledger is
 *  named separately, because unknown is not the same as zero. */
export function usdText(amount: number | null): string {
  return amount === null ? 'Not priced — no run in this window could be priced' : money(amount);
}

/** D9: a run whose Connection is gone (`connection_id` is `on delete set null`,
 *  deliberately, so the audit survives) rolls up under `unattributed`. It is
 *  styled as its own thing, never as a member: folding it into a member's row
 *  would attribute a deleted Connection's spend to a person who did not run it. */
export const UNATTRIBUTED_KEY = 'unattributed';

export function isUnattributed(row: SpendRow): boolean {
  return row.key === UNATTRIBUTED_KEY;
}

/**
 * One rollup table. `rows` are already sorted by the route (priced total
 * descending, then key ascending), so the page never re-orders them. A row
 * whose total is NULL means every call behind it was unpriced — that reads as
 * words, and the unpriced count beside it says how many.
 */
function SpendTable({ title, unitLabel, emptyText, rows }: {
  title: string;
  unitLabel: string;
  emptyText: string;
  rows: SpendRow[];
}) {
  return (
    <Card title={title}>
      {rows.length === 0 ? (
        <Empty>{emptyText}</Empty>
      ) : (
        <TableWrap>
          {/* The numeric columns are right-aligned through a descendant variant
              rather than a `text-right` class on each cell: `Table` bakes in
              `[&_th]:text-left`, whose compiled selector outranks a bare
              utility on the `th` itself, so a per-cell class would silently
              lose and the money column would drift back to the left. */}
          <Table className="[&_th:not(:first-child)]:text-right [&_td:not(:first-child)]:text-right">
            <thead>
              <tr>
                <th>key</th>
                <th>{unitLabel}</th>
                <th>cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const unattributed = isUnattributed(row);
                return (
                  <tr key={row.key} className={unattributed ? 'text-warning' : ''}>
                    <td>
                      {row.label}
                      {unattributed && (
                        <span className="text-xs"> · its Connection was deleted, so it is not a member</span>
                      )}
                    </td>
                    <td className="font-mono">{num(row.runs)}</td>
                    {/* A NULL cost is words, never $0.00 (honesty rule 3). */}
                    <td className="font-mono">
                      {row.costUsd === null ? 'not priced' : money(row.costUsd)}
                      {row.unpricedRuns > 0 && (
                        <span className="text-xs text-muted"> ({num(row.unpricedRuns)} unpriced)</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </TableWrap>
      )}
    </Card>
  );
}

export function Spend() {
  const [report, setReport] = useState<SpendReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    spendApi
      .get()
      .then((r) => { if (live) { setReport(r); setError(null); } })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : 'Could not load spend');
      });
    return () => { live = false; };
  }, []);

  if (report === null) {
    return error === null
      ? <Empty>Loading…</Empty>
      : <div className="text-[length:var(--control-font)] text-danger">{error}</div>;
  }

  const { ours, brain, coverage } = report;
  const brainReady = coverage.brainReachable && brain !== null;

  return (
    <div className="max-w-3xl space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Spend</h1>
        <p className="text-sm text-muted">
          What this deployment metered over the last {num(report.windowDays)} day(s), and what gbrain's own
          ledger recorded — two figures, never one.
        </p>
      </header>

      {error !== null && <div className="text-[length:var(--control-font)] text-danger">{error}</div>}

      {/* Section 1 — FIRST, not last: the argument is that coverage precedes the
          number. Ours and gbrain's are two different ledgers. */}
      <Card
        title="What this page can and cannot see"
        subtitle="Two meters, two different questions, and no attempt to reconcile them."
        className="space-y-3"
      >
        <div className="space-y-1">
          <div className="text-sm font-medium">Ours</div>
          <ul className="list-disc pl-5 text-sm space-y-1">
            {coverage.ours.map((line, i) => <li key={`${i}-${line}`}>{line}</li>)}
          </ul>
        </div>

        <div className="space-y-1">
          <div className="text-sm font-medium">gbrain's own ledger</div>
          {brainReady ? (
            <>
              <p className="text-sm">
                gbrain's ledger covers <span className="font-mono">gateway.chat</span> calls. Upstream's own
                <span className="font-mono"> coverage.notCovered</span> — its words, character for character — is:
              </p>
              {brain.coverage.notCovered.length === 0 ? (
                <p className="text-sm text-muted">Upstream listed nothing outside its coverage.</p>
              ) : (
                <ul className="list-disc pl-5 text-sm space-y-1">
                  {brain.coverage.notCovered.map((line, i) => <li key={`${i}-${line}`}>{line}</li>)}
                </ul>
              )}
            </>
          ) : (
            <p className="text-sm text-warning">
              The brain ledger could not be read, so the totals below are ours alone. An unread ledger is
              unknown, not zero, and this page will not print one.
            </p>
          )}
        </div>
      </Card>

      {/* Section 2 — TWO figures. No code path here adds them. */}
      <Card
        title="Totals"
        subtitle="Two separate figures, never added together. They meter different things; summing them would invent a number."
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Card className="space-y-1">
            <div className="text-sm text-muted">Ours — agent-runner model calls through our gateway</div>
            <div className="text-2xl font-semibold">{usdText(ours.totalUsd)}</div>
            <div className="text-xs text-muted">over the last {num(report.windowDays)} day(s)</div>
          </Card>
          <Card className="space-y-1">
            <div className="text-sm text-muted">
              gbrain's ledger — <span className="font-mono">gateway.chat</span> calls
            </div>
            {brain !== null ? (
              <>
                <div className="text-2xl font-semibold">{money(brain.totals.costUsd)}</div>
                <div className="text-xs text-muted">
                  over the last {num(brain.windowDays)} day(s), {num(brain.totals.calls)} call(s)
                </div>
              </>
            ) : (
              <div className="text-warning">Not read — the brain ledger could not be reached.</div>
            )}
          </Card>
        </div>
      </Card>

      {/* Section 3 — three tables. `unattributed` is its own row (D9). */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Rollups</h2>
        <SpendTable
          title="Per member"
          unitLabel="runs"
          emptyText="No agent run was metered in this window."
          rows={ours.byMember}
        />
        <SpendTable
          title="Per schedule"
          unitLabel="runs"
          emptyText="No scheduled agent run was metered in this window."
          rows={ours.bySchedule}
        />
        <SpendTable
          title="Per model"
          unitLabel="calls"
          emptyText="No model call was metered in this window."
          rows={ours.byModel}
        />
      </section>

      {/* Section 4 — shown even at zero. */}
      <Card title="Unpriced calls" className="space-y-2">
        <div className="text-2xl font-semibold">{num(ours.unpricedRuns)}</div>
        <p className="text-sm">
          A metered call we could not price adds no dollar amount to any total and is counted here instead —
          it is never silently zeroed. A count of zero means every metered call in this window had a rate in
          the price table.
        </p>
        {brain !== null && (
          <p className="text-xs text-muted">
            gbrain's ledger separately reports {num(brain.coverage.unpricedCalls)} unpriced call(s) of its
            {' '}{num(brain.coverage.pricedCalls + brain.coverage.unpricedCalls)} — that is the other meter, and it
            is not added to ours.
          </p>
        )}
      </Card>
    </div>
  );
}
