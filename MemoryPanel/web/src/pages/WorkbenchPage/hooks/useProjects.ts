import { useEffect, useState } from 'react';
import { getPanelSession } from '@/lib/panelSession';
export interface Project {id:string;name:string;description:string;archived:number;canManage:boolean}
interface ProjectData {items:Project[];assignments:{task:string;project_id:string}[];canAssignAny:boolean}
export async function projectRequest(team:string,action:string,body?:unknown){
 const s=getPanelSession();if(!s)throw Error('Please sign in.');
 const r=await fetch(`/api/v1/projects/${encodeURIComponent(team)}/${action}`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Tdai-Service-Id':s.instanceId,'X-Tdai-User-Key':s.userKey},body:body?JSON.stringify(body):undefined});
 const data=await r.json();if(!r.ok)throw Error(data.error||'Project request failed.');return data;
}
export function projectsChanged(){window.dispatchEvent(new Event('projects-changed'));}
export function useProjects(team:string){
 const [data,setData]=useState<ProjectData>({items:[],assignments:[],canAssignAny:false});const [error,setError]=useState('');const [loaded,setLoaded]=useState(false);
 useEffect(()=>{let active=true;let sequence=0;setLoaded(false);setData({items:[],assignments:[],canAssignAny:false});
 const load=()=>{const n=++sequence;if(team)void projectRequest(team,'list').then(d=>{if(active&&n===sequence){setData(d);setError('');setLoaded(true);}}).catch(e=>{if(active&&n===sequence)setError(e.message);});};
 load();window.addEventListener('projects-changed',load);return()=>{active=false;window.removeEventListener('projects-changed',load);};},[team]);
 return {...data,error,loaded};
}
