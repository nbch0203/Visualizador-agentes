import type { Agent } from '../../../shared/types.ts';
import { ACTIVITY_LABEL, STATUS_COLOR, STATUS_LABEL, hash } from '../ui.ts';
import { computeOverview, computeProject, WALL_H, type Layout, type Slot, type Zone } from './layout.ts';
import { CHAR_W, charSprite, grayLook, icon, lookFor, plantSprite, shade, type Look, type Pose } from './sprites.ts';

type Pt = { x: number; y: number };

interface Char {
  id: string;
  look: Look;
  x: number;
  y: number;
  path: Pt[];
  mode: 'walking' | 'seated' | 'leaving';
  dir: 'down' | 'up' | 'left' | 'right';
  seat?: Pt;
  alpha: number;
}

export interface Hit {
  agentId?: string;
  zoneKey?: string;
}

const SPEED = 46; // px de mundo por segundo
const DONE_LINGER_MS = 3500; // en el edificio, cuánto se queda un subagente terminado antes de irse
const FONT = '"Silkscreen", "Courier New", monospace';

function seatOf(s: Slot): Pt {
  if (s.kind === 'lounge') return { x: s.x + (s.w - CHAR_W) / 2, y: s.y + 12 };
  return { x: s.x + (s.w - CHAR_W) / 2, y: s.y + 16 };
}

export class OfficeScene {
  layout: Layout = computeOverview([], [], 400);
  private agents = new Map<string, Agent>();
  private chars = new Map<string, Char>();
  private doneSeen = new Map<string, number>();
  private lastStatus = new Map<string, string>();
  private initialized = false;
  private snap = false; // colocar a todos en su sitio sin caminar (al cambiar de vista)
  private worldW = 400;
  private projectKey?: string;
  showDone = false;
  selectedId?: string;
  hoverId?: string;
  hoverZone?: string;

  setWorldWidth(w: number) {
    if (Math.abs(w - this.worldW) < 1) return;
    this.worldW = w;
    this.snap = true;
    this.relayout();
  }

  snapAll() {
    this.snap = true;
    this.relayout();
  }

  // undefined = edificio con todas las salas; una clave = oficina de ese proyecto.
  setProject(key: string | undefined) {
    if (key === this.projectKey) return;
    this.projectKey = key;
    this.chars.clear();
    this.snap = true;
    this.relayout();
  }

  setAgents(list: Agent[], ready: boolean) {
    this.agents = new Map(list.map((a) => [a.id, a]));
    const now = Date.now();
    for (const a of list) {
      // Solo cuenta como "acaba de terminar" si lo vimos trabajando antes; si ya llegó terminado
      // (p. ej. al volver al edificio desde otro proyecto) no se queda a despedirse.
      const prev = this.lastStatus.get(a.id);
      if (a.status === 'done' && !this.doneSeen.has(a.id)) this.doneSeen.set(a.id, this.initialized && prev && prev !== 'done' ? now : 0);
      if (a.status !== 'done') this.doneSeen.delete(a.id);
      this.lastStatus.set(a.id, a.status);
    }
    if (this.lastStatus.size > 5000) this.lastStatus.clear();
    this.relayout();
    if (ready) this.initialized = true;
  }

  // En el edificio solo ocupan escritorio los activos; en la oficina de un proyecto, todos
  // (los terminados van a la zona de descanso).
  private seated(): Agent[] {
    const all = [...this.agents.values()];
    if (this.projectKey) return all.filter((a) => a.projectKey === this.projectKey);
    const now = Date.now();
    return all.filter((a) => {
      if (a.status !== 'done' || this.showDone) return true;
      return now - (this.doneSeen.get(a.id) ?? 0) < DONE_LINGER_MS;
    });
  }

