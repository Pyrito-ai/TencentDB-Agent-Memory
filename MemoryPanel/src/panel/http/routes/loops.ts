import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PanelDeps } from '../../panel-deps.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { buildCtx, resolveCallerUserId } from './knowledge/common.js';
import { loopStats, periodFor, type Frequency } from './loop-periods.js';
type Loop={id:string;instance:string;team:string;project_id:string;name:string;brief:string;frequency:Frequency;target:number;timezone:string;agents:string;created_by:string;archived:number};
type Occurrence={id:string;loop_id:string;instance:string;team:string;author:string;task_id:string|null;agent_id:string;project_id:string;project_name:string;brief:string;period:string;state:string;completed_at:number|null;note:string;result_url:string};
export function registerLoops(api:Hono,deps:PanelDeps,db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS loop_settings(instance TEXT NOT NULL,team TEXT NOT NULL,timezone TEXT NOT NULL,PRIMARY KEY(instance,team));
 CREATE TABLE IF NOT EXISTS loops(id TEXT PRIMARY KEY,instance TEXT NOT NULL,team TEXT NOT NULL,project_id TEXT NOT NULL,name TEXT NOT NULL,brief TEXT NOT NULL,frequency TEXT NOT NULL,target INTEGER NOT NULL,timezone TEXT NOT NULL,agents TEXT NOT NULL DEFAULT '[]',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,archived INTEGER NOT NULL DEFAULT 0);
 CREATE INDEX IF NOT EXISTS loops_team ON loops(instance,team);
 CREATE TABLE IF NOT EXISTS loop_occurrences(id TEXT PRIMARY KEY,loop_id TEXT NOT NULL,instance TEXT NOT NULL,team TEXT NOT NULL,author TEXT NOT NULL,task_id TEXT,agent_id TEXT NOT NULL,project_id TEXT NOT NULL,project_name TEXT NOT NULL,brief TEXT NOT NULL,period TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,completed_at INTEGER,note TEXT NOT NULL DEFAULT '',result_url TEXT NOT NULL DEFAULT '');
 CREATE INDEX IF NOT EXISTS loop_history ON loop_occurrences(instance,team,loop_id);
 CREATE TABLE IF NOT EXISTS loop_time(occurrence TEXT NOT NULL,time_id TEXT PRIMARY KEY);
 CREATE TABLE IF NOT EXISTS loop_audit(id INTEGER PRIMARY KEY,occurrence TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,at INTEGER NOT NULL);`);
 const preparing=new Set<string>();
 api.use('/loops/*',validatePanelMetaHeaders(deps));api.use('/loops/*',bodyLimit({maxSize:32768,onError:c=>c.json({error:'Request too large'},413)}));
 api.all('/loops/:teamId/:action',async c=>{
  const ctx=buildCtx(c),instance=ctx.instanceId,team=c.req.param('teamId'),action=c.req.param('action');
  const actor=await resolveCallerUserId(deps,ctx);if(!actor)return c.json({error:'Unauthorized'},401);
  const memberEnv=await deps.metaKernel.invoke('team-member/get',{team_id:team,user_id:actor},ctx);
  const member=memberEnv.code===0?memberEnv.data as {status?:string;role?:string}:null;
  if(member?.status!=='active')return c.json({error:'Forbidden'},403);
  const te=await deps.metaKernel.invoke('team/get',{team_id:team},ctx);
  const admin=member.role==='admin'||(te.code===0&&(te.data as {owner_user_id?:string})?.owner_user_id===actor);
  const timezone=String(db.prepare('SELECT timezone FROM loop_settings WHERE instance=? AND team=?').get(instance,team)?.timezone||'UTC');
  c.header('Cache-Control','private, no-store');
  const findLoop=(id:string)=>db.prepare('SELECT * FROM loops WHERE id=? AND instance=? AND team=?').get(id,instance,team) as Loop|undefined;
  const findOccurrence=(id:string)=>db.prepare('SELECT * FROM loop_occurrences WHERE id=? AND instance=? AND team=?').get(id,instance,team) as Occurrence|undefined;
  async function agentAllowed(id:string){
   const e=await deps.metaKernel.invoke('agent/get',{agent_id:id},ctx);const a=e.code===0?e.data as {team_id?:string;status?:string;visibility?:string;owner_user_id?:string}:null;
   return !!a&&a.team_id===team&&a.status==='active'&&(a.visibility==='team'||a.owner_user_id===actor);
  }
  if(action==='list'&&c.req.method==='GET'){
   const loops=db.prepare('SELECT * FROM loops WHERE instance=? AND team=? ORDER BY archived,name').all(instance,team) as Loop[];
   const history=db.prepare('SELECT * FROM loop_occurrences WHERE instance=? AND team=? ORDER BY created_at DESC').all(instance,team) as Occurrence[];
   return c.json({timezone,canManageTimezone:admin,items:loops.map(l=>({...l,agents:JSON.parse(l.agents),canManage:admin||l.created_by===actor,stats:loopStats(history.filter(o=>o.loop_id===l.id&&o.state==='completed').map(o=>o.period),periodFor(Date.now(),l.timezone,l.frequency),l.frequency,l.target)})),history:history.map(o=>({...o,time:db.prepare('SELECT t.id,t.author,t.seconds,t.review_state FROM loop_time lt JOIN task_time t ON t.id=lt.time_id WHERE lt.occurrence=?').all(o.id)}))});
  }
  if(c.req.method!=='POST')return c.json({error:'Method not allowed'},405);
  const b=await c.req.json().catch(()=>null);if(!b||typeof b!=='object')return c.json({error:'Invalid request'},400);
  if(action==='timezone'){
   if(!admin)return c.json({error:'Only team admins can change the timezone.'},403);
   if(typeof b.timezone!=='string'||b.timezone.length>100)return c.json({error:'Invalid timezone'},400);
   try{new Intl.DateTimeFormat('en',{timeZone:b.timezone}).format();}catch{return c.json({error:'Use an IANA timezone such as Europe/Madrid.'},400);}
   if(db.prepare('SELECT 1 FROM loops WHERE instance=? AND team=?').get(instance,team))return c.json({error:'Timezone is fixed once loops exist, to preserve recurrence history.'},409);
   db.prepare('INSERT INTO loop_settings VALUES(?,?,?) ON CONFLICT(instance,team) DO UPDATE SET timezone=excluded.timezone').run(instance,team,b.timezone);return c.json({ok:true});
  }
  if(action==='create'||action==='update'){
   const name=typeof b.name==='string'?b.name.trim():'',brief=typeof b.brief==='string'?b.brief.trim():'';
   if(!name||name.length>160||brief.length>10000||!['daily','weekly','monthly'].includes(b.frequency)||!Number.isInteger(b.target)||b.target<1||b.target>100||typeof b.projectId!=='string'||!Array.isArray(b.agents)||b.agents.length>10||b.agents.some((a:unknown)=>typeof a!=='string'))return c.json({error:'Enter a name, project, daily/weekly/monthly target (1–100), and up to 10 agents.'},400);
   const project=db.prepare('SELECT id FROM projects WHERE id=? AND instance=? AND team=? AND archived=0').get(b.projectId,instance,team);
   if(!project)return c.json({error:'Choose an active project in this team.'},400);
   for(const id of b.agents)if(!await agentAllowed(id))return c.json({error:'Choose an active team-visible agent, or an agent you own, in this team.'},403);
   if(action==='create'){
    const id=randomUUID();db.prepare('INSERT INTO loops(id,instance,team,project_id,name,brief,frequency,target,timezone,agents,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,instance,team,b.projectId,name,brief,b.frequency,b.target,timezone,JSON.stringify([...new Set(b.agents)]),actor,Date.now());return c.json({id},201);
   }
   const loop=typeof b.id==='string'?findLoop(b.id):null;if(!loop||(!admin&&loop.created_by!==actor))return c.json({error:'Forbidden'},403);
   if(db.prepare('SELECT 1 FROM loop_occurrences WHERE loop_id=?').get(loop.id)&&(loop.frequency!==b.frequency||loop.target!==b.target))return c.json({error:'Recurrence is fixed once work starts. Create a new loop for a different target.'},409);
   db.prepare('UPDATE loops SET project_id=?,name=?,brief=?,frequency=?,target=?,agents=? WHERE id=?').run(b.projectId,name,brief,b.frequency,b.target,JSON.stringify([...new Set(b.agents)]),loop.id);return c.json({ok:true});
  }
  if(action==='archive'){
   const loop=typeof b.id==='string'?findLoop(b.id):null;if(!loop||(!admin&&loop.created_by!==actor))return c.json({error:'Forbidden'},403);
   if(typeof b.archived!=='boolean')return c.json({error:'Invalid state'},400);
   db.prepare('UPDATE loops SET archived=? WHERE id=?').run(b.archived?1:0,loop.id);return c.json({ok:true});
  }
  if(action==='start'){
   const loop=typeof b.loopId==='string'?findLoop(b.loopId):null;
   if(!loop||loop.archived)return c.json({error:'Choose an active loop.'},404);
   if(typeof b.requestId!=='string'||!/^[-a-zA-Z0-9]{16,80}$/.test(b.requestId)||typeof b.agentId!=='string')return c.json({error:'Invalid occurrence request'},400);
   if(b.agentId&&(!JSON.parse(loop.agents).includes(b.agentId)||!await agentAllowed(b.agentId)))return c.json({error:'This agent is not available for this loop.'},403);
   const p=db.prepare('SELECT name FROM projects WHERE id=? AND instance=? AND team=? AND archived=0').get(loop.project_id,instance,team);if(!p)return c.json({error:'Restore the project before starting new work.'},409);
   let occurrence=findOccurrence(b.requestId);if(occurrence&&(occurrence.author!==actor||occurrence.loop_id!==loop.id))return c.json({error:'Request ID already used.'},409);
   if(occurrence?.task_id)return c.json({occurrence});
   if(preparing.has(b.requestId))return c.json({error:'Handoff is still being prepared. Retry shortly.'},409);
   const recovery=!!occurrence;preparing.add(b.requestId);
   try{
    if(!occurrence){
     db.prepare("INSERT INTO loop_occurrences(id,loop_id,instance,team,author,agent_id,project_id,project_name,brief,period,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,'preparing',?)").run(b.requestId,loop.id,instance,team,actor,b.agentId,loop.project_id,String(p.name),loop.brief,periodFor(Date.now(),loop.timezone,loop.frequency),Date.now());occurrence=findOccurrence(b.requestId)!;
    }
    let taskId='';
    if(recovery){
     // A prior request may have reached Core even if its response was lost. Reconcile, never blindly create again.
     for(let page=1;;page++){
      const e=await deps.metaKernel.invoke('task/list',{team_id:team,page,page_size:100},ctx);if(e.code!==0)throw Error('Cannot check the prior handoff.');
      const data=e.data as {items:Array<{task_id:string;metadata_json?:string}>;total:number};
      const match=data.items.find(t=>{try{return JSON.parse(t.metadata_json||'{}').loop_occurrence===b.requestId;}catch{return false;}});
      if(match){taskId=match.task_id;break;}if(page*100>=data.total||!data.items.length)break;
     }
     if(!taskId)return c.json({error:'The prior task creation could not be confirmed. Check the Task Board before starting another occurrence.'},409);
    }else{
     const e=await deps.metaKernel.invoke('task/create',{team_id:team,creator_user_id:actor,title:`${loop.name} · ${occurrence.period}`,description:loop.brief,source_type:'manual',metadata_json:JSON.stringify({loop_id:loop.id,loop_occurrence:occurrence.id,project_board:{status:b.agentId?'ready':'in_progress'}}),linked_agents:b.agentId?[{agent_id:b.agentId}]:[]},ctx);
     if(e.code!==0||!(e.data as {task_id?:string})?.task_id)throw Error('Task preparation failed. Retry to check whether it was created.');taskId=(e.data as {task_id:string}).task_id;
    }
    db.exec('BEGIN IMMEDIATE');try{
     db.prepare('INSERT INTO task_projects(instance,team,task,project_id) VALUES(?,?,?,?) ON CONFLICT(instance,task) DO NOTHING').run(instance,team,taskId,occurrence.project_id);
     db.prepare("UPDATE loop_occurrences SET task_id=?,state='open' WHERE id=?").run(taskId,occurrence.id);db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    return c.json({occurrence:findOccurrence(occurrence.id)},201);
   }catch{return c.json({error:'Could not confirm task preparation. Retry this occurrence to reconcile it safely.'},502);}finally{preparing.delete(b.requestId);}
  }
  const occurrence=typeof b.id==='string'?findOccurrence(b.id):null;if(!occurrence)return c.json({error:'Occurrence not found'},404);
  if(occurrence.author!==actor)return c.json({error:'Only the contributor can complete or undo their occurrence.'},403);
  if(action==='complete'){
   const note=typeof b.note==='string'?b.note.trim():'',result=typeof b.resultUrl==='string'?b.resultUrl.trim():'';
   if(note.length>10000||result.length>2000||!Array.isArray(b.timeIds)||b.timeIds.length>100||b.timeIds.some((id:unknown)=>typeof id!=='string')||new Set(b.timeIds).size!==b.timeIds.length)return c.json({error:'Invalid completion'},400);
   if(result){try{if(!['https:','http:'].includes(new URL(result).protocol))throw Error();}catch{return c.json({error:'Use an HTTP or HTTPS result link.'},400);}}
   db.exec('BEGIN IMMEDIATE');try{
    const current=findOccurrence(occurrence.id)!;if(current.state!=='open'){db.exec('ROLLBACK');return c.json({error:'This occurrence is not open.'},409);}
    for(const id of b.timeIds){const t=db.prepare('SELECT * FROM task_time WHERE id=? AND instance=? AND team=? AND task=? AND author=? AND ended IS NOT NULL').get(id,instance,team,occurrence.task_id!,actor);if(!t||db.prepare('SELECT 1 FROM loop_time WHERE time_id=?').get(id)){db.exec('ROLLBACK');return c.json({error:'Select your own stopped time entries from this occurrence task.'},409);}}
    const loop=findLoop(occurrence.loop_id)!;
    db.prepare("UPDATE loop_occurrences SET state='completed',completed_at=?,period=?,note=?,result_url=? WHERE id=?").run(Date.now(),periodFor(Date.now(),loop.timezone,loop.frequency),note,result,occurrence.id);
    for(const id of b.timeIds)db.prepare('INSERT INTO loop_time VALUES(?,?)').run(occurrence.id,id);
    db.prepare("INSERT INTO loop_audit(occurrence,actor,action,at) VALUES(?,?,'complete',?)").run(occurrence.id,actor,Date.now());db.exec('COMMIT');return c.json({ok:true});
   }catch(e){db.exec('ROLLBACK');throw e;}
  }
  if(action==='undo'){
   db.exec('BEGIN IMMEDIATE');try{
    if(findOccurrence(occurrence.id)?.state!=='completed'){db.exec('ROLLBACK');return c.json({error:'This occurrence is not completed.'},409);}
    if(db.prepare("SELECT 1 FROM loop_time l JOIN task_time t ON t.id=l.time_id WHERE l.occurrence=? AND t.review_state!='pending'").get(occurrence.id)){db.exec('ROLLBACK');return c.json({error:'Approved or paid time locks this completion.'},409);}
    db.prepare('DELETE FROM loop_time WHERE occurrence=?').run(occurrence.id);db.prepare("UPDATE loop_occurrences SET state='open',completed_at=NULL WHERE id=?").run(occurrence.id);db.prepare("INSERT INTO loop_audit(occurrence,actor,action,at) VALUES(?,?,'undo',?)").run(occurrence.id,actor,Date.now());db.exec('COMMIT');return c.json({ok:true});
   }catch(e){db.exec('ROLLBACK');throw e;}
  }
  return c.json({error:'Unknown action'},404);
 });
}
