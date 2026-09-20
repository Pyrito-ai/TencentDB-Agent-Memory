import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getPanelSession } from '@/lib/panelSession';
import { useDisplayNameResolver } from '@/services/user-profile-store';
interface Activity { id: string; kind: 'note' | 'attachment'; author: string; createdAt: string; text?: string; name?: string; size?: number }
export default function TaskActivity({ taskId, creator, currentUser }: { taskId: string; creator: string; currentUser: string }) {
  const { t } = useTranslation(); const name = useDisplayNameResolver();
  const [items, setItems] = useState<Activity[]>([]); const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  async function request(action: string, init: RequestInit = {}) {
    const session = getPanelSession();
    if (!session) throw new Error(t('board.activity.login'));
    const response = await fetch(`/api/v1/task/activity/${encodeURIComponent(taskId)}/${action}`, {
      ...init, headers: { 'X-Tdai-Service-Id': session.instanceId, 'X-Tdai-User-Key': session.userKey, ...init.headers },
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || t('board.activity.failed'));
    }
    return response;
  }
  async function refresh() { const r = await request('list'); setItems((await r.json()).items); }
  useEffect(() => {
    let cancelled = false;
    request('list').then(r => r.json()).then(data => { if (!cancelled) setItems(data.items); })
      .catch(err => { if (!cancelled) setError(err.message); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // Mounted with a task key, so a task switch resets all local draft state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);
  async function perform(work: () => Promise<void>) {
    setBusy(true); setError('');
    try { await work(); await refresh(); } catch (err) { setError(err instanceof Error ? err.message : t('board.activity.failed')); }
    finally { setBusy(false); }
  }
  return <section className="project-board-activity">
    <h3>{t('board.activity.title')}</h3>
    {error && <p role="alert" className="project-board-error">{error} <button onClick={() => void perform(refresh)} disabled={busy}>{t('board.activity.retry')}</button></p>}
    {loading ? <p>{t('board.loading')}</p> : !items.length && <p>{t('board.activity.empty')}</p>}
    {items.map(item => <article key={item.id} className="project-board-activity-item">
      <header><strong>{name(item.author)}</strong><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></header>
      {item.kind === 'note' ? <p>{item.text}</p> : <button className="project-board-file" disabled={busy} onClick={() => void perform(async () => {
        const r = await request(`download?id=${encodeURIComponent(item.id)}`); const url = URL.createObjectURL(await r.blob());
        const a = document.createElement('a'); a.href = url; a.download = item.name || 'attachment'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
      })}>{item.name} · {Math.ceil((item.size || 0) / 1024)} KB ↓</button>}
      {(item.author === currentUser || creator === currentUser) && <button disabled={busy} className="project-board-remove" onClick={() => {
        if (window.confirm(t('board.activity.confirmDelete'))) void perform(async () => { await request(`delete?id=${encodeURIComponent(item.id)}`, { method: 'POST' }); });
      }}>{t('board.activity.delete')}</button>}
    </article>)}
    <label className="project-board-criteria-label">{t('board.activity.note')}
      <textarea rows={4} maxLength={20000} value={note} disabled={busy} placeholder={t('board.activity.placeholder')} onChange={e => setNote(e.target.value)} />
    </label>
    <div className="project-board-activity-actions">
      <button disabled={busy || !note.trim()} onClick={() => void perform(async () => {
        await request('note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: note }) }); setNote('');
      })}>{t('board.activity.addNote')}</button>
      <label>{t('board.activity.attach')}<input type="file" disabled={busy} onChange={e => {
        const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
        if (file.size > 10 * 1024 * 1024 || !file.size) { setError(t('board.activity.size')); return; }
        void perform(async () => { const form = new FormData(); form.append('file', file); await request('upload', { method: 'POST', body: form }); });
      }} /></label>
      {busy && <span role="status">{t('board.activity.working')}</span>}
    </div>
  </section>;
}
