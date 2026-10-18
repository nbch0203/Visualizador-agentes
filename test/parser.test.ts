import { describe, expect, it } from 'vitest';
import { parseRecord, summarizeTool, toolActivity } from '../server/transcripts/parser.ts';

const ts = '2026-10-09T20:00:00.000Z';

describe('parseRecord', () => {
  it('extrae tool_use y fin de turno de mensajes assistant', () => {
    const sigs = parseRecord({
      type: 'assistant', timestamp: ts, cwd: 'D:\\Proyecto',
      message: { model: 'claude-opus-5', stop_reason: 'tool_use', content: [
        { type: 'text', text: 'Voy a leer' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'D:\\Proyecto\\a.ts' } },
      ] },
    });
    expect(sigs.map((s) => s.t)).toEqual(['meta', 'text', 'tool_start']);
    expect(sigs[0]).toMatchObject({ cwd: 'D:\\Proyecto', model: 'claude-opus-5' });

    const end = parseRecord({ type: 'assistant', timestamp: ts, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Listo' }] } });
    expect(end.map((s) => s.t)).toContain('turn_end');
  });

  it('extrae tool_result y lanzamiento de subagente async', () => {
    const sigs = parseRecord({
      type: 'user', timestamp: ts,
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'ok' }] },
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'abc123' },
    });
    const kinds = sigs.map((s) => s.t);
    expect(kinds.indexOf('subagent_launched')).toBeLessThan(kinds.indexOf('tool_end'));
    expect(sigs.find((s) => s.t === 'subagent_launched')).toMatchObject({ agentId: 'abc123', background: true, toolUseId: 'toolu_2' });
  });

  it('marca errores de herramienta', () => {
    const [, end] = parseRecord({ type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: [{ type: 'text', text: 'falló' }] }] } });
    expect(end).toMatchObject({ t: 'tool_end', ok: false, text: 'falló' });
  });

  it('limpia prompts y detecta interrupciones', () => {
    const p = parseRecord({ type: 'user', timestamp: ts, message: { content: '<system-reminder>x</system-reminder>Hola mundo' } });
    expect(p.find((s) => s.t === 'prompt')).toMatchObject({ text: 'Hola mundo' });
    const onlyReminder = parseRecord({ type: 'user', timestamp: ts, message: { content: '<system-reminder>x</system-reminder>' } });
    expect(onlyReminder.some((s) => s.t === 'prompt')).toBe(false);
    const i = parseRecord({ type: 'user', timestamp: ts, message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
    expect(i.some((s) => s.t === 'interrupted')).toBe(true);
  });

  it('reconoce títulos, coste y errores de sistema', () => {
    expect(parseRecord({ type: 'ai-title', aiTitle: 'Mi sesión' })[0]).toMatchObject({ t: 'title', title: 'Mi sesión' });
    expect(parseRecord({ type: 'cost-state', totalCostUSD: 1.5 })[0]).toMatchObject({ t: 'cost', costUSD: 1.5 });
    expect(parseRecord({ type: 'system', subtype: 'api_error', timestamp: ts, error: { message: '401' } })[0]).toMatchObject({ t: 'error' });
    expect(parseRecord({ type: 'atis-latch' })).toEqual([]);
  });
});

describe('orquestación', () => {
  it('distingue bloques intermedios (mensaje aún generándose) del final', () => {
    const mid = parseRecord({ type: 'assistant', timestamp: ts, message: { id: 'm1', stop_reason: null, content: [{ type: 'tool_use', id: 'a', name: 'Write', input: {} }] } });
    expect(mid.find((s) => s.t === 'tool_start')).toMatchObject({ ready: false, msgId: 'm1' });
    expect(mid.some((s) => s.t === 'msg_done')).toBe(false);
    const last = parseRecord({ type: 'assistant', timestamp: ts, message: { id: 'm1', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'b', name: 'Write', input: {} }] } });
    expect(last.find((s) => s.t === 'msg_done')).toMatchObject({ msgId: 'm1' });
  });

  it('reconoce hand-backs y task-notifications de subagentes', () => {
    const handback = parseRecord({ type: 'user', timestamp: ts, message: { content: 'Another Claude session sent a message:\n<agent-message from="abc123">\n[Subagent hand-back] informe' } });
    expect(handback.map((s) => s.t)).toEqual(['meta', 'agent_report', 'wake']);
    expect(handback.some((s) => s.t === 'prompt')).toBe(false);
    const queued = parseRecord({
      type: 'queue-operation', operation: 'enqueue', timestamp: ts,
      content: '<task-notification>\n<task-id>abc123</task-id>\n<status>completed</status>\n<summary>Agent "X" finished</summary>\n</task-notification>',
    });
    expect(queued[0]).toMatchObject({ t: 'agent_report', fromId: 'abc123', status: 'completed', summary: 'Agent "X" finished' });
  });

  it('los comandos locales no se toman como prompts', () => {
    expect(parseRecord({ type: 'user', timestamp: ts, message: { content: '<local-command-caveat>Caveat</local-command-caveat>' } }).map((s) => s.t)).toEqual(['meta']);
    const cmd = parseRecord({ type: 'user', timestamp: ts, message: { content: '<command-name>/agents</command-name>\n<command-message>agents</command-message>' } });
    expect(cmd.find((s) => s.t === 'command')).toMatchObject({ text: '/agents' });
  });
});

describe('herramientas', () => {
  it('resume inputs', () => {
    expect(summarizeTool('Edit', { file_path: 'C:\\a\\b\\c.ts' })).toBe('c.ts');
    expect(summarizeTool('Bash', { command: 'npm test', description: 'Ejecutar tests' })).toBe('Ejecutar tests');
    expect(summarizeTool('Agent', { subagent_type: 'Explore', description: 'Buscar' })).toBe('Explore: Buscar');
  });
  it('clasifica actividad', () => {
    expect(toolActivity('Write')).toBe('typing');
    expect(toolActivity('Grep')).toBe('reading');
    expect(toolActivity('PowerShell')).toBe('running');
    expect(toolActivity('Agent')).toBe('delegating');
    expect(toolActivity('AskUserQuestion')).toBe('waiting');
  });
});
