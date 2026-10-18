// Tipos compartidos entre servidor y web.

export type AgentStatus =
  | 'working' // ejecutando herramientas o generando respuesta
  | 'waiting_permission' // Claude pide permiso al usuario
  | 'waiting_input' // terminó el turno, espera un nuevo prompt
  | 'idle' // sin actividad reciente
  | 'done' // subagente terminado
  | 'error' // error de API
  | 'stale'; // decía "working" pero lleva mucho sin dar señales

export type Activity = 'typing' | 'reading' | 'running' | 'delegating' | 'thinking' | 'none';

export type AgentKind = 'main' | 'subagent';

export interface ActiveTool {
  id: string;
  name: string;
  summary: string;
  startedAt: number;
  // false mientras el modelo aún genera el mensaje (la herramienta todavía no se ejecuta)
  executing: boolean;
  readyAt?: number;
  msgId?: string;
}

export interface Agent {
  id: string; // sessionId para principales, agentId para subagentes
  sessionId: string;
  parentId?: string;
  kind: AgentKind;
  project: string; // nombre legible del proyecto (última carpeta del cwd)
  projectKey: string; // carpeta codificada en ~/.claude/projects
  cwd?: string;
  title: string;
  agentType?: string;
  description?: string;
  prompt?: string;
  model?: string;
  status: AgentStatus;
  activity: Activity;
  currentTools: ActiveTool[];
  lastText?: string;
  startedAt: number;
  lastActivityAt: number;
  endedAt?: number;
  costUSD?: number;
  background?: boolean;
  toolsDone: number; // herramientas completadas en total
  waitingOn?: number; // orquestador: subagentes que siguen trabajando
  recent: RecentAction[]; // últimas acciones (más reciente al final)
  spawnDepth?: number;
  toolUseId?: string; // tool_use del padre que lo lanzó
  source: { transcript: boolean; hooks: boolean };
}

export interface RecentAction {
  ts: number;
  kind: EventKind;
  tool?: string;
  text: string;
  ok?: boolean;
}

export type EventKind =
  | 'prompt'
  | 'text'
  | 'tool_start'
  | 'tool_end'
  | 'turn_end'
  | 'permission'
  | 'notification'
  | 'error'
  | 'compact'
  | 'subagent_start'
  | 'subagent_end'
  | 'session_start'
  | 'session_end';

export interface FeedEvent {
  id: string;
  agentId: string;
  ts: number;
  kind: EventKind;
  tool?: string;
  text: string;
  ok?: boolean;
}

export interface HooksStatus {
  installed: boolean;
  events: string[];
  settingsPath: string;
  lastHookAt?: number;
}

export type ServerMessage =
  | { type: 'snapshot'; agents: Agent[]; hooks: HooksStatus; now: number }
  | { type: 'agent'; agent: Agent }
  | { type: 'remove'; id: string }
  | { type: 'event'; event: FeedEvent }
  | { type: 'hooks'; hooks: HooksStatus };
