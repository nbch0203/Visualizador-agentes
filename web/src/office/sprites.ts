// Sprites pixel-art definidos en código (sin assets externos).
// Cada carácter de una matriz es un píxel; '.' es transparente.

import { hash } from '../ui.ts';

export interface Look {
  hair: string;
  skin: string;
  shirt: string;
  shirtDark: string;
  pants: string;
  shoes: string;
}

const HAIR = ['#2b1d14', '#503a2a', '#8a5a2b', '#d9b26f', '#1f1f2e', '#7a2e2e', '#bfbfbf', '#e07b39'];
const SKIN = ['#f2c79b', '#e0ac7e', '#c68642', '#8d5524', '#f5d6c6', '#d99e74'];
const SHIRT = ['#5b8def', '#ef6b5b', '#4cc38a', '#b26be8', '#f2a541', '#3fb6c6', '#e45ca5', '#8bc34a', '#7c83fd', '#ff8a65'];
const PANTS = ['#2f3650', '#3b3b3b', '#4a3b2a', '#1e3a5f', '#40304f'];

export function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  const r = ch((n >> 16) & 255), g = ch((n >> 8) & 255), b = ch(n & 255);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

// Desatura un color hacia gris (para agentes que ya terminaron).
function desaturate(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const l = 0.3 * r + 0.59 * g + 0.11 * b;
  const mix = (v: number) => Math.round((v * 0.15 + l * 0.85) * 0.8);
  return '#' + ((1 << 24) | (mix(r) << 16) | (mix(g) << 8) | mix(b)).toString(16).slice(1);
}

const grayCache = new Map<Look, Look>();
export function grayLook(look: Look): Look {
  let g = grayCache.get(look);
  if (!g) {
    g = {
      hair: desaturate(look.hair), skin: desaturate(look.skin), shirt: desaturate(look.shirt),
      shirtDark: desaturate(look.shirtDark), pants: desaturate(look.pants), shoes: desaturate(look.shoes),
    };
    grayCache.set(look, g);
  }
  return g;
}

export function lookFor(id: string): Look {
  const h = hash(id);
  const shirt = SHIRT[h % SHIRT.length];
  return {
    hair: HAIR[(h >>> 4) % HAIR.length],
    skin: SKIN[(h >>> 8) % SKIN.length],
    shirt,
    shirtDark: shade(shirt, 0.72),
    pants: PANTS[(h >>> 12) % PANTS.length],
    shoes: '#2a2321',
  };
}

// ---- matrices de personaje (12 x 16) ----

const FACE_FRONT = [
  '...hhhhhh...',
  '..hhhhhhhh..',
  '..hssssssh..',
  '..ssessess..',
  '..ssssssss..',
  '...ssmmss...',
  '....ssss....',
];
const FACE_SLEEP = [
  '...hhhhhh...',
  '..hhhhhhhh..',
  '..hssssssh..',
  '..ssssssss..',
  '..seessees..',
  '...ssssss...',
  '....ssss....',
];
const FACE_BACK = [
  '...hhhhhh...',
  '..hhhhhhhh..',
  '..hhhhhhhh..',
  '..hhhhhhhh..',
  '..hhhhhhhh..',
  '...shhhhs...',
  '....ssss....',
];
const FACE_SIDE = [
  '...hhhhhh...',
  '..hhhhhhhh..',
  '..hhhhssss..',
  '..hhhsssess.',
  '..hhssssss..',
  '...sssssm...',
  '....ssss....',
];
const BODY_FRONT = [
  '..dccccccd..',
  '.dccccccccd.',
  '.sccccccccs.',
  '.sccccccccs.',
  '..cccccccc..',
];
const BODY_SIT = [
  '..dccccccd..',
  '.dccccccccd.',
  '.dccccccccd.',
  '.dccccccccd.',
  '..cccccccc..',
];
const BODY_SIDE = [
  '...dcccccd..',
  '...cccccc...',
  '...ccsccc...',
  '...ccsccc...',
  '...cccccc...',
];
const LEGS_STAND = ['..pppppppp..', '..ppp..ppp..', '..ppp..ppp..', '..kkk..kkk..'];
const LEGS_WALK_A = ['..pppppppp..', '..ppp..ppp..', '..kkk..ppp..', '.......kkk..'];
const LEGS_WALK_B = ['..pppppppp..', '..ppp..ppp..', '..ppp..kkk..', '..kkk.......'];
const LEGS_SIDE_A = ['...pppppp...', '...pp..pp...', '..pp....pp..', '..kk....kk..'];
const LEGS_SIDE_B = ['...pppppp...', '....pppp....', '....pppp....', '....kkkk....'];

