import { useEffect, useRef } from 'react';
import type { Agent } from '../../../shared/types.ts';
import { OfficeScene } from './scene.ts';

interface Props {
  agents: Agent[];
  ready: boolean;
  showDone: boolean;
  selectedId?: string;
  onSelect: (id: string | undefined) => void;
  projectKey?: string; // proyecto abierto; undefined = edificio
  projectName?: string;
  onOpenProject: (key: string) => void;
  onBack: () => void;
}

// Escala entera para que el pixel-art se vea nítido.
function pickScale(width: number): number {
  if (width >= 1400) return 4;
  if (width >= 760) return 3;
  return 2;
}

export function OfficeCanvas({ agents, ready, showDone, selectedId, onSelect, projectKey, projectName, onOpenProject, onBack }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<OfficeScene>(null as unknown as OfficeScene);
  if (!sceneRef.current) {
    sceneRef.current = new OfficeScene();
    (window as unknown as { __vaScene: OfficeScene }).__vaScene = sceneRef.current; // para depurar desde la consola
  }
  const scaleRef = useRef(3);

  useEffect(() => {
    sceneRef.current.setProject(projectKey);
    wrapRef.current?.scrollTo(0, 0);
  }, [projectKey]);

  useEffect(() => {
    const scene = sceneRef.current;
    scene.showDone = showDone;
    scene.setAgents(agents, ready);
  }, [agents, ready, showDone]);

  useEffect(() => {
    sceneRef.current.selectedId = selectedId;
  }, [selectedId]);

  useEffect(() => {
    const wrap = wrapRef.current!;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const scene = sceneRef.current;
    let raf = 0;
    let last = performance.now();
    let viewW = 0;

    const resize = () => {
      const scale = pickScale(wrap.clientWidth);
      scaleRef.current = scale;
      viewW = Math.floor(wrap.clientWidth / scale);
      scene.setWorldWidth(viewW);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    const frame = (now: number) => {
      // Si la pestaña estuvo en segundo plano (el navegador pausa la animación), colocar a
      // todos directamente en su sitio en vez de verlos caminar a cámara lenta.
      if (now - last > 1000) scene.snapAll();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      scene.update(dt);
      const scale = scaleRef.current;
      const dpr = window.devicePixelRatio || 1;
      const viewH = Math.max(Math.floor(wrap.clientHeight / scale), scene.layout.height);
      const cssW = viewW * scale;
      const cssH = viewH * scale;
      if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${cssH}px`;
      }
      ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
      scene.render(ctx, viewW, viewH, now / 1000);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  const toWorld = (e: React.MouseEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    const s = scaleRef.current;
    return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s };
  };

  return (
    <div className="office-wrap">
      <div className="office-bar">
        {projectKey ? (
          <>
            <button className="back" onClick={onBack}>← Todos los proyectos</button>
            <span className="office-title">Oficina de <b>{projectName ?? projectKey}</b></span>
          </>
        ) : (
          <span className="office-title muted">Edificio · haz clic en una sala para entrar en la oficina del proyecto</span>
        )}
      </div>
      <div className="office" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={projectKey ? `Oficina del proyecto ${projectName ?? ''} con su orquestador y subagentes` : 'Edificio con una sala por proyecto'}
          onMouseMove={(e) => {
            const p = toWorld(e);
            const hit = sceneRef.current.hitTest(p.x, p.y);
            sceneRef.current.hoverId = hit.agentId;
            sceneRef.current.hoverZone = hit.zoneKey;
            canvasRef.current!.style.cursor = hit.agentId || hit.zoneKey ? 'pointer' : 'default';
          }}
          onMouseLeave={() => {
            sceneRef.current.hoverId = undefined;
            sceneRef.current.hoverZone = undefined;
          }}
          onClick={(e) => {
            const p = toWorld(e);
            const hit = sceneRef.current.hitTest(p.x, p.y);
            if (!projectKey && hit.zoneKey) onOpenProject(hit.zoneKey);
            onSelect(hit.agentId);
          }}
        />
      </div>
    </div>
  );
}
