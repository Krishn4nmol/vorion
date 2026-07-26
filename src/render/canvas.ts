import {
  TILE,
  isWallTile,
  lineOfSight,
  tileAt,
  T_GROUND,
  T_ROAD,
  T_INTERIOR,
  T_DOOR,
  T_COVER,
} from '../core/map';
import { dist, type Entity } from '../core/entity';
import { isHostile, type World, type GameEvent } from '../core/world';
import { drawSoldier, drawCorpse, stepAnim, type AnimState } from './soldier';
import type { SquadKnowledge } from '../ai/commander/snapshot';

/**
 * Palette. Cold slate arena, ice-blue friendlies, ember enemies. Kept in one
 * place so the v1 commander overlay can borrow the same tokens.
 */
export const C = {
  void: '#0d1117',
  ground: '#181d24',
  groundAlt: '#1b2129',
  road: '#232a33',
  interior: '#242c37',
  interiorAlt: '#273039',
  door: '#3d4a3a',
  wall: '#2f3945',
  wallTop: '#414e5e',
  cover: '#453a2e',
  coverTop: '#5a4b3a',
  player: '#eef6fa',
  ally: '#79cfe6',
  enemy: '#e0714a',
  bullet: '#f3e3c3',
  flash: '#fff4d6',
  hudDim: '#5d6b7d',
  hudText: '#97a6b8',
  accent: '#79cfe6',
  danger: '#e0714a',
} as const;

export const VIEW_H = 880;
export interface Camera {
  x: number;
  y: number;
}

export interface RenderState {
  camera: Camera;
  flashes: { x: number; y: number; life: number }[];
  hitMarks: { x: number; y: number; life: number }[];
  shake: number;
  zoom: number; // device px per world unit
  dpr: number;
  anims: Map<number, AnimState>; // per-entity walk cycles; render-side only
  commander: CommanderView | null; // set by main.ts each frame
  showCommander: boolean;
  muted: boolean;
  /** What the player's side has seen — drives fog of war on the minimap. */
  knowledge: SquadKnowledge | null;
  showMinimap: boolean;
  /** True while the title screen is up — suppresses player-specific HUD. */
  attract: boolean;
  /** Static map layer, redrawn only when the seed changes. */
  minimapCache: HTMLCanvasElement | null;
  minimapSeed: number;
}

/** What the HUD knows about the AI commander. Purely presentational. */
export interface CommanderView {
  enabled: boolean;
  thinking: boolean;
  calls: number;
  model: string;
  lastTick: number;
  currentTick: number;
  orders: { unitId: number; kind: string; reason: string }[];
  error: string | null;
}

export function createRenderState(): RenderState {
  return {
    camera: { x: 0, y: 0 },
    flashes: [],
    hitMarks: [],
    shake: 0,
    zoom: 1,
    dpr: 1,
    anims: new Map(),
    commander: null,
    showCommander: true,
    muted: false,
    knowledge: null,
    showMinimap: true,
    attract: false,
    minimapCache: null,
    minimapSeed: -1,
  };
}

/** Canvas-space pixels -> world coordinates. Used for mouse aim. */
export function screenToWorld(rs: RenderState, sx: number, sy: number): { x: number; y: number } {
  return { x: rs.camera.x + sx / rs.zoom, y: rs.camera.y + sy / rs.zoom };
}

export function teamColor(e: Entity): string {
  if (e.team === 'player') return C.player;
  return e.team === 'ally' ? C.ally : C.enemy;
}

/** Feed tick events into the visual-effects layer. */
export function ingestEvents(rs: RenderState, w: World, events: GameEvent[]): void {
  for (const ev of events) {
    if (ev.type === 'fire') {
      const e = w.entities.find((x) => x.id === ev.shooterId);
      if (e) {
        rs.flashes.push({
          x: e.pos.x + Math.cos(e.aim) * (e.radius + 4),
          y: e.pos.y + Math.sin(e.aim) * (e.radius + 4),
          life: 1,
        });
      }
    } else if (ev.type === 'damage') {
      const v = w.entities.find((x) => x.id === ev.victimId);
      if (v) rs.hitMarks.push({ x: v.pos.x, y: v.pos.y, life: 1 });
    } else if (ev.type === 'death') {
      rs.shake = Math.min(1, rs.shake + 0.5);
    }
  }
}

