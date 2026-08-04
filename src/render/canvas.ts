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
import { drawSoldier, drawCorpse, drawDowned, stepAnim, type AnimState } from './soldier';
import type { SquadKnowledge } from '../ai/commander/snapshot';
import type { MatchStats } from '../stats';
import type { SurvivalState } from '../survival';

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
/** How far walls throw their shadow, in world px. TILE is 32. */
const SHADOW_OFF = 6;
export interface Camera {
  x: number;
  y: number;
}

export interface RenderState {
  camera: Camera;
  flashes: { x: number; y: number; life: number }[];
  /** Additive light sources — muzzle flashes, for now. */
  lights: { x: number; y: number; r: number; life: number }[];
  particles: {
    x: number;
    y: number;
    vx: number;
    vy: number;
    life: number;
    decay: number;
    warm: boolean;
  }[];
  hitMarks: { x: number; y: number; life: number }[];
  /** Directions the player has recently been shot from, in world radians. */
  damageFrom: { angle: number; life: number }[];
  killFeed: { killer: string; victim: string; friendlyKill: boolean; life: number }[];
  /** Confirmation of the player's last squad order. */
  commandToast: { text: string; life: number } | null;
  /** World point of the last order, drawn as a marker. */
  commandMark: { x: number; y: number; life: number } | null;
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
  /** Per-match tallies for the end-of-match screen. */
  stats: MatchStats | null;
  /** Set when the camera is following a squadmate because the player is out. */
  spectating: boolean;
  /** Wave director state, or null outside survival mode. */
  survival: SurvivalState | null;
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
    lights: [],
    particles: [],
    hitMarks: [],
    damageFrom: [],
    killFeed: [],
    commandToast: null,
    commandMark: null,
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
    stats: null,
    spectating: false,
    survival: null,
  };
};

/** Canvas-space pixels -> world coordinates. Used for mouse aim. */
export function screenToWorld(rs: RenderState, sx: number, sy: number): { x: number; y: number } {
  return { x: rs.camera.x + sx / rs.zoom, y: rs.camera.y + sy / rs.zoom };
}

export function teamColor(e: Entity): string {
  if (e.team === 'player') return C.player;
  return e.team === 'ally' ? C.ally : C.enemy;
}