  relayout() {
    const seated = this.seated();
    this.layout = this.projectKey
      ? computeProject(seated, this.worldW)
      : computeOverview(seated, [...this.agents.values()], this.worldW);
    const door = this.doorSpot();
    const instant = !this.initialized || this.snap;
    this.snap = false;
    for (const [id, slot] of this.layout.slots) {
      const seat = seatOf(slot);
      let c = this.chars.get(id);
      if (!c) {
        const look = lookFor(id);
        c = instant
          ? { id, look, x: seat.x, y: seat.y, path: [], mode: 'seated', dir: 'down', seat, alpha: 1 }
          : { id, look, x: door.x, y: door.y, path: route(door, seat, seat.y - 14), mode: 'walking', dir: 'down', seat, alpha: 0 };
        this.chars.set(id, c);
      } else if (instant) {
        Object.assign(c, { x: seat.x, y: seat.y, path: [], mode: 'seated', seat, alpha: 1 });
      } else if (c.mode === 'leaving' || !c.seat || c.seat.x !== seat.x || c.seat.y !== seat.y) {
        c.seat = seat;
        c.mode = 'walking';
        c.alpha = Math.max(c.alpha, 0.2);
        c.path = route(c, seat, Math.min(c.y, seat.y) - 14);
      }
    }
    for (const c of this.chars.values()) {
      if (this.layout.slots.has(c.id) || c.mode === 'leaving') continue;
      if (instant) {
        this.chars.delete(c.id);
        continue;
      }
      c.mode = 'leaving';
      c.seat = undefined;
      c.path = route(c, door, Math.max(WALL_H + 2, c.y - 14));
    }
  }

  private doorSpot(): Pt {
    const d = this.layout.door;
    return { x: d.x + (d.w - CHAR_W) / 2, y: d.y + 8 };
  }

