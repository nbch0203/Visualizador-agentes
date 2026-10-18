// Modo demo: simula sesiones y subagentes de Claude escribiendo transcripts falsos en una
// carpeta temporal y arranca otra instancia del servidor (puerto 4318) apuntando a ella.
// No toca ~/.claude ni el servidor principal.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.join(os.tmpdir(), 'visualizador-agentes-demo');
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT, 'projects'), { recursive: true });
process.env.CLAUDE_CONFIG_DIR = ROOT;
process.env.VA_PORT ??= '4318';
process.env.VA_DEMO = '1';
await import('../server/index.ts');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const uid = () => crypto.randomUUID();
const toolId = () => 'toolu_' + crypto.randomBytes(9).toString('hex');

class Transcript {
  constructor(readonly file: string, readonly base: Record<string, unknown>) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  write(rec: Record<string, unknown>) {
    fs.appendFileSync(this.file, JSON.stringify({ ...this.base, uuid: uid(), timestamp: new Date().toISOString(), ...rec }) + '\n');
  }
  prompt(text: string) {
    this.write({ type: 'user', message: { role: 'user', content: text } });
  }
  say(text: string, end = false) {
    this.write({ type: 'assistant', message: { model: 'claude-opus-5', role: 'assistant', stop_reason: end ? 'end_turn' : 'tool_use', content: [{ type: 'text', text }] } });
  }
  toolUse(name: string, input: Record<string, unknown>) {
    const id = toolId();
    this.write({ type: 'assistant', message: { model: 'claude-opus-5', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] } });
    return id;
  }
  toolResult(id: string, ok = true, extra: Record<string, unknown> = {}) {
    this.write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: ok ? 'ok' : 'Error: falló', is_error: !ok }] }, ...extra });
  }
}

const FILES = ['src/app.ts', 'src/routes/pagos.ts', 'README.md', 'src/db/schema.sql', 'test/api.test.ts', 'src/components/Carrito.tsx'];
const TOOLS: [string, () => Record<string, unknown>][] = [
  ['Read', () => ({ file_path: 'D:/demo/' + pick(FILES) })],
  ['Edit', () => ({ file_path: 'D:/demo/' + pick(FILES) })],
  ['Write', () => ({ file_path: 'D:/demo/' + pick(FILES) })],
  ['Grep', () => ({ pattern: pick(['TODO', 'useCart', 'stripe', 'fetchUser']) })],
  ['Bash', () => ({ command: 'npm test', description: pick(['Ejecutar tests', 'Instalar dependencias', 'Compilar el proyecto']) })],
  ['WebSearch', () => ({ query: 'stripe webhooks retries' })],
];

async function toolBurst(t: Transcript, n: number) {
  for (let i = 0; i < n; i++) {
    const [name, input] = pick(TOOLS);
    const id = t.toolUse(name, input());
    await sleep(rand(1200, name === 'Bash' ? 6000 : 3000));
    t.toolResult(id, Math.random() > 0.08);
  }
}

function session(project: string) {
  const sessionId = uid();
  const dir = path.join(ROOT, 'projects', 'D--' + project);
  const t = new Transcript(path.join(dir, sessionId + '.jsonl'), { sessionId, cwd: 'D:\\' + project, isSidechain: false });
  return { sessionId, dir, t };
}

async function subagent(s: ReturnType<typeof session>, type: string, description: string, background: boolean, steps: number) {
  const parentTool = s.t.toolUse('Agent', { subagent_type: type, description, prompt: description, run_in_background: background });
  const agentId = 'a' + crypto.randomBytes(8).toString('hex');
  const sub = path.join(s.dir, s.sessionId, 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: type, description, toolUseId: parentTool, spawnDepth: 1, requestShape: background ? 'background' : 'foreground' }));
  const st = new Transcript(path.join(sub, `agent-${agentId}.jsonl`), { sessionId: s.sessionId, agentId, isSidechain: true });
  if (background) s.t.toolResult(parentTool, true, { toolUseResult: { isAsync: true, status: 'async_launched', agentId } });
  const run = async () => {
    st.prompt(description);
    await toolBurst(st, steps);
    const h = st.toolUse('SubagentHandback', { message: 'Hecho' });
    await sleep(600);
    st.toolResult(h);
    if (!background) s.t.toolResult(parentTool, true, { toolUseResult: { status: 'completed', agentId } });
  };
  return background ? run() : await run();
}

// Tienda: principal que delega en subagentes en paralelo.
async function tienda() {
  const s = session('tienda-online');
  s.t.write({ type: 'ai-title', aiTitle: 'Rediseño del carrito' });
  for (;;) {
    s.t.prompt('Rediseña el carrito y revisa la API de productos');
    await toolBurst(s.t, 2);
    const jobs = [
      subagent(s, 'Explore', 'Mapear componentes del carrito', true, 5),
      subagent(s, 'Explore', 'Revisar endpoints de productos', true, 4),
      subagent(s, 'general-purpose', 'Escribir tests del checkout', true, 6),
    ];
    await sleep(1500);
    s.t.say('Lancé tres subagentes en paralelo; espero sus informes.', true);
    await Promise.all(jobs);
    s.t.prompt('<task-notification><summary>Los subagentes terminaron</summary></task-notification>');
    await toolBurst(s.t, 3);
    s.t.say('Listo: carrito rediseñado.', true);
    await sleep(15000);
  }
}

// Pagos: una herramienta se queda colgada (parece pedir permiso), luego sigue.
async function pagos() {
  const s = session('api-pagos');
  s.t.write({ type: 'ai-title', aiTitle: 'Webhooks de Stripe' });
  for (;;) {
    s.t.prompt('Implementa reintentos para los webhooks');
    await toolBurst(s.t, 2);
    const id = s.t.toolUse('Write', { file_path: 'D:/api-pagos/src/webhooks.ts' });
    await sleep(14000); // sin resultado: el visualizador debería sospechar "pide permiso"
    s.t.toolResult(id);
    await subagent(s, 'Plan', 'Diseñar la cola de reintentos', false, 3);
    await toolBurst(s.t, 2);
    s.t.say('Reintentos implementados.', true);
    await sleep(20000);
  }
}

// Docs: casi siempre esperando, de vez en cuando trabaja o da error.
async function docs() {
  const s = session('documentacion');
  s.t.prompt('Actualiza la guía de instalación');
  await toolBurst(s.t, 2);
  s.t.say('Guía actualizada. ¿Algo más?', true);
  for (;;) {
    await sleep(25000);
    s.t.prompt('Añade una sección de FAQ');
    await toolBurst(s.t, 3);
    if (Math.random() < 0.4) s.t.write({ type: 'system', subtype: 'api_error', error: { message: '529 Overloaded' } });
    else s.t.say('FAQ añadida.', true);
  }
}

console.log(`  Demo: transcripts simulados en ${ROOT}`);
void tienda();
await sleep(2500);
void pagos();
await sleep(2500);
void docs();