/** Feed tick events into the visual-effects layer. */
/** Feed tick events into the visual-effects layer. */
export function ingestEvents(
  rs: RenderState,
  w: World,
  events: GameEvent[],
  playerId: number,
): void {
  for (const ev of events) {
    if (ev.type === 'fire') {
      const e = w.entities.find((x) => x.id === ev.shooterId);
      if (e) {
        const mx = e.pos.x + Math.cos(e.aim) * (e.radius + 4);
        const my = e.pos.y + Math.sin(e.aim) * (e.radius + 4);
        rs.flashes.push({ x: mx, y: my, life: 1 });
        // Bigger weapons throw more light. The shotgun's muzzle blast lighting
        // up a whole room is most of why it feels heavier than the SMG.
        const radius =
          e.weapon.id === 'shotgun'
            ? 150
            : e.weapon.id === 'marksman'
              ? 120
              : e.weapon.id === 'smg'
                ? 72
                : 95;
        rs.lights.push({ x: mx, y: my, r: radius, life: 1 });
      }
    } else if (ev.type === 'damage') {
      const v = w.entities.find((x) => x.id === ev.victimId);
      if (v) rs.hitMarks.push({ x: v.pos.x, y: v.pos.y, life: 1 });

      // Being shot from off-screen is otherwise unreadable: you lose health
      // with no indication of which way to turn.
      if (v && v.id === playerId) {
        const shooter = w.entities.find((x) => x.id === ev.shooterId);
        if (shooter) {
          const angle = Math.atan2(shooter.pos.y - v.pos.y, shooter.pos.x - v.pos.x);
          // Merge with a recent mark from roughly the same bearing rather than
          // stacking six overlapping arcs from one shotgun blast.
          const near = rs.damageFrom.find((d) => Math.abs(d.angle - angle) < 0.3);
          if (near) near.life = 1;
          else rs.damageFrom.push({ angle, life: 1 });
        }
      }
    } else if (ev.type === 'death') {
      rs.shake = Math.min(1, rs.shake + 0.5);

      // Most of a match happens off-screen. Without this you never learn that
      // your squad won a fight two buildings away.
      const label = (id: number): string => {
        if (id === playerId) return 'YOU';
        const ent = w.entities.find((x) => x.id === id);
        if (!ent) return `#${id}`;
        return ent.team === 'enemy' ? `HOSTILE #${id}` : `ALLY #${id}`;
      };
      const killer = w.entities.find((x) => x.id === ev.killerId);
      rs.killFeed.push({
        // Self-kill only happens when a casualty bleeds out with no known
        // shooter — show it as bleeding out rather than as killing themselves.
        killer: ev.killerId === ev.victimId ? '' : label(ev.killerId),
        victim:
          ev.killerId === ev.victimId
            ? `${label(ev.victimId)} BLED OUT`
            : label(ev.victimId),
        friendlyKill: !killer || killer.team !== 'enemy',
        life: 1,
      });
      if (rs.killFeed.length > 6) rs.killFeed.shift();
    } else if (ev.type === 'downed' || ev.type === 'revived') {
      if (ev.type === 'downed') rs.shake = Math.min(1, rs.shake + 0.3);
      const id = ev.type === 'downed' ? ev.victimId : ev.entityId;
      const v = w.entities.find((x) => x.id === id);
      if (v) {
        // Hostile casualties are hostile news — labelling every downed unit
        // "ALLY" made enemy losses read as your own.
        const hostile = v.team === 'enemy';
        const who =
          v.id === playerId ? 'YOU' : `${hostile ? 'HOSTILE' : 'ALLY'} #${v.id}`;
        const verb =
          ev.type === 'downed'
            ? v.id === playerId
              ? 'ARE DOWN'
              : 'DOWN'
            : v.id === playerId
              ? 'ARE UP'
              : 'REVIVED';
        rs.killFeed.push({
          killer: '',
          victim: `${who} ${verb}`,
          friendlyKill: !hostile,
          life: 1,
        });
        if (rs.killFeed.length > 6) rs.killFeed.shift();
      }
     } else if (ev.type === 'explosion') {
      rs.shake = Math.min(1, rs.shake + 0.9);
      rs.lights.push({ x: ev.x, y: ev.y, r: ev.radius * 2.4, life: 1 });
      // A lot of debris, thrown outward from the centre rather than in a
      // random cloud, so the blast reads as directional force.
      const n = 26;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.random() * 0.2;
        const speed = 2.5 + Math.random() * 5;
        rs.particles.push({
          x: ev.x,
          y: ev.y,
          vx: Math.cos(a) * speed,
          vy: Math.sin(a) * speed,
          life: 1,
          decay: 0.03,
          warm: true,
        });
      }
    } else if (ev.type === 'impact') {
      // Wall strikes throw a tight cone of sparks; body hits throw a slower,
      // wider spray. Capped so a shotgun blast into a wall — seven pellets at
      // once — cannot flood the buffer.
      if (rs.particles.length > 260) continue;
      const n = ev.onEntity ? 6 : 5;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const speed = ev.onEntity ? 0.6 + Math.random() * 1.6 : 1.2 + Math.random() * 3.2;
        rs.particles.push({
          x: ev.x,
          y: ev.y,
          vx: Math.cos(a) * speed,
          vy: Math.sin(a) * speed,
          life: 1,
          decay: ev.onEntity ? 0.055 : 0.085,
          warm: !ev.onEntity,
        });
      }
    }
  }
}