  update(dt: number) {
    if (!this.projectKey) {
      // En el edificio, los subagentes terminados se van pasado un momento.
      const now = Date.now();
      for (const [id, seen] of this.doneSeen) {
        if (!this.showDone && this.layout.slots.has(id) && now - seen >= DONE_LINGER_MS) {
          this.relayout();
          break;
        }
      }
    }
    for (const c of [...this.chars.values()]) {
      if (c.mode === 'seated') continue;
      let step = SPEED * dt;
      while (step > 0 && c.path.length) {
        const t = c.path[0];
        const dx = t.x - c.x, dy = t.y - c.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 0.01) c.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
        if (dist <= step) {
          c.x = t.x;
          c.y = t.y;
          c.path.shift();
          step -= dist;
        } else {
          c.x += (dx / dist) * step;
          c.y += (dy / dist) * step;
          step = 0;
        }
      }
      if (c.mode === 'walking') c.alpha = Math.min(1, c.alpha + dt * 3);
      if (!c.path.length) {
        if (c.mode === 'walking') {
          c.mode = 'seated';
          c.dir = 'down';
        } else if (c.mode === 'leaving') {
          c.alpha -= dt * 3;
          if (c.alpha <= 0) this.chars.delete(c.id);
        }
      }
    }
  }

  hitTest(wx: number, wy: number): Hit {
    const hit: Hit = {};
    for (const s of this.layout.slots.values()) {
      if (wx >= s.x && wx < s.x + s.w && wy >= s.y && wy < s.y + s.h) {
        hit.agentId = s.id;
        break;
      }
    }
    if (!this.projectKey) {
      const z = this.layout.zones.find((z) => wx >= z.x && wx < z.x + z.w && wy >= z.y && wy < z.y + z.h);
      if (z) hit.zoneKey = z.key;
    }
    return hit;
  }

  // ---------------- dibujo ----------------

  render(ctx: CanvasRenderingContext2D, viewW: number, viewH: number, t: number) {
    const H = Math.max(viewH, this.layout.height);
    ctx.imageSmoothingEnabled = false;
    drawFloor(ctx, viewW, H);
    drawWall(ctx, viewW, this.layout.door, t);
    for (const z of this.layout.zones) {
      if (z.kind === 'room') drawRoom(ctx, z, z.key === this.hoverZone);
      else this.drawTeam(ctx, z, t);
    }

    const slots = [...this.layout.slots.values()].sort((a, b) => a.y - b.y || a.x - b.x);
    for (const s of slots) {
      if (s.kind === 'lounge') this.drawLounge(ctx, s);
      else this.drawStation(ctx, s, t);
    }

    const walkers = [...this.chars.values()].filter((c) => c.mode !== 'seated').sort((a, b) => a.y - b.y);
    for (const c of walkers) this.drawWalker(ctx, c, t);

    for (const s of slots) this.drawOverlay(ctx, s, t);
    if (this.hoverId) this.drawTooltip(ctx, this.hoverId, viewW);

    if (this.layout.slots.size === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.font = `8px ${FONT}`;
      ctx.textAlign = 'center';
      const msg = this.projectKey ? 'Este proyecto no tiene agentes ahora mismo' : 'Oficina vacía: no hay sesiones de Claude activas';
      ctx.fillText(msg, viewW / 2, WALL_H + 50);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = `6px ${FONT}`;
      ctx.fillText('Abre Claude Code en cualquier proyecto y aparecerá aquí', viewW / 2, WALL_H + 62);
    }
  }

  // Sala de un equipo: alfombra, cartel con la sesión y cables del orquestador a sus subagentes.
  private drawTeam(ctx: CanvasRenderingContext2D, z: Zone, t: number) {
    ctx.fillStyle = shade(z.color, 0.7);
    ctx.fillRect(z.x - 1, z.y - 1, z.w + 2, z.h + 2);
    ctx.fillStyle = z.color;
    ctx.fillRect(z.x, z.y, z.w, z.h);
    rugDots(ctx, z.x, z.y + 18, z.w, z.h - 20, shade(z.color, 1.12));

    ctx.font = `7px ${FONT}`;
    const activeSubs = z.memberIds?.length ?? 0;
    const doneSubs = z.doneCount ?? 0;
    const label = fit(ctx, `★ ${z.name}`, z.w - 110);
    sign(ctx, z.x + 4, z.y + 3, label);
    ctx.font = `5px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(241,245,249,0.75)';
    ctx.fillText(
      `${activeSubs} subagente${activeSubs === 1 ? '' : 's'} activo${activeSubs === 1 ? '' : 's'} · ${doneSubs} terminado${doneSubs === 1 ? '' : 's'}`,
      z.x + z.w - 6, z.y + 11,
    );

    // Cables por el suelo del orquestador a cada subagente activo (con un pulso si trabaja).
    const bossSlot = z.bossId ? this.layout.slots.get(z.bossId) : undefined;
    if (bossSlot) {
      const bx = bossSlot.x + bossSlot.w / 2;
      const by = bossSlot.y + bossSlot.h - 1;
      for (const id of z.memberIds ?? []) {
        const s = this.layout.slots.get(id);
        const a = this.agents.get(id);
        if (!s || !a) continue;
        const sx = s.x + s.w / 2;
        const sy = s.y + 3;
        const midY = by + (sy - by) / 2;
        const col = a.status === 'working' ? '#93c5fd' : a.status === 'waiting_permission' ? '#fbbf24' : 'rgba(226,232,240,0.35)';
        ctx.fillStyle = 'rgba(15,23,42,0.35)';
        cable(ctx, bx, by, sx, sy, midY, 2);
        ctx.fillStyle = col;
        cable(ctx, bx, by, sx, sy, midY, 1);
        if (a.status === 'working') {
          // pulso viajando por el cable
          const len = Math.abs(midY - by) + Math.abs(sx - bx) + Math.abs(sy - midY);
          const d = ((t * 40 + (hash(id) % 50)) % len);
          const p = alongCable(bx, by, sx, sy, midY, d);
          ctx.fillStyle = '#f8fafc';
          ctx.fillRect(Math.round(p.x) - 1, Math.round(p.y) - 1, 2, 2);
        }
      }
    }

    // Zona de terminados
    if (z.loungeY !== undefined) {
      ctx.fillStyle = shade(z.color, 0.82);
      ctx.fillRect(z.x + 4, z.loungeY, z.w - 8, z.y + z.h - z.loungeY - 4);
      ctx.font = `5px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillStyle = '#ddd6fe';
      ctx.fillText(`✓ TERMINADOS (${z.doneCount})`, z.x + 8, z.loungeY + 8);
      // máquina de café decorativa
      const mx = z.x + z.w - 16, my = z.loungeY + 1;
      ctx.fillStyle = '#475569';
      ctx.fillRect(mx, my, 8, 10);
      ctx.fillStyle = '#94a3b8';
      ctx.fillRect(mx + 1, my + 1, 6, 3);
      ctx.fillStyle = '#f87171';
      ctx.fillRect(mx + 2, my + 5, 1, 1);
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(mx + 3, my + 7, 2, 2);
    }
    if (z.w > 120) ctx.drawImage(plantSprite(), z.x + 4, z.y + 18);
  }

  private drawStation(ctx: CanvasRenderingContext2D, s: Slot, t: number) {
    const a = this.agents.get(s.id);
    const c = this.chars.get(s.id);
    const x = s.x, y = s.y;
    const boss = s.kind === 'boss';

    if (s.id === this.selectedId || s.id === this.hoverId) {
      ctx.fillStyle = s.id === this.selectedId ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.08)';
      ctx.fillRect(x + 1, y + 1, s.w - 2, s.h - 2);
    }
    if (a?.status === 'waiting_permission') {
      const pulse = 0.25 + 0.25 * Math.sin(t * 6);
      ctx.fillStyle = `rgba(251,191,36,${pulse})`;
      ctx.fillRect(x + 1, y + 1, s.w - 2, s.h - 2);
    }

    // Silla (el orquestador tiene sillón de respaldo alto)
    ctx.fillStyle = boss ? '#5b2333' : '#3d2f26';
    ctx.fillRect(x + 16, y + (boss ? 18 : 22), 20, boss ? 16 : 12);
    ctx.fillStyle = boss ? '#7f2f45' : '#54413a';
    ctx.fillRect(x + 17, y + (boss ? 19 : 23), 18, 3);

    const seated = c && c.mode === 'seated' && a;
    if (seated) this.drawSeated(ctx, a!, c!, t);
    const lit = seated && a!.status !== 'done'; // un agente terminado tiene el monitor apagado

    // Escritorio
    const dx = x + (boss ? 3 : 6), dy = y + 28, dw = boss ? 46 : 40;
    ctx.fillStyle = boss ? '#8a5a3c' : '#a8794f';
    ctx.fillRect(dx, dy, dw, 5);
    ctx.fillStyle = boss ? '#a8724d' : '#c08c5c';
    ctx.fillRect(dx, dy, dw, 1);
    ctx.fillStyle = boss ? '#5e3a24' : '#7a5434';
    ctx.fillRect(dx, dy + 5, dw, 8);
    ctx.fillStyle = '#4a2f1c';
    ctx.fillRect(dx + 2, dy + 13, 3, 3);
    ctx.fillRect(dx + dw - 5, dy + 13, 3, 3);
    if (boss) {
      // placa dorada con estrella
      ctx.fillStyle = '#facc15';
      ctx.fillRect(dx + dw / 2 - 6, dy + 7, 12, 4);
      ctx.fillStyle = '#854d0e';
      ctx.fillRect(dx + dw / 2 - 1, dy + 8, 2, 2);
    } else {
      ctx.fillStyle = '#6b4a2e';
      ctx.fillRect(dx + 14, dy + 7, 12, 4);
      ctx.fillStyle = '#d6b07a';
      ctx.fillRect(dx + 19, dy + 8, 2, 1);
    }

    // Monitores (el orquestador tiene dos)
    const working = seated && a!.status === 'working';
    const actColor = a ? activityColor(a) : '#334155';
    const monitor = (mx: number, glowRight: boolean) => {
      ctx.fillStyle = '#2b2f3a';
      ctx.fillRect(mx, y + 18, 11, 10);
      ctx.fillStyle = '#3a4050';
      ctx.fillRect(mx + 1, y + 19, 9, 8);
      ctx.fillStyle = '#2b2f3a';
      ctx.fillRect(mx + 4, y + 28, 4, 1);
      ctx.fillStyle = lit ? actColor : '#1e293b';
      ctx.fillRect(glowRight ? mx + 10 : mx, y + 19, 1, 8);
      ctx.fillStyle = lit ? (a!.status === 'waiting_permission' && Math.floor(t * 3) % 2 ? '#fde68a' : STATUS_COLOR[a!.status]) : '#475569';
      ctx.fillRect(mx + 2, y + 25, 2, 1);
    };
    monitor(x + 8, true);
    if (boss) monitor(x + 33, false);
    if (working && (a!.activity === 'typing' || a!.activity === 'running')) {
      ctx.globalAlpha = 0.1 + 0.05 * Math.sin(t * 8);
      ctx.fillStyle = actColor;
      ctx.beginPath();
      ctx.moveTo(x + 19, y + 19);
      ctx.lineTo(x + 25, y + 16);
      ctx.lineTo(x + 25, y + 30);
      ctx.lineTo(x + 19, y + 27);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Teclado
    ctx.fillStyle = '#cbd5e1';
    ctx.fillRect(x + 21, y + 29, 11, 2);
    if (working && (a!.activity === 'typing' || a!.activity === 'running')) {
      ctx.fillStyle = '#ffffff';
      const k = Math.floor(t * 12) % 5;
      ctx.fillRect(x + 22 + k * 2, y + 29, 1, 1);
    }

    // Taza (no cabe junto al segundo monitor del jefe)
    if (!boss) {
      ctx.fillStyle = ['#e2e8f0', '#f87171', '#60a5fa', '#facc15'][hash(s.id) % 4];
      ctx.fillRect(x + 38, y + 25, 4, 4);
      ctx.fillRect(x + 42, y + 26, 1, 2);
    }

    if (lit) this.drawHands(ctx, a!, c!, x, y, t);
  }

  private drawHands(ctx: CanvasRenderingContext2D, a: Agent, c: Char, x: number, y: number, t: number) {
    const act = a.status === 'working' ? a.activity : 'none';
    ctx.fillStyle = c.look.skin;
    if (act === 'typing' || act === 'running') {
      const f = Math.floor(t * (act === 'typing' ? 9 : 4)) % 2;
      ctx.fillRect(x + 22, y + 28 - f, 2, 2);
      ctx.fillRect(x + 29, y + 27 + f, 2, 2);
    } else if (act === 'reading') {
      const bob = Math.floor(t * 2) % 2;
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(x + 22, y + 21 + bob, 8, 7);
      ctx.fillStyle = '#94a3b8';
      ctx.fillRect(x + 23, y + 23 + bob, 6, 1);
      ctx.fillRect(x + 23, y + 25 + bob, 4, 1);
      ctx.fillStyle = c.look.skin;
      ctx.fillRect(x + 21, y + 25 + bob, 2, 2);
      ctx.fillRect(x + 29, y + 25 + bob, 2, 2);
    } else if (act === 'delegating') {
      const up = Math.floor(t * 4) % 2;
      ctx.fillRect(x + 33, y + 18 + up, 2, 3);
      ctx.fillRect(x + 22, y + 28, 2, 2);
    } else {
      ctx.fillRect(x + 22, y + 28, 2, 2);
      ctx.fillRect(x + 29, y + 28, 2, 2);
    }
  }

  // Subagente terminado: de pie en la zona de descanso.
  private drawLounge(ctx: CanvasRenderingContext2D, s: Slot) {
    const a = this.agents.get(s.id);
    const c = this.chars.get(s.id);
    if (s.id === this.selectedId || s.id === this.hoverId) {
      ctx.fillStyle = s.id === this.selectedId ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.08)';
      ctx.fillRect(s.x + 1, s.y + 1, s.w - 2, s.h - 2);
    }
    // cojín/puf
    ctx.fillStyle = 'rgba(15,23,42,0.25)';
    ctx.fillRect(s.x + 9, s.y + 27, 14, 3);
    if (c && c.mode === 'seated' && a) {
      // Apagado (gris y semitransparente) para que no se confunda con un agente activo.
      ctx.globalAlpha = 0.55;
      ctx.drawImage(charSprite(grayLook(c.look), 'down', -1), c.x, c.y);
      ctx.fillStyle = '#cbd5e1';
      ctx.fillRect(c.x + 10, c.y + 9, 2, 2); // taza de café
      ctx.globalAlpha = 1;
      doneBadge(ctx, c.x + 9, c.y - 3);
    }
  }

  private drawSeated(ctx: CanvasRenderingContext2D, a: Agent, c: Char, t: number) {
    const sleeping = a.status === 'idle';
    const pose: Pose = sleeping ? 'sleep' : 'sit';
    const bob = a.status === 'working' && a.activity === 'thinking' ? Math.floor(t * 2.5) % 2 : 0;
    const done = a.status === 'done';
    const sprite = charSprite(done ? grayLook(c.look) : c.look, pose, 0);
    ctx.globalAlpha = done ? 0.55 : a.status === 'stale' ? 0.7 : 1;
    ctx.drawImage(sprite, 0, 0, sprite.width, 12, c.x, c.y + bob, sprite.width, 12);
    ctx.globalAlpha = 1;
    if (a.kind === 'subagent') {
      ctx.fillStyle = '#fef3c7';
      ctx.fillRect(c.x + 9, c.y + 8 + bob, 2, 2);
    }
  }

  private drawWalker(ctx: CanvasRenderingContext2D, c: Char, t: number) {
    const frame = Math.floor(t * 8) % 2;
    const pose: Pose = c.dir === 'up' ? 'up' : c.dir === 'down' ? 'down' : 'side';
    const sprite = charSprite(c.look, pose, frame, c.dir === 'left');
    ctx.globalAlpha = Math.max(0, Math.min(1, c.alpha));
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(Math.round(c.x) + 2, Math.round(c.y) + 15, 8, 2);
    ctx.drawImage(sprite, Math.round(c.x), Math.round(c.y));
    ctx.globalAlpha = 1;
  }

  private drawOverlay(ctx: CanvasRenderingContext2D, s: Slot, t: number) {
    const a = this.agents.get(s.id);
    const c = this.chars.get(s.id);
    if (!a) return;
    const cx = s.x + s.w / 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    if (s.kind === 'lounge') {
      ctx.font = `4px ${FONT}`;
      ctx.fillStyle = 'rgba(203,213,225,0.7)';
      ctx.fillText(fit(ctx, a.agentType ?? 'sub', s.w - 2), cx, s.y + 35);
      ctx.fillStyle = 'rgba(148,163,184,0.6)';
      ctx.fillText(fit(ctx, a.description ?? a.title, s.w - 2), cx, s.y + 41);
      return;
    }

    // Etiquetas bajo el escritorio (el orquestador, solo en su oficina, tiene sitio de sobra)
    const labelW = s.kind === 'boss' && this.projectKey ? 150 : s.w - 2;
    ctx.font = `6px ${FONT}`;
    const name = s.kind === 'boss' ? `★ ${a.title}` : a.kind === 'main' ? a.title : a.agentType ?? a.title;
    ctx.fillStyle = a.status === 'done' ? 'rgba(203,213,225,0.6)' : s.kind === 'boss' ? '#f8fafc' : '#fde68a';
    ctx.fillText(fit(ctx, name, labelW), cx, s.y + 52);
    ctx.font = `5px ${FONT}`;
    ctx.fillStyle = STATUS_COLOR[a.status];
    ctx.fillText(fit(ctx, statusLine(a, s.kind === 'boss' && !!this.projectKey), labelW), cx, s.y + 60);
    if (a.kind === 'subagent' && a.description) {
      ctx.fillStyle = 'rgba(226,232,240,0.6)';
      ctx.fillText(fit(ctx, a.description, s.w - 2), cx, s.y + 67);
    }

    if (!c || c.mode !== 'seated') return;
    const bx = c.x + 3, by = c.y - 12;
    switch (a.status) {
      case 'waiting_permission':
        bubble(ctx, bx, by, Math.floor(t * 3) % 2 ? '#fbbf24' : '#fde68a', icon('!', '#7c2d12'));
        break;
      case 'waiting_input':
        bubble(ctx, bx, by, '#f8fafc', icon('…', '#2563eb'));
        break;
      case 'error':
        bubble(ctx, bx, by, '#fecaca', icon('x', '#b91c1c'));
        break;
      case 'done':
        doneBadge(ctx, c.x + 9, c.y - 3);
        break;
      case 'stale':
        bubble(ctx, bx, by, '#e7e5e4', icon('?', '#57534e'));
        break;
      case 'idle': {
        const f = (t * 0.8) % 1;
        ctx.globalAlpha = 1 - f;
        ctx.drawImage(icon('z', '#cbd5e1'), c.x + 9 + f * 4, c.y - 2 - f * 8);
        ctx.globalAlpha = 1;
        break;
      }
      case 'working':
        if (a.activity === 'thinking') {
          const n = Math.floor(t * 3) % 4;
          ctx.fillStyle = '#e2e8f0';
          for (let i = 0; i < n; i++) ctx.fillRect(c.x + 3 + i * 3, c.y - 4, 2, 2);
        } else if (a.activity === 'running') {
          if (Math.floor(t * 2) % 2) ctx.drawImage(icon('gear', '#67e8f9'), c.x + 3, c.y - 8);
        }
        break;
    }
  }

  private drawTooltip(ctx: CanvasRenderingContext2D, id: string, viewW: number) {
    const a = this.agents.get(id);
    const s = this.layout.slots.get(id);
    if (!a || !s) return;
    const lines = [
      a.kind === 'subagent' ? `${a.agentType ?? 'Subagente'}: ${a.description ?? a.title}` : a.title,
      `${STATUS_LABEL[a.status]}${a.status === 'working' && a.activity !== 'none' ? ' · ' + ACTIVITY_LABEL[a.activity] : ''}`,
      ...a.currentTools.slice(-2).map((x) => `${x.name}: ${x.summary}`),
    ];
    ctx.font = `6px ${FONT}`;
    const w = Math.min(180, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 8);
    const h = lines.length * 8 + 4;
    let x = s.x + s.w / 2 - w / 2;
    x = Math.max(2, Math.min(viewW - w - 2, x));
    const y = Math.max(2, s.y - h + 4);
    ctx.fillStyle = 'rgba(15,23,42,0.94)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = STATUS_COLOR[a.status];
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.textAlign = 'left';
    lines.forEach((l, i) => {
      ctx.fillStyle = i === 0 ? '#f8fafc' : i === 1 ? STATUS_COLOR[a.status] : '#cbd5e1';
      ctx.fillText(fit(ctx, l, w - 8), x + 4, y + 9 + i * 8);
    });
  }
}

