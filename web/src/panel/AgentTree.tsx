import type { Agent } from '../../../shared/types.ts';
import { ACTIVITY_LABEL, STATUS_COLOR, STATUS_LABEL, STATUS_RANK, ago } from '../ui.ts';

interface Props {
  agents: Agent[];
  now: number;
  selectedId?: string;
  onSelect: (id: string) => void;
}

export function AgentTree({ agents, now, selectedId, onSelect }: Props) {
  if (!agents.length) {
    return <p className="empty">No hay agentes activos en los últimos 30 minutos.</p>;
  }
  const children = new Map<string, Agent[]>();
  const ids = new Set(agents.map((a) => a.id));
  const roots: Agent[] = [];
  for (const a of agents) {
    const parent = a.parentId && ids.has(a.parentId) ? a.parentId : a.kind === 'subagent' && ids.has(a.sessionId) ? a.sessionId : undefined;
    if (parent && parent !== a.id) {
      const list = children.get(parent) ?? [];
      list.push(a);
      children.set(parent, list);
    } else roots.push(a);
  }

  const byProject = new Map<string, Agent[]>();
  for (const r of roots) {
    const list = byProject.get(r.project) ?? [];
    list.push(r);
    byProject.set(r.project, list);
  }
  const sortAgents = (list: Agent[]) =>
    [...list].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.lastActivityAt - a.lastActivityAt);

  const renderNode = (a: Agent, depth: number): React.ReactNode => {
    const kids = sortAgents(children.get(a.id) ?? []);
    const tool = a.currentTools[a.currentTools.length - 1];
    const detail =
      a.status === 'working' && tool
        ? `${tool.name} · ${tool.summary}`
        : a.status === 'working' && a.waitingOn
          ? `coordinando ${a.waitingOn} ${a.waitingOn === 1 ? 'subagente' : 'subagentes'}`
          : a.status === 'working'
            ? ACTIVITY_LABEL[a.activity]
          : a.status === 'waiting_permission' && tool
            ? `${tool.name} · ${tool.summary}`
            : '';
    return (
      <li key={a.id}>
        <button
          className={`agent-row${a.id === selectedId ? ' selected' : ''} status-${a.status}`}
          style={{ paddingLeft: 10 + depth * 16 }}
          onClick={() => onSelect(a.id)}
          aria-pressed={a.id === selectedId}
        >
          <span className="dot" style={{ background: STATUS_COLOR[a.status] }} aria-hidden />
          <span className="row-main">
            <span className="row-title">
              {a.kind === 'subagent' && <span className="tag">{a.agentType ?? 'sub'}</span>}
              {a.title}
            </span>
            <span className="row-sub">
              <span style={{ color: STATUS_COLOR[a.status] }}>{STATUS_LABEL[a.status]}</span>
              {detail && <span className="row-tool"> · {detail}</span>}
            </span>
          </span>
          <span className="row-meta">
            <span>{ago(a.lastActivityAt, now)}</span>
            {a.costUSD !== undefined && <span className="cost">${a.costUSD.toFixed(2)}</span>}
            {a.background && <span className="bg" title="Subagente en segundo plano">bg</span>}
          </span>
        </button>
        {activeKids(kids).length > 0 && <ul>{activeKids(kids).map((k) => renderNode(k, depth + 1))}</ul>}
        {doneKids(kids).length > 0 && (
          // Los terminados van aparte y plegados, para no mezclarse con los activos.
          <details className="done-group" style={{ marginLeft: 10 + (depth + 1) * 16 }}>
            <summary>✓ {doneKids(kids).length} {doneKids(kids).length === 1 ? 'subagente terminado' : 'subagentes terminados'}</summary>
            <ul>{doneKids(kids).map((k) => renderNode(k, 0))}</ul>
          </details>
        )}
      </li>
    );
  };
  const activeKids = (list: Agent[]) => list.filter((k) => k.status !== 'done');
  const doneKids = (list: Agent[]) => list.filter((k) => k.status === 'done').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));

  return (
    <div className="tree">
      {[...byProject.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([project, list]) => (
          <section key={project}>
            <h3>{project}</h3>
            <ul>{sortAgents(list).map((a) => renderNode(a, 0))}</ul>
          </section>
        ))}
    </div>
  );
}
