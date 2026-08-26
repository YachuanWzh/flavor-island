'use strict';

// "Spicy" — the flavor-code pixel mascot: a chili-pepper buddy drawn live on
// canvas. Original design (no Claude/Clawd lineage) with three scenes keyed by
// agent status:
//   idle               → sleep: lying pod, droopy stem, breathing, floating z's
//   running/processing → work: typing bounce, alternating arms, flashing keys,
//                        swaying stem
//   waiting            → alert: startled decay-jumps, stem standing straight,
//                        waving arms, "!" mark, warm alarm glow
// Scene timings/keyframes follow the CodeIsland cadence so the island keeps
// the same lively feel.

const POD = '#ff6a3d';        // chili body
const POD_HI = '#ff9a6b';     // body sheen
const POD_LO = '#d14a24';     // body shading
const LEAF = '#5ec96f';       // stem / leaf
const LEAF_LO = '#3f9e50';
const EYE = '#14151c';
const CHEEK = '#ffd2a8';
const ALERT = '#ff3d00';
const KB_BASE = '#61707f';
const KB_KEY = '#99a8b5';
const KB_HI = '#ffffff';

// Interpolate between keyframes: [[pct, value], ...] — same helper CodeIsland
// uses for its notification jump/wave curves.
function lerp(kf, p) {
  if (p <= kf[0][0]) return kf[0][1];
  for (let i = 1; i < kf.length; i += 1) {
    if (p <= kf[i][0]) {
      const t = (p - kf[i - 1][0]) / (kf[i][0] - kf[i - 1][0]);
      return kf[i - 1][1] + (kf[i][1] - kf[i - 1][1]) * t;
    }
  }
  return kf[kf.length - 1][1];
}

// Maps the pill mascot state to one of the three animated scenes.
function sceneForState(state) {
  if (state === 'waiting') return 'alert';
  if (state === 'running' || state === 'processing') return 'work';
  return 'sleep';
}

