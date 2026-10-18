// Convierte cada línea JSONL de un transcript de Claude Code en señales normalizadas.

export type Signal =
  | { t: 'meta'; ts: number; cwd?: string; model?: string }
  | { t: 'title'; ts: number; title: string }
  | { t: 'cost'; ts: number; costUSD: number }
  | { t: 'prompt'; ts: number; text: string }
  | { t: 'text'; ts: number; text: string }
  | { t: 'thinking'; ts: number }
  | { t: 'tool_start'; ts: number; id: string; name: string; input: Record<string, unknown>; msgId?: string; ready?: boolean }
  // El mensaje del asistente terminó de generarse: sus herramientas empiezan a ejecutarse.
  | { t: 'msg_done'; ts: number; msgId: string }
  | { t: 'tool_end'; ts: number; id: string; ok: boolean; text?: string }
  | { t: 'turn_end'; ts: number }
  | { t: 'interrupted'; ts: number }
  | { t: 'error'; ts: number; text: string }
  | { t: 'compact'; ts: number }
  | { t: 'subagent_launched'; ts: number; toolUseId: string; agentId: string; background: boolean }
  // Un subagente entregó su informe (hand-back) o su tarea terminó (task-notification).
  | { t: 'agent_report'; ts: number; fromId: string; status?: string; summary?: string }
  // Mensaje del sistema que reactiva al agente (p. ej. aviso de subagente): no es un prompt tuyo.
  | { t: 'wake'; ts: number }
  // Comando de barra (/agents, /cost…): no cambia el estado por sí mismo.
  | { t: 'command'; ts: number; text: string };

type Rec = Record<string, any>;

const toTs = (v: unknown, fallback: number): number => {
  if (typeof v === 'string') {
    const n = Date.parse(v);
    if (!Number.isNaN(n)) return n;
  }
  return fallback;
};

export function clip(s: string, max = 160): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

// Quita etiquetas tipo <system-reminder>…</system-reminder> para mostrar el prompt real.
function cleanPrompt(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<(command-message|command-args|local-command-stdout|local-command-caveat)>[\s\S]*?<\/\1>/g, '')
    .replace(/<command-name>([\s\S]*?)<\/command-name>/g, '$1')
    .trim();
}

const AGENT_MSG_RE = /<agent-message from="([^"]+)">/g;
const TASK_NOTIF_RE = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const tag = (body: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1]?.trim();

// Avisos de fin de subagentes que llegan al orquestador como mensajes o en la cola.
export function agentReports(text: string, ts: number): Signal[] {
  const out: Signal[] = [];
  for (const m of text.matchAll(AGENT_MSG_RE)) out.push({ t: 'agent_report', ts, fromId: m[1] });
  for (const m of text.matchAll(TASK_NOTIF_RE)) {
    const id = tag(m[1], 'task-id');
    if (id) out.push({ t: 'agent_report', ts, fromId: id, status: tag(m[1], 'status'), summary: tag(m[1], 'summary') });
  }
  return out;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: Rec) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
      .join(' ');
  }
  return '';
}

export function parseRecord(o: Rec, now = Date.now()): Signal[] {
  if (!o || typeof o !== 'object') return [];
  const ts = toTs(o.timestamp, now);
  const out: Signal[] = [];

  switch (o.type) {
    case 'ai-title':
      if (typeof o.aiTitle === 'string') out.push({ t: 'title', ts, title: o.aiTitle });
      return out;
    case 'custom-title':
      if (typeof o.customTitle === 'string') out.push({ t: 'title', ts, title: o.customTitle });
      return out;
    case 'summary':
      if (typeof o.summary === 'string') out.push({ t: 'title', ts, title: o.summary });
      return out;
    case 'queue-operation':
      // Los avisos de subagentes se encolan antes de entregarse: sirven para detectar su fin al momento.
      if (o.operation === 'enqueue' && typeof o.content === 'string') return agentReports(o.content, ts);
      return out;
    case 'cost-state':
      if (typeof o.totalCostUSD === 'number') out.push({ t: 'cost', ts, costUSD: o.totalCostUSD });
      return out;
    case 'system':
      if (o.subtype === 'api_error') {
        const msg = o.error?.message ?? o.content ?? 'Error de API';
        out.push({ t: 'error', ts, text: clip(String(msg), 200) });
      } else if (o.subtype === 'compact_boundary') {
        out.push({ t: 'compact', ts });
      } else if (o.subtype === 'turn_duration' || o.subtype === 'stop_hook_summary') {
        out.push({ t: 'turn_end', ts });
      }
      return out;
    case 'assistant':
      return parseAssistant(o, ts);
    case 'user':
      return parseUser(o, ts);
    default:
      return out;
  }
}

