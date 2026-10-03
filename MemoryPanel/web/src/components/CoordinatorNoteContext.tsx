import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type CoordinatorNote = { id: string; revision: number; title: string };
type Selection = { note: CoordinatorNote; requestId: number };
type NoteContext = {
  selection?: Selection;
  discuss: (note: CoordinatorNote) => void;
  clear: (requestId: number) => void;
};
const Context = createContext<NoteContext | null>(null);

export function CoordinatorNoteProvider({
  scope,
  onOpen,
  children,
}: {
  scope: string;
  onOpen: () => void;
  children: ReactNode;
}) {
  const sequence = useRef(0);
  const [selected, setSelected] = useState<Selection & { scope: string }>();
  // Hide a previous identity's note immediately, before effects run. The shell
  // and runtime panes can stay mounted while the signed-in workspace changes.
  const selection = selected?.scope === scope ? selected : undefined;
  useEffect(() => {
    setSelected((current) => (current?.scope === scope ? current : undefined));
  }, [scope]);
  const discuss = useCallback(
    (note: CoordinatorNote) => {
      setSelected({ note, scope, requestId: ++sequence.current });
      onOpen();
    },
    [scope, onOpen],
  );
  const clear = useCallback(
    (requestId: number) => {
      setSelected((current) =>
        current?.scope === scope && current.requestId === requestId ? undefined : current,
      );
    },
    [scope],
  );
  const value = useMemo(() => ({ selection, discuss, clear }), [selection, discuss, clear]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useCoordinatorNote() {
  const context = useContext(Context);
  if (!context) throw new Error('Coordinator notes require the workspace shell.');
  return context;
}