// ---------------- utilidades de dibujo ----------------

function route(from: Pt, to: Pt, laneY: number): Pt[] {
  return [
    { x: from.x, y: laneY },
    { x: to.x, y: laneY },
    { x: to.x, y: to.y },
  ];
}

function cable(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, midY: number, w: number) {
  const o = Math.floor(w / 2);
  ctx.fillRect(Math.round(x1) - o, Math.round(Math.min(y1, midY)), w, Math.round(Math.abs(midY - y1)) + 1);
  ctx.fillRect(Math.round(Math.min(x1, x2)) - o, Math.round(midY) - o, Math.round(Math.abs(x2 - x1)) + w, w);
  ctx.fillRect(Math.round(x2) - o, Math.round(Math.min(midY, y2)), w, Math.round(Math.abs(y2 - midY)) + 1);
}

function alongCable(x1: number, y1: number, x2: number, y2: number, midY: number, d: number): Pt {
  const l1 = Math.abs(midY - y1);
  if (d <= l1) return { x: x1, y: y1 + Math.sign(midY - y1) * d };
  d -= l1;
  const l2 = Math.abs(x2 - x1);
  if (d <= l2) return { x: x1 + Math.sign(x2 - x1) * d, y: midY };
  d -= l2;
  return { x: x2, y: midY + Math.sign(y2 - midY) * d };
}

