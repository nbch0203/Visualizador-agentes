import fs from 'node:fs/promises';
import path from 'node:path';
import { PROJECTS_DIR, T } from '../config.ts';
import type { AgentStore, SubagentMeta } from '../runtime/store.ts';
import { FileTail } from './tailer.ts';
import { parseLine } from './parser.ts';

interface Tracked {
  tail: FileTail;
  kind: 'main' | 'subagent';
  id: string;
  sessionId: string;
  projectKey: string;
}

const SESSION_RE = /^[0-9a-f-]{36}\.jsonl$/i;
const SUB_RE = /^agent-([\w-]+)\.jsonl$/;

// Descubre y sigue los transcripts JSONL activos mediante sondeo (robusto en Windows).
export class TranscriptScanner {
  private tracked = new Map<string, Tracked>();
  // Archivos que dejamos de seguir porque el store retiró su agente: no se releen hasta que cambien.
  private retired = new Map<string, number>();
  private projectDirs: string[] = [];
  private lastDirScan = 0;
  private running = false;
  private timer?: NodeJS.Timeout;

  constructor(private store: AgentStore, private root = PROJECTS_DIR) {}

  start(): void {
    const loop = async () => {
      if (!this.running) {
        this.running = true;
        try {
          await this.scan();
        } catch (err) {
          console.error('[scanner]', err);
        } finally {
          this.running = false;
        }
      }
      this.timer = setTimeout(loop, T.pollMs);
    };
    void loop();
  }

  stop(): void {
    clearTimeout(this.timer);
  }

  async scan(now = Date.now()): Promise<void> {
    if (now - this.lastDirScan > T.dirRescanMs || this.projectDirs.length === 0) {
      this.lastDirScan = now;
      this.projectDirs = await listDirs(this.root);
    }

    for (const projectKey of this.projectDirs) {
      const dir = path.join(this.root, projectKey);
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!SESSION_RE.test(name)) continue;
        const sessionId = name.slice(0, -'.jsonl'.length);
        const file = path.join(dir, name);
        const isActive = await this.poll(file, now, T.activeWindowMs, () => ({ kind: 'main', id: sessionId, sessionId, projectKey }));
        // Solo miramos subagentes de sesiones activas (incluidos los ya terminados, como historial del equipo).
        if (isActive) await this.scanSubagents(path.join(dir, sessionId, 'subagents'), sessionId, projectKey, now);
      }
    }
  }

  private async scanSubagents(dir: string, sessionId: string, projectKey: string, now: number) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const m = SUB_RE.exec(name);
      if (!m) continue;
      const agentId = m[1];
      await this.poll(path.join(dir, name), now, T.subHistoryMs, () => ({ kind: 'subagent', id: agentId, sessionId, projectKey }), async () => {
        const meta = await readMeta(path.join(dir, `agent-${agentId}.meta.json`));
        this.store.upsertSub(agentId, sessionId, projectKey, meta);
      });
    }
  }

  // Devuelve true si el archivo se está siguiendo.
  private async poll(
    file: string,
    now: number,
    window: number,
    describe: () => Omit<Tracked, 'tail'>,
    onTrack?: () => Promise<void>,
  ): Promise<boolean> {
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      this.tracked.delete(file);
      return false;
    }
    let t = this.tracked.get(file);
    if (!t) {
      if (now - stat.mtimeMs > window) return false;
      if (this.retired.get(file) === stat.mtimeMs) return false;
      this.retired.delete(file);
      t = { ...describe(), tail: new FileTail(file, T.initialTailBytes) };
      this.tracked.set(file, t);
      if (t.kind === 'main') this.store.upsertMain(t.sessionId, t.projectKey);
      if (onTrack) await onTrack();
    } else if (now - stat.mtimeMs > T.activeWindowMs && !this.store.has(t.id)) {
      // Archivo quieto y su agente ya fue retirado del store: dejar de seguirlo hasta que cambie.
      this.tracked.delete(file);
      this.retired.set(file, stat.mtimeMs);
      return false;
    }

    if (stat.size !== t.tail.size || stat.mtimeMs !== t.tail.mtimeMs) {
      t.tail.size = stat.size;
      t.tail.mtimeMs = stat.mtimeMs;
      const lines = await t.tail.read(stat.size);
      if (lines.length) {
        // Si el store retiró al agente por inactividad y vuelve a haber líneas, recrearlo.
        if (t.kind === 'main') this.store.upsertMain(t.sessionId, t.projectKey);
        else if (!this.store.has(t.id)) {
          const meta = await readMeta(file.replace(/\.jsonl$/, '.meta.json'));
          this.store.upsertSub(t.id, t.sessionId, t.projectKey, meta);
        }
        for (const line of lines) {
          for (const sig of parseLine(line)) this.store.applySignal(t.id, sig);
        }
      }
    }
    return true;
  }
}

async function listDirs(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function readMeta(file: string): Promise<SubagentMeta> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return {};
  }
}
