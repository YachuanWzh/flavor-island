'use strict';

// Pure window-sizing helper, kept dependency-free so it is unit-testable without
// Electron. Clamps the renderer's requested content height to what fits on screen:
// never below `min`, never taller than `available - topMargin` (so the island
// can't push its content off the bottom of the display — the panel scrolls
// internally instead).
function clampWindowHeight(requested, available, { min = 1, topMargin = 0 } = {}) {
  const ceiling = Math.max(min, available - topMargin);
  const bounded = Math.min(Math.max(requested, min), ceiling);
  return Math.round(bounded);
}

// Compute the window's on-screen bounds for a renderer-requested content height.
// Default placement is top-centered (the island's resting spot). Once the user
// drags the window, `userPosition` carries the released {x, y}: we keep those
// coordinates and only re-clamp the height, so content-driven resizes no longer
// snap the island back to center.
function computeWindowBounds(requestedHeight, { workArea, width, topMargin = 0, min = 1, userPosition = null } = {}) {
  let x;
  let y;
  if (userPosition) {
    x = Math.round(Math.min(Math.max(userPosition.x, workArea.x), workArea.x + Math.max(0, workArea.width - width)));
    y = Math.round(Math.min(Math.max(userPosition.y, workArea.y), workArea.y + Math.max(0, workArea.height - min)));
  } else {
    x = Math.round(workArea.x + (workArea.width - width) / 2);
    y = Math.round(workArea.y + topMargin);
  }
  const availableBelow = Math.max(min, workArea.y + workArea.height - y);
  const height = Math.round(Math.min(Math.max(requestedHeight, min), availableBelow));
  return { x, y, width, height };
}

// Notch geometry, mirroring CodeIsland's ScreenDetector. Electron exposes no
// safeAreaInsets, so a notch display is detected from its top inset: on notch
// Macs the menu bar + notch occupy ~37-38pt, while plain menu bars are ~24-25pt
// (and 0 when the menu bar is auto-hidden). The notch width follows
// CodeIsland's simulated-notch rule: 14% of the screen width clamped to
// [160, 240] logical points — on real notch displays this covers the physical
// notch (14" MBP: ~204pt) since the black bar blends into the black notch.
const NOTCH_MIN_INSET = 30;
function computeNotchMetrics({ isMac, bounds, workArea, manual = null } = {}) {
  if (!bounds || !workArea) {
    return { hasNotch: false, notchHeight: 0, notchWidth: 0 };
  }
  // `manual.mode` carries the user's notch preference:
  //  - 'off': never fuse, regardless of platform (kills macOS auto-detection too).
  //  - 'on':  fuse to the supplied dimensions on any platform — this is how a
  //    Windows notch-screen user gets the CodeIsland look, since Windows exposes
  //    no cutout API for auto-detection.
  //  - 'auto' / absent: fall through to macOS auto-detection below.
  if (manual && manual.mode === 'off') {
    return { hasNotch: false, notchHeight: 0, notchWidth: 0 };
  }
  if (manual && manual.mode === 'on') {
    return {
      hasNotch: true,
      notchHeight: Math.max(1, Math.round(manual.notchHeight) || 32),
      notchWidth: Math.max(1, Math.round(manual.notchWidth) || 200),
    };
  }
  if (!isMac) {
    return { hasNotch: false, notchHeight: 0, notchWidth: 0 };
  }
  const topInset = workArea.y - bounds.y;
  if (topInset < NOTCH_MIN_INSET) {
    return { hasNotch: false, notchHeight: 0, notchWidth: 0 };
  }
  const notchWidth = Math.round(Math.min(Math.max(bounds.width * 0.14, 160), 240));
  return { hasNotch: true, notchHeight: Math.round(topInset), notchWidth };
}

// Window bounds that fuse the island with the notch: the window is centered on
// the *physical* display and its top edge sits at the very top (y = bounds.y),
// so the black bar covers the notch instead of hanging below the work area.
// `width` is content-driven (CodeIsland sizes the bar to notchW + wings when
// collapsed and widens to ~580 when expanded), clamped to the screen.
function computeNotchWindowBounds(height, { bounds, width }) {
  const w = Math.round(Math.min(Math.max(1, width), bounds.width));
  const x = Math.round(bounds.x + (bounds.width - w) / 2);
  const y = bounds.y;
  return { x, y, width: w, height: Math.max(1, Math.min(height, bounds.height)) };
}

module.exports = { clampWindowHeight, computeWindowBounds, computeNotchMetrics, computeNotchWindowBounds };