function activityColor(a: Agent): string {
  if (a.status !== 'working') return STATUS_COLOR[a.status];
  return { typing: '#4ade80', reading: '#38bdf8', running: '#67e8f9', delegating: '#f0abfc', thinking: '#e2e8f0', none: '#4ade80' }[a.activity];
}

function statusLine(a: Agent, long = false): string {
  if (a.status === 'working') {
    const tool = a.currentTools[a.currentTools.length - 1];
    if (tool) return `${tool.name} ${tool.summary}`;
    if (a.waitingOn) {
      return long
        ? `Coordinando: espera a ${a.waitingOn} subagente${a.waitingOn === 1 ? '' : 's'}`
        : `Coordina ${a.waitingOn} sub${a.waitingOn === 1 ? '' : 's'}`;
    }
    return ACTIVITY_LABEL[a.activity] || STATUS_LABEL.working;
  }
  if (a.status === 'waiting_permission') {
    const tool = a.currentTools[a.currentTools.length - 1];
    return tool ? `¿Permiso? ${tool.name}` : STATUS_LABEL.waiting_permission;
  }
  return STATUS_LABEL[a.status];
}

function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + '…').width <= max) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + '…';
}

function bubble(ctx: CanvasRenderingContext2D, x: number, y: number, fill: string, ic: HTMLCanvasElement) {
  x = Math.round(x);
  y = Math.round(y);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(x - 1, y, 9, 9);
  ctx.fillRect(x, y - 1, 7, 11);
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, 7, 9);
  ctx.fillRect(x + 2, y + 9, 2, 1);
  ctx.drawImage(ic, x + 1, y + 2);
}