function parseAssistant(o: Rec, ts: number): Signal[] {
  const out: Signal[] = [];
  const msg = o.message ?? {};
  const model = typeof msg.model === 'string' && !msg.model.startsWith('<') ? msg.model : undefined;
  out.push({ t: 'meta', ts, cwd: o.cwd, model });

  if (o.isApiErrorMessage) {
    const text = Array.isArray(msg.content) ? toolResultText(msg.content) : String(o.error ?? 'Error');
    out.push({ t: 'error', ts, text: clip(text || 'Error de API', 200) });
    return out;
  }

  const content: Rec[] = Array.isArray(msg.content) ? msg.content : [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      out.push({ t: 'text', ts, text: clip(block.text, 300) });
    } else if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
      out.push({ t: 'thinking', ts });
    } else if (block?.type === 'tool_use' && typeof block.id === 'string') {
      out.push({
        t: 'tool_start', ts, id: block.id, name: String(block.name ?? '?'), input: block.input ?? {},
        msgId: typeof msg.id === 'string' ? msg.id : undefined,
        // Los bloques intermedios llevan stop_reason null: el mensaje sigue generándose.
        ready: msg.stop_reason != null,
      });
    }
  }
  if (msg.stop_reason === 'tool_use' && typeof msg.id === 'string') out.push({ t: 'msg_done', ts, msgId: msg.id });
  if (msg.stop_reason === 'end_turn' || msg.stop_reason === 'stop_sequence') {
    out.push({ t: 'turn_end', ts });
  }
  return out;
}

function parseUser(o: Rec, ts: number): Signal[] {
  const out: Signal[] = [];
  out.push({ t: 'meta', ts, cwd: o.cwd });
  if (o.isMeta || o.isCompactSummary || o.isVisibleInTranscriptOnly) return out;

  const content = o.message?.content;
  if (typeof content === 'string') {
    pushPrompt(out, content, ts);
    return out;
  }
  if (!Array.isArray(content)) return out;

  for (const block of content as Rec[]) {
    if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      // Primero el enlace con el subagente, para que el store sepa si es background
      // antes de procesar el tool_end (un Agent async devuelve resultado al instante).
      const r = o.toolUseResult;
      if (r && typeof r === 'object' && typeof r.agentId === 'string') {
        out.push({
          t: 'subagent_launched',
          ts,
          toolUseId: block.tool_use_id,
          agentId: r.agentId,
          background: r.isAsync === true || r.status === 'async_launched',
        });
      }
      out.push({
        t: 'tool_end',
        ts,
        id: block.tool_use_id,
        ok: !block.is_error,
        text: clip(toolResultText(block.content), 200) || undefined,
      });
    } else if (block?.type === 'text' && typeof block.text === 'string') {
      pushPrompt(out, block.text, ts);
    }
  }
  return out;
}

function pushPrompt(out: Signal[], raw: string, ts: number) {
  if (raw.startsWith('[Request interrupted by user')) {
    out.push({ t: 'interrupted', ts });
    return;
  }
  // Salida o aviso de comandos locales: no los procesa el modelo.
  if (/^\s*<local-command-(caveat|stdout|stderr)>/.test(raw)) return;
  const reports = agentReports(raw, ts);
  if (reports.length) {
    out.push(...reports, { t: 'wake', ts });
    return;
  }
  if (/^\s*<command-name>/.test(raw)) {
    out.push({ t: 'command', ts, text: clip(cleanPrompt(raw), 80) });
    return;
  }
  const text = cleanPrompt(raw);
  if (!text) return;
  out.push({ t: 'prompt', ts, text: clip(text, 300) });
}

export function parseLine(line: string, now = Date.now()): Signal[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  try {
    return parseRecord(JSON.parse(trimmed), now);
  } catch {
    return [];
  }
}

// ---- Resumen y clasificación de herramientas ----

const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export function summarizeTool(name: string, input: Record<string, any>): string {
  const i = input ?? {};
  const pick = (...keys: string[]) => {
    for (const k of keys) if (typeof i[k] === 'string' && i[k]) return i[k] as string;
    return '';
  };
  const path = pick('file_path', 'notebook_path', 'path');
  if (path && /^(Read|Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return base(path);
  if (name === 'Bash' || name === 'PowerShell') return clip(pick('description') || pick('command'), 80);
  if (name === 'Grep' || name === 'Glob') return clip(pick('pattern') + (path ? ` en ${base(path)}` : ''), 80);
  if (name === 'Agent' || name === 'Task') return clip(`${pick('subagent_type') || 'agente'}: ${pick('description')}`, 80);
  if (name === 'WebFetch') return clip(pick('url'), 80);
  if (name === 'WebSearch') return clip(pick('query'), 80);
  if (name === 'Skill') return clip(pick('skill'), 80);
  const generic = pick('description', 'file_path', 'path', 'command', 'pattern', 'query', 'url', 'prompt');
  return clip(generic, 80);
}

export type ToolActivity = 'typing' | 'reading' | 'running' | 'delegating' | 'waiting';

export function toolActivity(name: string): ToolActivity {
  if (/^(Edit|Write|MultiEdit|NotebookEdit|SubagentHandback)$/.test(name)) return 'typing';
  if (/^(Read|Grep|Glob|LS|WebFetch|WebSearch|ToolSearch|Skill)$/.test(name)) return 'reading';
  if (/^(Agent|Task|SendMessage)$/.test(name)) return 'delegating';
  if (/^(AskUserQuestion|ExitPlanMode)$/.test(name)) return 'waiting';
  if (/browser|chrome|find|read_page|get_page_text/i.test(name)) return 'reading';
  return 'running';
}

// Herramientas que pueden tardar legítimamente y no deben interpretarse como "esperando permiso".
export function isLongRunningTool(name: string): boolean {
  return /^(Bash|PowerShell|Agent|Task|BashOutput|Monitor|ScheduleWakeup|WebFetch|WebSearch|SendMessage)$/.test(name) ||
    name.startsWith('mcp__');
}
