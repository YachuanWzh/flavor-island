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
  const height = clampWindowHeight(requestedHeight, workArea.height, { min, topMargin });
  let x;
  let y;
  if (userPosition) {
    x = Math.round(userPosition.x);
    y = Math.round(userPosition.y);
  } else {
    x = Math.round(workArea.x + (workArea.width - width) / 2);
    y = topMargin;
  }
  return { x, y, width, height };
}

module.exports = { clampWindowHeight, computeWindowBounds };
