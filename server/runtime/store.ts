import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { ActiveTool, Activity, Agent, AgentStatus, EventKind, FeedEvent } from '../../shared/types.ts';
import { T } from '../config.ts';
import { clip, isLongRunningTool, summarizeTool, toolActivity, type Signal } from '../transcripts/parser.ts';

type Phase = 'working' | 'waiting_input' | 'done' | 'error' | 'ended';

interface Permission {
  since: number;
  toolName?: string;
  toolId?: string;
  guessed: boolean;
}

interface Internal {
  agent: Agent;
  phase: Phase;
  phaseAt: number;
  turnEndAt: number;
  pending: Map<string, ActiveTool>;
  endedTools: Set<string>;
  permission?: Permission;
  events: FeedEvent[];
  lastHookAt?: number;
  hasTitle: boolean;
  nonInteractive?: boolean; // subagente que no puede pedir permisos
  inferredDone?: boolean; // terminado por inferencia (sin señales); revive si vuelve a escribir
}

export interface SubagentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  spawnDepth?: number;
  requestShape?: string;
  requestNonInteractive?: boolean;
  model?: string;
}

// Payload que envía hook-client.cjs (ya recortado).
export type HookPayload = Record<string, any> & {
  hook_event_name: string;
  session_id: string;
};

let eventSeq = 0;
const RECENT_COUNT = 5;
const RECENT_KINDS = new Set<EventKind>(['tool_start', 'text', 'prompt', 'permission', 'error', 'subagent_start', 'subagent_end']);

export function projectNameFrom(cwd: string | undefined, projectKey: string): string {
  if (cwd) {
    const name = path.basename(cwd.replace(/[\\/]+$/, ''));
    if (name) return name;
  }
  const parts = projectKey.split('--');
  return parts[parts.length - 1] || projectKey;
}

export class AgentStore extends EventEmitter {
  private agents = new Map<string, Internal>();
  private toolOwner = new Map<string, string>(); // tool_use id -> agente que lo invocó
  private subByToolUse = new Map<string, string>(); // tool_use id del Agent -> id del subagente
  private backgroundToolUses = new Set<string>();
  private reports = new Map<string, { ts: number; status?: string }>(); // subagentes que ya avisaron de su fin
  private dirty = new Set<string>();
  lastHookAt?: number;

  constructor(private now: () => number = Date.now) {
    super();
  }

  // ---------- consultas ----------

  list(): Agent[] {
    return [...this.agents.values()].map((s) => this.view(s));
  }

  get(id: string): Agent | undefined {
    const s = this.agents.get(id);
    return s && this.view(s);
  }

  events(id: string): FeedEvent[] {
    return this.agents.get(id)?.events ?? [];
  }

  has(id: string): boolean {
    return this.agents.has(id);
  }

  // ---------- altas ----------

  upsertMain(sessionId: string, projectKey: string, cwd?: string): void {
    if (this.agents.has(sessionId)) return;
    const t = this.now();
    this.agents.set(sessionId, this.blank({
      id: sessionId,
      sessionId,
      kind: 'main',
      projectKey,
      project: projectNameFrom(cwd, projectKey),
      cwd,
      title: 'Sesión ' + sessionId.slice(0, 8),
      startedAt: t,
      lastActivityAt: 0,
    }));
    this.touch(sessionId);
  }

