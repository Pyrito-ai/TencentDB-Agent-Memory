import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getPanelSession } from '@/lib/panelSession';
import { useDisplayNameResolver } from '@/services/user-profile-store';
interface Entry { id: string; author: string; started: number; ended: number | null; seconds: number | null; note: string; kind: string; review_state: string }
function duration(seconds: number) { const s = Math.max(0, Math.floor(seconds)); return `${Math.floor(s/3600)}h ${Math.floor(s/60)%60}m ${s%60}s`; }
function localDate() { const d = new Date(Date.now()-3600000); return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16); }
export default function TaskTime({ taskId, currentUser }: { taskId: string; currentUser: string }) {
 const { t } = useTranslation(); const name = useDisplayNameResolver();
 const [entries, setEntries] = useState<Entry[]>([]); const [other, setOther] = useState(false);
 const [now, setNow] = useState(Date.now()); const [offset, setOffset] = useState(0);
 const [busy, setBusy] = useState(false); const [loaded, setLoaded] = useState(false); const [error, setError] = useState('');
 const [minutes, setMinutes] = useState('60'); const [started, setStarted] = useState(localDate);
 const [note, setNote] = useState(''); const [manual, setManual] = useState(false);
 async function request(action: string, body?: unknown) {
  const session = getPanelSession(); if (!session) throw new Error(t('board.activity.login'));
  const r = await fetch(`/api/v1/task/time/${encodeURIComponent(taskId)}/${action}`, { method: body ? 'POST' : 'GET',
   headers: { 'Content-Type':'application/json', 'X-Tdai-Service-Id':session.instanceId, 'X-Tdai-User-Key':session.userKey }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json(); if (!r.ok) throw new Error(data.error || t('board.activity.failed')); return data;
 }
 async function refresh() {
  const data = await request('list'); setEntries(data.items);setOther(data.otherRunning);setOffset(data.serverNow-Date.now());setLoaded(true);
 }
 useEffect(() => {
  let cancelled = false;
  async function load() {
   try { const d = await request('list'); if (!cancelled) { setEntries(d.items);setOther(d.otherRunning);setOffset(d.serverNow-Date.now());setLoaded(true); } }
   catch (err) { if (!cancelled) setError(err instanceof Error ? err.message : t('board.activity.failed')); }
  }
  void load(); const poll = setInterval(() => void load(),30000);const tick = setInterval(() => setNow(Date.now()),1000);
  return () => { cancelled=true;clearInterval(poll);clearInterval(tick); };
  // The component is keyed by task; intervals use that task's request scope.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[taskId]);
 async function mutate(action: string, body: unknown) {
  setBusy(true);setError('');try { await request(action,body);await refresh(); if(action==='manual'){setManual(false);setNote('');} }
  catch(err){setError(err instanceof Error ? err.message : t('board.activity.failed'));}finally{setBusy(false);}
 }
 const elapsed = (entry: Entry) => entry.ended === null ? Math.max(0,(now+offset-entry.started)/1000) : entry.seconds || 0;
 const running = entries.find(e => e.author === currentUser && e.ended === null);
 const people = [...new Set(entries.map(e => e.author))];
 return <section className="project-board-time">
  <header><h3>{t('time.title')}</h3><strong>{duration(entries.reduce((sum,e)=>sum+elapsed(e),0))}</strong></header>
  {error && <p role="alert" className="project-board-error">{error}</p>}
  <div className="project-board-activity-actions">
   {running ? <button disabled={busy} onClick={()=>void mutate('stop',{id:running.id})}>{t('time.stop')} · {duration(elapsed(running))}</button>
    : <button disabled={busy||other||!loaded} onClick={()=>void mutate('start',{})}>{t('time.start')}</button>}
   <button disabled={busy} onClick={()=>setManual(!manual)}>{t('time.manual')}</button>
  </div>
  {other && <p>{t('time.other')}</p>}
  {manual && <form className="project-board-fields" onSubmit={e=>{e.preventDefault();void mutate('manual',{started:new Date(started).getTime(),seconds:Number(minutes)*60,note});}}>
   <label>{t('time.started')}<input type="datetime-local" required value={started} disabled={busy} onChange={e=>setStarted(e.target.value)} /></label>
   <label>{t('time.minutes')}<input type="number" min="1" max="1440" step="1" required value={minutes} disabled={busy} onChange={e=>setMinutes(e.target.value)} /></label>
   <label>{t('time.note')}<input maxLength={2000} value={note} disabled={busy} onChange={e=>setNote(e.target.value)} /></label>
   <button type="submit" disabled={busy}>{t('time.save')}</button>
  </form>}
  {people.map(user=><p key={user} className="project-board-time-total">{name(user)} <strong>{duration(entries.filter(e=>e.author===user).reduce((sum,e)=>sum+elapsed(e),0))}</strong></p>)}
  {!entries.length && loaded && <p>{t('time.empty')}</p>}
  {entries.map(entry=><article className="project-board-time-entry" key={entry.id}>
   <div><strong>{name(entry.author)}</strong> · {new Date(entry.started).toLocaleString()}<p>{entry.note || (entry.kind==='timer'?t('time.timer'):t('time.manual'))}</p></div>
   <span>{duration(elapsed(entry))}{entry.ended===null && ` · ${t('time.running')}`}</span>
   {entry.author===currentUser && entry.ended!==null && entry.review_state==='pending' && <button disabled={busy} onClick={()=>{if(window.confirm(t('time.removeConfirm')))void mutate('delete',{id:entry.id});}}>{t('board.activity.delete')}</button>}
  </article>)}
  <p className="project-board-detail-note">{t('time.hint')}</p>
 </section>;
}
