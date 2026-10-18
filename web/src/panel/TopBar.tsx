import { useState } from 'react';
import type { Agent, AgentStatus, HooksStatus } from '../../../shared/types.ts';
import { STATUS_COLOR, ago } from '../ui.ts';

interface Props {
  connected: boolean;
  agents: Agent[];
  projects: { key: string; name: string }[];
  project: string;
  onProject: (p: string) => void;
  showDone: boolean;
  onShowDone: (v: boolean) => void;
  sound: boolean;
  onSound: (v: boolean) => void;
  hooks?: HooksStatus;
  token?: string;
  now: number;
}

const COUNTERS: { status: AgentStatus; label: string }[] = [
  { status: 'waiting_permission', label: 'piden permiso' },
  { status: 'working', label: 'trabajando' },
  { status: 'waiting_input', label: 'esperan mensaje' },
  { status: 'error', label: 'con error' },
];

export function TopBar(p: Props) {
  const counts = new Map<AgentStatus, number>();
  for (const a of p.agents) counts.set(a.status, (counts.get(a.status) ?? 0) + 1);

  return (
    <header className="topbar">
      <div className="brand">
        <span className={`conn ${p.connected ? 'on' : 'off'}`} title={p.connected ? 'Conectado' : 'Reconectando…'} />
        <h1>Visualizador de agentes</h1>
      </div>
      <div className="counters">
        {COUNTERS.map(({ status, label }) => (
          <span key={status} className={`counter${counts.get(status) ? '' : ' zero'}`}>
            <span className="dot" style={{ background: STATUS_COLOR[status] }} aria-hidden />
            <b>{counts.get(status) ?? 0}</b> {label}
          </span>
        ))}
      </div>
      <div className="controls">
        <label>
          <span className="sr">Proyecto</span>
          <select value={p.project} onChange={(e) => p.onProject(e.target.value)}>
            <option value="all">Todos los proyectos</option>
            {p.projects.map((x) => (
              <option key={x.key} value={x.key}>{x.name}</option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={p.showDone} onChange={(e) => p.onShowDone(e.target.checked)} /> Terminados en la oficina
        </label>
        <label className="check" title="Avisar con sonido cuando un agente pide permiso o termina">
          <input type="checkbox" checked={p.sound} onChange={(e) => p.onSound(e.target.checked)} /> Sonido
        </label>
        <HooksControl hooks={p.hooks} token={p.token} now={p.now} />
      </div>
    </header>
  );
}

function HooksControl({ hooks, token, now }: { hooks?: HooksStatus; token?: string; now: number }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  if (!hooks) return null;

  const act = async (action: 'install' | 'uninstall') => {
    if (!token) return;
    if (action === 'install' && !confirm(`Se añadirán hooks del visualizador a:\n${hooks.settingsPath}\n\nSe hará una copia de seguridad antes. Solo afectan a sesiones nuevas de Claude Code. ¿Continuar?`)) return;
    setBusy(true);
    setMsg(undefined);
    try {
      const res = await fetch(`/api/hooks/${action}`, { method: 'POST', headers: { 'x-va-token': token } });
      const body = await res.json();
      setMsg(res.ok ? (action === 'install' ? 'Instalados. Abre una sesión nueva de Claude.' : 'Hooks eliminados.') : body.error);
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const title = hooks.installed
    ? `Hooks instalados (${hooks.events.length} eventos)${hooks.lastHookAt ? ` · último evento hace ${ago(hooks.lastHookAt, now)}` : ' · aún sin eventos'}`
    : 'Sin hooks: el estado se deduce de los transcripts (permiso = estimación)';

  return (
    <div className="hooks">
      <span className={`chip ${hooks.installed ? 'ok' : 'warn'}`} title={title}>
        Hooks {hooks.installed ? 'activos' : 'no instalados'}
      </span>
      {token ? (
        <button disabled={busy} onClick={() => act(hooks.installed ? 'uninstall' : 'install')}>
          {hooks.installed ? 'Quitar' : 'Instalar'}
        </button>
      ) : (
        <span className="muted small" title="Abre la URL con ?token=… que muestra el servidor al arrancar">(abre con ?token para gestionar)</span>
      )}
      {msg && <span className="small hooks-msg" role="status">{msg}</span>}
    </div>
  );
}