  upsertSub(agentId: string, sessionId: string, projectKey: string, meta: SubagentMeta = {}): void {
    const existing = this.agents.get(agentId);
    if (existing) {
      // Completar datos que puedan llegar después (meta.json leído tras un hook).
      const a = existing.agent;
      a.agentType ??= meta.agentType;
      a.description ??= meta.description;
      if (meta.toolUseId && !a.toolUseId) {
        a.toolUseId = meta.toolUseId;
        this.subByToolUse.set(meta.toolUseId, agentId);
        a.parentId = this.toolOwner.get(meta.toolUseId) ?? a.parentId;
      }
      if (meta.description && !existing.hasTitle) a.title = meta.description;
      if (meta.requestShape === 'background') a.background = true;
      if (meta.requestNonInteractive) existing.nonInteractive = true;
      a.model ??= meta.model;
      this.touch(agentId);
      return;
    }
    const parentId = (meta.toolUseId && this.toolOwner.get(meta.toolUseId)) || sessionId;
    const parent = this.agents.get(parentId) ?? this.agents.get(sessionId);
    const t = this.now();
    const st = this.blank({
      id: agentId,
      sessionId,
      parentId,
      kind: 'subagent',
      projectKey,
      project: parent?.agent.project ?? projectNameFrom(undefined, projectKey),
      cwd: parent?.agent.cwd,
      title: meta.description || meta.agentType || 'Subagente ' + agentId.slice(0, 6),
      agentType: meta.agentType,
      description: meta.description,
      toolUseId: meta.toolUseId,
      spawnDepth: meta.spawnDepth,
      background: meta.requestShape === 'background' || (meta.toolUseId !== undefined && this.backgroundToolUses.has(meta.toolUseId)) ? true : undefined,
      startedAt: t,
      lastActivityAt: 0,
    });
    st.hasTitle = !!meta.description;
    st.nonInteractive = meta.requestNonInteractive === true;
    st.agent.model = meta.model;
    this.agents.set(agentId, st);
    if (meta.toolUseId) this.subByToolUse.set(meta.toolUseId, agentId);
    // El lanzamiento ya figura en el feed del padre como su herramienta Agent (con su hora real).
    const report = this.reports.get(agentId);
    if (report) {
      st.agent.lastActivityAt = report.ts;
      this.finishSub(st, report.ts, report.status);
    }
    this.touch(agentId);
  }

  private blank(partial: Omit<Agent, 'status' | 'activity' | 'currentTools' | 'source' | 'toolsDone' | 'recent'>): Internal {
    return {
      agent: { ...partial, status: 'idle', activity: 'none', currentTools: [], source: { transcript: false, hooks: false }, toolsDone: 0, recent: [] },
      phase: 'waiting_input',
      phaseAt: 0,
      turnEndAt: 0,
      pending: new Map(),
      endedTools: new Set(),
      events: [],
      hasTitle: false,
    };
  }

  // ---------- señales de transcript ----------

