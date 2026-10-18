import { useState } from 'react';
import type { Agent } from '../../../shared/types.ts';
import { ACTIVITY_LABEL, STATUS_COLOR, STATUS_LABEL, STATUS_RANK, ago, shortModel } from '../ui.ts';

interface Props {
  agents: Agent[];
  all: Map<string, Agent>;
  now: number;
  selectedId?: string;
  onSelect: (id: string) => void;
}

const ACTIVE = new Set<Agent['status']>(['working', 'waiting_permission', 'error', 'stale']);

interface Team {
  sessionId: string;
  main?: Agent;
  active: Agent[];
  done: Agent[];
}

// Lo que está haciendo ahora mismo cada orquestador y cada uno de sus subagentes.
export function ActiveBoard({ agents, all, now, selectedId, onSelect }: Props) {
  const teams = new Map<string, Team>();
  for (const a of agents) {
    let t = teams.get(a.sessionId);
    if (!t) teams.set(a.sessionId, (t = { sessionId: a.sessionId, main: all.get(a.sessionId), active: [], done: [] }));
    if (a.kind === 'main') continue;
    if (a.status === 'done') t.done.push(a);
    else t.active.push(a);
  }

  const shown: Team[] = [];
  const waiting: Agent[] = [];
  for (const t of teams.values()) {
    const mainActive = t.main && ACTIVE.has(t.main.status);
    const hasTeam = t.active.length > 0 || (t.done.length > 0 && t.main?.status !== 'idle');
    if (mainActive || hasTeam) shown.push(t);
    else if (t.main?.status === 'waiting_input') waiting.push(t.main);
  }
  const urgency = (t: Team) => Math.min(...[t.main, ...t.active].filter(Boolean).map((a) => STATUS_RANK[a!.status]));
  shown.sort((a, b) => urgency(a) - urgency(b) || (b.main?.lastActivityAt ?? 0) - (a.main?.lastActivityAt ?? 0));

  const activeCount = agents.filter((a) => ACTIVE.has(a.status)).length;
  const subCount = agents.filter((a) => a.kind === 'subagent' && ACTIVE.has(a.status)).length;

  return (
    <div className="board">
      <p className="board-summary">
        <b>{activeCount}</b> {activeCount === 1 ? 'agente activo' : 'agentes activos'}
        {' · '}<b>{subCount}</b> {subCount === 1 ? 'subagente trabajando' : 'subagentes trabajando'}
      </p>

      {shown.length === 0 && <p className="empty">Ningún agente está trabajando ahora mismo.</p>}

      {shown.map((t) => (
        <TeamView key={t.sessionId} team={t} all={all} now={now} selectedId={selectedId} onSelect={onSelect} />
      ))}

      {waiting.length > 0 && (
        <section className="team">
          <h3>Esperando tu mensaje</h3>
          {waiting.map((a) => (
            <button key={a.id} className="mini-row" onClick={() => onSelect(a.id)}>
              <span className="dot" style={{ background: STATUS_COLOR[a.status] }} aria-hidden />
              <span className="row-title">{a.title}</span>
              <span className="muted small">{a.project} · {ago(a.lastActivityAt, now)}</span>
            </button>
          ))}
        </section>
      )}
    </div>
  );
}

