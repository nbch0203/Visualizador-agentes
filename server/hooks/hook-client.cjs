#!/usr/bin/env node
// Hook de Claude Code para el Visualizador de agentes.
// Lee el evento JSON por stdin y lo reenvía al servidor local. Nunca imprime nada
// ni falla: si el servidor no está corriendo, sale en silencio con código 0.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const done = () => process.exit(0);
setTimeout(done, 3000).unref();

const MAX = 400;
const clip = (v) => (typeof v === 'string' && v.length > MAX ? v.slice(0, MAX) + '…' : v);

// Recorta el payload: tool_input/tool_response pueden ser enormes.
function slim(p) {
  const out = {};
  for (const k of [
    'hook_event_name', 'session_id', 'transcript_path', 'cwd', 'permission_mode',
    'agent_id', 'agent_type', 'agent_transcript_path', 'tool_name', 'tool_use_id',
    'notification_type', 'message', 'title', 'source', 'reason', 'model', 'session_title',
    'prompt', 'error', 'last_assistant_message', 'duration_ms',
  ]) {
    if (p[k] !== undefined) out[k] = clip(p[k]);
  }
  if (p.tool_input && typeof p.tool_input === 'object') {
    const ti = {};
    for (const [k, v] of Object.entries(p.tool_input)) {
      if (typeof v === 'string') ti[k] = clip(v);
      else if (typeof v === 'number' || typeof v === 'boolean') ti[k] = v;
    }
    out.tool_input = ti;
  }
  return out;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('error', done);
process.stdin.on('end', () => {
  try {
    const dir = path.join(os.homedir(), '.visualizador-agentes');
    const server = JSON.parse(fs.readFileSync(path.join(dir, 'server.json'), 'utf8'));
    const token = fs.readFileSync(path.join(dir, 'token'), 'utf8').trim();
    const body = JSON.stringify(slim(JSON.parse(raw)));
    const req = http.request(
      {
        host: server.host || '127.0.0.1',
        port: server.port,
        path: '/api/hooks/event',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-va-token': token },
        timeout: 800,
      },
      (res) => {
        res.resume();
        res.on('end', done);
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', done);
    req.end(body);
  } catch {
    done();
  }
});
