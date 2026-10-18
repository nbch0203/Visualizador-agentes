import { useEffect } from 'react';
import type { Agent, FeedEvent } from '../../../shared/types.ts';
import { client } from '../net/socket.ts';
import { ACTIVITY_LABEL, STATUS_COLOR, STATUS_LABEL, ago, fmtTime, shortModel } from '../ui.ts';

interface Props {
  agent: Agent;
  events: FeedEvent[];
  children: Agent[];
  parent?: Agent;
  now: number;
  onSelect: (id: string | undefined) => void;
}

const KIND_ICON: Record<FeedEvent['kind'], string> = {
  prompt: '💬',
  text: '🗨️',
  tool_start: '🔧',
  tool_end: '🔧',
  turn_end: '⏸',
  permission: '✋',
  notification: '🔔',
  error: '⛔',
  compact: '🗜',
  subagent_start: '🧑‍💻',
  subagent_end: '✅',
  session_start: '▶',
  session_end: '⏹',
};

export function AgentDetail({ agent: a, events, children, parent, now, onSelect }: Props) {
  useEffect(() => {
    void client.loadEvents(a.id);
  }, [a.id]);

  const feed = [...events].reverse();

  return (
    <div className="detail">
      <div className="detail-head">
        <button className="link" onClick={() => onSelect(undefined)}>← Todos los agentes</button>
        <h2>{a.title}</h2>
        <div className="status-line">
          <span className="pill" style={{ background: STATUS_COLOR[a.status] }}>{STATUS_LABEL[a.status]}</span>
          {a.status === 'working' && a.activity !== 'none' && <span className="muted">{ACTIVITY_LABEL[a.activity]}</span>}
          <span className="muted">· última señal hace {ago(a.lastActivityAt, now)}</span>
        </div>
      </div>

      <dl className="facts">
        <dt>Tipo</dt>
        <dd>{a.kind === 'main' ? 'Sesión principal' : `Subagente${a.agentType ? ` (${a.agentType})` : ''}${a.background ? ' · en segundo plano' : ''}`}</dd>
        {parent && (
          <>
            <dt>Lanzado por</dt>
            <dd><button className="link" onClick={() => onSelect(parent.id)}>{parent.title}</button></dd>
          </>
        )}
        <dt>Proyecto</dt>
        <dd title={a.cwd}>{a.cwd ?? a.project}</dd>
        {a.model && (<><dt>Modelo</dt><dd>{shortModel(a.model)}</dd></>)}
        <dt>Desde</dt>
        <dd>{fmtTime(a.startedAt)} ({ago(a.startedAt, now)})</dd>
        {a.costUSD !== undefined && (<><dt>Coste</dt><dd>${a.costUSD.toFixed(2)}</dd></>)}
        <dt>Fuente</dt>
        <dd>{[a.source.transcript && 'transcript', a.source.hooks && 'hooks'].filter(Boolean).join(' + ') || '—'}</dd>
        <dt>ID</dt>
        <dd className="mono">{a.id}</dd>
      </dl>

      {(a.description || a.prompt) && (
        <section>
          <h3>{a.kind === 'subagent' ? 'Encargo' : 'Primer mensaje'}</h3>
          <p className="prompt">{a.kind === 'subagent' ? a.description : a.prompt}</p>
        </section>
      )}

      {a.currentTools.length > 0 && (
        <section>
          <h3>Herramientas en curso</h3>
          <ul className="tools">
            {a.currentTools.map((t) => (
              <li key={t.id}>
                <strong>{t.name}</strong> <span className="muted">{t.summary}</span>
                <span className="muted right">{ago(t.startedAt, now)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {children.length > 0 && (
        <section>
          <h3>Subagentes ({children.length})</h3>
          <ul className="kids">
            {children.map((k) => (
              <li key={k.id}>
                <button className="link" onClick={() => onSelect(k.id)}>
                  <span className="dot" style={{ background: STATUS_COLOR[k.status] }} aria-hidden /> {k.title}
                </button>
                <span className="muted"> {STATUS_LABEL[k.status]}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {a.lastText && (
        <section>
          <h3>Último mensaje</h3>
          <p className="prompt">{a.lastText}</p>
        </section>
      )}

      <section>
        <h3>Actividad</h3>
        {feed.length === 0 ? (
          <p className="muted">Sin eventos todavía.</p>
        ) : (
          <ol className="feed">
            {feed.map((e) => (
              <li key={e.id} className={`ev ev-${e.kind}${e.ok === false ? ' ev-fail' : ''}`}>
                <span className="ev-time">{fmtTime(e.ts)}</span>
                <span className="ev-icon" aria-hidden>{KIND_ICON[e.kind]}</span>
                <span className="ev-text">
                  {e.tool && <strong>{e.tool} </strong>}
                  {e.text}
                  {e.kind === 'tool_start' && (e.ok === undefined ? <em className="running"> en curso</em> : e.ok ? ' ✓' : ' ✗')}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