function decay(rs: RenderState): void {
  for (const f of rs.flashes) f.life -= 0.22;
  for (const h of rs.hitMarks) h.life -= 0.08;
  rs.flashes = rs.flashes.filter((f) => f.life > 0);
  rs.hitMarks = rs.hitMarks.filter((h) => h.life > 0);
  rs.shake *= 0.85;
}

export function render(
  ctx: CanvasRenderingContext2D,
  w: World,
  rs: RenderState,
  followId: number,
): void {
  const cv = ctx.canvas;
  rs.zoom = cv.height / VIEW_H;
  const vw = cv.width / rs.zoom; // world units visible horizontally
  const vh = VIEW_H;

  // --- camera: follow, then clamp to map bounds -----------------------------
  const target = w.entities.find((e) => e.id === followId);
  if (target) {
    rs.camera.x += (target.pos.x - vw / 2 - rs.camera.x) * 0.12;
    rs.camera.y += (target.pos.y - vh / 2 - rs.camera.y) * 0.12;
  }
  const maxX = Math.max(0, w.map.w * TILE - vw);
  const maxY = Math.max(0, w.map.h * TILE - vh);
  rs.camera.x = Math.min(maxX, Math.max(0, rs.camera.x));
  rs.camera.y = Math.min(maxY, Math.max(0, rs.camera.y));

  const shakeX = rs.shake * (Math.random() - 0.5) * 10;
  const shakeY = rs.shake * (Math.random() - 0.5) * 10;
  const ox = -rs.camera.x + shakeX;
  const oy = -rs.camera.y + shakeY;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = C.void;
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.save();
  ctx.scale(rs.zoom, rs.zoom);
  ctx.translate(ox, oy);

  // --- tiles: only what's on screen ----------------------------------------
  const tx0 = Math.max(0, Math.floor(rs.camera.x / TILE) - 1);
  const ty0 = Math.max(0, Math.floor(rs.camera.y / TILE) - 1);
  const tx1 = Math.min(w.map.w, Math.ceil((rs.camera.x + vw) / TILE) + 1);
  const ty1 = Math.min(w.map.h, Math.ceil((rs.camera.y + vh) / TILE) + 1);

  for (let ty = ty0; ty < ty1; ty++) {
    for (let tx = tx0; tx < tx1; tx++) {
      const px = tx * TILE;
      const py = ty * TILE;
      const t = tileAt(w.map, tx, ty);
      const checker = (tx + ty) % 2 === 0;

      if (t === T_COVER) {
        ctx.fillStyle = C.cover;
        ctx.fillRect(px, py, TILE, TILE);
        ctx.fillStyle = C.coverTop;
        ctx.fillRect(px + 3, py + 3, TILE - 6, 3);
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = 1;
        ctx.strokeRect(px + 0.5, py + 0.5, TILE - 1, TILE - 1);
      } else if (isWallTile(w.map, tx, ty)) {
        ctx.fillStyle = C.wall;
        ctx.fillRect(px, py, TILE, TILE);
        // lit edge wherever a wall meets something open above it
        if (!isWallTile(w.map, tx, ty - 1)) {
          ctx.fillStyle = C.wallTop;
          ctx.fillRect(px, py, TILE, 3);
        }
      } else if (t === T_INTERIOR) {
        ctx.fillStyle = checker ? C.interior : C.interiorAlt;
        ctx.fillRect(px, py, TILE, TILE);
      } else if (t === T_DOOR) {
        ctx.fillStyle = C.interior;
        ctx.fillRect(px, py, TILE, TILE);
        ctx.fillStyle = C.door;
        ctx.fillRect(px + 2, py + 2, TILE - 4, TILE - 4);
      } else if (t === T_ROAD) {
        ctx.fillStyle = C.road;
        ctx.fillRect(px, py, TILE, TILE);
      } else if (t === T_GROUND) {
        ctx.fillStyle = checker ? C.ground : C.groundAlt;
        ctx.fillRect(px, py, TILE, TILE);
      }
    }
  }

  // --- building labels: the commander's vocabulary, visible to the player ---
  ctx.font = '10px ui-monospace, "Cascadia Mono", Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(151,166,184,0.30)';
  for (const b of w.map.buildings) {
    const cx = (b.x + b.w / 2) * TILE;
    const cy = (b.y + b.h / 2) * TILE;
    if (cx < rs.camera.x - 200 || cx > rs.camera.x + vw + 200) continue;
    if (cy < rs.camera.y - 200 || cy > rs.camera.y + vh + 200) continue;
    ctx.fillText(b.name, cx, cy);
  }
  // --- bullets as motion streaks -------------------------------------------
  ctx.strokeStyle = C.bullet;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const b of w.bullets) {
    ctx.moveTo(b.pos.x, b.pos.y);
    ctx.lineTo(b.pos.x - b.vel.x * 0.8, b.pos.y - b.vel.y * 0.8);
  }
  ctx.stroke();

  // --- entities -------------------------------------------------------------
  // Corpses first so the living always draw on top of them.
  for (const e of w.entities) if (!e.alive) drawCorpse(ctx, e);

  for (const e of w.entities) {
    if (!e.alive) continue;

    const col = teamColor(e);

    let anim = rs.anims.get(e.id);
    if (!anim) {
      anim = { phase: 0, legAngle: e.aim };
      rs.anims.set(e.id, anim);
    }
    stepAnim(anim, e);

    if (e.id === followId) {
      // A faint sight line only for the entity you control — the rifle already
      // communicates facing for everyone else.
      ctx.strokeStyle = C.accent;
      ctx.globalAlpha = 0.18;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(e.pos.x, e.pos.y);
      ctx.lineTo(e.pos.x + Math.cos(e.aim) * 200, e.pos.y + Math.sin(e.aim) * 200);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Order indicator. Only for units the player can actually see, so the
    // overlay never leaks enemy positions through the fog.
    const me = w.entities.find((x) => x.id === followId);
    const visible =
      !me || !me.alive || e.id === followId || lineOfSight(w.map, me.pos, e.pos);
    if (e.order && visible && rs.showCommander) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = col;
      ctx.setLineDash([4, 5]);
      ctx.lineWidth = 1.5;
      if (e.order.target) {
        ctx.beginPath();
        ctx.moveTo(e.pos.x, e.pos.y);
        ctx.lineTo(e.order.target.x, e.order.target.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(e.order.target.x, e.order.target.y, 7, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = col;
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(e.order.kind.toUpperCase(), e.pos.x, e.pos.y + 22);
      ctx.restore();
    }

    drawSoldier(ctx, e, col, anim, e.weapon.reloadEndTick > w.tick);

    // health bar
    if (e.hp < e.maxHp) {
      const bw = 22;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(e.pos.x - bw / 2, e.pos.y - 15, bw, 3);
      ctx.fillStyle = e.hp > 35 ? col : C.danger;
      ctx.fillRect(e.pos.x - bw / 2, e.pos.y - 15, bw * (e.hp / e.maxHp), 3);
    }
  }

  // --- effects --------------------------------------------------------------
  for (const f of rs.flashes) {
    ctx.globalAlpha = f.life;
    ctx.fillStyle = C.flash;
    ctx.beginPath();
    ctx.arc(f.x, f.y, 4 * f.life + 1, 0, Math.PI * 2);
    ctx.fill();
  }
  for (const h of rs.hitMarks) {
    ctx.globalAlpha = h.life * 0.9;
    ctx.strokeStyle = C.danger;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(h.x, h.y, 14 * (1 - h.life) + 6, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  decay(rs);
  drawHud(ctx, w, rs, followId);
}

function drawHud(
  ctx: CanvasRenderingContext2D,
  w: World,
  rs: RenderState,
  followId: number,
): void {
  const cv = ctx.canvas;
  // HUD is laid out in CSS pixels so text stays the same physical size on
  // high-DPI screens instead of shrinking to nothing.
  ctx.setTransform(rs.dpr, 0, 0, rs.dpr, 0, 0);
  const W = cv.width / rs.dpr;
  const H = cv.height / rs.dpr;

  const me = w.entities.find((e) => e.id === followId);
  const friendlies = w.entities.filter((e) => e.alive && e.team !== 'enemy').length;
  const hostiles = w.entities.filter((e) => e.alive && e.team === 'enemy').length;

  // --- off-screen threat markers -------------------------------------------
  // Anything that can currently shoot you but is outside the view gets an edge
  // arrow. Without this, a fixed sight range on a short window means being shot
  // by something you had no way to know about.
  if (me && me.alive) {
    const scale = rs.zoom / rs.dpr;
    const margin = 26;
    for (const e of w.entities) {
      if (!e.alive || !isHostile(me, e)) continue;
      const d = dist(me.pos, e.pos);
      if (d > e.weapon.range) continue;
      if (!lineOfSight(w.map, e.pos, me.pos)) continue;

      const sx = (e.pos.x - rs.camera.x) * scale;
      const sy = (e.pos.y - rs.camera.y) * scale;
      const onScreen = sx > margin && sx < W - margin && sy > margin && sy < H - margin;
      if (onScreen) continue;

      const cx = W / 2;
      const cy = H / 2;
      const a = Math.atan2(sy - cy, sx - cx);
      const rx = (W / 2 - margin) / Math.abs(Math.cos(a) || 1e-6);
      const ry = (H / 2 - margin) / Math.abs(Math.sin(a) || 1e-6);
      const r = Math.min(rx, ry);
      const mx = cx + Math.cos(a) * r;
      const my = cy + Math.sin(a) * r;

      ctx.save();
      ctx.translate(mx, my);
      ctx.rotate(a);
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = C.enemy;
      ctx.beginPath();
      ctx.moveTo(9, 0);
      ctx.lineTo(-6, -6);
      ctx.lineTo(-6, 6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  // telemetry strip — the deterministic sim is the point, so it's on screen
  ctx.font = '11px ui-monospace, "Cascadia Mono", Consolas, monospace';
  ctx.textAlign = 'left';
  ctx.fillStyle = C.hudDim;
  ctx.fillText(`SEED ${w.seed}   TICK ${w.tick}${rs.muted ? '   MUTED' : ''}`, 14, 22);

  ctx.textAlign = 'right';
  ctx.fillStyle = C.ally;
  ctx.fillText(`FRIENDLY ${friendlies}`, W - 90, 22);
  ctx.fillStyle = C.enemy;
  ctx.fillText(`HOSTILE ${hostiles}`, W - 14, 22);
  if (rs.attract) {
    // Behind the title screen: no health, ammo or outcome text.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return;
  }
  drawMinimap(ctx, w, rs, followId);
  drawCommanderPanel(ctx, rs, W);
  const baseY = H - 26;
  ctx.textAlign = 'left';

  // Match outcome is a property of the world, not of the player being alive:
  // your squad can win the match after you're dead.
  if (w.over) {
    const won = w.entities.some((e) => e.alive && e.team !== 'enemy');
    ctx.textAlign = 'center';
    ctx.font = '20px ui-monospace, "Cascadia Mono", Consolas, monospace';
    ctx.fillStyle = won ? C.accent : C.danger;
    ctx.fillText(won ? 'SECTOR CLEARED' : 'SQUAD LOST', W / 2, H / 2 - 8);

    ctx.font = '12px ui-monospace, "Cascadia Mono", Consolas, monospace';
    ctx.fillStyle = C.hudDim;
    const note =
      won && me && !me.alive
        ? 'YOUR SQUAD FINISHED IT   [R] NEW MATCH'
        : '[R] NEW MATCH';
    ctx.fillText(note, W / 2, H / 2 + 16);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return;
  }

  if (!me) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return;
  }

  if (!me.alive) {
    ctx.font = '13px ui-monospace, "Cascadia Mono", Consolas, monospace';
    ctx.fillStyle = C.danger;
    ctx.fillText('ELIMINATED — SPECTATING SQUAD   [R] RESTART', 14, baseY);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return;
  }

  // health
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(14, baseY - 10, 150, 6);
  ctx.fillStyle = me.hp > 35 ? C.accent : C.danger;
  ctx.fillRect(14, baseY - 10, 150 * (me.hp / me.maxHp), 6);
  ctx.fillStyle = C.hudText;
  ctx.font = '11px ui-monospace, "Cascadia Mono", Consolas, monospace';
  ctx.fillText(`${me.hp}`, 172, baseY - 4);

  // ammo / reload
  const wp = me.weapon;
  const reloading = wp.reloadEndTick > w.tick;
  ctx.textAlign = 'right';
  if (reloading) {
    const left = wp.reloadEndTick - w.tick;
    const p = 1 - left / wp.reloadTicks;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(W - 150, baseY - 10, 136, 6);
    ctx.fillStyle = C.hudDim;
    ctx.fillRect(W - 150, baseY - 10, 136 * p, 6);
    ctx.fillStyle = C.hudDim;
    ctx.fillText('RELOADING', W - 14, baseY - 14);
  } else {
    ctx.fillStyle = wp.ammo > 5 ? C.hudText : C.danger;
    ctx.font = '15px ui-monospace, "Cascadia Mono", Consolas, monospace';
    ctx.fillText(`${wp.ammo} / ${wp.magSize}`, W - 14, baseY - 2);
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/**
 * The commander panel is the whole point of the project made visible: what the
 * model decided, and why, in its own words. Reasons come straight from the
 * validated orders, so nothing here is invented by the UI.
 */
function drawCommanderPanel(ctx: CanvasRenderingContext2D, rs: RenderState, W: number): void {
  const c = rs.commander;
  if (!c || !rs.showCommander) return;

  const x = W - 250;
  let y = 46;
  const mono = 'ui-monospace, "Cascadia Mono", Consolas, monospace';

  ctx.textAlign = 'left';
  ctx.font = '10px ' + mono;

  ctx.fillStyle = c.enabled ? C.enemy : C.hudDim;
  const status = !c.enabled
    ? 'OFF'
    : c.error
      ? 'ERROR'
      : c.thinking
        ? 'THINKING…'
        : 'STANDING BY';
  ctx.fillText(`HOSTILE COMMANDER — ${status}`, x, y);
  y += 13;

  ctx.fillStyle = C.hudDim;
  ctx.font = '9px ' + mono;
  const age = c.lastTick ? ` · ${Math.round((c.currentTick - c.lastTick) / 60)}s ago` : '';
  ctx.fillText(`${c.model}   ${c.calls} calls${age}`, x, y);
  y += 14;

  if (c.error) {
    ctx.fillStyle = C.danger;
    ctx.fillText(c.error.slice(0, 40), x, y);
    y += 12;
    ctx.fillStyle = C.hudDim;
    ctx.fillText('squad reverted to autonomous', x, y);
    return;
  }

  if (c.orders.length === 0) {
    ctx.fillStyle = C.hudDim;
    ctx.fillText('no orders issued', x, y);
    return;
  }

  ctx.font = '9px ' + mono;
  for (const o of c.orders.slice(0, 5)) {
    ctx.fillStyle = C.enemy;
    ctx.fillText(`#${o.unitId} ${o.kind}`, x, y);
    ctx.fillStyle = C.hudDim;
    ctx.fillText(`"${o.reason}"`.slice(0, 42), x + 8, y + 10);
    y += 23;
  }
}

// --- minimap ---------------------------------------------------------------

const MINIMAP_W = 176; // CSS pixels
const MINIMAP_PAD = 6;

/**
 * The static layer is expensive relative to its size — 3000+ tiles — and never
 * changes within a match, so it is rendered once to an offscreen canvas and
 * blitted thereafter. Cached at 2x so it stays crisp on high-DPI screens.
 */
function buildMinimapCache(w: World): HTMLCanvasElement {
  const scale = (MINIMAP_W * 2) / w.map.w;
  const cv = document.createElement('canvas');
  cv.width = Math.ceil(w.map.w * scale);
  cv.height = Math.ceil(w.map.h * scale);
  const c = cv.getContext('2d')!;

  c.fillStyle = '#0f141b';
  c.fillRect(0, 0, cv.width, cv.height);

  for (let ty = 0; ty < w.map.h; ty++) {
    for (let tx = 0; tx < w.map.w; tx++) {
      const t = tileAt(w.map, tx, ty);
      if (t === T_GROUND) continue;
      c.fillStyle =
        t === T_ROAD
          ? '#1b222b'
          : t === T_INTERIOR || t === T_DOOR
            ? '#222b36'
            : t === T_COVER
              ? '#3a3126'
              : '#3d4855'; // wall
      c.fillRect(tx * scale, ty * scale, Math.ceil(scale), Math.ceil(scale));
    }
  }

  // Building footprints, so compounds read as structures at a glance.
  c.strokeStyle = 'rgba(120,140,165,0.35)';
  c.lineWidth = 1;
  for (const b of w.map.buildings) {
    c.strokeRect(b.x * scale, b.y * scale, b.w * scale, b.h * scale);
  }
  return cv;
}

function drawMinimap(
  ctx: CanvasRenderingContext2D,
  w: World,
  rs: RenderState,
  followId: number,
): void {
  if (!rs.showMinimap) return;

  if (!rs.minimapCache || rs.minimapSeed !== w.seed) {
    rs.minimapCache = buildMinimapCache(w);
    rs.minimapSeed = w.seed;
  }

  const mw = MINIMAP_W;
  const mh = (MINIMAP_W * w.map.h) / w.map.w;
  const ox = 14;
  const oy = 32;
  const s = mw / (w.map.w * TILE); // world px -> minimap px

  ctx.save();
  ctx.fillStyle = 'rgba(8,12,17,0.72)';
  ctx.fillRect(ox - MINIMAP_PAD, oy - MINIMAP_PAD, mw + MINIMAP_PAD * 2, mh + MINIMAP_PAD * 2);
  ctx.strokeStyle = 'rgba(120,140,165,0.25)';
  ctx.lineWidth = 1;
  ctx.strokeRect(
    ox - MINIMAP_PAD + 0.5,
    oy - MINIMAP_PAD + 0.5,
    mw + MINIMAP_PAD * 2 - 1,
    mh + MINIMAP_PAD * 2 - 1,
  );

  ctx.drawImage(rs.minimapCache, ox, oy, mw, mh);

  // viewport rectangle — what is currently on screen
  const vwWorld = ctx.canvas.width / rs.zoom;
  const vhWorld = VIEW_H;
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.strokeRect(
    ox + rs.camera.x * s,
    oy + rs.camera.y * s,
    Math.min(mw, vwWorld * s),
    Math.min(mh, vhWorld * s),
  );

  // Enemy contacts: only what the player's side has actually seen. Stale ones
  // fade rather than vanish — a contact from ten seconds ago is still worth
  // knowing about, as long as it is visibly uncertain.
  if (rs.knowledge) {
    for (const c of rs.knowledge.contacts.values()) {
      const age = w.tick - c.lastSeenTick;
      const fresh = Math.max(0.18, 1 - age / 720);
      ctx.globalAlpha = fresh;
      ctx.fillStyle = C.enemy;
      const cx = ox + (c.tile.x + 0.5) * TILE * s;
      const cy = oy + (c.tile.y + 0.5) * TILE * s;
      ctx.beginPath();
      ctx.arc(cx, cy, 2.6, 0, Math.PI * 2);
      ctx.fill();
      if (age > 180) {
        ctx.strokeStyle = C.enemy;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  for (const e of w.entities) {
    if (!e.alive || e.team === 'enemy') continue;
    const px = ox + e.pos.x * s;
    const py = oy + e.pos.y * s;
    if (e.id === followId) {
      ctx.fillStyle = C.player;
      ctx.beginPath();
      ctx.arc(px, py, 3.2, 0, Math.PI * 2);
      ctx.fill();
      // facing wedge
      ctx.strokeStyle = C.player;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + Math.cos(e.aim) * 8, py + Math.sin(e.aim) * 8);
      ctx.stroke();
    } else {
      ctx.fillStyle = C.ally;
      ctx.beginPath();
      ctx.arc(px, py, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();
}