function createMascot(canvas) {
  const ctx = canvas.getContext('2d');
  let state = 'idle';
  let raf = 0;
  let timer = 0;
  let running = false;
  const t0 = performance.now();
  let reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // SVG-units → pixels mapper (y0 shifts the SVG origin down so scenes sit
  // nicely inside the square frame).
  function view(w, h, svgW, svgH, y0) {
    const s = Math.min(w / svgW, h / svgH);
    return { ox: (w - svgW * s) / 2, oy: (h - svgH * s) / 2, s, y0 };
  }

  function rect(v, x, y, w, h, dy, color, alpha) {
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.fillStyle = color;
    ctx.fillRect(v.ox + x * v.s, v.oy + (y - v.y0 + (dy || 0)) * v.s, w * v.s, h * v.s);
    ctx.globalAlpha = 1;
  }

  // 2×2 block rotated around a pivot — the typing/waving arms.
  function arm(v, x, y, pivotX, pivotY, angleDeg, dy, color) {
    const a = (angleDeg * Math.PI) / 180;
    ctx.save();
    ctx.translate(v.ox + pivotX * v.s, v.oy + (pivotY - v.y0 + (dy || 0)) * v.s);
    ctx.rotate(a);
    ctx.fillStyle = color || POD;
    ctx.fillRect((x - pivotX) * v.s, (y - pivotY) * v.s, 2 * v.s, 2 * v.s);
    ctx.restore();
  }

  // The chili pod: rounded-by-rects body with sheen/shade + a stem and leaf
  // on top. `stem` (0..1) controls how upright the stem stands: droopy while
  // asleep, swaying while typing, bolt upright when startled.
  function pod(v, x, w, topY, h, dy, stem) {
    // Body — narrow top/bottom rows fake a rounded pod.
    rect(v, x + 1, topY, w - 2, 1, dy, POD);
    rect(v, x, topY + 1, w, h - 2, dy, POD);
    rect(v, x + 1, topY + h - 1, w - 2, 1, dy, POD);
    // Sheen stripe on the left edge, shade on the right.
    rect(v, x + 1, topY + 2, 1, h - 4, dy, POD_HI);
    rect(v, x + w - 2, topY + 2, 1, h - 4, dy, POD_LO);
    // Stem: base + a tip block leaning with `lean` (-1 droopy … +1 upright).
    const cx = x + w / 2;
    rect(v, cx - 0.5, topY - 2, 1, 2, dy, LEAF_LO);
    const lean = (1 - stem) * -2.5; // droops to the left as stem relaxes
    rect(v, cx - 0.5 + lean, topY - 3, 1, 1, dy, LEAF);
    // Leaf flag next to the stem tip.
    rect(v, cx + 0.5 + lean * 0.5, topY - 3, 2, 1, dy, LEAF);
  }

  // ── SLEEP: pod lying flat, breathing puff, droopy stem, floating z's ──
  function drawSleep(w, h, t) {
    const v = view(w, h, 17, 7, 9);
    const phase = (t % 4.5) / 4.5;
    const breathe = phase < 0.4 ? Math.sin((phase / 0.4) * Math.PI) : 0;

    // Shadow widens with the breath.
    const shScale = 1.0 + breathe * 0.03;
    rect(v, -1, 15, 17 * shScale, 1, 0, '#000', 0.35 + breathe * 0.08);
    // Legs sticking up from behind the lying pod.
    for (const x of [3, 5, 9, 11]) rect(v, x, 8.5, 1, 1.5, 0, POD_LO);
    // Lying pod — horizontal, puffs a little on inhale.
    const puff = Math.max(0, breathe) * 0.25;
    const bodyH = 5 * (1 + puff);
    const bodyW = 13 * (1 + breathe * 0.015);
    const bx = 1 - (bodyW - 13) / 2;
    const by = 15 - bodyH;
    rect(v, bx + 1, by, bodyW - 2, 1, 0, POD);
    rect(v, bx, by + 1, bodyW, bodyH - 2, 0, POD);
    rect(v, bx + 1, by + bodyH - 1, bodyW - 2, 1, 0, POD);
    rect(v, bx + 1, by + 1, bodyW - 2, 1, 0, POD_HI);
    // Stem drooping off the right end.
    rect(v, bx + bodyW - 2, by - 1, 2, 1, 0, LEAF_LO);
    rect(v, bx + bodyW, by, 2, 1, 0, LEAF);
    // Shut eyes (move with the puff) + rosy cheeks.
    const eyeY = by + bodyH * 0.42 - puff * 2.5;
    rect(v, 3.5, eyeY, 2.5, 1, 0, EYE);
    rect(v, 9.5, eyeY, 2.5, 1, 0, EYE);
    rect(v, 3, eyeY + 1.3, 1.5, 0.8, 0, CHEEK, 0.8);
    rect(v, 11, eyeY + 1.3, 1.5, 0.8, 0, CHEEK, 0.8);

    // Floating z's — staggered loop rising above the body.
    for (let i = 0; i < 3; i += 1) {
      const cycle = 2.8 + i * 0.3;
      const p = ((t - i * 0.9) % cycle) / cycle;
      if (p < 0) continue;
      const baseOp = 0.7 - i * 0.1;
      const op = p < 0.8 ? baseOp : (1 - p) * 3.5 * baseOp;
      const px = w * (0.5 + 0.1 + i * 0.07 + Math.sin(p * Math.PI * 2) * 0.03);
      const py = h * 0.55 - h * (0.15 + p * 0.38);
      ctx.globalAlpha = Math.max(0, Math.min(1, op));
      ctx.fillStyle = '#fff';
      ctx.font = `900 ${Math.max(5, h * (0.18 + p * 0.1))}px ui-monospace, monospace`;
      ctx.fillText('z', px, py);
      ctx.globalAlpha = 1;
    }
  }

  // ── WORK: typing bounce + alternating arms + flashing keys + swaying stem ──
  function drawWork(w, h, t) {
    const v = view(w, h, 16, 11, 5.5);
    const dy = Math.sin((t * 2 * Math.PI) / 0.35) * 1.2; // 0.35s bounce
    const breathe = Math.sin((t * 2 * Math.PI) / 3.2);
    const armLRaw = Math.sin((t * 2 * Math.PI) / 0.15);
    const armL = armLRaw * 22.5 - 32.5;
    const armRRaw = Math.sin((t * 2 * Math.PI) / 0.12);
    const armR = armRRaw * 22.5 + 32.5;
    const leftHit = armLRaw > 0.3;
    const rightHit = armRRaw > 0.3;

    // Shadow shrinks while the body is up.
    const shadowW = 9 - Math.abs(dy) * 0.3;
    rect(v, 3 + (9 - shadowW) / 2, 15, shadowW, 1, 0, '#000', Math.max(0.1, 0.4 - Math.abs(dy) * 0.03));
    // Short legs behind the keyboard.
    for (const x of [4, 6, 9, 11]) rect(v, x, 13, 1, 2, 0, POD_LO);
    // Upright chili pod (slightly narrower than the old square body).
    const bodyW = 10 * (1 + breathe * 0.015);
    pod(v, 3 - (bodyW - 10) / 2, bodyW, 5.5, 7.5, dy, 0.55 + 0.25 * Math.sin(t * 2 * Math.PI / 0.7));
    // Eyes: squinted focus, occasional scan-up + blink.
    const scanPhase = t % 10;
    let eyeScale = scanPhase > 5.7 && scanPhase < 6.9 ? 1.0 : 0.5;
    const eyeDY = eyeScale < 0.8 ? 1.0 : -0.5;
    if (t % 3.5 > 1.4 && t % 3.5 < 1.55) eyeScale = 0.1;
    const eyeH = Math.max(0.2, 2 * eyeScale);
    const eyeY = 8 + (2 - eyeH) / 2 + eyeDY;
    rect(v, 5, eyeY, 1, eyeH, dy, EYE);
    rect(v, 9.5, eyeY, 1, eyeH, dy, EYE);
    // Keyboard: base + 6×3 key grid.
    rect(v, -0.5, 11.8, 16, 3.5, 0, KB_BASE);
    for (let row = 0; row < 3; row += 1) {
      for (let col = 0; col < 6; col += 1) {
        const kw = col === 2 && row === 1 ? 4.5 : 2.0;
        rect(v, 0.3 + col * 2.5, 12.2 + row * 1.0, kw, 0.7, 0, KB_KEY);
      }
    }
    // Key flashes synced with arm hits.
    if (leftHit) {
      const col = Math.floor(t / 0.15) % 3;
      rect(v, 0.3 + col * 2.5, 12.2 + (col % 3) * 1.0, 2, 0.7, 0, KB_HI, 0.9);
    }
    if (rightHit) {
      const col = 3 + (Math.floor(t / 0.12) % 3);
      rect(v, 0.3 + col * 2.5, 12.2 + ((col - 3) % 3) * 1.0, 2, 0.7, 0, KB_HI, 0.9);
    }
    // Arms on top, pivoting at the pod edge.
    arm(v, 1, 9, 3, 10, armL, dy);
    arm(v, 12, 9, 12, 10, armR, dy);
  }

  // Alert jump keyframes (decaying startle jumps over a 3.5s cycle), same
  // cadence as CodeIsland's notification keyframes.
  const JUMP_KF = [
    [0, 0], [0.03, 0], [0.10, -1], [0.15, 1.5],
    [0.175, -10], [0.20, -10], [0.25, 1.5],
    [0.275, -8], [0.30, -8], [0.35, 1.2],
    [0.375, -5], [0.40, -5], [0.45, 1.0],
    [0.475, -3], [0.50, -3], [0.55, 0.5],
    [0.62, 0], [1.0, 0],
  ];
  const WAVE_KF = [
    [0, 0], [0.03, 0], [0.10, 25],
    [0.15, 30], [0.20, 155], [0.25, 115],
    [0.30, 140], [0.35, 100], [0.40, 115],
    [0.45, 80], [0.50, 80], [0.55, 40],
    [0.62, 0], [1.0, 0],
  ];

  // ── ALERT: alarm glow + decaying jumps + rigid stem + waving arms + "!" ──
  function drawAlert(w, h, t) {
    // Pulsing alarm glow behind the character.
    const glow = 0.12 + 0.1 * (0.5 + 0.5 * Math.sin((t * 2 * Math.PI) / 1.0));
    ctx.fillStyle = ALERT;
    ctx.globalAlpha = glow;
    ctx.beginPath();
    ctx.arc(w / 2, h * 0.55, w * 0.42, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    const v = view(w, h, 15, 12, 4);
    const pct = (t % 3.5) / 3.5;
    const jumpY = lerp(JUMP_KF, pct);
    // Squash wider/shorter on landing.
    const scaleX = jumpY > 0.5 ? 1 + jumpY * 0.05 : 1;
    const scaleY = jumpY > 0.5 ? 1 - jumpY * 0.04 : 1;
    const wave = lerp(WAVE_KF, pct);

    // Shadow reacts to jump height.
    const up = Math.abs(Math.min(0, jumpY));
    const shadowW = 9 * (1 - up * 0.04);
    rect(v, 3 + (9 - shadowW) / 2, 15, shadowW, 1, 0, '#000', Math.max(0.08, 0.5 - up * 0.04));
    // Legs.
    for (const x of [4, 6, 9, 11]) rect(v, x, 11, 1, 4, 0, POD_LO);
    // Chili pod with squash/stretch, anchored at the bottom; stem bolt upright.
    const bodyW = 10 * scaleX;
    const bodyH = 7.5 * scaleY;
    pod(v, 2.5 - (bodyW - 10) / 2, bodyW, 6 + (7.5 - bodyH), bodyH, jumpY, 1);
    // Eyes widen during the initial startle.
    const eyeScale = pct > 0.03 && pct < 0.15 ? 1.3 : 1.0;
    const eyeDY = pct > 0.03 && pct < 0.15 ? -0.5 : 0;
    const eyeH = 2 * eyeScale;
    const eyeY = 8 + (2 - eyeH) / 2 + eyeDY;
    rect(v, 4.5, eyeY, 1, eyeH, jumpY, EYE);
    rect(v, 9.5, eyeY, 1, eyeH, jumpY, EYE);
    // Waving arms.
    arm(v, 0.5, 9, 2.5, 10, wave, jumpY);
    arm(v, 12.5, 9, 12.5, 10, -wave, jumpY);
    // "!" pops above the head (damped so it rides the jump gently).
    const bangOp = lerp([[0, 0], [0.03, 1], [0.10, 1], [0.55, 1], [0.62, 0], [1.0, 0]], pct);
    if (bangOp > 0.01) {
      const bangScale = lerp([[0, 0.3], [0.03, 1.3], [0.10, 1.0], [0.55, 1.0], [0.62, 0.6], [1.0, 0.6]], pct);
      const bw = 2 * bangScale;
      const by = 3.5 + jumpY * 0.15;
      rect(v, 13, by, bw, 3.5 * bangScale, 0, ALERT, bangOp);
      rect(v, 13, by + 4 * bangScale, bw, 1.5 * bangScale, 0, ALERT, bangOp);
    }
  }

  function drawFrame() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const t = reducedMotion ? 0 : (performance.now() - t0) / 1000;
    const scene = sceneForState(state);
    if (scene === 'alert') drawAlert(w, h, t);
    else if (scene === 'work') drawWork(w, h, t);
    else drawSleep(w, h, t);
  }

  // Idle animation is intentionally low-frequency; active work stays smooth
  // without waking the renderer 60 times per second forever.
  function schedule() {
    if (!running || reducedMotion || document.hidden || timer || raf) return;
    const interval = sceneForState(state) === 'sleep' ? 125 : 50;
    timer = window.setTimeout(() => {
      timer = 0;
      raf = requestAnimationFrame(() => {
        raf = 0;
        drawFrame();
        schedule();
      });
    }, interval);
  }

  function cancelScheduledFrame() {
    if (timer) window.clearTimeout(timer);
    if (raf) cancelAnimationFrame(raf);
    timer = 0;
    raf = 0;
  }

  // Size the backing store to the CSS size × devicePixelRatio for crisp rects.
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const sizePx = Math.max(1, Math.round(canvas.clientWidth || 24));
    canvas.width = sizePx * dpr;
    canvas.height = sizePx * dpr;
    drawFrame();
  }

  function onVisibilityChange() {
    cancelScheduledFrame();
    if (!document.hidden) {
      drawFrame();
      schedule();
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      resize();
      window.addEventListener('resize', resize);
      document.addEventListener('visibilitychange', onVisibilityChange);
      schedule();
    },
    stop() {
      running = false;
      cancelScheduledFrame();
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    },
    setState(next) {
      const changed = state !== (next || 'idle');
      state = next || 'idle';
      if (changed) {
        cancelScheduledFrame();
        drawFrame();
        schedule();
      }
    },
    setReducedMotion(next) {
      const changed = reducedMotion !== !!next;
      reducedMotion = !!next;
      if (!changed) return;
      cancelScheduledFrame();
      drawFrame();
      schedule();
    },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createMascot, sceneForState, lerpKeyframes: lerp };
}