// Marca pequeña de "terminado" (en vez de una burbuja, que se asocia a agentes activos).
function doneBadge(ctx: CanvasRenderingContext2D, x: number, y: number) {
  x = Math.round(x);
  y = Math.round(y);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(x - 1, y - 1, 7, 7);
  ctx.fillStyle = '#4ade80';
  ctx.fillRect(x, y, 5, 5);
  ctx.drawImage(icon('ok', '#14532d'), x, y);
}

function sign(ctx: CanvasRenderingContext2D, x: number, y: number, label: string) {
  const lw = ctx.measureText(label).width + 8;
  ctx.fillStyle = '#1e1b2e';
  ctx.fillRect(x, y, lw, 10);
  ctx.fillStyle = '#f1f5f9';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(label, x + 4, y + 8);
  return lw;
}

function rugDots(ctx: CanvasRenderingContext2D, x0: number, y0: number, w: number, h: number, color: string) {
  ctx.fillStyle = color;
  for (let y = y0; y < y0 + h; y += 6) {
    for (let x = x0 + ((y / 6) % 2 ? 3 : 0) + 2; x < x0 + w - 2; x += 6) ctx.fillRect(x, y, 1, 1);
  }
}

function drawFloor(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle = '#6b5440';
  ctx.fillRect(0, 0, w, h);
  for (let y = WALL_H, row = 0; y < h; y += 8, row++) {
    ctx.fillStyle = row % 2 ? '#705843' : '#674f3c';
    ctx.fillRect(0, y, w, 8);
    ctx.fillStyle = '#5a4433';
    ctx.fillRect(0, y + 7, w, 1);
    for (let x = (row % 3) * 13; x < w; x += 40) ctx.fillRect(x, y, 1, 7);
  }
}

