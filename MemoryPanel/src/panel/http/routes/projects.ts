import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { PanelDeps } from '../../panel-deps.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { buildCtx, resolveCallerUserId } from './knowledge/common.js';
export function registerProjects(api:Hono,deps:PanelDeps,db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,instance TEXT NOT NULL,team TEXT NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',archived INTEGER NOT NULL DEFAULT 0,created_by TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS project_name ON projects(instance,team,name COLLATE NOCASE);
 CREATE TABLE IF NOT EXISTS task_projects(instance TEXT NOT NULL,team TEXT NOT NULL,task TEXT NOT NULL,project_id TEXT NOT NULL,PRIMARY KEY(instance,task));`);
 api.use('/projects/*',validatePanelMetaHeaders(deps));api.use('/projects/*',bodyLimit({maxSize:8192,onError:c=>c.json({error:'Request too large'},413)}));
 api.all('/projects/:teamId/:action',async c=>{
  const ctx=buildCtx(c),instance=ctx.instanceId,team=c.req.param('teamId'),action=c.req.param('action');
  const actor=await resolveCallerUserId(deps,ctx);if(!actor)return c.json({error:'Unauthorized'},401);
  const env=await deps.metaKernel.invoke('team-member/get',{team_id:team,user_id:actor},ctx);
  const member=env.code===0?env.data as {status?:string;role?:string}:null;if(member?.status!=='active')return c.json({error:'Forbidden'},403);
  const teamEnv=await deps.metaKernel.invoke('team/get',{team_id:team},ctx);
  const admin=member.role==='admin'||(teamEnv.code===0&&(teamEnv.data as {owner_user_id?:string})?.owner_user_id===actor);
  c.header('Cache-Control','private, no-store');
  if(action==='list'&&c.req.method==='GET')return c.json({items:db.prepare('SELECT * FROM projects WHERE instance=? AND team=? ORDER BY archived,name').all(instance,team).map(p=>({...p,canManage:admin||p.created_by===actor})),assignments:db.prepare('SELECT task,project_id FROM task_projects WHERE instance=? AND team=?').all(instance,team),canAssignAny:admin});
  if(c.req.method!=='POST')return c.json({error:'Method not allowed'},405);
  const body=await c.req.json().catch(()=>null);if(!body||typeof body!=='object')return c.json({error:'Invalid request'},400);
  if(action==='create'||action==='update'){
   const name=typeof body.name==='string'?body.name.trim():'',description=typeof body.description==='string'?body.description.trim():'';
   if(!name||name.length>120||description.length>4000)return c.json({error:'Use a project name up to 120 characters and description up to 4,000.'},400);
   const id=action==='create'?randomUUID():body.id;
   if(typeof id!=='string')return c.json({error:'Invalid project'},400);
   if(action==='update'){
    const p=db.prepare('SELECT created_by FROM projects WHERE id=? AND instance=? AND team=?').get(id,instance,team);
    if(!p||(!admin&&p.created_by!==actor))return c.json({error:'Forbidden'},403);
   }
   try{
    if(action==='create')db.prepare('INSERT INTO projects(id,instance,team,name,description,created_by,created_at) VALUES(?,?,?,?,?,?,?)').run(id,instance,team,name,description,actor,Date.now());
    else {db.exec('BEGIN IMMEDIATE');try{db.prepare('UPDATE projects SET name=?,description=? WHERE id=?').run(name,description,id);db.prepare("UPDATE task_time SET project=? WHERE instance=? AND team=? AND project_id=? AND review_state='pending'").run(name,instance,team,id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}
   }catch(e){if(String(e).includes('UNIQUE constraint'))return c.json({error:'A project with that name already exists in this team.'},409);throw e;}
   return c.json({id},action==='create'?201:200);
  }
  if(action==='archive'){
   if(typeof body.id!=='string'||typeof body.archived!=='boolean')return c.json({error:'Invalid project'},400);
   const p=db.prepare('SELECT created_by FROM projects WHERE id=? AND instance=? AND team=?').get(body.id,instance,team);
   if(!p||(!admin&&p.created_by!==actor))return c.json({error:'Forbidden'},403);
   db.prepare('UPDATE projects SET archived=? WHERE id=?').run(body.archived?1:0,body.id);return c.json({ok:true});
  }
  if(action==='assign'){
   if(typeof body.task!=='string'||typeof body.projectId!=='string')return c.json({error:'Invalid assignment'},400);
   const taskEnv=await deps.metaKernel.invoke('task/get',{task_id:body.task},ctx);
   const task=taskEnv.code===0?taskEnv.data as {team_id:string;creator_user_id:string}:null;
   if(task?.team_id!==team||(!admin&&task.creator_user_id!==actor))return c.json({error:'Only the task creator or team admin can change its project.'},403);
   const project=body.projectId?db.prepare('SELECT name FROM projects WHERE id=? AND instance=? AND team=? AND archived=0').get(body.projectId,instance,team):null;
   if(body.projectId&&!project)return c.json({error:'Choose an active project in this team.'},400);
   db.exec('BEGIN IMMEDIATE');try{
    if(body.projectId)db.prepare('INSERT INTO task_projects(instance,team,task,project_id) VALUES(?,?,?,?) ON CONFLICT(instance,task) DO UPDATE SET project_id=excluded.project_id,team=excluded.team').run(instance,team,body.task,body.projectId);
    else db.prepare('DELETE FROM task_projects WHERE instance=? AND team=? AND task=?').run(instance,team,body.task);
    db.prepare("UPDATE task_time SET project_id=?,project=? WHERE instance=? AND task=? AND review_state='pending'").run(body.projectId,project?.name||'',instance,body.task);db.exec('COMMIT');
   }catch(e){db.exec('ROLLBACK');throw e;}
   return c.json({ok:true});
  }
  return c.json({error:'Unknown action'},404);
 });
}
