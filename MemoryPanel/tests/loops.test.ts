import {beforeEach,afterEach,test,expect} from 'vitest';
import {Hono} from 'hono';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {registerTaskTimeRoutes} from '../src/panel/http/routes/task-time.js';
import {periodFor,loopStats,nextPeriod} from '../src/panel/http/routes/loop-periods.js';
import type {PanelDeps} from '../src/panel/panel-deps.js';
let app:Hono,root:string,close:()=>void,project:string,loop:string,area:string;let tasks:any[],failAfterCreate:boolean;
beforeEach(async()=>{
 root=await mkdtemp(path.join(tmpdir(),'loops-test-'));tasks=[];failAfterCreate=false;
 const deps={instanceRegistry:{resolve:(id:string)=>({instance_id:id,gateway_endpoint:'',api_key:''})},metaKernel:{invoke:async(action:string,b:any)=>{
  if(action==='task/create'){const task={...b,task_id:'task-'+tasks.length};tasks.push(task);if(failAfterCreate)throw Error('Lost response');return {code:0,data:task};}
  return {code:0,data:action==='auth/verify'?{valid:b.user_key!=='invalid',user:{user_id:b.user_key}}:action==='team-member/get'?{status:b.user_id==='outsider'?'removed':'active',role:b.user_id==='admin'?'admin':'member'}:action==='team/get'?{owner_user_id:'admin'}:action==='agent/get'?{team_id:b.agent_id==='foreign'?'other':'team',status:'active',visibility:b.agent_id==='private'?'private':'team',owner_user_id:'admin'}:action==='task/get'?tasks.find(t=>t.task_id===b.task_id):action==='task/list'?{items:tasks,total:tasks.length}:null};
 }}} as unknown as PanelDeps;
 app=new Hono();close=registerTaskTimeRoutes(app,deps,root);
 area=(await (await req('areas/team/create',{name:'Marketing'})).json()).id;
 project=(await (await req('projects/team/create',{name:'Project'})).json()).id;
 loop=(await (await req('loops/team/create',{name:'Review',brief:'Review the findings',projectId:project,frequency:'weekly',target:2,agents:['agent']})).json()).id;
});
afterEach(async()=>{close();await rm(root,{recursive:true,force:true});});
function req(route:string,body?:unknown,who='alice',instance='default') {if(body&&/loops\/.*\/(create|update)$/.test(route))body={areaId:area,ownerId:'alice',mode:'flexible',startDate:'',...body as object};return app.request('/'+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Tdai-Service-Id':instance,'X-Tdai-User-Key':who},body:body?JSON.stringify(body):undefined});}
async function start(requestId='request-1234567890',who='alice',agentId=''){const r=await req('loops/team/start',{loopId:loop,requestId,agentId},who);expect(r.status).toBeLessThan(300);return (await r.json()).occurrence;}
test('timezone buckets respect DST, month/year transitions and Monday weeks; streaks require targets',()=>{
 expect(periodFor(Date.parse('2026-09-20T23:30:00Z'),'Europe/Madrid','daily')).toBe('2026-09-21');
 expect(periodFor(Date.parse('2026-09-20T23:30:00Z'),'America/New_York','weekly')).toBe('2026-09-14');
 expect(periodFor(Date.parse('2026-03-29T01:30:00Z'),'Europe/Madrid','daily')).toBe('2026-03-29');
 expect(nextPeriod('2026-12','monthly')).toBe('2027-01');
 expect(loopStats(['2026-09-14','2026-09-14','2026-09-15','2026-09-15','2026-09-16'],'2026-09-16','daily',2)).toMatchObject({currentStreak:2,bestStreak:2,progress:1,total:5});
});
test('manual handoff creates exactly one project-linked task and never auto-completes',async()=>{
 const o=await start(undefined,'alice','agent');await start(undefined,'alice','agent');expect(tasks).toHaveLength(1);expect(tasks[0].linked_agents).toEqual([{agent_id:'agent'}]);expect(tasks[0].description).toBe('Review the findings');
 const list=await (await req('loops/team/list')).json();expect(list.history[0].state).toBe('open');expect(list.items[0].stats.total).toBe(0);
 const assignments=await (await req('projects/team/list')).json();expect(assignments.assignments[0]).toMatchObject({task:o.task_id,project_id:project});
});
test('lost Core response is reconciled by request ID instead of creating a second task',async()=>{
 failAfterCreate=true;expect((await req('loops/team/start',{loopId:loop,requestId:'lost-response-123456',agentId:''})).status).toBe(502);
 failAfterCreate=false;const o=await start('lost-response-123456');expect(o.task_id).toBe(tasks[0].task_id);expect(tasks).toHaveLength(1);
});
test('completion is contributor-attributed, idempotent and counts toward the shared target',async()=>{
 const a=await start();const b=await start('request-bob-123456','bob');
 expect((await req('loops/team/complete',{id:a.id,note:'Claim',resultUrl:'',timeIds:[]},'bob')).status).toBe(403);
 for(const [o,who] of [[a,'alice'],[b,'bob']] as const)expect((await req('loops/team/complete',{id:o.id,note:'Accepted',resultUrl:'https://example.com/work',timeIds:[]},who)).status).toBe(200);
 expect((await req('loops/team/complete',{id:a.id,note:'Again',resultUrl:'',timeIds:[]})).status).toBe(409);
 const data=await (await req('loops/team/list')).json();expect(data.items[0].stats).toMatchObject({progress:2,target:2,currentStreak:1,total:2});
 await req('loops/team/undo',{id:a.id});expect((await (await req('loops/team/list')).json()).items[0].stats.total).toBe(1);
});
test('linked time is reused, stopped, owned by contributor, and protected by approval',async()=>{
 const o=await start();const time=(await (await req(`task/time/${o.task_id}/manual`,{started:Date.now()-7200000,seconds:3600,note:'Human work'})).json()).id;
 const running=(await (await req(`task/time/${o.task_id}/start`,{})).json()).id;
 expect((await req('loops/team/complete',{id:o.id,note:'',resultUrl:'',timeIds:[running]})).status).toBe(409);
 await req(`task/time/${o.task_id}/stop`,{id:running});
 expect((await req('loops/team/complete',{id:o.id,note:'',resultUrl:'',timeIds:[time]})).status).toBe(200);
 expect((await req(`task/time/${o.task_id}/delete`,{id:time})).status).toBe(403);
 const history=(await (await req('loops/team/list')).json()).history;expect(history[0].time[0].seconds).toBe(3600);
 await req('timesheets/team/approve',{ids:[time]},'admin');expect((await req('loops/team/undo',{id:o.id})).status).toBe(409);
 expect((await (await req(`task/time/${o.task_id}/list`)).json()).items).toHaveLength(2);
});
test('team, instance, agent, project, membership and management restrictions are enforced',async()=>{
 expect((await req('loops/team/list',undefined,'outsider')).status).toBe(403);
 expect((await req('loops/team/list',undefined,'invalid')).status).toBe(401);
 expect((await (await req('loops/team/list',undefined,'alice','other')).json()).items).toHaveLength(0);
 expect((await req('loops/team/archive',{id:loop,archived:true},'bob')).status).toBe(403);
 for(const agents of [['foreign'],['private']])expect((await req('loops/team/update',{id:loop,name:'Review',brief:'',projectId:project,frequency:'weekly',target:2,agents})).status).toBe(403);
 expect((await req('loops/other/start',{loopId:loop,requestId:'request-foreign-12345',agentId:''})).status).toBe(404);
 await req('loops/team/archive',{id:loop,archived:true});expect((await req('loops/team/start',{loopId:loop,requestId:'request-archive-12345',agentId:''})).status).toBe(404);
});
test('schedule changes cannot rewrite history; archive preserves completions',async()=>{
 const o=await start();expect((await req('loops/team/update',{id:loop,name:'Review',brief:'',projectId:project,frequency:'daily',target:2,agents:[]})).status).toBe(409);
 expect((await req('loops/team/timezone',{timezone:'Europe/Madrid'},'admin')).status).toBe(409);
 expect((await req('loops/team/complete',{id:o.id,note:'',resultUrl:'javascript:alert(1)',timeIds:[]})).status).toBe(400);
 await req('loops/team/complete',{id:o.id,note:'Done',resultUrl:'',timeIds:[]});await req('loops/team/archive',{id:loop,archived:true});
 expect((await (await req('loops/team/list')).json()).history).toHaveLength(1);
});

test('Areas and owners are required, scoped, and transferable without rewriting occurrence history',async()=>{
 const body={name:'Search terms',brief:'',projectId:'',areaId:area,ownerId:'bob',mode:'flexible',frequency:'weekly',target:2,agents:[]};
 expect((await req('loops/team/create',{...body,ownerId:'outsider'})).status).toBe(400);
 expect((await req('loops/team/create',{...body,areaId:'foreign-area'})).status).toBe(400);
 const created=await req('loops/team/create',body);expect(created.status).toBe(201);const id=(await created.json()).id;
 expect((await req('loops/team/archive',{id,archived:true})).status).toBe(403);
 const r=await req('loops/team/start',{loopId:id,requestId:'area-owner-request-1234',agentId:''});expect(r.status).toBe(201);const o=(await r.json()).occurrence;expect(o).toMatchObject({owner_id:'bob',author:'alice',area_id:area,project_id:''});
 expect((await req('loops/team/update',{...body,id,ownerId:'alice'},'bob')).status).toBe(200);
 const list=await (await req('loops/team/list')).json();expect(list.history.find((x:any)=>x.id===o.id).owner_id).toBe('bob');expect(list.items.find((l:any)=>l.id===id).owner_id).toBe('alice');
 expect((await req('areas/team/archive',{id:area,archived:true})).status).toBe(409);
 expect((await req('areas/other/update',{id:area,name:'Stolen',description:''},'admin')).status).toBe(403);
});
test('scheduled late completion keeps its original deadline, rejects duplicate slots, and can record skips',async()=>{
 const body={name:'Friday report',brief:'Report',projectId:'',areaId:area,ownerId:'alice',mode:'scheduled',startDate:'2026-01-02',frequency:'weekly',target:1,agents:[]};
 const made=await req('loops/team/create',body);expect(made.status).toBe(201);const id=(await made.json()).id;
 expect((await req('loops/team/start',{loopId:id,requestId:'bad-scheduled-day-1234',agentId:'',dueDay:'2026-01-03'})).status).toBe(400);
 const r=await req('loops/team/start',{loopId:id,requestId:'friday-report-day-1234',agentId:'',dueDay:'2026-01-02'});expect(r.status).toBe(201);const o=(await r.json()).occurrence;
 expect(tasks.at(-1).metadata_json).toContain('2026-01-02');
 expect((await req('loops/team/start',{loopId:id,requestId:'friday-duplicate-1234',agentId:'',dueDay:'2026-01-02'},'bob')).status).toBe(409);
 expect((await req('loops/team/complete',{id:o.id,note:'Late delivery',resultUrl:'',timeIds:[]})).status).toBe(200);
 const data=await (await req('loops/team/list')).json();expect(data.history.find((x:any)=>x.id===o.id)).toMatchObject({due_day:'2026-01-02',period:'2025-12-29'});expect(data.items.find((l:any)=>l.id===id).slots.find((s:any)=>s.day==='2026-01-02').late).toBe(true);
 const skip={loopId:id,requestId:'skip-next-report-1234',agentId:'',dueDay:'2026-01-09',note:'Client paused reports'};
 expect((await req('loops/team/skip',skip,'bob')).status).toBe(403);expect((await req('loops/team/skip',skip)).status).toBe(201);
 expect((await req('loops/team/start',{loopId:id,requestId:'skip-replay-slot-1234',agentId:'',dueDay:'2026-01-09'})).status).toBe(409);
 expect((await req('loops/team/update',{...body,id,startDate:'2026-01-03'})).status).toBe(409);
});