function decay(rs: RenderState): void {
  for (const f of rs.flashes) f.life -= 0.22;
  for (const h of rs.hitMarks) h.life -= 0.08;
  rs.flashes = rs.flashes.filter((f) => f.life > 0);
  rs.hitMarks = rs.hitMarks.filter((h) => h.life > 0);
  for (const d of rs.damageFrom) d.life -= 0.022; // ~0.75s, long enough to react
  rs.damageFrom = rs.damageFrom.filter((d) => d.life > 0);
  for (const k of rs.killFeed) k.life -= 0.005; // ~3.3s
  rs.killFeed = rs.killFeed.filter((k) => k.life > 0);
  if (rs.commandToast) {
    rs.commandToast.life -= 0.012;
    if (rs.commandToast.life <= 0) rs.commandToast = null;
  }
  if (rs.commandMark) {
    rs.commandMark.life -= 0.01;
    if (rs.commandMark.life <= 0) rs.commandMark = null;
  }

  // Slower than the sprite flash: light lingers a frame or two longer than the
  // spark, which is what stops rapid fire looking like a strobe.
  for (const l of rs.lights) l.life -= 0.13;
  rs.lights = rs.lights.filter((l) => l.life > 0);

  for (const p of rs.particles) {
    p.x += p.vx;
    p.y += p.vy;
    // Drag rather than gravity: this is a top-down view, so "down" is not a
    // direction. Sparks slow and fade in place.
    p.vx *= 0.9;
    p.vy *= 0.9;
    p.life -= p.decay;
  }
  rs.particles = rs.particles.filter((p) => p.life > 0);

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

  // Three passes rather than one. A shadow has to sit on top of the floor but
  // underneath the wall casting it, which a single pass cannot order correctly:
  // a wall drawn at (x,y) would be painted before the floor at (x+1,y+1).
  const isSolid = (tx: number, ty: number): boolean =>
    tileAt(w.map, tx, ty) === T_COVER || isWallTile(w.map, tx, ty);

  // Pass 1 — floors.
  for (let ty = ty0; ty < ty1; ty++) {
    for (let tx = tx0; tx < tx1; tx++) {
      if (isSolid(tx, ty)) continue;
      const t = tileAt(w.map, tx, ty);
      const px = tx * TILE;
      const py = ty * TILE;
      const checker = (tx + ty) % 2 === 0;

      if (t === T_INTERIOR) {
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
      } else {
        ctx.fillStyle = checker ? C.ground : C.groundAlt;
        ctx.fillRect(px, py, TILE, TILE);
      }
    }
  }

  // Pass 2 — shadows. Offset down and right, matching the lit top edge already
  // drawn on walls, so the whole map reads as lit from above-left.
  ctx.fillStyle = 'rgba(0,0,0,0.34)';
  for (let ty = ty0; ty < ty1; ty++) {
    for (let tx = tx0; tx < tx1; tx++) {
      if (!isSolid(tx, ty)) continue;
      // Skip tiles buried inside a solid mass: their shadow would be entirely
      // covered by the neighbours drawn over it in pass 3.
      if (isSolid(tx + 1, ty) && isSolid(tx, ty + 1)) continue;
      ctx.fillRect(tx * TILE + SHADOW_OFF, ty * TILE + SHADOW_OFF, TILE, TILE);
    }
  }

  // Pass 3 — solids, painted over any shadow that fell on them.
  for (let ty = ty0; ty < ty1; ty++) {
    for (let tx = tx0; tx < tx1; tx++) {
      if (!isSolid(tx, ty)) continue;
      const t = tileAt(w.map, tx, ty);
      const px = tx * TILE;
      const py = ty * TILE;

      if (t === T_COVER) {
        ctx.fillStyle = C.cover;
        ctx.fillRect(px, py, TILE, TILE);
        ctx.fillStyle = C.coverTop;
        ctx.fillRect(px + 3, py + 3, TILE - 6, 3);
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = 1;
        ctx.strokeRect(px + 0.5, py + 0.5, TILE - 1, TILE - 1);
      } else {
        ctx.fillStyle = C.wall;
        ctx.fillRect(px, py, TILE, TILE);
        // lit edge wherever a wall meets something open above it
        if (!isWallTile(w.map, tx, ty - 1)) {
          ctx.fillStyle = C.wallTop;
          ctx.fillRect(px, py, TILE, 3);
        }
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

    if (e.downed) {
      const fuse = Math.max(0, (e.bleedOutTick - w.tick) / 420);
      drawDowned(ctx, e, col, fuse, e.reviveProgress);
      continue;
    }

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

  // --- grenades -------------------------------------------------------------
  for (const g of w.grenades) {
    // Blink faster as the fuse runs down — the only warning anyone gets.
    const urgency = 1 - g.fuse / 130;
    const blink = Math.sin(g.fuse * (0.3 + urgency * 0.9)) > 0;
    ctx.fillStyle = '#3a4450';
    ctx.beginPath();
    ctx.arc(g.pos.x, g.pos.y, 4.5, 0, Math.PI * 2);
    ctx.fill();
    if (blink) {
      ctx.fillStyle = '#ff8a4a';
      ctx.beginPath();
      ctx.arc(g.pos.x, g.pos.y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    // Danger ring, so you can judge whether you are inside the blast.
    ctx.globalAlpha = 0.12 + urgency * 0.2;
    ctx.strokeStyle = C.danger;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(g.pos.x, g.pos.y, 96, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // --- squad order marker ---------------------------------------------------
  if (rs.commandMark) {
    const m = rs.commandMark;
    ctx.globalAlpha = m.life;
    ctx.strokeStyle = C.accent;
    ctx.lineWidth = 2;
    // Expands outward then fades — reads as a command landing rather than a
    // static dot sitting on the ground.
    const r = 6 + (1 - m.life) * 22;
    ctx.beginPath();
    ctx.arc(m.x, m.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(m.x, m.y, 3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // --- particles ------------------------------------------------------------
  // Drawn as short streaks along their own velocity, which reads as motion at
  // this size far better than dots do.
  ctx.lineCap = 'round';
  for (const p of rs.particles) {
    ctx.globalAlpha = Math.min(1, p.life * 1.4);
    ctx.strokeStyle = p.warm ? '#ffd9a0' : '#d8583f';
    ctx.lineWidth = p.warm ? 1.4 : 1.8;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x - p.vx * 1.6, p.y - p.vy * 1.6);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // --- lighting -------------------------------------------------------------
  // Additive pass over the finished scene, still inside the camera transform.
  // 'lighter' brightens whatever is underneath rather than painting over it,
  // so walls and soldiers near a muzzle catch the light for free.
  ctx.globalCompositeOperation = 'lighter';
  for (const l of rs.lights) {
    const t = l.life * l.life; // square it: light falls off fast, then lingers
    const g = ctx.createRadialGradient(l.x, l.y, 0, l.x, l.y, l.r);
    g.addColorStop(0, `rgba(255, 226, 170, ${0.42 * t})`);
    g.addColorStop(0.35, `rgba(255, 176, 96, ${0.16 * t})`);
    g.addColorStop(1, 'rgba(255, 150, 60, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(l.x - l.r, l.y - l.r, l.r * 2, l.r * 2);
  }
  ctx.globalCompositeOperation = 'source-over';

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

  drawDamageFeedback(ctx, rs, me, W, H);

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
  drawKillFeed(ctx, rs);
  drawSurvival(ctx, rs, W, H);
  if (rs.commandToast) {
    ctx.globalAlpha = Math.min(1, rs.commandToast.life * 3);
    ctx.textAlign = 'center';
    ctx.font = '11px ' + MONO;
    ctx.fillStyle = C.accent;
    ctx.fillText(rs.commandToast.text, W / 2, H - 68);
    ctx.globalAlpha = 1;
  }
  const baseY = H - 26;
  ctx.textAlign = 'left';

  // Match outcome is a property of the world, not of the player being alive:
  // your squad can win the match after you're dead.
  if (w.over) {
    drawScoreboard(ctx, w, rs, followId, W, H);
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

  // Spectating a squadmate: their state is shown below, so say whose it is.
  if (rs.spectating) {
    ctx.textAlign = 'left';
    ctx.font = '12px ' + MONO;
    ctx.fillStyle = C.danger;
    ctx.fillText('ELIMINATED', 14, baseY - 34);
    ctx.fillStyle = C.hudDim;
    ctx.font = '10px ' + MONO;
    ctx.fillText(`SPECTATING ALLY #${me.id}   [LMB] NEXT   [R] NEW MATCH`, 14, baseY - 20);
  }

  if (me.downed) {
    const secs = Math.max(0, (me.bleedOutTick - w.tick) / 60);
    ctx.textAlign = 'center';
    ctx.font = '18px ' + MONO;
    ctx.fillStyle = C.danger;
    ctx.fillText('DOWN', W / 2, H / 2 - 30);
    ctx.font = '11px ' + MONO;
    ctx.fillStyle = C.hudDim;
    ctx.fillText(
      me.reviveProgress > 0
        ? `BEING REVIVED — ${Math.round(me.reviveProgress * 100)}%`
        : `BLEEDING OUT — ${secs.toFixed(0)}s`,
      W / 2,
      H / 2 - 10,
    );
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
    ctx.fillStyle = wp.ammo > wp.magSize * 0.2 ? C.hudText : C.danger;
    ctx.font = '15px ui-monospace, "Cascadia Mono", Consolas, monospace';
    ctx.fillText(`${wp.ammo} / ${wp.magSize}`, W - 14, baseY - 2);
    ctx.font = '9px ui-monospace, "Cascadia Mono", Consolas, monospace';
    ctx.fillStyle = C.hudDim;
    ctx.fillText(wp.name, W - 14, baseY - 20);
  }

  // grenades — left of the ammo block
  ctx.textAlign = 'right';
  ctx.font = '11px ui-monospace, "Cascadia Mono", Consolas, monospace';
  ctx.fillStyle = me.grenades > 0 ? C.hudText : C.hudDim;
  ctx.fillText(`✦ ${me.grenades}`, W - 120, baseY - 2);

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

// --- end-of-match scoreboard ------------------------------------------------

const MONO = 'ui-monospace, "Cascadia Mono", Consolas, monospace';

/**
 * Shown when the match ends. Every figure here comes from the same event bus
 * the renderer and audio engine read, so nothing is tracked twice and the
 * simulation stays unaware it is being scored.
 */
function drawScoreboard(
  ctx: CanvasRenderingContext2D,
  w: World,
  rs: RenderState,
  followId: number,
  W: number,
  H: number,
): void {
  const me = w.entities.find((e) => e.id === followId);
  const won = w.entities.some((e) => e.alive && e.team !== 'enemy');
  const stats = rs.stats;

  const rows = w.entities
    .filter((e) => e.team !== 'enemy')
    .sort((a, b) => (a.id === followId ? -1 : b.id === followId ? 1 : a.id - b.id));

  const panelW = 480;
  const panelH = 132 + rows.length * 22;
  const px = (W - panelW) / 2;
  const py = (H - panelH) / 2;

  ctx.fillStyle = 'rgba(8,12,17,0.88)';
  ctx.fillRect(px, py, panelW, panelH);
  ctx.strokeStyle = won ? 'rgba(121,207,230,0.35)' : 'rgba(224,113,74,0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(px + 0.5, py + 0.5, panelW - 1, panelH - 1);

  ctx.textAlign = 'center';
  ctx.font = '22px ' + MONO;
  ctx.fillStyle = won ? C.accent : C.danger;
  ctx.fillText(won ? 'SECTOR CLEARED' : 'SQUAD LOST', W / 2, py + 42);

  ctx.font = '10px ' + MONO;
  ctx.fillStyle = C.hudDim;
  const secs = (w.tick / 60).toFixed(1);
  ctx.fillText(
    `SEED ${w.seed}   ${secs}s   ${won && me && !me.alive ? 'YOUR SQUAD FINISHED IT' : ''}`,
    W / 2,
    py + 60,
  );

  // column headers
  const colId = px + 24;
  const colKills = px + 210;
  const colRev = px + 278;
  const colDmg = px + 356;
  const colAcc = px + 456;
  let y = py + 88;

  ctx.font = '9px ' + MONO;
  ctx.fillStyle = C.hudDim;
  ctx.textAlign = 'left';
  ctx.fillText('UNIT', colId, y);
  ctx.textAlign = 'right';
  ctx.fillText('KILLS', colKills, y);
  ctx.fillText('REVIVES', colRev, y);
  ctx.fillText('DAMAGE', colDmg, y);
  ctx.fillText('ACCURACY', colAcc, y);

  ctx.strokeStyle = 'rgba(121,207,230,0.14)';
  ctx.beginPath();
  ctx.moveTo(px + 24, y + 6);
  ctx.lineTo(px + panelW - 24, y + 6);
  ctx.stroke();

  y += 24;
  ctx.font = '11px ' + MONO;

  for (const e of rows) {
    const s = stats?.get(e.id);
    const isMe = e.id === followId;
    ctx.fillStyle = isMe ? C.player : e.alive ? C.ally : 'rgba(121,207,230,0.4)';

    ctx.textAlign = 'left';
    ctx.fillText(isMe ? 'YOU' : `ALLY #${e.id}`, colId, y);

    ctx.textAlign = 'right';
    ctx.fillText(String(s?.kills ?? 0), colKills, y);
    // Zero revives shows as a dash: a column of noughts reads as failure when
    // it usually just means nobody needed picking up.
    const rev = s?.revives ?? 0;
    ctx.fillStyle = rev > 0 ? C.accent : ctx.fillStyle;
    ctx.fillText(rev > 0 ? String(rev) : '—', colRev, y);
    ctx.fillStyle = isMe ? C.player : e.alive ? C.ally : 'rgba(121,207,230,0.4)';
    ctx.fillText(String(Math.round(s?.damageDealt ?? 0)), colDmg, y);
    const acc = stats ? stats.accuracy(e.id) : 0;
    ctx.fillText(s?.shotsFired ? `${(acc * 100).toFixed(0)}%` : '—', colAcc, y);

    if (!e.alive) {
      // Struck through rather than hidden: who died is part of the story.
      ctx.strokeStyle = 'rgba(224,113,74,0.45)';
      ctx.beginPath();
      ctx.moveTo(colId, y - 4);
      ctx.lineTo(colId + 56, y - 4);
      ctx.stroke();
    }
    y += 22;
  }

  ctx.textAlign = 'center';
  ctx.font = '11px ' + MONO;
  ctx.fillStyle = C.hudDim;
  ctx.fillText('[R] NEW MATCH      [ESC] MENU', W / 2, py + panelH - 18);
}

/**
 * Red vignette plus edge arcs pointing at whatever last hit you. The vignette
 * also rises as health falls, so a wounded player feels wounded without having
 * to read the health bar.
 */
function drawDamageFeedback(
  ctx: CanvasRenderingContext2D,
  rs: RenderState,
  me: Entity | undefined,
  W: number,
  H: number,
): void {
  if (!me || !me.alive || rs.attract) return;

  const recent = rs.damageFrom.reduce((m, d) => Math.max(m, d.life), 0);
  const wounded = Math.max(0, 1 - me.hp / 45); // ramps in below 45 hp
  const intensity = Math.min(0.75, recent * 0.5 + wounded * 0.4);

  if (intensity > 0.01) {
    const r = Math.hypot(W, H) / 2;
    const g = ctx.createRadialGradient(W / 2, H / 2, r * 0.45, W / 2, H / 2, r);
    g.addColorStop(0, 'rgba(190, 40, 25, 0)');
    g.addColorStop(1, `rgba(190, 40, 25, ${intensity})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  const radius = Math.min(W, H) * 0.3;
  ctx.lineCap = 'round';
  for (const d of rs.damageFrom) {
    ctx.globalAlpha = d.life * 0.85;
    ctx.strokeStyle = '#ff6a48';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, radius, d.angle - 0.32, d.angle + 0.32);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.lineCap = 'butt';
}

/**
 * Sits under the minimap on the left, clear of the commander panel. Entries
 * are captured at the moment of death rather than looked up later, since
 * labels depend on who was alive at the time.
 */
function drawKillFeed(ctx: CanvasRenderingContext2D, rs: RenderState): void {
  if (rs.killFeed.length === 0) return;

  const x = 14;
  let y = 205; // below the minimap panel
  ctx.textAlign = 'left';
  ctx.font = '10px ' + MONO;

  for (const k of rs.killFeed) {
    // Fade only over the final third of the lifetime, so entries stay legible
    // while they matter and then leave cleanly.
    ctx.globalAlpha = Math.min(1, k.life * 3);

    // Status lines (downed, revived, bled out) carry no killer, so they render
    // as a single phrase rather than an arrow with nothing on its left.
    if (k.killer === '') {
      ctx.fillStyle = k.friendlyKill ? C.ally : C.enemy;
      ctx.fillText(k.victim, x, y);
      y += 15;
      continue;
    }

    ctx.fillStyle = k.friendlyKill ? C.ally : C.enemy;
    ctx.fillText(k.killer, x, y);
    const w1 = ctx.measureText(k.killer).width;

    ctx.fillStyle = C.hudDim;
    ctx.fillText(' \u25b8 ', x + w1, y);
    const w2 = ctx.measureText(' \u25b8 ').width;

    ctx.fillStyle = k.friendlyKill ? C.enemy : C.ally;
    ctx.fillText(k.victim, x + w1 + w2, y);

    y += 15;
  }
  ctx.globalAlpha = 1;
}

/**
 * Wave counter, score, and the intermission countdown. Centred at the top
 * because in survival the wave number is the thing you are actually playing
 * against — it belongs where the eye already goes.
 */
function drawSurvival(
  ctx: CanvasRenderingContext2D,
  rs: RenderState,
  W: number,
  H: number,
): void {
  const s = rs.survival;
  if (!s) return;

  ctx.textAlign = 'center';
  ctx.font = '20px ' + MONO;
  ctx.fillStyle = C.accent;
  ctx.fillText(`WAVE ${s.wave}`, W / 2, 30);

  ctx.font = '11px ' + MONO;
  ctx.fillStyle = C.hudText;
  ctx.fillText(s.score.toLocaleString(), W / 2, 48);

  // Intermission: the only moment in the mode where nothing is shooting, so
  // it gets the whole centre of the screen rather than a corner.
  if (s.countdown > 0) {
    const secs = Math.ceil(s.countdown / 60);
    ctx.font = '15px ' + MONO;
    ctx.fillStyle = C.hudDim;
    ctx.fillText('SECTOR CLEAR — SQUAD RECOVERING', W / 2, H / 2 - 40);
    ctx.font = '34px ' + MONO;
    ctx.fillStyle = C.accent;
    ctx.fillText(String(secs), W / 2, H / 2);
    ctx.font = '11px ' + MONO;
    ctx.fillStyle = C.hudDim;
    ctx.fillText(`WAVE ${s.wave + 1} INBOUND`, W / 2, H / 2 + 22);
  }
}