export type Pose = 'down' | 'up' | 'side' | 'sit' | 'sleep';

function matrixFor(pose: Pose, frame: number): string[] {
  const walk = frame % 2 === 0 ? LEGS_WALK_A : LEGS_WALK_B;
  switch (pose) {
    case 'down':
      return [...FACE_FRONT, ...BODY_FRONT, ...(frame < 0 ? LEGS_STAND : walk)];
    case 'up':
      return [...FACE_BACK, ...BODY_FRONT, ...(frame < 0 ? LEGS_STAND : walk)];
    case 'side':
      return [...FACE_SIDE, ...BODY_SIDE, ...(frame % 2 === 0 ? LEGS_SIDE_A : LEGS_SIDE_B)];
    case 'sit':
      return [...FACE_FRONT, ...BODY_SIT, ...LEGS_STAND];
    case 'sleep':
      return [...FACE_SLEEP, ...BODY_SIT, ...LEGS_STAND];
  }
}

export const CHAR_W = 12;
export const CHAR_H = 16;

const cache = new Map<string, HTMLCanvasElement>();

function paint(rows: string[], colors: Record<string, string>, flip = false): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = rows[0].length;
  c.height = rows.length;
  const ctx = c.getContext('2d')!;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const col = colors[row[x]];
      if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(flip ? row.length - 1 - x : x, y, 1, 1);
    }
  });
  return c;
}

export function charSprite(look: Look, pose: Pose, frame: number, flip = false): HTMLCanvasElement {
  const key = `${look.hair}${look.skin}${look.shirt}${look.pants}|${pose}|${frame}|${flip}`;
  let c = cache.get(key);
  if (!c) {
    c = paint(matrixFor(pose, frame), {
      h: look.hair,
      s: look.skin,
      e: '#1b1b1b',
      m: shade(look.skin, 0.75),
      c: look.shirt,
      d: look.shirtDark,
      p: look.pants,
      k: look.shoes,
    }, flip);
    cache.set(key, c);
  }
  return c;
}

// ---- iconos de burbuja (5 x 5) ----
const ICONS: Record<string, string[]> = {
  '!': ['..x..', '..x..', '..x..', '.....', '..x..'],
  '…': ['.....', '.....', '.....', '.....', 'x.x.x'],
  '?': ['.xxx.', '...x.', '..x..', '.....', '..x..'],
  ok: ['.....', '....x', '...x.', 'x.x..', '.x...'],
  x: ['x...x', '.x.x.', '..x..', '.x.x.', 'x...x'],
  z: ['xxxx.', '..x..', '.x...', 'xxxx.', '.....'],
  gear: ['.x.x.', 'xxxxx', '.x.x.', 'xxxxx', '.x.x.'],
};

export function icon(name: keyof typeof ICONS | string, color: string): HTMLCanvasElement {
  const key = `icon|${name}|${color}`;
  let c = cache.get(key);
  if (!c) {
    c = paint(ICONS[name] ?? ICONS['?'], { x: color });
    cache.set(key, c);
  }
  return c;
}

// ---- planta decorativa (8 x 12) ----
const PLANT = [
  '..g..g..',
  '.gGg.gg.',
  'gGgGgGg.',
  '.gGgGgGg',
  'gGgggGg.',
  '.gGgGg..',
  '..gGg...',
  '...t....',
  '.bbbbbb.',
  '.BbbbbB.',
  '..BbbB..',
  '..BBBB..',
];
export function plantSprite(): HTMLCanvasElement {
  let c = cache.get('plant');
  if (!c) {
    c = paint(PLANT, { g: '#3f9b4a', G: '#2f7a3a', t: '#6b4a2b', b: '#c46a3a', B: '#9c4f28' });
    cache.set('plant', c);
  }
  return c;
}
