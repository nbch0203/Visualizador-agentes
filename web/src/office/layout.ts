import type { Agent } from '../../../shared/types.ts';
import { STATUS_RANK, hash } from '../ui.ts';

// Dimensiones del mundo (en píxeles de sprite; luego se escalan).
export const SLOT_W = 52;
export const SLOT_H = 70;
export const LOUNGE_W = 32;
export const LOUNGE_H = 44;
export const WALL_H = 36;
export const MARGIN = 12;
const PAD = 8;
const HEADER = 16;
const FOOTER = 12;
const GAP = 14;

export type SlotKind = 'desk' | 'boss' | 'lounge';

export interface Slot {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: SlotKind;
  zoneKey: string;
}

export interface Zone {
  key: string; // projectKey (edificio) o sessionId (oficina de proyecto)
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  kind: 'room' | 'team';
  footer?: string;
  loungeY?: number; // inicio de la zona de terminados (equipos)
  doneCount?: number;
  bossId?: string;
  memberIds?: string[]; // subagentes activos (para dibujar los cables)
}

export interface Layout {
  zones: Zone[];
  slots: Map<string, Slot>;
  width: number;
  height: number;
  door: { x: number; y: number; w: number; h: number };
}

const RUGS = ['#3b4a6b', '#4a3b5e', '#2f5a52', '#5e4a33', '#5a3340', '#33505e', '#4f5a33', '#563d63'];
export const rugColor = (key: string) => RUGS[hash(key) % RUGS.length];

const door = { x: MARGIN + 10, y: WALL_H - 26, w: 20, h: 26 };

function groupTeams(agents: Agent[]): Map<string, Agent[]> {
  const teams = new Map<string, Agent[]>();
  for (const a of agents) {
    const t = teams.get(a.sessionId) ?? [];
    t.push(a);
    teams.set(a.sessionId, t);
  }
  return teams;
}

const byStart = (a: Agent, b: Agent) => a.startedAt - b.startedAt || a.id.localeCompare(b.id);

// ---------------- Edificio: una sala por proyecto ----------------

// `seated` son quienes ocupan escritorio; `all` sirve para el resumen de cada sala.
export function computeOverview(seated: Agent[], all: Agent[], worldW: number): Layout {
  const byZone = new Map<string, { name: string; teams: Map<string, Agent[]> }>();
  for (const a of seated) {
    let z = byZone.get(a.projectKey);
    if (!z) byZone.set(a.projectKey, (z = { name: a.project, teams: new Map() }));
    if (a.kind === 'main') z.name = a.project;
    const team = z.teams.get(a.sessionId) ?? [];
    team.push(a);
    z.teams.set(a.sessionId, team);
  }

  const maxCols = Math.max(1, Math.min(6, Math.floor((worldW - 2 * MARGIN - 2 * PAD) / SLOT_W)));
  const zones: Zone[] = [];
  const slots = new Map<string, Slot>();
  let cx = MARGIN;
  let cy = WALL_H + 14;
  let lineH = 0;

  const keys = [...byZone.keys()].sort((a, b) => byZone.get(a)!.name.localeCompare(byZone.get(b)!.name));
  for (const key of keys) {
    const z = byZone.get(key)!;
    const teams = [...z.teams.values()]
      .map((t) => t.sort((a, b) => (a.kind === 'main' ? -1 : b.kind === 'main' ? 1 : byStart(a, b))))
      .sort((a, b) => byStart(a[0], b[0]));

    const rows: Agent[][] = [];
    for (const team of teams) {
      for (let i = 0; i < team.length; i += maxCols) rows.push(team.slice(i, i + maxCols));
    }
    const cols = Math.max(2, ...rows.map((r) => r.length));
    const w = cols * SLOT_W + 2 * PAD;
    const h = HEADER + rows.length * SLOT_H + FOOTER + 4;

    if (cx + w > worldW - MARGIN && cx > MARGIN) {
      cx = MARGIN;
      cy += lineH + GAP;
      lineH = 0;
    }

    const inProject = all.filter((a) => a.projectKey === key);
    const working = inProject.filter((a) => a.status === 'working' || a.status === 'waiting_permission').length;
    const subs = inProject.filter((a) => a.kind === 'subagent');
    const done = subs.filter((a) => a.status === 'done').length;
    const activeSubs = subs.length - done;
    const parts = [`${working} trabajando`];
    if (activeSubs) parts.push(`${activeSubs} sub${activeSubs === 1 ? '' : 's'} activo${activeSubs === 1 ? '' : 's'}`);
    if (done) parts.push(`${done} ✓ terminado${done === 1 ? '' : 's'}`);
    const footer = `${parts.join(' · ')}  ▸ entrar`;

    zones.push({ key, name: z.name, x: cx, y: cy, w, h, color: rugColor(key), kind: 'room', footer });
    rows.forEach((row, r) => {
      row.forEach((a, c) => {
        slots.set(a.id, {
          id: a.id, x: cx + PAD + c * SLOT_W, y: cy + HEADER + r * SLOT_H, w: SLOT_W, h: SLOT_H,
          kind: a.kind === 'main' ? 'boss' : 'desk', zoneKey: key,
        });
      });
    });
    cx += w + GAP;
    lineH = Math.max(lineH, h);
  }

  return { zones, slots, width: worldW, height: cy + lineH + MARGIN + 8, door };
}

