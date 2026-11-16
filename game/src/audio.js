// audio.js — all sound is synthesised with WebAudio; zero audio files, zero
// network. One AudioContext, lazily created on the first user gesture (the
// click that locks the pointer), and a tiny helper per sound. Distance
// attenuates enemy shots so the player hears where fire comes from.

let ctx = null;
let master = null;

export function ensureAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
  } catch { ctx = null; }
}

function noiseBuffer(duration) {
  const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * duration), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
  return buf;
}

function playNoise({ duration = 0.12, freq = 1800, gain = 0.5, type = 'lowpass', when = 0 }) {
  if (!ctx) return;
  const t = ctx.currentTime + when;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(duration);
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + duration);
  src.connect(filter); filter.connect(g); g.connect(master);
  src.start(t); src.stop(t + duration);
}

function playTone({ freq = 440, endFreq = null, duration = 0.1, gain = 0.3, type = 'square', when = 0 }) {
  if (!ctx) return;
  const t = ctx.currentTime + when;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (endFreq !== null) osc.frequency.exponentialRampToValueAtTime(endFreq, t + duration);
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + duration);
  osc.connect(g); g.connect(master);
  osc.start(t); osc.stop(t + duration);
}

// gainFor(distance) — simple linear falloff, 1 at the muzzle, 0 past 45 m.
function gainFor(dist) {
  if (dist === undefined) return 1;
  return Math.max(0.08, 1 - dist / 45);
}

export const sfx = {
  shoot(dist) { playNoise({ duration: 0.1, freq: 1400, gain: 0.55 * gainFor(dist) }); playTone({ freq: 160, endFreq: 60, duration: 0.08, gain: 0.25 * gainFor(dist), type: 'sawtooth' }); },
  shootMarksman(dist) { playNoise({ duration: 0.22, freq: 900, gain: 0.7 * gainFor(dist) }); playTone({ freq: 110, endFreq: 40, duration: 0.18, gain: 0.35 * gainFor(dist), type: 'sawtooth' }); },
  hit() { playTone({ freq: 1200, duration: 0.05, gain: 0.3, type: 'sine' }); },
  kill() { playTone({ freq: 880, duration: 0.07, gain: 0.3 }); playTone({ freq: 1320, duration: 0.1, gain: 0.3, when: 0.07 }); },
  hurt() { playTone({ freq: 220, endFreq: 110, duration: 0.15, gain: 0.35, type: 'sawtooth' }); },
  reload() { playTone({ freq: 500, duration: 0.05, gain: 0.2 }); playTone({ freq: 700, duration: 0.05, gain: 0.2, when: 0.35 }); },
  dry() { playTone({ freq: 900, duration: 0.04, gain: 0.2, type: 'square' }); },
  buy() { playTone({ freq: 660, duration: 0.06, gain: 0.25 }); playTone({ freq: 990, duration: 0.09, gain: 0.25, when: 0.06 }); },
  roundStart() { playTone({ freq: 523, duration: 0.12, gain: 0.3 }); playTone({ freq: 784, duration: 0.16, gain: 0.3, when: 0.12 }); },
  roundWin() { [523, 659, 784, 1047].forEach((f, i) => playTone({ freq: f, duration: 0.14, gain: 0.28, when: i * 0.11 })); },
  roundLose() { [392, 330, 262].forEach((f, i) => playTone({ freq: f, duration: 0.18, gain: 0.28, when: i * 0.13 })); },
  plantBeep() { playTone({ freq: 1500, duration: 0.06, gain: 0.3, type: 'sine' }); },
  bombTick() { playTone({ freq: 1800, duration: 0.04, gain: 0.22, type: 'sine' }); },
  explode() { playNoise({ duration: 0.9, freq: 300, gain: 0.9, type: 'lowpass' }); playTone({ freq: 70, endFreq: 28, duration: 0.8, gain: 0.5, type: 'sine' }); },
  smoke() { playNoise({ duration: 0.5, freq: 600, gain: 0.3, type: 'bandpass' }); },
  step() { playNoise({ duration: 0.05, freq: 500, gain: 0.08 }); },
};