  applySignal(id: string, sig: Signal, from: 'transcript' | 'hook' = 'transcript'): void {
    const st = this.agents.get(id);
    if (!st) return;
    const a = st.agent;
    a.source[from === 'hook' ? 'hooks' : 'transcript'] = true;

    if (sig.t !== 'title' && sig.t !== 'cost' && sig.t !== 'meta') {
      if (sig.ts > a.lastActivityAt) a.lastActivityAt = sig.ts;
      if (!a.startedAt || (a.lastActivityAt && a.startedAt > sig.ts)) a.startedAt = sig.ts;
      // Cualquier señal nueva desmiente una sospecha heurística de permiso.
      if (st.permission?.guessed && sig.ts >= st.permission.since) st.permission = undefined;
    }

    switch (sig.t) {
      case 'meta':
        if (sig.cwd && !a.cwd) {
          a.cwd = sig.cwd;
          a.project = projectNameFrom(sig.cwd, a.projectKey);
        }
        if (sig.model) a.model = sig.model;
        break;
      case 'title':
        if (a.kind === 'main') {
          a.title = clip(sig.title, 80);
          st.hasTitle = true;
        }
        break;
      case 'cost':
        a.costUSD = sig.costUSD;
        break;
      case 'prompt':
        if (!a.prompt) a.prompt = sig.text;
        if (a.kind === 'main' && !st.hasTitle) a.title = clip(sig.text, 60);
        this.setPhase(st, 'working', sig.ts);
        st.permission = undefined;
        this.pushEvent(st, 'prompt', sig.text, sig.ts);
        break;
      case 'text':
        a.lastText = sig.text;
        this.setPhase(st, 'working', sig.ts, true);
        this.pushEvent(st, 'text', sig.text, sig.ts);
        break;
      case 'thinking':
        this.setPhase(st, 'working', sig.ts, true);
        break;
      case 'tool_start':
        this.toolStart(st, sig.id, sig.name, sig.input, sig.ts, sig.ready !== false || from === 'hook', sig.msgId);
        break;
      case 'msg_done':
        for (const tool of st.pending.values()) {
          if (tool.msgId === sig.msgId && !tool.executing) {
            tool.executing = true;
            tool.readyAt = sig.ts;
          }
        }
        break;
      case 'tool_end':
        this.toolEnd(st, sig.id, sig.ok, sig.ts, sig.text);
        break;
      case 'turn_end':
        this.turnEnd(st, sig.ts);
        break;
      case 'interrupted':
        this.turnEnd(st, sig.ts, 'Interrumpido por el usuario');
        break;
      case 'error':
        if (this.setPhase(st, 'error', sig.ts)) this.pushEvent(st, 'error', sig.text, sig.ts);
        break;
      case 'compact':
        this.pushEvent(st, 'compact', 'Contexto compactado', sig.ts);
        break;
      case 'wake':
        // Aviso del sistema (p. ej. informe de un subagente): el agente retoma el trabajo.
        this.setPhase(st, 'working', sig.ts);
        break;
      case 'command':
        this.pushEvent(st, 'notification', `Comando ${sig.text}`, sig.ts);
        break;
      case 'agent_report': {
        const prev = this.reports.get(sig.fromId);
        if (!prev || prev.ts < sig.ts) this.reports.set(sig.fromId, { ts: sig.ts, status: sig.status });
        const sub = this.agents.get(sig.fromId);
        if (sub && sub.agent.kind === 'subagent' && sub.phase !== 'done' && sig.ts >= sub.phaseAt) {
          this.finishSub(sub, sig.ts, sig.status);
        }
        break;
      }
      case 'subagent_launched': {
        const subId = this.subByToolUse.get(sig.toolUseId) ?? sig.agentId;
        this.subByToolUse.set(sig.toolUseId, subId);
        if (sig.background) this.backgroundToolUses.add(sig.toolUseId);
        const sub = this.agents.get(subId);
        if (sub && sig.background) {
          sub.agent.background = true;
          this.touch(subId);
        }
        break;
      }
    }
    this.touch(id);
  }

  private setPhase(st: Internal, phase: Phase, ts: number, onlyIfActive = false): boolean {
    if (ts < st.phaseAt) return false; // información más vieja que el último cambio
    if (onlyIfActive && st.phase === 'done' && !st.inferredDone) return false;
    if (st.phase === 'ended' && phase !== 'working') return false;
    const changed = st.phase !== phase;
    st.phase = phase;
    st.phaseAt = ts;
    if (phase === 'working') {
      st.agent.endedAt = undefined;
      st.inferredDone = false;
    }
    return changed;
  }

  private toolStart(st: Internal, toolId: string, name: string, input: Record<string, unknown>, ts: number, ready: boolean, msgId?: string) {
    this.toolOwner.set(toolId, st.agent.id);
    // Re-enlazar subagentes cuyo meta.json se leyó antes que este tool_use.
    const subId = this.subByToolUse.get(toolId);
    if (subId) {
      const sub = this.agents.get(subId);
      if (sub && sub.agent.parentId !== st.agent.id) {
        sub.agent.parentId = st.agent.id;
        this.touch(subId);
      }
    }
    const known = st.pending.get(toolId);
    if (known) {
      // Ya la conocíamos (p. ej. por el transcript y ahora llega el hook): solo actualizar si arrancó.
      if (ready && !known.executing) {
        known.executing = true;
        known.readyAt = ts;
      }
      return;
    }
    if (st.endedTools.has(toolId) || ts < st.turnEndAt) return;
    const tool: ActiveTool = {
      id: toolId, name, summary: summarizeTool(name, input as any), startedAt: ts,
      executing: ready, readyAt: ready ? ts : undefined, msgId,
    };
    st.pending.set(toolId, tool);
    this.setPhase(st, 'working', ts);
    this.pushEvent(st, 'tool_start', tool.summary, ts, { tool: name, id: 'tool:' + toolId });
    if (toolActivity(name) === 'waiting') {
      this.pushEvent(st, 'notification', name === 'AskUserQuestion' ? 'Te está haciendo una pregunta' : 'Espera que apruebes el plan', ts);
    }
  }

