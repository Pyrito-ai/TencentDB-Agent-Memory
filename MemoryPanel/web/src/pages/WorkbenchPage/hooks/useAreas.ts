import { useEffect, useState } from 'react';
import { getPanelSession } from '@/lib/panelSession';
export type Area = {
  id: string;
  name: string;
  description: string;
  archived: number;
  canManage: boolean;
};
export async function workApi(path: string, body?: unknown) {
  const s = getPanelSession();
  if (!s) throw Error('Please sign in.');
  const r = await fetch('/api/v1/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tdai-Service-Id': s.instanceId,
      'X-Tdai-User-Key': s.userKey,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.error || 'Request failed.');
  return d;
}
export function useAreas(team: string) {
  const [items, setItems] = useState<Area[]>([]),
    [error, setError] = useState(''),
    [loaded, setLoaded] = useState(false),
    [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    setLoaded(false);
    setItems([]);
    void workApi(`areas/${encodeURIComponent(team)}/list`)
      .then((d) => {
        if (active) {
          setItems(d.items);
          setError('');
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [team, version]);
  return { items, error, loaded, reload: () => setVersion((v) => v + 1) };
}
