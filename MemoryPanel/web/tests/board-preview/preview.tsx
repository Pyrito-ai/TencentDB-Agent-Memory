import Timesheets from '../../src/pages/WorkbenchPage/components/Timesheets';
import { setPanelSession } from '../../src/lib/panelSession';
// Synthetic browser fixture. Never calls the production deployment.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/i18n';
import 'tea-component/dist/themes/default-pack.css';
import 'tea-component/dist/tea-themeable.css';
import '../../src/index.css';
import '../../src/pages/WorkbenchPage/styles/task-workbench.css';
import BoardView from '../../src/pages/WorkbenchPage/components/BoardView';
import { BOARD_STATUSES, writeTaskBoard } from '../../src/services/task-board';
import type { Task, Team } from '../../src/services';
setPanelSession({ instanceId: 'preview', userKey: 'john' });
const team: Team = { team_id: 'preview', name: 'Product team', description: '', owner_user_id: 'john', created_at_ms: Date.now(), members: [{ user_id: 'john', username: 'John', role: 'admin', joined_at_ms: Date.now() }] };
const titles = ['Map the customer journey', 'Draft the launch checklist', 'Build the project board', 'Review onboarding copy', 'Agree the first milestone'];
function Preview() {
 const [tasks, setTasks] = useState<Task[]>(BOARD_STATUSES.map((status, i) => ({ task_id: `preview-${i}`, team_id: 'preview', creator_user_id: 'john', participants: [], title: titles[i], description: 'Keep the work clear and the next step easy to find. No agent required.', source_type: 'manual', source_url: '', linked_agents: [], status: status === 'done' ? 'completed' : 'running', created_at_ms: Date.now(), updated_at_ms: Date.now(), metadata_json: writeTaskBoard('{}', { status, priority: i === 2 ? 'high' : 'medium', assignee: 'john' }) })));
 const [view,setView]=useState('board');
 const [id, setId] = useState<string | null>(null);
 return <main style={{padding:32}}><p style={{marginBottom:12,color:"#64748b"}}>Local preview · sample tasks · changes do not affect the live trial</p><div className="workbench-view-switch"><button onClick={()=>setView('board')}>Task board</button><button onClick={()=>setView('time')}>Timesheets</button></div>{view==='time'?<Timesheets teamId="preview"/>:<BoardView tasks={tasks} tasksLoading={false} selected={tasks.find(t => t.task_id === id) ?? null} onSelect={setId}
 onCreate={() => {}} onDelete={task => setTasks(tasks.filter(t => t.task_id !== task.task_id))}
 onUpdateTask={async (task, patch) => { setTasks(ts => ts.map(t => t.task_id === task.task_id ? { ...t, ...patch, status: patch.board?.status ? patch.board.status === 'done' ? 'completed' : 'running' : t.status, metadata_json: writeTaskBoard(t.metadata_json, patch.board ?? {}) } : t)); return true; }} agents={[]} teams={[team]} currentUser="john" participationByTask={new Map()} />}</main>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