  private toolEnd(st: Internal, toolId: string, ok: boolean, ts: number, text?: string) {
    const tool = st.pending.get(toolId);
    if (st.endedTools.has(toolId)) return;
    st.endedTools.add(toolId);
    st.agent.toolsDone++;
    if (st.endedTools.size > 500) st.endedTools.delete(st.endedTools.values().next().value!);
    st.pending.delete(toolId);
    if (st.permission && (st.permission.toolId === toolId || (!st.permission.toolId && st.permission.toolName === tool?.name))) {
      st.permission = undefined;
    }
    this.setPhase(st, 'working', ts, true);
    const ev = st.events.find((e) => e.id === 'tool:' + toolId);
    if (ev) {
      ev.ok = ok;
      if (!ok && text) ev.text = `${ev.text} — ${clip(text, 100)}`;
      this.emit('event', ev);
    }
    // Los subagentes entregan su informe con SubagentHandback: eso marca el final.
    if (st.agent.kind === 'subagent' && (tool?.name ?? ev?.tool) === 'SubagentHandback') {
      this.finishSub(st, ts);
      return;
    }
    // Un subagente síncrono termina cuando el padre recibe su resultado.
    const subId = this.subByToolUse.get(toolId);
    const sub = subId ? this.agents.get(subId) : undefined;
    if (sub && !sub.agent.background && sub.phase !== 'done') this.finishSub(sub, ts);
  }

  private turnEnd(st: Internal, ts: number, label?: string) {
    if (ts < st.phaseAt) return;
    st.turnEndAt = Math.max(st.turnEndAt, ts);
    for (const id of st.pending.keys()) st.endedTools.add(id);
    st.pending.clear();
    st.permission = undefined;
    if (st.agent.kind === 'subagent') {
      this.finishSub(st, ts);
      return;
    }
    if (this.setPhase(st, 'waiting_input', ts) || label) {
      this.pushEvent(st, 'turn_end', label ?? 'Turno terminado, esperando tu mensaje', ts);
    }
  }

  private finishSub(st: Internal, ts: number, status?: string) {
    st.pending.clear();
    st.permission = undefined;
    if (!this.setPhase(st, 'done', ts)) return;
    st.turnEndAt = Math.max(st.turnEndAt, ts);
    st.agent.endedAt = ts;
    const failed = status && status !== 'completed' ? ` (${status})` : '';
    this.pushEvent(st, 'subagent_end', `Subagente terminado${failed}`, ts);
    const parent = st.agent.parentId ? this.agents.get(st.agent.parentId) : undefined;
    if (parent) this.pushEvent(parent, 'subagent_end', `Subagente terminó${failed}: ${st.agent.title}`, ts);
    this.touch(st.agent.id);
  }

  // ---------- hooks ----------

