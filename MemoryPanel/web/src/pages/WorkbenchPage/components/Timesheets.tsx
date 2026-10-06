import { useEffect, useState } from 'react';
import { Download, RotateCw } from 'lucide-react';
import { SummaryStrip } from '@/components/baren';
import { readJsonResponse, readResponseError } from '@/lib/fetch-json';
import { getPanelSession } from '@/lib/panelSession';
import { useDisplayNameResolver } from '@/services/user-profile-store';
import '../styles/timesheets.css';
type Entry = {
  id: string;
  author: string;
  task: string;
  title: string;
  project: string;
  started: number;
  ended: number | null;
  seconds: number | null;
  note: string;
  review_state: string;
  reviewed_by: string | null;
  paid_by: string | null;
  paid_at: number | null;
  payment_ref: string | null;
};
type Sheet = {
  items: Entry[];
  contributors: string[];
  totals: { completed: number; pending: number; payable: number; paid: number; running: number };
  daily: Record<string, number>;
  canReview: boolean;
  canPay: boolean;
  unresolvedLegacy: number;
};
const hours = (seconds: number) =>
  `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ${seconds % 60}s`;
const today = () => new Date().toISOString().slice(0, 10);
// Matches the server's per-request limit for approve, reopen and pay.
const MAX_BULK = 200;
export default function Timesheets({ teamId }: { teamId: string }) {
  const name = useDisplayNameResolver();
  const [from, setFrom] = useState(() => today().slice(0, 8) + '01'),
    [to, setTo] = useState(today),
    [author, setAuthor] = useState('');
  const [sheet, setSheet] = useState<Sheet | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [version, setVersion] = useState(0);
  const [selected, setSelected] = useState<string[]>([]),
    [reference, setReference] = useState(''),
    [payment, setPayment] = useState(false),
    [capped, setCapped] = useState(0);
  const query = new URLSearchParams({ from, to, author }).toString();
  async function request(action: string, body?: unknown) {
    const session = getPanelSession();
    if (!session) throw Error('Please sign in.');
    const response = await fetch(
      `/api/v1/timesheets/${encodeURIComponent(teamId)}/${action}?${query}`,
      {
        method: body ? 'POST' : 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Tdai-Service-Id': session.instanceId,
          'X-Tdai-User-Key': session.userKey,
        },
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    if (!response.ok) throw Error(await readResponseError(response, 'Timesheets request failed.'));
    return response;
  }
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSelected([]);
    setCapped(0);
    setPayment(false);
    setError('');
    setSheet(null);
    void request('list')
      .then((r) => readJsonResponse<Sheet>(r, 'Timesheets request failed.'))
      .then((data) => {
        if (!cancelled) setSheet(data);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Filters define the request scope; responses from previous scopes are discarded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, from, to, author, version]);
  const chosen = sheet?.items.filter((e) => selected.includes(e.id)) || [];
  const withinLimit = chosen.length > 0 && chosen.length <= MAX_BULK;
  const allPending =
    withinLimit && chosen.every((e) => e.ended !== null && e.review_state === 'pending');
  const allApproved =
    withinLimit && chosen.every((e) => e.ended !== null && e.review_state === 'approved');
  const completedIn = (state: string) =>
    sheet?.items.filter((e) => e.ended !== null && e.review_state === state) || [];
  const pendingEntries = completedIn('pending'),
    approvedEntries = completedIn('approved');
  // Bulk actions apply to a single review state, so select-all targets one actionable group.
  const selectAllGroup = pendingEntries.length ? pendingEntries : approvedEntries;
  function selectGroup(entries: Entry[]) {
    setPayment(false);
    setSelected(entries.slice(0, MAX_BULK).map((e) => e.id));
    setCapped(entries.length > MAX_BULK ? entries.length : 0);
  }
  function clearSelection() {
    setPayment(false);
    setSelected([]);
    setCapped(0);
  }
  async function mutate(action: string) {
    setBusy(true);
    setError('');
    try {
      await request(action, { ids: selected, reference });
      setVersion((v) => v + 1);
      setReference('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to update entries.');
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    setBusy(true);
    setError('');
    try {
      const r = await request('csv');
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `timesheet-${from}-${to}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="timesheets" aria-label="Team timesheets">
      <header className="work-page-header">
        <div>
          <span className="work-eyebrow">Make every contribution count</span>
          <h2>Timesheets</h2>
          <p>Review contributions, approve time, and record completed payments.</p>
        </div>
        <div className="work-actions">
          <button onClick={() => setVersion((v) => v + 1)} disabled={busy || loading}>
            <RotateCw size={15} aria-hidden="true" />
            Refresh
          </button>
          <button
            className="work-primary"
            onClick={() => void download()}
            disabled={busy || loading || !sheet}
          >
            <Download size={16} aria-hidden="true" />
            Export CSV
          </button>
        </div>
      </header>
      <div className="timesheet-filters work-filterbar" aria-label="Filter timesheets">
        <label>
          Teammate
          <select
            value={author}
            disabled={busy || !sheet?.canReview}
            onChange={(e) => setAuthor(e.target.value)}
          >
            <option value="">{sheet?.canReview ? 'All teammates' : 'My time'}</option>
            {sheet?.contributors.map((id) => (
              <option key={id} value={id}>
                {name(id)}
              </option>
            ))}
          </select>
        </label>
        <label>
          From (UTC)
          <input
            type="date"
            value={from}
            disabled={busy}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label>
          Through (UTC)
          <input type="date" value={to} disabled={busy} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      <p className="timesheet-hint">
        Dates are inclusive. Each entry is assigned in full to its start date in UTC, including work
        crossing midnight. Running timers are excluded from all hour totals. Approved and paid
        entries retain their project at approval.
      </p>
      {error && (
        <p role="alert" className="project-board-error">
          {error}
        </p>
      )}
      {loading && (
        <p className="work-empty" role="status">
          Loading timesheets…
        </p>
      )}
      {sheet && (
        <>
          {sheet.unresolvedLegacy > 0 && (
            <p role="alert">
              Some older task records could not be resolved. Ask an administrator to reconcile
              legacy entries before using this report for payment.
            </p>
          )}
          <SummaryStrip
            className="timesheet-totals"
            items={[
              { label: 'Completed', value: hours(sheet.totals.completed) },
              { label: 'Awaiting approval', value: hours(sheet.totals.pending) },
              { label: 'Approved • unpaid', value: hours(sheet.totals.payable) },
              { label: 'Paid', value: hours(sheet.totals.paid) },
              { label: 'Running timers', value: sheet.totals.running },
            ]}
          />
          <details className="timesheet-daily work-surface">
            <summary>
              Daily totals <span className="timesheet-zone">UTC</span>
            </summary>
            <div className="timesheet-daily-grid">
              {Object.entries(sheet.daily)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([day, seconds]) => (
                  <p key={day}>
                    {day} · {hours(seconds)}
                  </p>
                ))}
              {!Object.keys(sheet.daily).length && <p>No completed time in this period.</p>}
            </div>
          </details>
          {sheet.canReview && (
            <div className={`timesheet-actions${selected.length ? ' has-selection' : ''}`}>
              <span>{selected.length} selected</span>
              {pendingEntries.length > 0 && (
                <button disabled={busy} onClick={() => selectGroup(pendingEntries)}>
                  Select awaiting approval ({pendingEntries.length})
                </button>
              )}
              {approvedEntries.length > 0 && (
                <button disabled={busy} onClick={() => selectGroup(approvedEntries)}>
                  Select approved ({approvedEntries.length})
                </button>
              )}
              <button
                className="work-primary"
                disabled={busy || !allPending}
                onClick={() => void mutate('approve')}
              >
                Approve selected
              </button>
              <button disabled={busy || !allApproved} onClick={() => void mutate('reopen')}>
                Return to pending
              </button>
              {sheet.canPay && (
                <button disabled={busy || !allApproved} onClick={() => setPayment(true)}>
                  Mark paid…
                </button>
              )}
            </div>
          )}
          {capped > 0 && (
            <p className="timesheet-hint" role="status">
              Selected the first {MAX_BULK} of {capped} entries, the most one action can update. Run
              the action, then select again for the rest.
            </p>
          )}
          {payment && (
            <form
              className="timesheet-payment work-surface"
              onSubmit={(e) => {
                e.preventDefault();
                void mutate('pay');
              }}
            >
              <strong>
                Record payment for {chosen.length} entries ·{' '}
                {hours(chosen.reduce((s, e) => s + (e.seconds || 0), 0))}
              </strong>
              <p>
                This records a payment you already made; it does not send money. Paid entries are
                locked and cannot be marked paid again.
              </p>
              <label>
                Payment reference
                <input
                  required
                  maxLength={200}
                  value={reference}
                  disabled={busy}
                  placeholder="e.g. transfer or invoice reference"
                  onChange={(e) => setReference(e.target.value)}
                />
              </label>
              <button className="work-primary" disabled={busy || !reference.trim() || !allApproved}>
                Confirm paid
              </button>
              <button type="button" disabled={busy} onClick={() => setPayment(false)}>
                Cancel
              </button>
            </form>
          )}
          <div
            className="timesheet-table-wrap work-surface"
            tabIndex={0}
            role="region"
            aria-label="Time entries"
          >
            <table>
              <thead>
                <tr>
                  {sheet.canReview && (
                    <th>
                      <input
                        type="checkbox"
                        aria-label={
                          pendingEntries.length
                            ? 'Select entries awaiting approval'
                            : 'Select approved entries'
                        }
                        disabled={busy || !selectAllGroup.length}
                        checked={
                          selected.length > 0 &&
                          selectAllGroup.slice(0, MAX_BULK).every((e) => selected.includes(e.id))
                        }
                        onChange={(e) =>
                          e.target.checked ? selectGroup(selectAllGroup) : clearSelection()
                        }
                      />
                    </th>
                  )}
                  <th>Teammate</th>
                  <th>Started (UTC)</th>
                  <th>Task / project</th>
                  <th>Time</th>
                  <th>Work notes</th>
                  <th>Review / payment</th>
                </tr>
              </thead>
              <tbody>
                {sheet.items.map((e) => (
                  <tr key={e.id} className={selected.includes(e.id) ? 'is-selected' : undefined}>
                    {sheet.canReview && (
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Select ${e.title} ${e.id}`}
                          disabled={busy || e.ended === null || e.review_state === 'paid'}
                          checked={selected.includes(e.id)}
                          onChange={(ev) => {
                            setPayment(false);
                            setCapped(0);
                            setSelected((ids) =>
                              ev.target.checked ? [...ids, e.id] : ids.filter((id) => id !== e.id),
                            );
                          }}
                        />
                      </td>
                    )}
                    <td>{name(e.author)}</td>
                    <td className="timesheet-date">
                      {new Date(e.started).toISOString().replace('T', ' ').slice(0, 16)}
                    </td>
                    <td>
                      <strong>{e.title || e.task}</strong>
                      <small>{e.project || 'Unassigned'}</small>
                    </td>
                    <td className="timesheet-duration">
                      {e.ended === null ? 'Running — excluded' : hours(e.seconds || 0)}
                    </td>
                    <td className="timesheet-note">{e.note || '—'}</td>
                    <td>
                      <strong
                        className={`timesheet-state is-${e.ended === null ? 'running' : e.review_state}`}
                      >
                        {e.ended === null ? 'Running' : e.review_state}
                      </strong>
                      {e.reviewed_by && <small>Approved by {name(e.reviewed_by)}</small>}
                      {e.paid_by && (
                        <small>
                          Paid by {name(e.paid_by)} ·{' '}
                          {new Date(e.paid_at!).toISOString().slice(0, 10)}
                          <br />
                          {e.payment_ref}
                        </small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!sheet.items.length && <p className="work-empty">No time entries match this period.</p>}
          <p className="timesheet-hint">
            Approved entries are locked against deletion. Return them to pending to allow their
            author to correct them. Paid records remain locked. Rates and payment amounts are not
            calculated.
          </p>
        </>
      )}
    </section>
  );
}
