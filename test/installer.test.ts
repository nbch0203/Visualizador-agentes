import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOOK_EVENTS, hooksStatus, installHooks, uninstallHooks } from '../server/hooks/installer.ts';

const dirs: string[] = [];
function tmpSettings(content?: object) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'va-'));
  dirs.push(dir);
  const file = path.join(dir, 'settings.json');
  if (content) fs.writeFileSync(file, JSON.stringify(content, null, 2));
  return file;
}
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe('installer', () => {
  it('instala, es idempotente y desinstala dejando lo ajeno intacto', () => {
    const original = {
      model: 'opus',
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo ajeno' }] }] },
    };
    const file = tmpSettings(original);

    const { backup } = installHooks(file);
    expect(backup && fs.existsSync(backup)).toBeTruthy();
    installHooks(file); // segunda vez: no duplica
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(s.model).toBe('opus');
    expect(s.hooks.PreToolUse).toHaveLength(2);
    expect(s.hooks.PreToolUse[1].hooks[0]).toMatchObject({ type: 'command', async: true });
    expect(hooksStatus(file).events.sort()).toEqual([...HOOK_EVENTS].sort());

    uninstallHooks(file);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(original);
    expect(hooksStatus(file).installed).toBe(false);
  });

  it('no toca un settings.json inválido', () => {
    const file = tmpSettings();
    fs.writeFileSync(file, '{ roto');
    expect(() => installHooks(file)).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('{ roto');
  });
});
