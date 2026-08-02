import type { Entity } from '../core/entity';

/**
 * Top-down soldier, drawn procedurally — no sprite assets, no licences.
 * Lower body faces the direction of travel, upper body faces the aim, which is
 * what makes a strafing soldier read as a person rather than a rotating blob.
 */

export interface AnimState {
  phase: number; // walk cycle, radians
  legAngle: number; // smoothed facing of the lower body
}

export function stepAnim(a: AnimState, e: Entity): void {
  const speed = Math.hypot(e.vel.x, e.vel.y);
  a.phase += speed * 0.28;
  if (speed > 0.05) {
    const want = Math.atan2(e.vel.y, e.vel.x);
    let diff = want - a.legAngle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    a.legAngle += diff * 0.25;
  } else {
    let diff = e.aim - a.legAngle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    a.legAngle += diff * 0.08;
  }
}

function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, ((n >> 16) & 255) + amount));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amount));
  const b = Math.max(0, Math.min(255, (n & 255) + amount));
  return `rgb(${r},${g},${b})`;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export function drawSoldier(
  ctx: CanvasRenderingContext2D,
  e: Entity,
  color: string,
  anim: AnimState,
  isReloading: boolean,
): void {
  const dark = shade(color, -70);
  const mid = shade(color, -30);
  const skin = shade(color, 40);

  ctx.save();
  ctx.translate(e.pos.x, e.pos.y);

  // --- ground shadow --------------------------------------------------------
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(1.5, 2, 9, 8, 0, 0, Math.PI * 2);
  ctx.fill();

  // --- legs, oriented to movement ------------------------------------------
  ctx.save();
  ctx.rotate(anim.legAngle);
  const swing = Math.sin(anim.phase) * 3.2;
  ctx.fillStyle = dark;
  roundRect(ctx, -3 + swing, -5.5, 8, 4.2, 2);
  ctx.fill();
  roundRect(ctx, -3 - swing, 1.3, 8, 4.2, 2);
  ctx.fill();
  ctx.restore();

  // --- upper body, oriented to aim -----------------------------------------
  ctx.rotate(e.aim);

  // torso: narrow front-to-back, wide across the shoulders
  ctx.fillStyle = color;
  ctx.strokeStyle = dark;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.ellipse(0, 0, 6.4, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // webbing across the chest
  ctx.strokeStyle = mid;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(-1.5, -6);
  ctx.lineTo(2.5, 3);
  ctx.stroke();

  // --- rifle and arms -------------------------------------------------------
  const rifleY = 3.2;
  const recoil = isReloading ? -3 : 0;

  // support arm reaching to the fore-grip
  ctx.strokeStyle = mid;
  ctx.lineWidth = 3.4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(1, -5);
  ctx.lineTo(9 + recoil, rifleY - 1);
  ctx.stroke();

  // trigger arm
  ctx.beginPath();
  ctx.moveTo(1, 5.5);
  ctx.lineTo(5 + recoil, rifleY + 1);
  ctx.stroke();

  // weapon
  ctx.fillStyle = '#1d2129';
  roundRect(ctx, 1 + recoil, rifleY - 1.5, 16, 3, 1);
  ctx.fill();
  ctx.fillStyle = '#2a313c';
  roundRect(ctx, -1 + recoil, rifleY - 2.6, 5, 5.2, 1.5);
  ctx.fill();

  // --- head -----------------------------------------------------------------
  ctx.fillStyle = skin;
  ctx.strokeStyle = dark;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(1.2, 0, 4.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // helmet brim, so facing is readable at a glance
  ctx.fillStyle = mid;
  ctx.beginPath();
  ctx.arc(1.2, 0, 4.4, -Math.PI / 2.1, Math.PI / 2.1);
  ctx.fill();

  ctx.restore();
}

/**
 * Downed but not dead: prone, desaturated, with a revive ring that fills as a
 * squadmate works. Deliberately distinct from a corpse — the difference has to
 * be readable at a glance across the map.
 */
export function drawDowned(
  ctx: CanvasRenderingContext2D,
  e: Entity,
  color: string,
  fuse: number,
  progress: number,
): void {
  ctx.save();
  ctx.translate(e.pos.x, e.pos.y);

  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(1, 2, 10, 8, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.rotate(e.aim + 1.2); // sprawled, not facing anywhere useful
  ctx.globalAlpha = 0.75;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(0, 0, 8, 5.2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(6.5, 1, 3.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Bleed-out clock: a ring that empties as the timer runs down.
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = 'rgba(224,113,74,0.35)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(0, 0, 14, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = '#e0714a';
  ctx.beginPath();
  ctx.arc(0, 0, 14, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * fuse);
  ctx.stroke();

  if (progress > 0) {
    ctx.strokeStyle = '#79cfe6';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, 18, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
  ctx.restore();
}

export function drawCorpse(ctx: CanvasRenderingContext2D, e: Entity): void {
  ctx.save();
  ctx.translate(e.pos.x, e.pos.y);
  ctx.rotate(e.aim + 0.7);
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = '#39404b';
  ctx.beginPath();
  ctx.ellipse(0, 0, 7.5, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(6, 1, 3.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.restore();
}