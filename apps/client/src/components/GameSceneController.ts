/**
 * Imperative PixiJS v8 overworld controller responsible for:
 *  - Initializing the WebGL/Canvas renderer sized to the host container.
 *  - Baking the static map (world border, encounter buildings, and solid walls) into a cached texture.
 *  - Listening to WASD/Arrow keyboard inputs and window/visibility focus events to emit `WASD` vectors.
 *  - Running a 60fps-style ticker with client-side movement prediction for the local player,
 *    smooth exponential interpolation for remote players, and camera centering on `myId`.
 */
import { Application, Container, Graphics, Text } from "pixi.js";
import { BUILDINGS, WALLS, MAP_WIDTH, MAP_HEIGHT, PLAYER_RADIUS, stepMovement } from "../../../../shared/map-zones";
import type { EntityPos } from "../hooks/useGameRoom";

export class GameSceneController {
  private app = new Application();
  private world = new Container();
  private mapLayer: Container | null = null;
  private sprites = new Map<string, Container>();
  private keys = new Set<string>();
  private input: { dx: -1 | 0 | 1; dy: -1 | 0 | 1 } = { dx: 0, dy: 0 };
  private destroyed = false;
  private initialized = false;

  constructor(
    private host: HTMLElement,
    private myId: string,
    private positions: Map<string, EntityPos>,
    private getMovementLocked: () => boolean,
    private sendWASD: (dx: -1 | 0 | 1, dy: -1 | 0 | 1) => void
  ) {}

  /**
   * Asynchronously initializes the PixiJS application, mounts the canvas into `host`,
   * constructs the static map layer, binds keyboard/focus listeners, and starts the frame ticker.
   */
  async init(): Promise<void> {
    await this.app.init({
      resizeTo: this.host,
      backgroundColor: 0x0f172a,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true
    });
    // Guard against races where `destroy()` is called while `this.app.init()` is still awaiting.
    if (this.destroyed) {
      this.app.destroy(true, { children: true });
      return;
    }

    this.host.appendChild(this.app.canvas);
    this.app.stage.addChild(this.world);
    this.buildStaticMap();
    this.bindInputListeners();
    this.initialized = true;

    this.app.ticker.add((ticker) => {
      // Clamp frame delta to 100ms so background tab switches do not cause huge simulation jumps.
      const dt = Math.min(0.1, ticker.deltaMS / 1000);
      this.tick(dt);
    });
  }

  /**
   * Clears held movement keys when movement is locked (e.g., on disconnect, unsynced state, or combat)
   * and re-evaluates the net input vector so movement stops immediately.
   */
  setMovementLocked(locked: boolean): void {
    if (locked) {
      this.keys.clear();
    }
    this.syncKeys();
  }

  /**
   * Draws world bounds, building encounter zones, and collision walls onto a single `mapLayer`
   * container and caches it as a texture so panning the camera avoids re-drawing static geometry.
   */
  private buildStaticMap(): void {
    const mapLayer = new Container();
    const mapGfx = new Graphics();
    mapGfx.rect(0, 0, MAP_WIDTH, MAP_HEIGHT).stroke({ width: 4, color: 0x334155 });

    for (const b of BUILDINGS) {
      mapGfx.rect(b.x, b.y, b.w, b.h).fill({ color: 0x1e293b }).stroke({ width: 2, color: 0xfacc15 });
      const label = new Text({ text: b.name ?? b.id, style: { fill: 0xfacc15, fontSize: 13 } });
      label.x = b.x + 8;
      label.y = b.y + 8;
      mapLayer.addChild(label);
    }

    for (const w of WALLS) {
      mapGfx.rect(w.x, w.y, w.w, w.h).fill({ color: 0x64748b });
    }

    mapLayer.addChildAt(mapGfx, 0);
    mapLayer.cacheAsTexture(true);
    this.mapLayer = mapLayer;
    this.world.addChildAt(mapLayer, 0);
  }

  /**
   * Computes normalized (-1, 0, 1) horizontal and vertical movement axes from held keys,
   * forcing zero movement whenever `getMovementLocked()` is true, and sends a `WASD` update
   * only when the net direction vector changes.
   */
  private syncKeys = (): void => {
    const dx = (this.getMovementLocked()
      ? 0
      : (this.keys.has("KeyD") || this.keys.has("ArrowRight") ? 1 : 0) -
        (this.keys.has("KeyA") || this.keys.has("ArrowLeft") ? 1 : 0)) as -1 | 0 | 1;
    const dy = (this.getMovementLocked()
      ? 0
      : (this.keys.has("KeyS") || this.keys.has("ArrowDown") ? 1 : 0) -
        (this.keys.has("KeyW") || this.keys.has("ArrowUp") ? 1 : 0)) as -1 | 0 | 1;

    if (dx !== this.input.dx || dy !== this.input.dy) {
      this.input = { dx, dy };
      this.sendWASD(dx, dy);
    }
  };

