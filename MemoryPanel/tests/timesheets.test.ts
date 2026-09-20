import { beforeEach, afterEach, expect, test } from 'vitest';
import { Hono } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { registerTaskTimeRoutes } from '../src/panel/http/routes/task-time.js';
import type { PanelDeps } from '../src/panel/panel-deps.js';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
let app:Hono,root:string,close:()=>void,deps:PanelDeps;let deleted=false;
const started=Date.parse('2026-09-18T23:30:00Z');
beforeEach(async()=>{
 root=await mkdtemp(path.join(tmpdir(),'timesheets-'));deleted=false;
 deps={instanceRegistry:{resolve:(id:string)=>({instance_id:id,gateway_endpoint:'',api_key:''})},metaKernel:{invoke:async(action:string,body:any)=>({code:0,data:
 action==='auth/verify'?{valid:body.user_key!=='invalid',user:{user_id:body.user_key}}:
 action==='team-member/get'?{status:body.user_id==='outsider'?'removed':'active',role:body.user_id==='admin'?'admin':body.user_id==='reviewer'?'reviewer':'member'}:
 action==='team/get'?{owner_user_id:'admin'}:
 action==='task/get'?deleted?null:{team_id:body.task_id==='foreign'?'other':'team',creator_user_id:'alice',title:'Design brief'}:null})}} as unknown as PanelDeps;
 app=new Hono();close=registerTaskTimeRoutes(app,deps,root);
});
afterEach(async()=>{close();await rm(root,{recursive:true,force:true});});
function req(route:string,body?:unknown,who='admin',instance='default'){
 return app.request(route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Tdai-Service-Id':instance,'X-Tdai-User-Key':who},body:body?JSON.stringify(body):undefined});
}
const list=(who='admin',suffix='')=>req('/timesheets/team/list?from=2026-09-18&to=2026-09-19'+suffix,undefined,who);
async function manual(who='alice',task='task'){return (await (await req(`/task/time/${task}/manual`,{started,seconds:3600,note:'=formula, "quoted"\nwork'},who)).json()).id;}
async function project(name='Launch',team='team'){return (await (await req(`/projects/${team}/create`,{name,description:'Launch work'})).json()).id;}
test('team totals include all contributors; normal members see only their own time',async()=>{
 await manual();await manual('bob');await manual('alice','foreign');
 const sheet=await (await list()).json();expect(sheet.items).toHaveLength(2);expect(sheet.totals).toMatchObject({completed:7200,pending:7200,payable:0,paid:0});expect(sheet.daily).toEqual({'2026-09-18':7200});
 expect((await (await list('alice','&author=bob')).json()).items).toHaveLength(1);
 expect((await (await list('admin','&author=bob')).json()).items[0].author).toBe('bob');
 expect((await list('outsider')).status).toBe(403);expect((await list('invalid')).status).toBe(401);
 expect((await req('/timesheets/team/list?from=2026-09-18&to=2026-09-19',undefined,'admin','other')).status).toBe(200);
 expect((await (await req('/timesheets/team/list?from=2026-09-18&to=2026-09-19',undefined,'admin','other')).json()).items).toHaveLength(0);
});
test('running timers are flagged, not payable or approvable',async()=>{
 const timer=await (await req('/task/time/task/start',{},'alice')).json();
 const now=new Date().toISOString().slice(0,10);const sheet=await (await req(`/timesheets/team/list?from=${now}&to=${now}`)).json();expect(sheet.totals.running).toBe(1);expect(sheet.totals.completed).toBe(0);expect(sheet.totals.payable).toBe(0);
 expect((await req('/timesheets/team/approve',{ids:[timer.id]})).status).toBe(409);
});
test('review roles, paid locking, atomic batches and duplicate payments',async()=>{
 const id=await manual();const foreign=await manual('alice','foreign');
 expect((await req('/timesheets/team/approve',{ids:[id]},'alice')).status).toBe(403);
 expect((await req('/timesheets/team/approve',{ids:[id,foreign]})).status).toBe(409);
 expect((await (await list()).json()).items[0].review_state).toBe('pending');
 expect((await req('/timesheets/team/approve',{ids:[id]},'reviewer')).status).toBe(200);
 expect((await req('/task/time/task/delete',{id},'alice')).status).toBe(403);
 expect((await req('/timesheets/team/pay',{ids:[id],reference:'TX-1'},'reviewer')).status).toBe(403);
 expect((await req('/timesheets/team/pay',{ids:[id],reference:''})).status).toBe(400);
 const results=await Promise.all([req('/timesheets/team/pay',{ids:[id],reference:'TX-1'}),req('/timesheets/team/pay',{ids:[id],reference:'TX-2'})]);expect(results.map(r=>r.status).sort()).toEqual([200,409]);
 expect((await req('/timesheets/team/reopen',{ids:[id]})).status).toBe(409);expect((await req('/task/time/task/delete',{id},'alice')).status).toBe(403);
 const sheet=await (await list()).json();expect(sheet.totals).toMatchObject({payable:0,paid:3600});expect(sheet.items[0]).toMatchObject({reviewed_by:'reviewer',paid_by:'admin',payment_ref:'TX-1'});
 const db=new DatabaseSync(path.join(root,'time.sqlite'));expect(db.prepare('SELECT * FROM time_audit').all()).toHaveLength(2);db.close();
});
test('approved work can reopen, but only pending work can be removed by its author',async()=>{
 const id=await manual();await req('/timesheets/team/approve',{ids:[id]});await req('/timesheets/team/reopen',{ids:[id]});
 expect((await req('/task/time/task/delete',{id},'alice')).status).toBe(200);
});
test('projects are team-scoped; archived projects reject new assignments; snapshots freeze at approval',async()=>{
 const p=await project(),other=await project('Other','other');
 expect((await req('/projects/team/assign',{task:'task',projectId:other},'alice')).status).toBe(400);
 expect((await req('/projects/team/assign',{task:'foreign',projectId:p})).status).toBe(403);
 expect((await req('/projects/team/assign',{task:'task',projectId:p},'bob')).status).toBe(403);
 await req('/projects/team/assign',{task:'task',projectId:p},'alice');
 const id=await manual();expect((await (await list()).json()).items[0].project).toBe('Launch');
 await req('/timesheets/team/approve',{ids:[id]});
 await req('/projects/team/update',{id:p,name:'Renamed',description:'New'});
 await req('/projects/team/assign',{task:'task',projectId:''},'alice');
 expect((await (await list()).json()).items[0].project).toBe('Launch');
 await req('/projects/team/archive',{id:p,archived:true});expect((await req('/projects/team/assign',{task:'task',projectId:p})).status).toBe(400);
 await req('/projects/team/archive',{id:p,archived:false});expect((await req('/projects/team/assign',{task:'task',projectId:p})).status).toBe(200);
 deleted=true;expect((await (await list()).json()).items[0].project).toBe('Launch');
});
test('CSV escapes formulas, quotes and newlines; includes payment references and excludes running durations',async()=>{
 const id=await manual();await req('/timesheets/team/approve',{ids:[id]});await req('/timesheets/team/pay',{ids:[id],reference:'TX-CSV'});
 const r=await req('/timesheets/team/csv?from=2026-09-18&to=2026-09-19');expect(r.headers.get('content-type')).toContain('text/csv');const csv=await r.text();expect(csv).toContain('"\'=formula, ""quoted""\nwork"');expect(csv).toContain('"TX-CSV"');expect(csv).toContain('"1.0000"');
 expect((await req('/timesheets/team/list?from=2026-02-30&to=2026-09-19')).status).toBe(400);
});
test('legacy schema migration is additive and backfills team without losing entries',async()=>{
 close();const file=path.join(root,'time.sqlite');await rm(file);const db=new DatabaseSync(file);db.exec("CREATE TABLE task_time(id TEXT PRIMARY KEY,instance TEXT NOT NULL,task TEXT NOT NULL,author TEXT NOT NULL,started INTEGER NOT NULL,ended INTEGER,seconds INTEGER,note TEXT NOT NULL DEFAULT '',kind TEXT NOT NULL)");db.prepare("INSERT INTO task_time VALUES('legacy','default','task','alice',?,?,3600,'legacy note','manual')").run(started,started+3600000);db.close();
 app=new Hono();close=registerTaskTimeRoutes(app,deps,root);const sheet=await (await list()).json();expect(sheet.items[0]).toMatchObject({id:'legacy',team:'team',review_state:'pending',note:'legacy note',seconds:3600});
});
