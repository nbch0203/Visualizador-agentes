import { useSyncExternalStore } from 'react';
import type { Agent, FeedEvent, HooksStatus, ServerMessage } from '../../../shared/types.ts';

export interface ClientState {
  connected: boolean;
  ready: boolean; // ya llegó el primer snapshot
  agents: Map<string, Agent>;
  events: Map<string, FeedEvent[]>;
  hooks?: HooksStatus;
  clockSkew: number; // serverNow - clientNow
  version: number;
}

const MAX_EVENTS = 200;

type Listener = () => void;
type Transition = (prev: Agent | undefined, next: Agent) => void;

class AgentClient {
  state: ClientState = { connected: false, ready: false, agents: new Map(), events: new Map(), clockSkew: 0, version: 0 };
  private listeners = new Set<Listener>();
  private transitions = new Set<Transition>();
  private ws?: WebSocket;
  private retry = 500;
  private pending = false;

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 500;
      this.update({ connected: true });
    };
    ws.onclose = () => {
      this.update({ connected: false });
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 5000);
    };
    ws.onmessage = (e) => this.handle(JSON.parse(e.data) as ServerMessage);
  }

  private handle(msg: ServerMessage) {
    const s = this.state;
    switch (msg.type) {
      case 'snapshot': {
        const agents = new Map(msg.agents.map((a) => [a.id, a]));
        this.update({ agents, ready: true, hooks: msg.hooks, clockSkew: msg.now - Date.now() });
        break;
      }
      case 'agent': {
        const prev = s.agents.get(msg.agent.id);
        const agents = new Map(s.agents);
        agents.set(msg.agent.id, msg.agent);
        this.update({ agents });
        for (const t of this.transitions) t(prev, msg.agent);
        break;
      }
      case 'remove': {
        const agents = new Map(s.agents);
        agents.delete(msg.id);
        this.update({ agents });
        break;
      }
      case 'event': {
        const events = new Map(s.events);
        const list = [...(events.get(msg.event.agentId) ?? [])];
        const i = list.findIndex((e) => e.id === msg.event.id);
        if (i >= 0) list[i] = msg.event;
        else list.push(msg.event);
        if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS);
        events.set(msg.event.agentId, list);
        this.update({ events });
        break;
      }
      case 'hooks':
        this.update({ hooks: msg.hooks });
        break;
    }
  }

  async loadEvents(agentId: string) {
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/events`);
      if (!res.ok) return;
      const history = (await res.json()) as FeedEvent[];
      const live = this.state.events.get(agentId) ?? [];
      const byId = new Map<string, FeedEvent>();
      for (const e of [...history, ...live]) byId.set(e.id, e);
      const merged = [...byId.values()].sort((a, b) => a.ts - b.ts).slice(-MAX_EVENTS);
      const events = new Map(this.state.events);
      events.set(agentId, merged);
      this.update({ events });
    } catch {}
  }

  onTransition(fn: Transition) {
    this.transitions.add(fn);
    return () => {
      this.transitions.delete(fn);
    };
  }

  // Agrupa varias actualizaciones en un solo render.
  private update(patch: Partial<ClientState>) {
    this.state = { ...this.state, ...patch, version: this.state.version + 1 };
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      for (const l of this.listeners) l();
    });
  }

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = () => this.state;
}

export const client = new AgentClient();

export function useClient(): ClientState {
  return useSyncExternalStore(client.subscribe, client.getSnapshot);
}

// ---- token de gestión (de ?token=…) ----
const TOKEN_KEY = 'va-token';
export function readToken(): string | undefined {
  const url = new URL(location.href);
  const t = url.searchParams.get('token');
  if (t) {
    try {
      sessionStorage.setItem(TOKEN_KEY, t);
    } catch {}
    url.searchParams.delete('token');
    history.replaceState(null, '', url.toString());
    return t;
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