  applyHook(p: HookPayload): void {
    const t = this.now();
    this.lastHookAt = t;
    const sessionId = p.session_id;
    if (!sessionId) return;
    const projectKey = p.transcript_path ? path.basename(path.dirname(p.transcript_path)) : 'desconocido';
    this.upsertMain(sessionId, projectKey, p.cwd);
    let id = sessionId;
    if (p.agent_id && p.agent_id !== sessionId) {
      id = p.agent_id;
      this.upsertSub(id, sessionId, projectKey, { agentType: p.agent_type });
    }
    const st = this.agents.get(id)!;
    st.lastHookAt = t;
    st.agent.source.hooks = true;
    if (p.cwd && !st.agent.cwd) this.applySignal(id, { t: 'meta', ts: t, cwd: p.cwd }, 'hook');

    switch (p.hook_event_name) {
      case 'SessionStart':
        if (st.phase === 'ended') st.phase = 'waiting_input';
        if (typeof p.model === 'string') st.agent.model = p.model;
        if (typeof p.session_title === 'string') this.applySignal(id, { t: 'title', ts: t, title: p.session_title }, 'hook');
        this.pushEvent(st, 'session_start', `Sesión iniciada (${p.source ?? 'startup'})`, t);
        st.agent.lastActivityAt = Math.max(st.agent.lastActivityAt, t);
        break;
      case 'UserPromptSubmit':
        if (typeof p.prompt === 'string') this.applySignal(id, { t: 'prompt', ts: t, text: clip(p.prompt, 300) }, 'hook');
        break;
      case 'PreToolUse':
        if (p.tool_use_id) this.applySignal(id, { t: 'tool_start', ts: t, id: p.tool_use_id, name: p.tool_name ?? '?', input: p.tool_input ?? {} }, 'hook');
        break;
      case 'PostToolUse':
      case 'PostToolUseFailure':
        if (p.tool_use_id) {
          this.applySignal(id, {
            t: 'tool_end', ts: t, id: p.tool_use_id,
            ok: p.hook_event_name === 'PostToolUse',
            text: typeof p.error === 'string' ? p.error : undefined,
          }, 'hook');
        }
        break;
      case 'PermissionRequest': {
        const name = p.tool_name as string | undefined;
        const tool = [...st.pending.values()].reverse().find((x) => x.name === name);
        st.permission = { since: t, toolName: name, toolId: tool?.id, guessed: false };
        st.agent.lastActivityAt = Math.max(st.agent.lastActivityAt, t);
        const summary = name ? `${name}: ${summarizeTool(name, p.tool_input ?? {})}` : 'una acción';
        this.pushEvent(st, 'permission', `Pide permiso para ${summary}`, t);
        break;
      }
      case 'Notification': {
        const type = p.notification_type as string | undefined;
        if (type === 'permission_prompt') {
          if (!st.permission || st.permission.guessed) {
            const last = [...st.pending.values()].pop();
            st.permission = { since: t, toolName: last?.name, toolId: last?.id, guessed: false };
            this.pushEvent(st, 'permission', p.message ?? 'Necesita tu permiso', t);
          }
        } else if (type === 'idle_prompt') {
          this.setPhase(st, 'waiting_input', t);
        } else if (p.message) {
          this.pushEvent(st, 'notification', clip(String(p.message), 200), t);
        }
        break;
      }
      case 'Stop':
        this.applySignal(id, { t: 'turn_end', ts: t }, 'hook');
        break;
      case 'SubagentStart':
        this.setPhase(st, 'working', t);
        st.agent.lastActivityAt = Math.max(st.agent.lastActivityAt, t);
        break;
      case 'SubagentStop':
        if (st.agent.kind === 'subagent') this.finishSub(st, t);
        break;
      case 'SessionEnd':
        st.pending.clear();
        st.permission = undefined;
        st.phase = 'ended';
        st.phaseAt = t;
        st.agent.endedAt = t;
        this.pushEvent(st, 'session_end', `Sesión cerrada (${p.reason ?? 'fin'})`, t);
        break;
    }
    this.touch(id);
  }

  // ---------- reloj: heurísticas y limpieza ----------

