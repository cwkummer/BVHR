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
  let nx = Math.max(PLAYER_RADIUS, Math.min(MAP_WIDTH - PLAYER_RADIUS, x + (dx / len) * PLAYER_SPEED * dt));
  let ny = Math.max(PLAYER_RADIUS, Math.min(MAP_HEIGHT - PLAYER_RADIUS, y + (dy / len) * PLAYER_SPEED * dt));

  // Push candidate circle out of any overlapping wall rectangle.
  for (const w of WALLS) {
    const cx = Math.max(w.x, Math.min(nx, w.x + w.w));
    const cy = Math.max(w.y, Math.min(ny, w.y + w.h));
    const vx = nx - cx;
    const vy = ny - cy;
    const dSq = vx * vx + vy * vy;
    if (dSq < PLAYER_RADIUS * PLAYER_RADIUS) {
      const d = Math.sqrt(dSq) || 0.001;
      nx += (vx / d) * (PLAYER_RADIUS - d);
      ny += (vy / d) * (PLAYER_RADIUS - d);
    }
  }

  // Re-clamp after wall resolution so wall pushes never push a player outside world bounds.
  nx = Math.max(PLAYER_RADIUS, Math.min(MAP_WIDTH - PLAYER_RADIUS, nx));
  ny = Math.max(PLAYER_RADIUS, Math.min(MAP_HEIGHT - PLAYER_RADIUS, ny));

  return { x: nx, y: ny };
}
