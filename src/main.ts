import { createWorld, step, fire, startReload, canFire, type Controller, type World } from './core/world';
import { makeBotController } from './ai/behaviour';
import { createRenderState, render, ingestEvents, screenToWorld } from './render/canvas';
import { attachInput, moveAxis, type InputState } from './input';
import './style.css';

const TICK_MS = 1000 / 60;
const MAX_CATCHUP = 5; // never simulate more than this many ticks per frame

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const input = attachInput(canvas);
const rs = createRenderState();

function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  rs.dpr = dpr;
}
window.addEventListener('resize', resize);

let wantReload = false;

/** Translates raw input into the same Controller shape the bots use. */
function makePlayerController(inp: InputState): Controller {
  return (w, e) => {
    const ax = moveAxis(inp.keys);
    e.vel.x = ax.x * e.speed;
    e.vel.y = ax.y * e.speed;

    // Screen -> world: undo the camera translation and zoom.
    const m = screenToWorld(rs, inp.mouseX, inp.mouseY);
    e.aim = Math.atan2(m.y - e.pos.y, m.x - e.pos.x);

    if (wantReload || e.weapon.ammo === 0) {
      wantReload = false;
      startReload(w, e);
    }
    if (inp.firing && canFire(w, e)) fire(w, e, e.aim);
  };
}

let world: World;
let controllers: Map<number, Controller>;
let playerId: number;

function newMatch(seed = Math.floor(Math.random() * 1e9)): void {
  world = createWorld(seed);
  rs.anims.clear();
  const bot = makeBotController();
  const player = makePlayerController(input);
  controllers = new Map();
  playerId = world.entities.find((e) => e.team === 'player')!.id;
  for (const e of world.entities) {
    controllers.set(e.id, e.id === playerId ? player : bot);
  }
  rs.camera.x = world.entities[0].pos.x;
  rs.camera.y = world.entities[0].pos.y;
}

resize();
newMatch();

let last = performance.now();
let acc = 0;

function frame(now: number): void {
  acc += now - last;
  last = now;

  // R reloads mid-match; once the match is decided (or you're dead) it restarts.
  if (input.consumePress('r')) {
    const me = world.entities.find((e) => e.id === playerId);
    if (world.over || !me || !me.alive) newMatch();
    else wantReload = true;
  }

  let steps = 0;
  while (acc >= TICK_MS && steps < MAX_CATCHUP) {
    acc -= TICK_MS;
    steps++;
    if (!world.over) {
      step(world, controllers);
      ingestEvents(rs, world, world.events);
    }
  }
  if (acc > TICK_MS * 10) acc = 0; // tab was backgrounded; don't fast-forward

  render(ctx, world, rs, playerId);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);