  tick(): void {
    const now = this.now();
    for (const st of this.agents.values()) {
      const a = st.agent;
      const hooksFresh = st.lastHookAt !== undefined && now - st.lastHookAt < T.hooksFreshMs;

      // Heurística de permiso cuando no hay hooks: herramienta corta colgada y el archivo quieto.
      // Solo cuenta desde que la herramienta empezó a ejecutarse (mensaje completo), y nunca en
      // subagentes no interactivos, que no pueden pedir permiso.
      if (!hooksFresh && !st.permission && !st.nonInteractive && st.phase === 'working') {
        for (const tool of st.pending.values()) {
          if (!tool.readyAt || isLongRunningTool(tool.name) || toolActivity(tool.name) === 'waiting') continue;
          if (now - tool.readyAt > T.permissionGuessMs && now - a.lastActivityAt > T.permissionGuessMs) {
            st.permission = { since: now, toolName: tool.name, toolId: tool.id, guessed: true };
            this.pushEvent(st, 'permission', `¿Esperando permiso para ${tool.name}: ${tool.summary}?`, now);
            break;
          }
        }
      }

      // Subagente que dejó de dar señales y cuyo orquestador ya siguió adelante (terminó su
      // turno después de la última señal del subagente, o cerró la sesión): se da por terminado.
      // Sin este paso quedaría como "sin señales" y contaría como activo indefinidamente.
      if (a.kind === 'subagent' && (st.phase === 'working' || st.phase === 'error')) {
        const silent = now - a.lastActivityAt;
        const limit = [...st.pending.values()].some((x) => isLongRunningTool(x.name)) ? T.staleLongToolMs : T.subSilentDoneMs;
        const parent = this.agents.get(a.sessionId);
        const parentMovedOn = !parent || parent.phase === 'ended' || (parent.phase === 'waiting_input' && parent.phaseAt > a.lastActivityAt);
        if (silent > limit && (parentMovedOn || silent > T.hideAfterMs)) {
          st.inferredDone = true;
          this.finishSub(st, now, 'sin señales');
          a.endedAt = a.lastActivityAt;
        }
      }

      // Limpieza. Los subagentes terminados se conservan mientras viva su sesión,
      // para que el orquestador muestre su equipo completo.
      const quiet = now - this.lastSignalOfTeam(st);
      let remove: boolean;
      if (a.kind === 'subagent' && st.phase === 'done') {
        remove = !this.agents.has(a.sessionId) || quiet > T.subHistoryMs;
      } else {
        remove =
          (st.phase === 'ended' && quiet > 60_000) ||
          (st.phase !== 'working' && quiet > T.hideAfterMs) ||
          quiet > T.hideAfterMs * 2;
      }
      if (remove) {
        this.remove(a.id);
        continue;
      }
      this.touch(a.id);
    }

    // Límite de subagentes terminados por sesión (se quitan los más antiguos).
    const doneBySession = new Map<string, Internal[]>();
    for (const st of this.agents.values()) {
      if (st.agent.kind !== 'subagent' || st.phase !== 'done') continue;
      const list = doneBySession.get(st.agent.sessionId) ?? [];
      list.push(st);
      doneBySession.set(st.agent.sessionId, list);
    }
    for (const list of doneBySession.values()) {
      if (list.length <= T.maxDoneSubsPerSession) continue;
      list.sort((x, y) => (y.agent.endedAt ?? 0) - (x.agent.endedAt ?? 0));
      for (const st of list.slice(T.maxDoneSubsPerSession)) this.remove(st.agent.id);
    }
  }

  // Última señal del agente o, para una sesión principal, de cualquiera de sus subagentes activos.
  private lastSignalOfTeam(st: Internal): number {
    let last = Math.max(st.agent.lastActivityAt, st.lastHookAt ?? 0);
    if (st.agent.kind === 'main') {
      for (const o of this.agents.values()) {
        if (o.agent.kind === 'subagent' && o.agent.sessionId === st.agent.id && o.phase !== 'done') {
          last = Math.max(last, o.agent.lastActivityAt, o.lastHookAt ?? 0);
        }
      }
    }
    return last;
  }

