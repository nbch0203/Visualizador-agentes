import { describe, expect, it } from 'vitest';
import { AgentStore } from '../server/runtime/store.ts';
import { T } from '../server/config.ts';

function setup() {
  let now = 1_000_000;
  const store = new AgentStore(() => now);
  store.upsertMain('sess', 'D--Proyecto', 'D:\\Proyecto');
  return { store, advance: (ms: number) => (now += ms), at: () => now };
}

describe('AgentStore', () => {
  it('sigue el ciclo prompt → herramienta → fin de turno', () => {
    const { store, at } = setup();
    store.applySignal('sess', { t: 'prompt', ts: at(), text: 'Haz algo' });
    expect(store.get('sess')).toMatchObject({ status: 'working', activity: 'thinking', title: 'Haz algo', project: 'Proyecto' });

    store.applySignal('sess', { t: 'tool_start', ts: at(), id: 't1', name: 'Edit', input: { file_path: 'x.ts' } });
    expect(store.get('sess')).toMatchObject({ status: 'working', activity: 'typing' });
    expect(store.get('sess')!.currentTools[0]).toMatchObject({ name: 'Edit', summary: 'x.ts' });

    store.applySignal('sess', { t: 'tool_end', ts: at(), id: 't1', ok: true });
    store.applySignal('sess', { t: 'turn_end', ts: at() });
    expect(store.get('sess')).toMatchObject({ status: 'waiting_input', currentTools: [] });
    const a = store.get('sess')!;
    expect(a.toolsDone).toBe(1);
    expect(a.recent.map((r) => r.kind)).toEqual(['prompt', 'tool_start']);
    expect(a.recent[1]).toMatchObject({ tool: 'Edit', text: 'x.ts', ok: true });
  });

  it('enlaza subagentes y los termina con SubagentHandback', () => {
    const { store, at } = setup();
    store.applySignal('sess', { t: 'tool_start', ts: at(), id: 'tuAgent', name: 'Agent', input: { subagent_type: 'Explore', description: 'Buscar' } });
    store.upsertSub('sub1', 'sess', 'D--Proyecto', { agentType: 'Explore', description: 'Buscar', toolUseId: 'tuAgent', requestShape: 'background' });
    expect(store.get('sub1')).toMatchObject({ parentId: 'sess', kind: 'subagent', background: true, title: 'Buscar' });
    expect(store.get('sess')!.activity).toBe('delegating');

    store.applySignal('sub1', { t: 'tool_start', ts: at(), id: 'r1', name: 'Read', input: {} });
    expect(store.get('sub1')).toMatchObject({ status: 'working', activity: 'reading' });
    store.applySignal('sub1', { t: 'tool_start', ts: at(), id: 'h1', name: 'SubagentHandback', input: {} });
    store.applySignal('sub1', { t: 'tool_end', ts: at(), id: 'h1', ok: true });
    expect(store.get('sub1')!.status).toBe('done');
  });

  it('un subagente síncrono termina cuando el padre recibe el resultado', () => {
    const { store, at } = setup();
    store.applySignal('sess', { t: 'tool_start', ts: at(), id: 'tuA', name: 'Agent', input: {} });
    store.upsertSub('sub2', 'sess', 'D--Proyecto', { toolUseId: 'tuA' });
    store.applySignal('sub2', { t: 'prompt', ts: at(), text: 'tarea' });
    store.applySignal('sess', { t: 'tool_end', ts: at(), id: 'tuA', ok: true });
    expect(store.get('sub2')!.status).toBe('done');
  });

  it('no da por terminado un subagente background al recibir el resultado inmediato', () => {
    const { store, at } = setup();
    store.applySignal('sess', { t: 'tool_start', ts: at(), id: 'tuB', name: 'Agent', input: {} });
    store.upsertSub('sub3', 'sess', 'D--Proyecto', { toolUseId: 'tuB' });
    store.applySignal('sub3', { t: 'prompt', ts: at(), text: 'tarea' });
    store.applySignal('sess', { t: 'subagent_launched', ts: at(), toolUseId: 'tuB', agentId: 'sub3', background: true });
    store.applySignal('sess', { t: 'tool_end', ts: at(), id: 'tuB', ok: true });
    expect(store.get('sub3')!.status).toBe('working');
  });

  it('hooks: PermissionRequest y su resolución', () => {
    const { store, advance } = setup();
    store.applyHook({ hook_event_name: 'PreToolUse', session_id: 'sess', tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'rm x' } });
    advance(10);
    store.applyHook({ hook_event_name: 'PermissionRequest', session_id: 'sess', tool_name: 'Bash', tool_input: { command: 'rm x' } });
    expect(store.get('sess')!.status).toBe('waiting_permission');
    // Una línea vieja del transcript no debe pisar el estado de permiso.
    store.applySignal('sess', { t: 'text', ts: 0, text: 'viejo' });
    expect(store.get('sess')!.status).toBe('waiting_permission');
    advance(10);
    store.applyHook({ hook_event_name: 'PostToolUse', session_id: 'sess', tool_name: 'Bash', tool_use_id: 'b1' });
    expect(store.get('sess')!.status).toBe('working');
    store.applyHook({ hook_event_name: 'Stop', session_id: 'sess' });
    expect(store.get('sess')!.status).toBe('waiting_input');
  });

  it('heurística: herramienta corta colgada sin hooks ⇒ posible permiso', () => {
    const { store, advance, at } = setup();
    store.applySignal('sess', { t: 'tool_start', ts: at(), id: 'w1', name: 'Write', input: { file_path: 'a' } });
    advance(T.permissionGuessMs + 500);
    store.tick();
    expect(store.get('sess')!.status).toBe('waiting_permission');
    store.applySignal('sess', { t: 'tool_end', ts: at(), id: 'w1', ok: true });
    expect(store.get('sess')!.status).toBe('working');
  });

  it('Bash largo no se confunde con permiso, pero acaba en stale', () => {
    const { store, advance, at } = setup();
    store.applySignal('sess', { t: 'tool_start', ts: at(), id: 'b2', name: 'Bash', input: {} });
    advance(60_000);
    store.tick();
    expect(store.get('sess')!.status).toBe('working');
    advance(T.staleLongToolMs);
    expect(store.get('sess')!.status).toBe('stale');
  });

  it('AskUserQuestion cuenta como esperando input', () => {
    const { store, at } = setup();
    store.applySignal('sess', { t: 'tool_start', ts: at(), id: 'q', name: 'AskUserQuestion', input: {} });
    expect(store.get('sess')!.status).toBe('waiting_input');
  });

  it('retira sesiones inactivas', () => {
    const { store, advance, at } = setup();
    store.applySignal('sess', { t: 'turn_end', ts: at() });
    advance(T.hideAfterMs + 1000);
    store.tick();
    expect(store.has('sess')).toBe(false);
  });

  // ---- orquestador con subagentes (casos vistos en transcripts reales) ----

  it('el orquestador que espera a sus subagentes figura como coordinando, no esperando al usuario', () => {
    const { store, at } = setup();
    store.applySignal('sess', { t: 'tool_start', ts: at(), id: 'tuA', name: 'Agent', input: {} });
    store.upsertSub('s1', 'sess', 'D--Proyecto', { toolUseId: 'tuA', requestShape: 'background' });
    store.applySignal('sub1', { t: 'prompt', ts: at(), text: 'x' });
    store.applySignal('s1', { t: 'prompt', ts: at(), text: 'tarea' });
    store.applySignal('sess', { t: 'subagent_launched', ts: at(), toolUseId: 'tuA', agentId: 's1', background: true });
    store.applySignal('sess', { t: 'tool_end', ts: at(), id: 'tuA', ok: true });
    store.applySignal('sess', { t: 'turn_end', ts: at() });
    expect(store.get('sess')).toMatchObject({ status: 'working', activity: 'delegating', waitingOn: 1 });
    // El aviso de hand-back en la cola del orquestador termina al subagente.
    store.applySignal('sess', { t: 'agent_report', ts: at(), fromId: 's1', status: 'completed' });
    expect(store.get('s1')!.status).toBe('done');
    expect(store.get('sess')).toMatchObject({ status: 'waiting_input' });
  });

  it('conserva los subagentes terminados mientras viva la sesión', () => {
    const { store, advance, at } = setup();
    store.upsertSub('s1', 'sess', 'D--Proyecto', { description: 'Tarea' });
    store.applySignal('s1', { t: 'turn_end', ts: at() });
    store.applySignal('sess', { t: 'prompt', ts: at(), text: 'sigue' });
    advance(20 * 60_000);
    store.applySignal('sess', { t: 'turn_end', ts: at() });
    store.tick();
    expect(store.get('s1')!.status).toBe('done');
    advance(T.hideAfterMs + 1000);
    store.tick(); // se retira la sesión…
    store.tick(); // …y con ella su historial
    expect(store.has('sess')).toBe(false);
    expect(store.has('s1')).toBe(false);
  });

  it('un aviso de fin leído antes que el transcript del subagente lo deja terminado', () => {
    const { store, at, advance } = setup();
    const reportTs = at();
    store.applySignal('sess', { t: 'agent_report', ts: reportTs, fromId: 's9' });
    store.upsertSub('s9', 'sess', 'D--Proyecto', {});
    // Backfill del transcript del subagente (líneas anteriores al aviso).
    store.applySignal('s9', { t: 'tool_start', ts: reportTs - 5000, id: 'w', name: 'Write', input: {} });
    advance(1000);
    expect(store.get('s9')).toMatchObject({ status: 'done', currentTools: [] });
  });

  it('no sospecha permiso mientras el mensaje con varias herramientas aún se genera', () => {
    const { store, advance, at } = setup();
    store.applySignal('sess', { t: 'tool_start', ts: at(), id: 'w1', name: 'Write', input: {}, msgId: 'm1', ready: false });
    advance(T.permissionGuessMs + 3000);
    store.tick();
    expect(store.get('sess')!.status).toBe('working');
    store.applySignal('sess', { t: 'msg_done', ts: at(), msgId: 'm1' });
    expect(store.get('sess')!.currentTools[0].executing).toBe(true);
    advance(T.permissionGuessMs + 500);
    store.tick();
    expect(store.get('sess')!.status).toBe('waiting_permission');
  });

  it('nunca sospecha permiso en subagentes no interactivos', () => {
    const { store, advance, at } = setup();
    store.upsertSub('bg', 'sess', 'D--Proyecto', { requestNonInteractive: true, model: 'sonnet' });
    store.applySignal('bg', { t: 'tool_start', ts: at(), id: 'w', name: 'Write', input: {} });
    advance(T.permissionGuessMs * 3);
    store.tick();
    expect(store.get('bg')).toMatchObject({ status: 'working', model: 'sonnet' });
  });

  // ---- subagentes que dejan de dar señales ----

  it('da por terminado a un subagente callado cuyo orquestador ya siguió adelante', () => {
    const { store, advance, at } = setup();
    store.upsertSub('s1', 'sess', 'D--Proyecto', { requestShape: 'background' });
    store.applySignal('s1', { t: 'prompt', ts: at(), text: 'tarea' });
    advance(10_000);
    store.applySignal('sess', { t: 'turn_end', ts: at() });
    advance(T.subSilentDoneMs + 1000);
    store.tick();
    expect(store.get('s1')).toMatchObject({ status: 'done' });
    expect(store.get('sess')).toMatchObject({ status: 'waiting_input', waitingOn: undefined });
  });

  it('no lo da por terminado si el orquestador sigue esperándolo, y revive si vuelve a escribir', () => {
    const { store, advance, at } = setup();
    store.upsertSub('s2', 'sess', 'D--Proyecto', {});
    store.applySignal('sess', { t: 'prompt', ts: at(), text: 'orquesta' });
    store.applySignal('s2', { t: 'prompt', ts: at(), text: 'tarea' });
    advance(T.subSilentDoneMs + 1000);
    store.tick();
    expect(store.get('s2')!.status).not.toBe('done'); // el padre sigue trabajando
    store.applySignal('sess', { t: 'turn_end', ts: at() });
    advance(1000);
    store.tick();
    expect(store.get('s2')!.status).toBe('done');
    advance(1000);
    store.applySignal('s2', { t: 'text', ts: at(), text: 'sigo vivo' });
    expect(store.get('s2')!.status).toBe('working');
  });
});
