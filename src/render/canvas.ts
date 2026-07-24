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
  ctx.fillText(`SEED ${w.seed}   TICK ${w.tick}`, 14, 22);

  ctx.textAlign = 'right';
  ctx.fillStyle = C.ally;
  ctx.fillText(`FRIENDLY ${friendlies}`, W - 90, 22);
  ctx.fillStyle = C.enemy;
  ctx.fillText(`HOSTILE ${hostiles}`, W - 14, 22);

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