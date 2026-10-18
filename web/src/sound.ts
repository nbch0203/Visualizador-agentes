let ctx: AudioContext | undefined;

// Pitidos sintetizados (sin archivos de audio).
export function chime(kind: 'alert' | 'done') {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const notes = kind === 'alert' ? [880, 660, 880] : [523, 784];
    notes.forEach((freq, i) => {
      const t0 = ctx!.currentTime + i * 0.12;
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.05, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.11);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(t0);
      osc.stop(t0 + 0.12);
    });
  } catch {}
}
