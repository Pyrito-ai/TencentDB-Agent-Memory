import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerTaskTimeRoutes } from '../src/panel/http/routes/task-time.js';
import type { PanelDeps } from '../src/panel/panel-deps.js';
let root: string; let app: Hono; let close: () => void; let active = true; let deps: PanelDeps;
beforeEach(async () => {
 root=await mkdtemp(path.join(tmpdir(),'task-time-test-'));active=true;
 deps={instanceRegistry:{resolve:(id:string)=>({instance_id:id,gateway_endpoint:'',api_key:''})},metaKernel:{invoke:async(action:string,body:any)=>({code:0,data:
  action==='auth/verify'?{valid:body.user_key!=='invalid',user:{user_id:body.user_key}}:
  action==='task/get'?{team_id:'team'}:action==='team-member/get'?{status:active&&body.user_id!=='outsider'?'active':'removed'}:null})}} as unknown as PanelDeps;
 app=new Hono();close=registerTaskTimeRoutes(app,deps,root);
 vi.spyOn(Date,'now').mockReturnValue(2000000000000);
});
afterEach(async()=>{close();vi.restoreAllMocks();await rm(root,{recursive:true,force:true});});
function request(action:string,body?:unknown,who='alice',task='task-a',instance='default'){
 return app.request(`/task/time/${task}/${action}`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Tdai-Service-Id':instance,'X-Tdai-User-Key':who},body:body?JSON.stringify(body):undefined});
}
test('one running timer per user across tasks; different users can work simultaneously',async()=>{
 const responses=await Promise.all([request('start',{}),request('start',{},'alice','task-b')]);
 expect(responses.map(r=>r.status).sort()).toEqual([201,409]);
 expect((await request('start',{},'bob')).status).toBe(201);
 expect((await request('start',{},'alice','task-a','other-instance')).status).toBe(201);
});
test('timer survives reopening the database and uses server elapsed time',async()=>{
 const entry=await (await request('start',{})).json();close();app=new Hono();close=registerTaskTimeRoutes(app,deps,root);
 vi.mocked(Date.now).mockReturnValue(2000000090000);
 expect((await request('stop',{id:entry.id})).status).toBe(200);
 const list=await (await request('list')).json();expect(list.items[0].seconds).toBe(90);
 expect((await request('stop',{id:entry.id})).status).toBe(409);
});
test('only the author can stop or remove time; current membership always required',async()=>{
 const entry=await (await request('start',{})).json();
 expect((await request('stop',{id:entry.id},'bob')).status).toBe(409);
 expect((await request('stop',{id:entry.id},'alice','different-task')).status).toBe(409);
 expect((await request('delete',{id:entry.id})).status).toBe(403);
 active=false;expect((await request('stop',{id:entry.id})).status).toBe(403);active=true;
 await request('stop',{id:entry.id});
 expect((await request('delete',{id:entry.id},'bob')).status).toBe(403);
 expect((await request('delete',{id:entry.id})).status).toBe(200);
 expect((await request('list',undefined,'invalid')).status).toBe(401);
 expect((await request('list',undefined,'outsider')).status).toBe(403);
});
test('manual entries validate duration and dates, ignore forged authors and isolate records',async()=>{
 const body={seconds:3600,started:1999996000000,note:'Planning',author:'bob'};
 expect((await request('manual',body)).status).toBe(201);
 const list=await (await request('list')).json();expect(list.items[0]).toMatchObject({author:'alice',seconds:3600,note:'Planning'});
 expect((await (await request('list',undefined,'alice','other')).json()).items).toHaveLength(0);
 expect((await (await request('list',undefined,'alice','task-a','other')).json()).items).toHaveLength(0);
 for(const patch of [{seconds:-1},{seconds:86401},{seconds:1.5},{started:Date.now()},{started:'bad'}])expect((await request('manual',{...body,...patch})).status).toBe(400);
});