function TeamView({ team: t, all, now, selectedId, onSelect }: { team: Team; all: Map<string, Agent>; now: number; selectedId?: string; onSelect: (id: string) => void }) {
  const [showAllDone, setShowAllDone] = useState(false);
  const active = [...t.active].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.startedAt - b.startedAt);
  const done = [...t.done].sort((a, b) => (b.endedAt ?? b.lastActivityAt) - (a.endedAt ?? a.lastActivityAt));
  const visibleDone = showAllDone ? done : done.slice(0, 5);
  const subTotal = active.length + done.length;

  return (
    <section className="team">
      <h3>
        {t.main ? t.main.title : 'Sesión ' + t.sessionId.slice(0, 8)}
        <span className="muted"> · {(t.main ?? active[0] ?? done[0])?.project}</span>
      </h3>
      {subTotal > 0 && (
        <p className="team-note">
          Orquestador con {subTotal} {subTotal === 1 ? 'subagente' : 'subagentes'}: {active.length} activos · {done.length} terminados
        </p>
      )}
      {t.main && <AgentCard agent={t.main} now={now} selected={t.main.id === selectedId} onSelect={onSelect} />}
      {active.map((a) => (
        <AgentCard key={a.id} agent={a} parent={a.parentId ? all.get(a.parentId) : undefined} now={now} selected={a.id === selectedId} onSelect={onSelect} />
      ))}
      {done.length > 0 && (
        <div className="done-list">
          <span className="done-head muted small">Terminados ({done.length})</span>
          {visibleDone.map((a) => (
            <button key={a.id} className={`done-row${a.id === selectedId ? ' selected' : ''}`} onClick={() => onSelect(a.id)}>
              <span className="ok" aria-hidden>✓</span>
              <span className="tag">{a.agentType ?? 'sub'}</span>
              <span className="row-title">{a.description || a.title}</span>
              <span className="muted small nowrap">
                {a.model && `${shortModel(a.model)} · `}{a.toolsDone} acc. · hace {ago(a.endedAt ?? a.lastActivityAt, now)}
              </span>
            </button>
          ))}
          {done.length > 5 && (
            <button className="link small" onClick={() => setShowAllDone(!showAllDone)}>
              {showAllDone ? 'Ver menos' : `Ver los ${done.length} terminados`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function AgentCard({ agent: a, parent, now, selected, onSelect }: { agent: Agent; parent?: Agent; now: number; selected: boolean; onSelect: (id: string) => void }) {
  const current = a.currentTools[a.currentTools.length - 1];
  const history = a.recent.filter((r) => !(current && r.kind === 'tool_start' && r.ok === undefined && r.tool === current.name && r.text === current.summary));
  const name = a.kind === 'subagent' ? a.description || a.title : a.title;

  return (
    <button className={`card status-${a.status}${selected ? ' selected' : ''}${a.kind === 'subagent' ? ' sub' : ''}`} onClick={() => onSelect(a.id)}>
      <span className="card-head">
        <span className="dot" style={{ background: STATUS_COLOR[a.status] }} aria-hidden />
        {a.kind === 'subagent' ? <span className="tag">{a.agentType ?? 'subagente'}</span> : <span className="tag main">orquestador</span>}
        <span className="card-title">{name}</span>
        {a.model && <span className="model">{shortModel(a.model)}</span>}
        <span className="muted small nowrap">{ago(a.startedAt, now)}</span>
      </span>
      {a.kind === 'subagent' && parent && parent.kind === 'subagent' && (
        <span className="card-parent muted small">↳ lanzado por {parent.description || parent.title}</span>
      )}

      <span className="card-now" style={{ borderColor: STATUS_COLOR[a.status] }}>
        <NowLine agent={a} now={now} />
      </span>

      {history.length > 0 && (
        <span className="card-history">
          {history.slice(-4).map((r, i) => (
            <span key={i} className={`hist${r.ok === false ? ' fail' : ''}`}>
              <span className="muted nowrap">{ago(r.ts, now)}</span>
              <span className="hist-text">
                {r.kind === 'tool_start' ? (
                  <><b>{r.tool}</b> {r.text} {r.ok === undefined ? '' : r.ok ? '✓' : '✗'}</>
                ) : r.kind === 'prompt' ? (
                  <>💬 {r.text}</>
                ) : (
                  r.text
                )}
              </span>
            </span>
          ))}
        </span>
      )}
      <span className="card-foot muted small">
        {a.toolsDone} {a.toolsDone === 1 ? 'acción hecha' : 'acciones hechas'}
        {a.background && ' · segundo plano'}
        {a.costUSD !== undefined && ` · $${a.costUSD.toFixed(2)}`}
      </span>
    </button>
  );
}

function NowLine({ agent: a, now }: { agent: Agent; now: number }) {
  const current = a.currentTools[a.currentTools.length - 1];
  switch (a.status) {
    case 'waiting_permission':
      return <>✋ <b>Pide permiso</b>{current && <> para <b>{current.name}</b> {current.summary}</>}</>;
    case 'error':
      return <>⛔ <b>Error</b> {a.recent.filter((r) => r.kind === 'error').pop()?.text}</>;
    case 'stale':
      return <>❔ Sin señales desde hace {ago(a.lastActivityAt, now)}</>;
    case 'waiting_input':
      return <>💬 Espera tu mensaje</>;
    case 'idle':
      return <>💤 Inactivo desde hace {ago(a.lastActivityAt, now)}</>;
    case 'done':
      return <>✓ Terminado</>;
  }
  if (current) {
    return (
      <>
        <span className="spin" aria-hidden />
        <b>{current.name}</b> <span className="now-sum">{current.summary}</span>
        <span className="muted small nowrap right">{current.executing ? ago(current.readyAt ?? current.startedAt, now) : 'generando…'}</span>
      </>
    );
  }
  if (a.waitingOn) {
    return <><span className="spin" aria-hidden />Coordinando: espera a {a.waitingOn} {a.waitingOn === 1 ? 'subagente' : 'subagentes'}</>;
  }
  return <><span className="spin" aria-hidden />{ACTIVITY_LABEL[a.activity] || 'trabajando'}…</>;
}
