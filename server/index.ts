import crypto from 'node:crypto';
import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { WebSocketServer, WebSocket } from 'ws';
import type { ServerMessage } from '../shared/types.ts';
import { APP_DIR, HOST, PORT, SERVER_FILE, TOKEN_FILE, WEB_DIST } from './config.ts';
import { hooksStatus, installHooks, uninstallHooks } from './hooks/installer.ts';
import { AgentStore, type HookPayload } from './runtime/store.ts';
import { TranscriptScanner } from './transcripts/scanner.ts';

function loadToken(): string {
  fs.mkdirSync(APP_DIR, { recursive: true });
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t.length >= 32) return t;
  } catch {}
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  return t;
}

const token = loadToken();
const safeEq = (a: unknown) =>
  typeof a === 'string' && a.length === token.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(token));

const store = new AgentStore();
const scanner = new TranscriptScanner(store);
const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });

// Protección contra DNS rebinding y sitios externos: solo hosts/orígenes locales.
const LOCAL_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const isLocalOrigin = (origin: string | undefined) => {
  if (!origin) return true;
  try {
    return LOCAL_HOST_RE.test(new URL(origin).host);
  } catch {
    return false;
  }
};
app.addHook('onRequest', async (req, reply) => {
  if (HOST !== '0.0.0.0' && !LOCAL_HOST_RE.test(req.headers.host ?? '')) return reply.code(403).send('host');
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true });
const send = (ws: WebSocket, msg: ServerMessage) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
const broadcast = (msg: ServerMessage) => {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
};
const currentHooks = () => ({ ...hooksStatus(), lastHookAt: store.lastHookAt });

wss.on('connection', (ws) => {
  store.flush();
  send(ws, { type: 'snapshot', agents: store.list(), hooks: currentHooks(), now: Date.now() });
});

store.on('agent', (agent) => broadcast({ type: 'agent', agent }));
store.on('remove', (id) => broadcast({ type: 'remove', id }));
store.on('event', (event) => broadcast({ type: 'event', event }));

// ---------- API ----------
app.get('/api/agents', async () => store.list());

app.get<{ Params: { id: string } }>('/api/agents/:id/events', async (req, reply) => {
  if (!store.has(req.params.id)) return reply.code(404).send({ error: 'no existe' });
  return store.events(req.params.id);
});

app.get('/api/hooks', async () => currentHooks());

app.post('/api/hooks/event', async (req, reply) => {
  if (!safeEq(req.headers['x-va-token'])) return reply.code(401).send({ error: 'token' });
  const p = req.body as HookPayload;
  if (!p || typeof p.hook_event_name !== 'string' || typeof p.session_id !== 'string') {
    return reply.code(400).send({ error: 'payload' });
  }
  store.applyHook(p);
  store.flush();
  return { ok: true };
});

for (const action of ['install', 'uninstall'] as const) {
  app.post(`/api/hooks/${action}`, async (req, reply) => {
    if (!safeEq(req.headers['x-va-token'])) {
      return reply.code(401).send({ error: 'Abre la URL con ?token=… que imprime el servidor para gestionar los hooks.' });
    }
    try {
      const res = action === 'install' ? installHooks() : uninstallHooks();
      broadcast({ type: 'hooks', hooks: currentHooks() });
      return res;
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });
}

if (fs.existsSync(WEB_DIST)) {
  await app.register(fastifyStatic, { root: WEB_DIST });
} else {
  app.get('/', async (_req, reply) =>
    reply.type('text/html').send('<p>Falta compilar la web: ejecuta <code>npm run build</code> (o usa <code>npm run dev</code>).</p>'));
}

app.server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/ws') || !isLocalOrigin(req.headers.origin)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// ---------- arranque ----------
scanner.start();
setInterval(() => store.tick(), 1000);
setInterval(() => store.flush(), 150);
// Refrescar el estado de los hooks por si se cambian desde la CLI.
let lastHooksKey = '';
setInterval(() => {
  const h = currentHooks();
  const key = JSON.stringify(h);
  if (key !== lastHooksKey) {
    lastHooksKey = key;
    broadcast({ type: 'hooks', hooks: h });
  }
}, 5000);

try {
  await app.listen({ host: HOST, port: PORT });
} catch (err) {
  console.error(`No se pudo escuchar en ${HOST}:${PORT}:`, (err as Error).message);
  process.exit(1);
}
// En modo demo no anunciamos el servidor: los hooks reales deben seguir yendo al principal.
if (!process.env.VA_DEMO) fs.writeFileSync(SERVER_FILE, JSON.stringify({ host: '127.0.0.1', port: PORT, pid: process.pid }));

const shown = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
console.log(`\n  Visualizador de agentes listo`);
console.log(`  Ver:               http://${shown}:${PORT}/`);
console.log(`  Ver y gestionar:   http://${shown}:${PORT}/?token=${token}\n`);
