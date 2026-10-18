import fs from 'node:fs';
import path from 'node:path';
import type { HooksStatus } from '../../shared/types.ts';
import { CLAUDE_SETTINGS, HOOK_CLIENT } from '../config.ts';

// Eventos de hooks que escuchamos (nombres según la documentación de Claude Code).
export const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'SubagentStart',
  'SubagentStop',
] as const;

const MARKER = 'visualizador-agentes';

const hookCommand = () => `node "${HOOK_CLIENT.replace(/\\/g, '/')}"`;

type Handler = { type?: string; command?: string; [k: string]: unknown };
type Group = { matcher?: string; hooks?: Handler[]; [k: string]: unknown };
type Settings = { hooks?: Record<string, Group[]>; [k: string]: unknown };

const isOurs = (h: Handler) => typeof h.command === 'string' && h.command.toLowerCase().includes(MARKER);

function readSettings(file: string): Settings {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  return JSON.parse(text); // si no es JSON válido, lanzamos y no tocamos nada
}

function writeSettings(file: string, settings: Settings): string | undefined {
  let backup: string | undefined;
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backup = `${file}.bak-${stamp}`;
    fs.copyFileSync(file, backup);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const text = JSON.stringify(settings, null, 2) + '\n';
  JSON.parse(text); // validación
  const tmp = file + '.tmp-va';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
  return backup;
}

// Quita nuestros handlers sin tocar los demás; elimina grupos/eventos que queden vacíos.
function strip(settings: Settings): Settings {
  const hooks = settings.hooks;
  if (!hooks) return settings;
  for (const event of Object.keys(hooks)) {
    const groups = (hooks[event] ?? [])
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (groups.length) hooks[event] = groups;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return settings;
}

export function hooksStatus(file = CLAUDE_SETTINGS): HooksStatus {
  try {
    const s = readSettings(file);
    const events = Object.entries(s.hooks ?? {})
      .filter(([, groups]) => groups.some((g) => (g.hooks ?? []).some(isOurs)))
      .map(([e]) => e);
    return { installed: events.length > 0, events, settingsPath: file };
  } catch {
    return { installed: false, events: [], settingsPath: file };
  }
}

export function installHooks(file = CLAUDE_SETTINGS): { backup?: string; status: HooksStatus } {
  const settings = strip(readSettings(file));
  settings.hooks ??= {};
  for (const event of HOOK_EVENTS) {
    const groups = (settings.hooks[event] ??= []);
    // async: se ejecuta en segundo plano, nunca retrasa a Claude.
    groups.push({ hooks: [{ type: 'command', command: hookCommand(), async: true, timeout: 5 }] });
  }
  const backup = writeSettings(file, settings);
  return { backup, status: hooksStatus(file) };
}

export function uninstallHooks(file = CLAUDE_SETTINGS): { backup?: string; status: HooksStatus } {
  const before = hooksStatus(file);
  if (!before.installed) return { status: before };
  const settings = strip(readSettings(file));
  const backup = writeSettings(file, settings);
  return { backup, status: hooksStatus(file) };
}