  remove(id: string): void {
    if (!this.agents.delete(id)) return;
    this.dirty.delete(id);
    this.emit('remove', id);
  }

  // Emite los agentes modificados desde la última llamada (solo si su vista cambió).
  private lastSent = new Map<string, string>();
  flush(): void {
    for (const id of this.dirty) {
      const st = this.agents.get(id);
      if (!st) continue;
      const view = this.view(st);
      const key = JSON.stringify(view);
      if (this.lastSent.get(id) === key) continue;
      this.lastSent.set(id, key);
      this.emit('agent', view);
    }
    this.dirty.clear();
    for (const id of this.lastSent.keys()) if (!this.agents.has(id)) this.lastSent.delete(id);
  }

  private touch(id: string) {
    this.dirty.add(id);
  }

  private pushEvent(st: Internal, kind: EventKind, text: string, ts: number, extra: { tool?: string; id?: string } = {}) {
    const ev: FeedEvent = {
      id: extra.id ?? `e${++eventSeq}`,
      agentId: st.agent.id,
      ts,
      kind,
      text,
      tool: extra.tool,
    };
    st.events.push(ev);
    // Los transcripts de padre e hijos se leen por separado: mantener el feed en orden temporal.
    const n = st.events.length;
    if (n > 1 && st.events[n - 2].ts > ts) st.events.sort((x, y) => x.ts - y.ts);
    if (st.events.length > T.eventsPerAgent) st.events.splice(0, st.events.length - T.eventsPerAgent);
    this.emit('event', ev);
  }

  // ---------- estado derivado ----------

  private view(st: Internal): Agent {
    const now = this.now();
    const a = st.agent;
    const tools = [...st.pending.values()];
    const last = tools[tools.length - 1];
    let status = this.baseStatus(st, now);
    let activity: Activity = 'none';

    // Un orquestador que terminó su turno pero tiene subagentes trabajando no espera al usuario:
    // está coordinando.
    let waitingOn = 0;
    if (a.kind === 'main' && (status === 'waiting_input' || status === 'idle')) {
      for (const o of this.agents.values()) {
        if (o.agent.kind !== 'subagent' || o.agent.sessionId !== a.id) continue;
        const s = this.baseStatus(o, now);
        if (s === 'working' || s === 'waiting_permission') waitingOn++;
      }
      if (waitingOn) status = 'working';
    }

    if (status === 'working') {
      const act = last ? toolActivity(last.name) : waitingOn ? 'delegating' : 'thinking';
      activity = act === 'waiting' ? 'none' : act;
    }
    const recent = st.events
      .filter((e) => RECENT_KINDS.has(e.kind))
      .slice(-RECENT_COUNT)
      .map(({ ts, kind, tool, text, ok }) => ({ ts, kind, tool, text: clip(text, 120), ok }));
    return { ...a, status, activity, currentTools: tools, source: { ...a.source }, recent, waitingOn: waitingOn || undefined };
  }

  private baseStatus(st: Internal, now: number): AgentStatus {
    const a = st.agent;
    const tools = [...st.pending.values()];
    const last = tools[tools.length - 1];
    const quiet = now - a.lastActivityAt;
    let status: AgentStatus;

    if (st.phase === 'done') status = 'done';
    else if (st.phase === 'ended') status = 'idle';
    else if (st.permission) status = 'waiting_permission';
    else if (st.phase === 'error') status = 'error';
    else if (st.phase === 'waiting_input') status = quiet > T.idleAfterMs ? 'idle' : 'waiting_input';
    else if (last && toolActivity(last.name) === 'waiting') status = 'waiting_input';
    else {
      const limit = tools.some((x) => isLongRunningTool(x.name)) ? T.staleLongToolMs : T.staleMs;
      status = quiet > limit ? 'stale' : 'working';
    }
    return status;
  }
}