  /**
   * Records key-down movement inputs unless focus is inside a form input element.
   */
  private onKeyDown = (e: KeyboardEvent): void => {
    const tag = (document.activeElement as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.code.startsWith("Arrow")) e.preventDefault();
    this.keys.add(e.code);
    this.syncKeys();
  };

  /**
   * Releases a held movement key and updates the active movement vector.
   */
  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
    this.syncKeys();
  };

  /**
   * Clears all held keys when the browser window loses focus to prevent "stuck" walking keys.
   */
  private onBlur = (): void => {
    this.keys.clear();
    this.syncKeys();
  };

  /**
   * Clears held keys when the document becomes hidden (e.g., switching tabs).
   */
  private onVisibilityChange = (): void => {
    if (document.hidden) {
      this.keys.clear();
      this.syncKeys();
    }
  };

  /**
   * Registers window and document listeners for keyboard input and focus resets.
   */
  private bindInputListeners(): void {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  /**
   * Per-frame scene update:
   *  - Removes sprite containers for players no longer present in `this.positions`.
   *  - Lazily creates body + floating username containers for newly seen players.
   *  - Advances local player position via client-side prediction + error reconciliation,
   *    and interpolates remote players toward their latest server `targetX`/`targetY`.
   *  - Centers `this.world` on the local player's coordinates.
   */
  private tick(dt: number): void {
    const posMap = this.positions;
    const movementLocked = this.getMovementLocked();

    for (const [id, container] of this.sprites.entries()) {
      if (!posMap.has(id)) {
        this.world.removeChild(container);
        container.destroy({ children: true, texture: true });
        this.sprites.delete(id);
      }
    }

    for (const entity of posMap.values()) {
      let container = this.sprites.get(entity.id);
      if (!container) {
        container = new Container();
        const body = new Graphics()
          .circle(0, 0, PLAYER_RADIUS)
          .fill(entity.id === this.myId ? 0x38bdf8 : 0xf43f5e);
        const nameTag = new Text({ text: entity.username, style: { fill: 0xffffff, fontSize: 11 } });
        nameTag.anchor.set(0.5, 1);
        nameTag.y = -PLAYER_RADIUS - 4;
        container.addChild(body, nameTag);
        this.world.addChild(container);
        this.sprites.set(entity.id, container);
      }

      const selfLerp = 1 - Math.exp(-10 * dt);
      const remoteLerp = 1 - Math.exp(-16 * dt);

      if (entity.id === this.myId && !movementLocked) {
        const { dx, dy } = this.input;
        const isMoving = dx !== 0 || dy !== 0;
        if (isMoving) {
          const predicted = stepMovement(entity.x, entity.y, dx, dy, dt);
          entity.x = predicted.x;
          entity.y = predicted.y;
        }
        const errX = entity.targetX - entity.x;
        const errY = entity.targetY - entity.y;
        const errDist = Math.hypot(errX, errY);
        // Snap if server position diverges by >120px (e.g., teleport/resync), otherwise smooth drift.
        if (errDist > 120) {
          entity.x = entity.targetX;
          entity.y = entity.targetY;
        } else if (errDist > (isMoving ? 28 : 1)) {
          entity.x += errX * selfLerp;
          entity.y += errY * selfLerp;
        }
      } else {
        entity.x += (entity.targetX - entity.x) * remoteLerp;
        entity.y += (entity.targetY - entity.y) * remoteLerp;
      }

      container.x = entity.x;
      container.y = entity.y;

      if (entity.id === this.myId) {
        this.world.x = this.app.screen.width / 2 - entity.x;
        this.world.y = this.app.screen.height / 2 - entity.y;
      }
    }
  }

  /**
   * Tears down event listeners, cached map textures, player sprites, and the PixiJS application.
   */
  destroy(): void {
    this.destroyed = true;
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.sprites.clear();
    if (this.mapLayer) {
      this.world.removeChild(this.mapLayer);
      this.mapLayer.destroy({ children: true, texture: true, textureSource: true });
      this.mapLayer = null;
    }
    if (this.initialized) {
      this.app.destroy(true, { children: true, texture: true });
    }
  }
}