// ---------------- Oficina de un proyecto: cada equipo con su orquestador ----------------

export function computeProject(agents: Agent[], worldW: number): Layout {
  const zones: Zone[] = [];
  const slots = new Map<string, Slot>();
  const zoneX = MARGIN;
  const zoneW = Math.max(SLOT_W * 2 + 2 * PAD, worldW - 2 * MARGIN);
  const innerW = zoneW - 2 * PAD;
  const deskCols = Math.max(1, Math.min(8, Math.floor(innerW / SLOT_W)));
  const loungeCols = Math.max(1, Math.floor(innerW / LOUNGE_W));
  let y = WALL_H + 14;

  const rank = (t: Agent[]) => Math.min(...t.map((a) => STATUS_RANK[a.status]));
  const teams = [...groupTeams(agents).entries()].sort(
    ([, a], [, b]) => rank(a) - rank(b) || Math.max(...b.map((x) => x.lastActivityAt)) - Math.max(...a.map((x) => x.lastActivityAt)),
  );

  for (const [sessionId, members] of teams) {
    const boss = members.find((a) => a.kind === 'main');
    const active = members.filter((a) => a.kind === 'subagent' && a.status !== 'done').sort(byStart);
    const done = members
      .filter((a) => a.kind === 'subagent' && a.status === 'done')
      .sort((a, b) => (a.endedAt ?? a.lastActivityAt) - (b.endedAt ?? b.lastActivityAt));

    const zone: Zone = {
      key: sessionId,
      name: boss?.title ?? 'Sesión ' + sessionId.slice(0, 8),
      x: zoneX, y, w: zoneW, h: 0,
      color: rugColor(sessionId),
      kind: 'team',
      doneCount: done.length,
      bossId: boss?.id,
      memberIds: active.map((a) => a.id),
    };
    let cy = y + HEADER;

    // Escritorio del orquestador, centrado.
    if (boss) {
      slots.set(boss.id, { id: boss.id, x: zoneX + (zoneW - SLOT_W) / 2, y: cy, w: SLOT_W, h: SLOT_H, kind: 'boss', zoneKey: sessionId });
    }
    cy += SLOT_H + (active.length ? 10 : 0); // hueco para los cables

    // Subagentes trabajando, en filas centradas.
    for (let i = 0; i < active.length; i += deskCols) {
      const row = active.slice(i, i + deskCols);
      const rowX = zoneX + (zoneW - row.length * SLOT_W) / 2;
      row.forEach((a, c) => slots.set(a.id, { id: a.id, x: rowX + c * SLOT_W, y: cy, w: SLOT_W, h: SLOT_H, kind: 'desk', zoneKey: sessionId }));
      cy += SLOT_H;
    }
    if (!active.length && done.length) cy += 4;

    // Zona de terminados.
    if (done.length) {
      zone.loungeY = cy;
      cy += 12;
      for (let i = 0; i < done.length; i += loungeCols) {
        const row = done.slice(i, i + loungeCols);
        row.forEach((a, c) => slots.set(a.id, { id: a.id, x: zoneX + PAD + c * LOUNGE_W, y: cy, w: LOUNGE_W, h: LOUNGE_H, kind: 'lounge', zoneKey: sessionId }));
        cy += LOUNGE_H;
      }
    }
    zone.h = cy - y + PAD;
    zones.push(zone);
    y += zone.h + GAP;
  }

  return { zones, slots, width: worldW, height: y + MARGIN, door };
}
