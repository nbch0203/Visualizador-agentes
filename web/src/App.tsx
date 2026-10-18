import { useEffect, useMemo, useState } from 'react';
import { client, readToken, useClient } from './net/socket.ts';
import { OfficeCanvas } from './office/OfficeCanvas.tsx';
import { ActiveBoard } from './panel/ActiveBoard.tsx';
import { AgentDetail } from './panel/AgentDetail.tsx';
import { AgentTree } from './panel/AgentTree.tsx';
import { TopBar } from './panel/TopBar.tsx';
import { chime } from './sound.ts';

function usePref(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => {
    try {
      const s = localStorage.getItem(key);
      return s === null ? initial : s === '1';
    } catch {
      return initial;
    }
  });
  const set = (nv: boolean) => {
    setV(nv);
    try {
      localStorage.setItem(key, nv ? '1' : '0');
    } catch {}
  };
  return [v, set];
}

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

const token = readToken();

export function App() {
  const state = useClient();
  const now = useNow() + state.clockSkew;
  const [selectedId, setSelectedId] = useState<string>();
  const [project, setProject] = useState('all');
  const [showDone, setShowDone] = usePref('va-show-done', false);
  const [sound, setSound] = usePref('va-sound', true);
  const [treeView, setTreeView] = usePref('va-tree-view', false);

  const all = useMemo(() => [...state.agents.values()], [state.agents]);
  const projects = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of all) if (!m.has(a.projectKey) || a.kind === 'main') m.set(a.projectKey, a.project);
    return [...m.entries()].map(([key, name]) => ({ key, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [all]);

  const inProject = useMemo(() => (project === 'all' ? all : all.filter((a) => a.projectKey === project)), [all, project]);
  const selected = selectedId ? state.agents.get(selectedId) : undefined;

  // Avisos sonoros
  useEffect(() => {
    return client.onTransition((prev, next) => {
      if (!sound || !prev) return;
      if (next.status === 'waiting_permission' && prev.status !== 'waiting_permission') chime('alert');
      else if (next.kind === 'main' && prev.status === 'working' && next.status === 'waiting_input') chime('done');
    });
  }, [sound]);

  // Escape: primero deselecciona, después vuelve al edificio.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
      if (selectedId) setSelectedId(undefined);
      else if (project !== 'all') setProject('all');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, project]);

  // Contador en el título de la pestaña
  const waiting = all.filter((a) => a.status === 'waiting_permission').length;
  useEffect(() => {
    document.title = waiting ? `(${waiting}) ✋ Visualizador de agentes` : 'Visualizador de agentes';
  }, [waiting]);

  return (
    <div className="app">
      <TopBar
        connected={state.connected}
        agents={inProject}
        projects={projects}
        project={project}
        onProject={setProject}
        showDone={showDone}
        onShowDone={setShowDone}
        sound={sound}
        onSound={setSound}
        hooks={state.hooks}
        token={token}
        now={now}
      />
      <main className="body">
        <OfficeCanvas
          agents={inProject}
          ready={state.ready}
          showDone={showDone}
          selectedId={selectedId}
          onSelect={setSelectedId}
          projectKey={project === 'all' ? undefined : project}
          projectName={projects.find((p) => p.key === project)?.name}
          onOpenProject={setProject}
          onBack={() => setProject('all')}
        />
        <aside className="panel" aria-label="Agentes">
          {selected ? (
            <AgentDetail
              agent={selected}
              events={state.events.get(selected.id) ?? []}
              children={all.filter((a) => a.parentId === selected.id)}
              parent={selected.parentId ? state.agents.get(selected.parentId) : undefined}
              now={now}
              onSelect={setSelectedId}
            />
          ) : (
            <>
              <div className="tabs" role="tablist">
                <button role="tab" aria-selected={!treeView} onClick={() => setTreeView(false)}>En curso</button>
                <button role="tab" aria-selected={treeView} onClick={() => setTreeView(true)}>Todos ({inProject.length})</button>
              </div>
              {treeView ? (
                <AgentTree agents={inProject} now={now} selectedId={selectedId} onSelect={setSelectedId} />
              ) : (
                <ActiveBoard agents={inProject} all={state.agents} now={now} selectedId={selectedId} onSelect={setSelectedId} />
              )}
            </>
          )}
          {!state.connected && <p className="banner">Sin conexión con el servidor. Reintentando…</p>}
        </aside>
      </main>
    </div>
  );
}
