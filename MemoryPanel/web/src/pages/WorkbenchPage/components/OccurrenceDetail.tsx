import { useState } from 'react';
import TaskTime from './TaskTime';
import { workApi as api } from '../hooks/useAreas';
import type { Loop, Occurrence } from './loop-types';
export default function OccurrenceDetail({
  occurrence: o,
  loop,
  currentUser,
  teamId,
  busy,
  mutate,
  onOpenTask,
  onRetry,
}: {
  occurrence: Occurrence;
  loop: Loop;
  currentUser: string;
  teamId: string;
  busy: boolean;
  mutate: (action: string, body: unknown) => Promise<unknown>;
  onOpenTask: (id: string) => void;
  onRetry: () => void;
}) {
  const [note, setNote] = useState(o.note),
    [resultUrl, setResultUrl] = useState(o.result_url),
    [time, setTime] = useState<{ id: string; seconds: number; note: string }[]>([]),
    [ids, setIds] = useState<string[]>([]),
    [error, setError] = useState(''),
    [copied, setCopied] = useState(false);
  const mine = o.author === currentUser;
  async function refreshTime() {
    if (!o.task_id) return;
    try {
      const d = await api(`task/time/${o.task_id}/list`);
      setTime(
        d.items.filter(
          (e: { author: string; ended: number | null }) =>
            e.author === currentUser && e.ended !== null,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to load time.');
    }
  }
  const brief = `Loop: ${loop.name}\nOccurrence: ${o.id}\nTeam: ${teamId}\nArea: ${o.area_name}\nOwner: ${o.owner_id}\nDue: ${o.due_day || 'Flexible period'}\nProject: ${o.project_id ? `${o.project_name} (${o.project_id})` : 'No project'}\nTask ID: ${o.task_id}\nAgent ID: ${o.agent_id || 'Human work'}\n\n${o.brief}\n\nUse the task ID above in the Tencent session context. Record findings and work links on the task. Do not mark the loop complete; a human must review and accept the result.`;
  return (
    <section className="loop-occurrence">
      <h3>{loop.name} — occurrence</h3>
      <p>
        {o.area_name} · {o.project_name || 'No project'} · {o.state}
        {o.due_day && ` · Due ${o.due_day}`}
      </p>
      {error && <p role="alert">{error}</p>}
      {o.task_id ? (
        <>
          <button onClick={() => onOpenTask(o.task_id!)}>Open linked task</button>
          <details open={!!o.agent_id}>
            <summary>{o.agent_id ? 'Manual agent handoff' : 'Occurrence brief'}</summary>
            <pre>{brief}</pre>
            <button
              onClick={() => {
                void navigator.clipboard
                  .writeText(brief)
                  .then(() => setCopied(true))
                  .catch(() => setError('Copy failed. Select the brief and copy it manually.'));
              }}
            >
              {copied ? 'Copied' : 'Copy brief'}
            </button>
            <p className="loop-help">
              Paste this brief into your agent client. No agent is started automatically. Sessions
              recorded with this task ID appear in the task’s People & agent participation section.
            </p>
          </details>
        </>
      ) : (
        <p>
          Task preparation was interrupted.{' '}
          {mine && (
            <button disabled={busy} onClick={onRetry}>
              Check preparation
            </button>
          )}
        </p>
      )}
      {o.state === 'skipped' ? (
        <p>Skipped: {o.note}</p>
      ) : o.state === 'completed' ? (
        <>
          <p>{o.note || 'No completion note.'}</p>
          {o.result_url && (
            <a href={o.result_url} target="_blank" rel="noopener noreferrer">
              View result
            </a>
          )}
          <p>Linked human time: {o.time.reduce((sum, t) => sum + t.seconds, 0) / 60} minutes</p>
          {mine && (
            <button disabled={busy} onClick={() => void mutate('undo', { id: o.id })}>
              Undo completion
            </button>
          )}
        </>
      ) : (
        o.task_id &&
        mine && (
          <>
            <TaskTime taskId={o.task_id} currentUser={currentUser} />
            <form
              className="loop-form"
              onSubmit={(e) => {
                e.preventDefault();
                void mutate('complete', { id: o.id, note, resultUrl, timeIds: ids });
              }}
            >
              <label>
                Completion notes
                <textarea
                  rows={3}
                  maxLength={10000}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
              <label>
                Result / agent work link (optional)
                <input
                  type="url"
                  maxLength={2000}
                  value={resultUrl}
                  onChange={(e) => setResultUrl(e.target.value)}
                />
              </label>
              <fieldset>
                <legend>Link your tracked time (optional)</legend>
                <button type="button" onClick={() => void refreshTime()}>
                  Refresh stopped time entries
                </button>
                {time.map((t) => (
                  <label className="loop-check" key={t.id}>
                    <input
                      type="checkbox"
                      checked={ids.includes(t.id)}
                      onChange={(e) =>
                        setIds(e.target.checked ? [...ids, t.id] : ids.filter((id) => id !== t.id))
                      }
                    />
                    {t.seconds / 60} minutes · {t.note || 'Task work'}
                  </label>
                ))}
                <p className="loop-help">
                  Only stopped entries belonging to you can be linked. Linking reuses existing
                  timesheet entries; it does not add time again.
                </p>
              </fieldset>
              <button disabled={busy}>Accept work & complete occurrence</button>
              <p className="loop-help">
                {o.due_day
                  ? 'Completion stays attached to this deadline, even when late.'
                  : `Completion counts in the current ${loop.frequency} period.`}{' '}
                It records your acceptance; the linked task’s workflow is managed separately.
              </p>
            </form>
          </>
        )
      )}
    </section>
  );
}