function drawWall(ctx: CanvasRenderingContext2D, w: number, door: Layout['door'], t: number) {
  ctx.fillStyle = '#3a3f58';
  ctx.fillRect(0, 0, w, WALL_H);
  ctx.fillStyle = '#454b68';
  ctx.fillRect(0, 0, w, 3);
  ctx.fillStyle = '#2a2e40';
  ctx.fillRect(0, WALL_H - 3, w, 3);

  for (let x = door.x + door.w + 30; x + 28 < w - 50; x += 84) {
    ctx.fillStyle = '#23263a';
    ctx.fillRect(x - 1, 7, 30, 19);
    ctx.fillStyle = '#7fb2e5';
    ctx.fillRect(x, 8, 28, 17);
    ctx.fillStyle = '#a9cdf0';
    ctx.fillRect(x, 8, 28, 6);
    ctx.fillStyle = '#23263a';
    ctx.fillRect(x + 13, 8, 2, 17);
    ctx.fillRect(x, 15, 28, 1);
    ctx.fillStyle = '#f8fafc';
    const cloud = ((t * 3 + x) % 40) - 6;
    if (cloud > 0 && cloud < 22) ctx.fillRect(x + cloud, 11, 6, 2);
  }

  const cx = w - 28, cy = 16;
  ctx.fillStyle = '#e2e8f0';
  ctx.beginPath();
  ctx.arc(cx, cy, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 1;
  ctx.stroke();
  const d = new Date();
  const hand = (ang: number, len: number) => {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.sin(ang) * len, cy - Math.cos(ang) * len);
    ctx.stroke();
  };
  hand(((d.getHours() % 12) + d.getMinutes() / 60) * (Math.PI / 6), 4);
  hand(d.getMinutes() * (Math.PI / 30), 6);

  ctx.fillStyle = '#4a3324';
  ctx.fillRect(door.x - 2, door.y - 2, door.w + 4, door.h + 2);
  ctx.fillStyle = '#7a5434';
  ctx.fillRect(door.x, door.y, door.w, door.h);
  ctx.fillStyle = '#8f6440';
  ctx.fillRect(door.x + 3, door.y + 3, door.w - 6, 8);
  ctx.fillRect(door.x + 3, door.y + 14, door.w - 6, 9);
  ctx.fillStyle = '#facc15';
  ctx.fillRect(door.x + door.w - 5, door.y + 13, 2, 2);
  ctx.fillStyle = '#9ca3af';
  ctx.fillRect(door.x - 4, WALL_H, door.w + 8, 3);
}

