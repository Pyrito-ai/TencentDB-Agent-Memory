import type { Hono } from 'hono';
import type { DatabaseSync } from 'node:sqlite';
import type { PanelDeps } from '../../panel-deps.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { buildCtx, resolveCallerUserId } from './knowledge/common.js';
import { bodyLimit } from 'hono/body-limit';

export function migrateTimesheets(db: DatabaseSync) {
 const columns = new Set(db.prepare('PRAGMA table_info(task_time)').all().map(x=>x.name));
 for (const [name, definition] of Object.entries({team:"TEXT",title:"TEXT NOT NULL DEFAULT ''",project_id:"TEXT NOT NULL DEFAULT ''",project:"TEXT NOT NULL DEFAULT ''",review_state:"TEXT NOT NULL DEFAULT 'pending'",reviewed_by:'TEXT',reviewed_at:'INTEGER',paid_by:'TEXT',paid_at:'INTEGER',payment_ref:'TEXT'})) {
  if (!columns.has(name)) db.exec(`ALTER TABLE task_time ADD COLUMN ${name} ${definition}`);
 }
 db.exec(`CREATE INDEX IF NOT EXISTS task_time_team ON task_time(instance,team,started);
 CREATE TABLE IF NOT EXISTS time_audit(id INTEGER PRIMARY KEY,entry TEXT NOT NULL,instance TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,at INTEGER NOT NULL,reference TEXT);`);
}
export function csvCell(value: unknown): string {
 let text=String(value ?? ''); if (/^[\s]*[=+@-]/.test(text)) text="'"+text;
 return '"'+text.replaceAll('"','""')+'"';
}
export function registerTimesheets(api:Hono,deps:PanelDeps,db:DatabaseSync) {
 api.use('/timesheets/*',validatePanelMetaHeaders(deps));
 api.use('/timesheets/*',bodyLimit({maxSize:32768,onError:c=>c.json({error:'Request too large'},413)}));
 api.all('/timesheets/:teamId/:action',async c=>{
  const ctx=buildCtx(c),instance=ctx.instanceId,team=c.req.param('teamId'),action=c.req.param('action');
  const actor=await resolveCallerUserId(deps,ctx);if(!actor)return c.json({error:'Unauthorized'},401);
  const member=await deps.metaKernel.invoke('team-member/get',{team_id:team,user_id:actor},ctx);
  const m=member.code===0?member.data as {status?:string;role?:string}:null;
  if(m?.status!=='active')return c.json({error:'Forbidden'},403);
  const teamEnv=await deps.metaKernel.invoke('team/get',{team_id:team},ctx);
  const owner=teamEnv.code===0&&(teamEnv.data as {owner_user_id?:string})?.owner_user_id===actor;
  const canPay=owner||m.role==='admin',canReview=canPay||m.role==='reviewer';
  c.header('Cache-Control','private, no-store');
  // Upgrade legacy entries with authoritative task ownership, never client-supplied team IDs.
  const legacy=db.prepare('SELECT DISTINCT task FROM task_time WHERE instance=? AND team IS NULL').all(instance);
  let unresolved=0;
  for(const row of legacy){
   const env=await deps.metaKernel.invoke('task/get',{task_id:row.task},ctx);
   const task=env.code===0?env.data as {team_id:string;title?:string}:null;
   if(task?.team_id)db.prepare('UPDATE task_time SET team=?,title=? WHERE instance=? AND task=? AND team IS NULL').run(task.team_id,task.title||String(row.task),instance,String(row.task));
   else unresolved++;
  }
  if(c.req.method==='GET'&&(action==='list'||action==='csv')){
   const from=c.req.query('from')||'',to=c.req.query('to')||'';
   const date=(s:string)=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
   if(!date(from)||!date(to)||from>to)return c.json({error:'Choose a valid date range.'},400);
   const start=Date.parse(from),end=Date.parse(to)+86400000;
   const author=canReview?(c.req.query('author')||''):actor;
   const items=db.prepare(`SELECT * FROM task_time WHERE instance=? AND team=? AND started>=? AND started<? ${author?'AND author=?':''} ORDER BY started DESC,id`).all(...[instance,team,start,end,...(author?[author]:[])]);
   const contributors=db.prepare(`SELECT DISTINCT author FROM task_time WHERE instance=? AND team=? ${canReview?'':'AND author=?'}`).all(...[instance,team,...(canReview?[]:[actor])]).map(x=>x.author);
   const totals={completed:0,pending:0,payable:0,paid:0,running:0};const daily:Record<string,number>={};
   for(const e of items){if(e.ended===null){totals.running++;continue;}const seconds=Number(e.seconds);totals.completed+=seconds;
    if(e.review_state==='approved')totals.payable+=seconds;else if(e.review_state==='paid')totals.paid+=seconds;else totals.pending+=seconds;
    const day=new Date(Number(e.started)).toISOString().slice(0,10);daily[day]=(daily[day]||0)+seconds;
   }
   if(action==='csv'){
    const rows=[['Entry ID','Teammate ID','Task ID','Task','Project','Started UTC','Duration seconds','Hours','State','Work note','Reviewed by','Reviewed UTC','Paid by','Paid UTC','Payment reference'],...items.map(e=>[e.id,e.author,e.task,e.title,e.project||'Unassigned',new Date(Number(e.started)).toISOString(),e.ended===null?'':e.seconds,e.ended===null?'':(Number(e.seconds)/3600).toFixed(4),e.ended===null?'running':e.review_state,e.note,e.reviewed_by,e.reviewed_at?new Date(Number(e.reviewed_at)).toISOString():'',e.paid_by,e.paid_at?new Date(Number(e.paid_at)).toISOString():'',e.payment_ref])];
    c.header('Content-Type','text/csv; charset=utf-8');c.header('Content-Disposition',`attachment; filename="timesheet-${from}-${to}.csv"`);c.header('X-Content-Type-Options','nosniff');return c.body('\uFEFF'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n'));
   }
   return c.json({items,contributors,totals,daily,canReview,canPay,unresolvedLegacy:canPay?unresolved:0});
  }
  if(c.req.method!=='POST'||!['approve','reopen','pay'].includes(action))return c.json({error:'Method not allowed'},405);
  if(!canReview||(action==='pay'&&!canPay))return c.json({error:'Forbidden'},403);
  const body=await c.req.json().catch(()=>null);
  const ids=body?.ids;
  if(!Array.isArray(ids)||!ids.length||ids.length>200||ids.some(id=>typeof id!=='string')||new Set(ids).size!==ids.length)return c.json({error:'Select 1 to 200 distinct entries.'},400);
  const reference=typeof body.reference==='string'?body.reference.trim():'';
  if(action==='pay'&&(!reference||reference.length>200))return c.json({error:'A payment reference of 1 to 200 characters is required.'},400);
  const expected=action==='approve'?'pending':'approved',next=action==='approve'?'approved':action==='pay'?'paid':'pending',now=Date.now();
  db.exec('BEGIN IMMEDIATE');
  try{
   for(const id of ids){
    const entry=db.prepare('SELECT review_state,ended FROM task_time WHERE id=? AND instance=? AND team=?').get(id,instance,team);
    if(!entry||entry.ended===null||entry.review_state!==expected){db.exec('ROLLBACK');return c.json({error:'An entry changed or is ineligible. Refresh and review your selection; nothing was changed.'},409);}
   }
   for(const id of ids){
    if(action==='pay')db.prepare('UPDATE task_time SET review_state=?,paid_by=?,paid_at=?,payment_ref=? WHERE id=?').run(next,actor,now,reference,id);
    else {
     db.prepare('UPDATE task_time SET review_state=?,reviewed_by=?,reviewed_at=? WHERE id=?').run(next,action==='approve'?actor:null,action==='approve'?now:null,id);
     const entry=db.prepare('SELECT task FROM task_time WHERE id=?').get(id)!;
     const project=db.prepare('SELECT p.id,p.name FROM task_projects t JOIN projects p ON p.id=t.project_id AND p.instance=t.instance AND p.team=t.team WHERE t.instance=? AND t.team=? AND t.task=?').get(instance,team,String(entry.task));
     db.prepare('UPDATE task_time SET project_id=?,project=? WHERE id=?').run(project?.id||'',project?.name||'',id);
    }
    db.prepare('INSERT INTO time_audit(entry,instance,actor,action,at,reference) VALUES(?,?,?,?,?,?)').run(id,instance,actor,action,now,reference||null);
   }
   db.exec('COMMIT');return c.json({ok:true,count:ids.length});
  }catch(error){db.exec('ROLLBACK');throw error;}
 });
}
