/**
 * Shared world geometry, movement constants, encounter building zones, and collision physics.
 * Used identically on the server (`GameRoom`) for authoritative movement and on the client
 * (`GameSceneController`) for map rendering and local movement prediction.
 */

export type Rect = { id: string; name?: string; x: number; y: number; w: number; h: number };

// World dimensions in pixels and player movement/collision constants.
export const MAP_WIDTH = 1600;
export const MAP_HEIGHT = 1200;
export const PLAYER_SPEED = 180;
export const PLAYER_RADIUS = 14;

// Named rectangular zones where stepping inside with another unengaged player triggers a battle.
export const BUILDINGS: Rect[] = [
  { id: "tavern", name: "The Rusty Mug", x: 240, y: 180, w: 200, h: 160 },
  { id: "bank", name: "Central Bank", x: 760, y: 420, w: 240, h: 180 }
];

/**
 * Returns the id of the building zone containing `(x, y)` (edges inclusive), or null when outside all zones.
 */
export function findZoneId(x: number, y: number): string | null {
  const zone = BUILDINGS.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
  return zone ? zone.id : null;
}

// Impassable obstacle rectangles that push player circles out along their closest contact normal.
export const WALLS: Rect[] = [
  { id: "rock_1", x: 520, y: 260, w: 80, h: 80 },
  { id: "wall_1", x: 480, y: 580, w: 180, h: 40 }
];

/**
 * Advances a circular entity at `(x, y)` along direction `(dx, dy)` for `dt` seconds,
 * resolving circle-vs-AABB collisions against `WALLS` and clamping the final position
 * inside `[PLAYER_RADIUS, MAP_WIDTH - PLAYER_RADIUS] x [PLAYER_RADIUS, MAP_HEIGHT - PLAYER_RADIUS]`.
 */
export function stepMovement(x: number, y: number, dx: number, dy: number, dt: number): { x: number; y: number } {
  // Normalize diagonal inputs so diagonal movement speed matches cardinal movement speed.
  const len = Math.hypot(dx, dy) || 1;
  const stepX = (dx / len) * PLAYER_SPEED * dt;
  const stepY = (dy / len) * PLAYER_SPEED * dt;

  // Sub-step so a single large `dt` can never carry the circle's center past a wall's surface
  // (which would make the push-out normal degenerate and let players tunnel through).
  const substeps = Math.max(1, Math.ceil(Math.hypot(stepX, stepY) / (PLAYER_RADIUS / 2)));
  let nx = x;
  let ny = y;
  for (let i = 0; i < substeps; i++) {
    nx = clampX(nx + stepX / substeps);
    ny = clampY(ny + stepY / substeps);
    for (const w of WALLS) {
      const pushed = pushOutOfRect(nx, ny, w);
      nx = pushed.x;
      ny = pushed.y;
    }
    // Re-clamp after wall resolution so wall pushes never push a player outside world bounds.
    nx = clampX(nx);
    ny = clampY(ny);
  }

  return { x: nx, y: ny };
}

const clampX = (v: number) => Math.max(PLAYER_RADIUS, Math.min(MAP_WIDTH - PLAYER_RADIUS, v));
const clampY = (v: number) => Math.max(PLAYER_RADIUS, Math.min(MAP_HEIGHT - PLAYER_RADIUS, v));

/**
 * Pushes a circle at `(x, y)` out of rectangle `w` along the contact normal. If the circle's center
 * is already inside the rectangle, exits along the axis of least penetration.
 */
function pushOutOfRect(x: number, y: number, w: Rect): { x: number; y: number } {
  const cx = Math.max(w.x, Math.min(x, w.x + w.w));
  const cy = Math.max(w.y, Math.min(y, w.y + w.h));
  const vx = x - cx;
  const vy = y - cy;
  const dSq = vx * vx + vy * vy;
  if (dSq >= PLAYER_RADIUS * PLAYER_RADIUS) return { x, y };

  if (dSq > 0) {
    const d = Math.sqrt(dSq);
    return { x: x + (vx / d) * (PLAYER_RADIUS - d), y: y + (vy / d) * (PLAYER_RADIUS - d) };
  }

  // Center is inside the rectangle: exit through the nearest face.
  const left = x - w.x;
  const right = w.x + w.w - x;
  const top = y - w.y;
  const bottom = w.y + w.h - y;
  const min = Math.min(left, right, top, bottom);
  if (min === left) return { x: w.x - PLAYER_RADIUS, y };
  if (min === right) return { x: w.x + w.w + PLAYER_RADIUS, y };
  if (min === top) return { x, y: w.y - PLAYER_RADIUS };
  return { x, y: w.y + w.h + PLAYER_RADIUS };
}