// Sala de un proyecto en el edificio (clicable para entrar).
function drawRoom(ctx: CanvasRenderingContext2D, z: Zone, hover: boolean) {
  ctx.fillStyle = hover ? '#f8fafc' : shade(z.color, 0.7);
  ctx.fillRect(z.x - 1, z.y - 1, z.w + 2, z.h + 2);
  ctx.fillStyle = hover ? shade(z.color, 1.15) : z.color;
  ctx.fillRect(z.x, z.y, z.w, z.h);
  rugDots(ctx, z.x, z.y + 18, z.w, z.h - 32, shade(z.color, 1.12));
  ctx.font = `7px ${FONT}`;
  const lw = sign(ctx, z.x + 4, z.y + 3, fit(ctx, z.name, z.w - 12));
  if (z.w > lw + 24) ctx.drawImage(plantSprite(), z.x + z.w - 11, z.y + 2);
  // pie de sala: resumen y llamada a entrar
  if (z.footer) {
    ctx.fillStyle = hover ? 'rgba(15,23,42,0.85)' : 'rgba(15,23,42,0.55)';
    ctx.fillRect(z.x + 3, z.y + z.h - 13, z.w - 6, 10);
    ctx.font = `5px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = hover ? '#fde68a' : 'rgba(241,245,249,0.85)';
    ctx.fillText(fit(ctx, z.footer, z.w - 10), z.x + z.w / 2, z.y + z.h - 6);
  }
}
