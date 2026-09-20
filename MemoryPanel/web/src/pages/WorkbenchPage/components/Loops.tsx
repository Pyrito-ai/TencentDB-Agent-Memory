import { useEffect, useState } from 'react';
import { getPanelSession } from '@/lib/panelSession';
import { useDisplayNameResolver } from '@/services/user-profile-store';
import { useProjects } from '../hooks/useProjects';
import TaskTime from './TaskTime';
import '../styles/loops.css';
type Agent={id:string;name:string};
type Loop={id:string;name:string;brief:string;project_id:string;frequency:string;target:number;timezone:string;agents:string[];archived:number;canManage:boolean;stats:{currentPeriod:string;progress:number;target:number;currentStreak:number;bestStreak:number;total:number}};
type Occurrence={id:string;loop_id:string;author:string;task_id:string|null;agent_id:string;project_id:string;project_name:string;brief:string;period:string;state:string;created_at:number;completed_at:number|null;note:string;result_url:string;time:{id:string;seconds:number;review_state:string}[]};
type Data={items:Loop[];history:Occurrence[];timezone:string;canManageTimezone:boolean};
async function api(path:string,body?:unknown){
 const s=getPanelSession();if(!s)throw Error('Please sign in.');
 const r=await fetch('/api/v1/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Tdai-Service-Id':s.instanceId,'X-Tdai-User-Key':s.userKey},body:body?JSON.stringify(body):undefined});
 const d=await r.json();if(!r.ok)throw Error(d.error||'Request failed.');return d;
}
const empty={name:'',brief:'',projectId:'',frequency:'weekly',target:1,agents:[] as string[]};
export default function Loops({teamId,currentUser,agents,onOpenTask}:{teamId:string;currentUser:string;agents:Agent[];onOpenTask:(id:string)=>void}){
 const name=useDisplayNameResolver(),projects=useProjects(teamId);
 const [data,setData]=useState<Data|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[version,setVersion]=useState(0);
 const [form,setForm]=useState<typeof empty|null>(null),[editing,setEditing]=useState(''),[projectFilter,setProjectFilter]=useState('all'),[person,setPerson]=useState('all'),[showArchived,setShowArchived]=useState(false),[zone,setZone]=useState('UTC');
 const [selected,setSelected]=useState(''),[agentsByLoop,setAgentsByLoop]=useState<Record<string,string>>({});
 useEffect(()=>{let active=true;void api(`loops/${teamId}/list`).then(d=>{if(active){setData(d);setZone(d.timezone);}}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[teamId,version]);
 async function mutate(action:string,body:unknown){setError('');setBusy(true);try{const d=await api(`loops/${teamId}/${action}`,body);setVersion(v=>v+1);window.dispatchEvent(new Event('tdai-memory.backend-refresh'));return d;}catch(e){setError(e instanceof Error?e.message:'Request failed.');return null;}finally{setBusy(false);}}
 async function start(loop:Loop,requestId:string=crypto.randomUUID()){
  const result=await mutate('start',{loopId:loop.id,agentId:agentsByLoop[loop.id]||'',requestId});if(result?.occurrence)setSelected(result.occurrence.id);else setVersion(v=>v+1);
 }
 const occurrence=data?.history.find(o=>o.id===selected);
 return <section className="loops-view">
  <header><div><h2>Loops</h2><p>Recurring work for people and agents. Completions count when a person accepts the work.</p></div><button disabled={busy||!projects.loaded} onClick={()=>{setEditing('');setForm({...empty,projectId:projects.items.find(p=>!p.archived)?.id||''});}}>New loop</button></header>
  {error&&<p role="alert" className="project-board-error">{error}</p>}{projects.error&&<p role="alert">{projects.error}</p>}
  {!data&&<p>Loading loops…</p>}
  {data&&<>
   <p className="loop-help">Team timezone: <strong>{data.timezone}</strong>. Weeks start Monday. Targets are shared across contributors; streaks count consecutive periods meeting the target.</p>
   {!data.items.length&&data.canManageTimezone&&<form className="loop-inline" onSubmit={e=>{e.preventDefault();void mutate('timezone',{timezone:zone});}}><label>Team timezone<input required value={zone} disabled={busy} onChange={e=>setZone(e.target.value)} placeholder="Europe/Madrid"/></label><button disabled={busy}>Save timezone</button></form>}
   {form&&<form className="loop-form" onSubmit={async e=>{e.preventDefault();if(await mutate(editing?'update':'create',{...form,id:editing}))setForm(null);}}>
    <h3>{editing?'Edit loop':'New loop'}</h3><label>Name<input required maxLength={160} value={form.name} disabled={busy} onChange={e=>setForm({...form,name:e.target.value})}/></label>
    <label>Project<select required value={form.projectId} disabled={busy} onChange={e=>setForm({...form,projectId:e.target.value})}><option value="">Choose a project</option>{projects.items.filter(p=>!p.archived).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <div className="loop-inline"><label>Target completions<input type="number" min={1} max={100} required value={form.target} disabled={busy||!!editing&&data.history.some(o=>o.loop_id===editing)} onChange={e=>setForm({...form,target:Number(e.target.value)})}/></label><label>Per period<select value={form.frequency} disabled={busy||!!editing&&data.history.some(o=>o.loop_id===editing)} onChange={e=>setForm({...form,frequency:e.target.value})}><option value="daily">Day</option><option value="weekly">Week</option><option value="monthly">Month</option></select></label></div>
    <label>Reusable brief / acceptance criteria<textarea rows={5} maxLength={10000} value={form.brief} disabled={busy} onChange={e=>setForm({...form,brief:e.target.value})}/></label>
    <fieldset><legend>Linked agents (optional)</legend>{agents.map(a=><label key={a.id} className="loop-check"><input type="checkbox" checked={form.agents.includes(a.id)} disabled={busy} onChange={e=>setForm({...form,agents:e.target.checked?[...form.agents,a.id]:form.agents.filter(id=>id!==a.id)})}/>{a.name}</label>)}{!agents.length&&<p>Create an agent in this team to enable handoffs.</p>}</fieldset>
    <p className="loop-help">Recurrence and timezone are fixed once work begins. Brief, project, and agent changes apply to future occurrences.</p><div className="loop-inline"><button disabled={busy||!form.projectId}>Save loop</button><button type="button" disabled={busy} onClick={()=>setForm(null)}>Cancel</button></div>
   </form>}
   <div className="loop-inline"><label>Project filter<select value={projectFilter} onChange={e=>setProjectFilter(e.target.value)}><option value="all">All projects</option>{projects.items.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label className="loop-check"><input type="checkbox" checked={showArchived} onChange={e=>setShowArchived(e.target.checked)}/>Show archived loops</label><button disabled={busy} onClick={()=>setVersion(v=>v+1)}>Refresh</button></div>
   <div className="loop-cards">{data.items.filter(l=>(showArchived||!l.archived)&&(projectFilter==='all'||l.project_id===projectFilter)).map(loop=><article key={loop.id}>
    <h3>{loop.name}{!!loop.archived&&' · Archived'}</h3><p>{projects.items.find(p=>p.id===loop.project_id)?.name||'Project unavailable'} · {loop.target} per {loop.frequency==='daily'?'day':loop.frequency==='weekly'?'week':'month'}</p><strong>{loop.stats.progress} / {loop.target} this period</strong><progress value={Math.min(loop.stats.progress,loop.target)} max={loop.target}/><p>Current streak {loop.stats.currentStreak} · Best {loop.stats.bestStreak} · {loop.stats.total} completions</p><p className="loop-help">Period begins {loop.stats.currentPeriod} · {loop.timezone}</p>
    {!loop.archived&&<div className="loop-inline"><label>Work with<select aria-label={`Agent for ${loop.name}`} value={agentsByLoop[loop.id]||''} disabled={busy} onChange={e=>setAgentsByLoop({...agentsByLoop,[loop.id]:e.target.value})}><option value="">Human teammate</option>{loop.agents.map(id=><option key={id} value={id}>{agents.find(a=>a.id===id)?.name||id}</option>)}</select></label><button disabled={busy} onClick={()=>void start(loop)}>{agentsByLoop[loop.id]?'Prepare agent handoff':'Start occurrence'}</button></div>}
    {loop.canManage&&<div className="loop-inline"><button disabled={busy} onClick={()=>{setEditing(loop.id);setForm({name:loop.name,brief:loop.brief,projectId:loop.project_id,frequency:loop.frequency,target:loop.target,agents:loop.agents});}}>Edit</button><button disabled={busy} onClick={()=>void mutate('archive',{id:loop.id,archived:!loop.archived})}>{loop.archived?'Restore':'Archive'}</button></div>}
   </article>)}</div>
   {!data.items.length&&<p>Create a project on the Task Board, then add your first loop.</p>}
   <h3>Occurrences & completion history</h3><label>Contributor<select value={person} onChange={e=>setPerson(e.target.value)}><option value="all">All contributors</option>{[...new Set(data.history.map(o=>o.author))].map(id=><option key={id} value={id}>{name(id)}</option>)}</select></label>
   <div className="loop-history">{data.history.filter(o=>(person==='all'||o.author===person)&&(projectFilter==='all'||o.project_id===projectFilter)).map(o=><button className={selected===o.id?'is-selected':''} key={o.id} onClick={()=>setSelected(o.id)}><strong>{data.items.find(l=>l.id===o.loop_id)?.name}</strong><span>{o.project_name} · {name(o.author)} · {o.state==='completed'?'Completed':o.state==='preparing'?'Preparation needs checking':'Open'}</span><small>{new Date(o.completed_at||o.created_at).toLocaleString()} · {o.agent_id?agents.find(a=>a.id===o.agent_id)?.name||o.agent_id:'Human work'}</small></button>)}</div>
   {occurrence&&<OccurrenceDetail key={occurrence.id} occurrence={occurrence} loop={data.items.find(l=>l.id===occurrence.loop_id)!} currentUser={currentUser} teamId={teamId} busy={busy} mutate={mutate} onOpenTask={onOpenTask} onRetry={()=>void start(data.items.find(l=>l.id===occurrence.loop_id)!,occurrence.id)}/>}
  </>}
 </section>;
}
function OccurrenceDetail({occurrence:o,loop,currentUser,teamId,busy,mutate,onOpenTask,onRetry}:{occurrence:Occurrence;loop:Loop;currentUser:string;teamId:string;busy:boolean;mutate:(action:string,body:unknown)=>Promise<unknown>;onOpenTask:(id:string)=>void;onRetry:()=>void}){
 const [note,setNote]=useState(o.note),[resultUrl,setResultUrl]=useState(o.result_url),[time,setTime]=useState<{id:string;seconds:number;note:string}[]>([]),[ids,setIds]=useState<string[]>([]),[error,setError]=useState(''),[copied,setCopied]=useState(false);
 const mine=o.author===currentUser;
 async function refreshTime(){if(!o.task_id)return;try{const d=await api(`task/time/${o.task_id}/list`);setTime(d.items.filter((e:{author:string;ended:number|null})=>e.author===currentUser&&e.ended!==null));}catch(e){setError(e instanceof Error?e.message:'Unable to load time.');}}
 const brief=`Loop: ${loop.name}\nOccurrence: ${o.id}\nTeam: ${teamId}\nProject: ${o.project_name} (${o.project_id})\nTask ID: ${o.task_id}\nAgent ID: ${o.agent_id||'Human work'}\n\n${o.brief}\n\nUse the task ID above in the Tencent session context. Record findings and work links on the task. Do not mark the loop complete; a human must review and accept the result.`;
 return <section className="loop-occurrence"><h3>{loop.name} — occurrence</h3><p>{o.project_name} · {o.state}</p>{error&&<p role="alert">{error}</p>}
  {o.task_id?<><button onClick={()=>onOpenTask(o.task_id!)}>Open linked task</button><details open={!!o.agent_id}><summary>{o.agent_id?'Manual agent handoff':'Occurrence brief'}</summary><pre>{brief}</pre><button onClick={()=>{void navigator.clipboard.writeText(brief).then(()=>setCopied(true)).catch(()=>setError('Copy failed. Select the brief and copy it manually.'));}}>{copied?'Copied':'Copy brief'}</button><p className="loop-help">Paste this brief into your agent client. No agent is started automatically. Sessions recorded with this task ID appear in the task’s People & agent participation section.</p></details></>:<p>Task preparation was interrupted. {mine&&<button disabled={busy} onClick={onRetry}>Check preparation</button>}</p>}
  {o.state==='completed'?<><p>{o.note||'No completion note.'}</p>{o.result_url&&<a href={o.result_url} target="_blank" rel="noopener noreferrer">View result</a>}<p>Linked human time: {o.time.reduce((sum,t)=>sum+t.seconds,0)/60} minutes</p>{mine&&<button disabled={busy} onClick={()=>void mutate('undo',{id:o.id})}>Undo completion</button>}</>:o.task_id&&mine&&<>
   <TaskTime taskId={o.task_id} currentUser={currentUser}/>
   <form className="loop-form" onSubmit={e=>{e.preventDefault();void mutate('complete',{id:o.id,note,resultUrl,timeIds:ids});}}>
    <label>Completion notes<textarea rows={3} maxLength={10000} value={note} onChange={e=>setNote(e.target.value)}/></label><label>Result / agent work link (optional)<input type="url" maxLength={2000} value={resultUrl} onChange={e=>setResultUrl(e.target.value)}/></label>
    <fieldset><legend>Link your tracked time (optional)</legend><button type="button" onClick={()=>void refreshTime()}>Refresh stopped time entries</button>{time.map(t=><label className="loop-check" key={t.id}><input type="checkbox" checked={ids.includes(t.id)} onChange={e=>setIds(e.target.checked?[...ids,t.id]:ids.filter(id=>id!==t.id))}/>{t.seconds/60} minutes · {t.note||'Task work'}</label>)}<p className="loop-help">Only stopped entries belonging to you can be linked. Linking reuses existing timesheet entries; it does not add time again.</p></fieldset>
    <button disabled={busy}>Accept work & complete occurrence</button><p className="loop-help">Completion counts in the current {loop.frequency} period. It records your acceptance; the linked task’s workflow is managed separately.</p>
   </form>
  </>}
 </section>;
}
