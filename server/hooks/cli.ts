import { CLAUDE_SETTINGS } from '../config.ts';
import { HOOK_EVENTS, hooksStatus, installHooks, uninstallHooks } from './installer.ts';

const cmd = process.argv[2];

try {
  if (cmd === 'install') {
    const { backup, status } = installHooks();
    console.log(`Hooks instalados en ${CLAUDE_SETTINGS} (${status.events.length} eventos).`);
    if (backup) console.log(`Copia de seguridad: ${backup}`);
    console.log('Las sesiones de Claude Code que abras a partir de ahora enviarán eventos al visualizador.');
  } else if (cmd === 'uninstall') {
    const { backup, status } = uninstallHooks();
    console.log(status.installed ? 'No se pudieron quitar todos los hooks.' : 'Hooks del visualizador eliminados.');
    if (backup) console.log(`Copia de seguridad: ${backup}`);
  } else {
    const s = hooksStatus();
    console.log(`Archivo: ${s.settingsPath}`);
    console.log(s.installed ? `Instalados: ${s.events.join(', ')}` : 'No instalados.');
    if (s.installed && s.events.length < HOOK_EVENTS.length) console.log('Instalación parcial: ejecuta npm run hooks:install');
  }
} catch (err) {
  console.error('Error:', (err as Error).message);
  console.error('No se modificó settings.json.');
  process.exit(1);
}
