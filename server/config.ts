import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(here, '..');
export const WEB_DIST = path.join(ROOT_DIR, 'web', 'dist');
export const HOOK_CLIENT = path.join(ROOT_DIR, 'server', 'hooks', 'hook-client.cjs');

export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
export const CLAUDE_SETTINGS = path.join(CLAUDE_DIR, 'settings.json');

export const APP_DIR = path.join(os.homedir(), '.visualizador-agentes');
export const TOKEN_FILE = path.join(APP_DIR, 'token');
export const SERVER_FILE = path.join(APP_DIR, 'server.json');

export const HOST = process.env.VA_HOST ?? '127.0.0.1';
export const PORT = Number(process.env.VA_PORT ?? 4317);

const min = 60_000;
export const T = {
  pollMs: 1000,
  dirRescanMs: 4000,
  activeWindowMs: 30 * min, // archivos modificados en esta ventana se siguen
  initialTailBytes: 512 * 1024,
  permissionGuessMs: 7000, // herramienta corta pendiente sin actividad => probablemente pide permiso
  staleMs: 5 * min,
  staleLongToolMs: 20 * min,
  idleAfterMs: 10 * min, // waiting_input pasa a idle
  hideAfterMs: 30 * min, // sesiones sin actividad se quitan
  subHistoryMs: 6 * 60 * min, // historial de subagentes terminados de sesiones activas
  subSilentDoneMs: 3 * min, // subagente callado cuyo orquestador siguió adelante => terminado
  maxDoneSubsPerSession: 30,
  hooksFreshMs: 15 * min, // si hubo hooks de una sesión en este lapso, se desactivan heurísticas
  eventsPerAgent: 200,
};
