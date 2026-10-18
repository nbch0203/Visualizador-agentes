# Visualizador de agentes

Oficina pixel-art y panel en vivo para supervisar tus sesiones de **Claude Code** y sus **subagentes**: quién está trabajando, con qué herramienta, en qué archivo, quién pide permiso y quién espera tu mensaje. Está inspirado en [pixel-agents](https://github.com/pixel-agents-hq/pixel-agents), pero los sprites están dibujados en código y no usa assets de terceros.

## Arranque

```bash
npm install
npm run build      # compila la web (solo la primera vez o tras cambios en web/)
npm start          # servidor en http://127.0.0.1:4317
```

Al arrancar, el servidor imprime dos URLs:

- La normal sirve para mirar.
- La que lleva `?token=…` permite además instalar o quitar los hooks desde la interfaz.

Otros comandos:

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor + Vite con recarga en caliente (http://127.0.0.1:5173) |
| `npm run demo` | Simula sesiones y subagentes en una carpeta temporal (puerto 4318). No toca `~/.claude` |
| `npm test` | Tests de parser, store e instalador |

## Qué muestra

- **Edificio:** una sala por proyecto con su resumen. **Haz clic en una sala** (o elige el proyecto en el desplegable) para entrar en su oficina. Con "← Todos los proyectos" o `Esc` se vuelve.
- **Oficina del proyecto:**
  - Cada orquestador tiene su escritorio de jefe ★ y, debajo, un escritorio por subagente activo. Los une un cable por el suelo, con un pulso cuando el subagente trabaja.
  - Los subagentes terminados pasan a la zona **Terminados**, de pie con su ✓ y un café.
- **En ambas vistas:**
  - Los personajes teclean (Edit/Write), leen (Read/Grep/Web), ejecutan (Bash/PowerShell), piensan o delegan.
  - Los subagentes nuevos entran por la puerta. Al terminar muestran ✓: en el edificio salen por la puerta y en la oficina del proyecto caminan a la zona Terminados.
  - Burbujas sobre la cabeza:

    | Burbuja | Significado |
    |---|---|
    | `!` ámbar | pide permiso |
    | `…` | espera tu mensaje |
    | ✗ | error |
    | `?` | sin señales |
    | zzz | inactivo |

- **Panel "En curso":** cada orquestador aparece con su equipo.
  - Los subagentes activos tienen una tarjeta con su encargo, su modelo, la herramienta que usan ahora y desde cuándo, sus últimas acciones (✓/✗) y el número de acciones hechas.
  - Los subagentes terminados aparecen en una lista compacta, con historial de hasta 6 h mientras la sesión siga viva.
  - Si el orquestador terminó su turno pero sus subagentes siguen trabajando, figura como *coordinando* y no como "espera tu mensaje".
- **Panel "Todos":** árbol proyecto → sesión → subagentes. Al hacer clic se abre el detalle con el feed completo de actividad.
- **Avisos:**
  - Contador en la pestaña del navegador, por ejemplo `(1) ✋`.
  - Sonido opcional cuando alguien pide permiso o termina su turno.

## Cómo detecta la actividad

1. **Transcripts:**
   - Lee de forma incremental `~/.claude/projects/**/<sesión>.jsonl` y `…/<sesión>/subagents/agent-*.jsonl`, más su `.meta.json`.
   - Solo sigue las sesiones modificadas en los últimos 30 minutos. De ellas carga también sus subagentes de las últimas 6 h.
   - El fin de un subagente se detecta por su `SubagentHandback`, por el aviso que recibe el orquestador o por el hook `SubagentStop`.
2. **Hooks (recomendado):** dan el estado exacto de "pide permiso" y del fin de turno al instante.

   ```bash
   npm run hooks:install     # añade los hooks a ~/.claude/settings.json (con copia .bak)
   npm run hooks:status
   npm run hooks:uninstall   # quita solo las entradas del visualizador
   ```

   - Los hooks son `async`, así que nunca retrasan a Claude. Si el servidor está apagado, el hook sale en silencio.
   - Solo afectan a las sesiones de Claude Code que se abran **después** de instalarlos.

Sin hooks, el estado "pide permiso" es una estimación: una herramienta corta que lleva más de 7 s sin resultado.

## Seguridad

- El servidor escucha solo en `127.0.0.1` y rechaza otros `Host` y `Origin`.
- Los hooks y la gestión de hooks requieren el token de `~/.visualizador-agentes/token`.

## Configuración (variables de entorno)

| Variable | Defecto | Uso |
|---|---|---|
| `VA_PORT` | `4317` | Puerto del servidor |
| `VA_HOST` | `127.0.0.1` | Interfaz de escucha |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Carpeta de configuración de Claude |
