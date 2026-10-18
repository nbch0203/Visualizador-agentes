import type { Agent, AgentStatus } from '../../shared/types.ts';

export const STATUS_LABEL: Record<AgentStatus, string> = {
  working: 'Trabajando',
  waiting_permission: 'Pide permiso',
  waiting_input: 'Espera tu mensaje',
  idle: 'Inactivo',
  done: 'Terminado',
  error: 'Error',
  stale: 'Sin señales',
};

// Colores de estado (mismos en tema claro/oscuro; la UI es oscura).
export const STATUS_COLOR: Record<AgentStatus, string> = {
  working: '#4ade80',
  waiting_permission: '#fbbf24',
  waiting_input: '#60a5fa',
  idle: '#94a3b8',
  done: '#a78bfa',
  error: '#f87171',
  stale: '#a8a29e',
};

export const ACTIVITY_LABEL: Record<Agent['activity'], string> = {
  typing: 'escribiendo',
  reading: 'leyendo',
  running: 'ejecutando',
  delegating: 'delegando',
  thinking: 'pensando',
  none: '',
};

// Orden de urgencia: lo que necesita atención primero.
export const STATUS_RANK: Record<AgentStatus, number> = {
  waiting_permission: 0,
  error: 1,
  waiting_input: 2,
  working: 3,
  stale: 4,
  idle: 5,
  done: 6,
};

export function ago(ts: number, now: number): string {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60 ? `${s % 60}s` : ''}`.trim();
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function shortModel(m?: string): string {
  if (!m) return '';
  return m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}
