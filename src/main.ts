import { createWorld, step, fire, startReload, canFire, type Controller, type World } from './core/world';
import { makeBotController } from './ai/behaviour';
import { createRenderState, render, ingestEvents, screenToWorld } from './render/canvas';
import { attachInput, moveAxis, type InputState } from './input';
import { Commander } from './ai/commander/runtime';
import { createKnowledge } from './ai/commander/snapshot';
import { createBrowserAsk } from './ai/commander/browserAsk';
import './style.css';
import { AudioEngine } from './render/audio';

const TICK_MS = 1000 / 60;
const MAX_CATCHUP = 5;

/**
 * 7 seconds between decisions. Two constraints set this: free-tier rate limits
 * (~10-15 requests/minute) and the fact that orders that change faster than
 * units can carry them out are just noise.
 */
const COMMAND_INTERVAL_TICKS = 150;
const MODEL = 'gemini-3.5-flash-lite';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const input = attachInput(canvas);
const rs = createRenderState();
const audio = new AudioEngine();

// Browsers block audio until the user interacts, so the context is created on
// the first gesture rather than at load.
for (const ev of ['pointerdown', 'keydown'] as const) {
  window.addEventListener(ev, () => audio.unlock(), { once: false });
}

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

function makePlayerController(inp: InputState): Controller {
  return (w, e) => {
    const ax = moveAxis(inp.keys);
    e.vel.x = ax.x * e.speed;
    e.vel.y = ax.y * e.speed;

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
let commander: Commander | null = null;
let commanderEnabled = true;

const ask = createBrowserAsk(MODEL);

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

  // Side 1 is the hostile squad. The player's allies stay autonomous, so the
  // comparison the player experiences is coordinated vs uncoordinated.
  commander = commanderEnabled
    ? new Commander(createKnowledge(1), ask, {
        intervalTicks: COMMAND_INTERVAL_TICKS,
        mode: 'async',
        maxCalls: 60,
        timeoutMs: 6000,
      })
    : null;

  rs.camera.x = world.entities[0].pos.x;
  rs.camera.y = world.entities[0].pos.y;
}

function syncCommanderView(): void {
  if (!commander) {
    rs.commander = commanderEnabled
      ? null
      : { enabled: false, thinking: false, calls: 0, model: MODEL, lastTick: 0, currentTick: world.tick, orders: [], error: null };
    return;
  }
  const last = commander.lastDecision;
  rs.commander = {
    enabled: true,
    thinking: commander.thinking,
    calls: commander.callCount,
    model: MODEL,
    lastTick: last?.tick ?? 0,
    currentTick: world.tick,
    orders: last?.accepted ?? [],
    error: last?.error ?? null,
  };
}

resize();
newMatch();

let last = performance.now();
let acc = 0;

function frame(now: number): void {
  acc += now - last;
  last = now;

  if (input.consumePress('r')) {
    const me = world.entities.find((e) => e.id === playerId);
    if (world.over || !me || !me.alive) newMatch();
    else wantReload = true;
  }

  // C toggles the commander between matches; O hides the overlay.
  if (input.consumePress('c')) {
    commanderEnabled = !commanderEnabled;
    newMatch();
  }
  if (input.consumePress('o')) rs.showCommander = !rs.showCommander;

  if (input.consumePress('m')) rs.muted = audio.toggleMute();

  let steps = 0;
  while (acc >= TICK_MS && steps < MAX_CATCHUP) {
    acc -= TICK_MS;
    steps++;
    if (!world.over) {
      step(world, controllers);
      ingestEvents(rs, world, world.events);
      // Fire-and-forget: async mode never blocks the render loop.
      audio.ingest(world, rs, world.events, playerId, canvas.width / rs.zoom);
      commander?.update(world);
    }
  }
  if (acc > TICK_MS * 10) acc = 0;

  syncCommanderView();
  render(ctx, world, rs, playerId);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);