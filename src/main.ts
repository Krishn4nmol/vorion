import { createWorld, step, fire, startReload, canFire, throwGrenade, type Controller, type World } from './core/world';
import { makeBotController } from './ai/behaviour';
import { createRenderState, render, ingestEvents, screenToWorld, VIEW_H } from './render/canvas';
import { attachInput, moveAxis, type InputState } from './input';
import { Commander } from './ai/commander/runtime';
import './style.css';
import { AudioEngine } from './render/audio';
import { createKnowledge, updateKnowledge, markHeard } from './ai/commander/snapshot';
import { createBrowserAsk, QuotaError } from './ai/commander/browserAsk';
import { ScriptedCommander } from './ai/commander/scripted';
import { expireOrders } from './ai/commander/orders';
import { commandSquad, hostileAt } from './squadCommand';
import { MatchStats } from './stats';
import { sideOf, type WeaponId } from './core/entity';
import { setupMenu, type Scale } from './menu';

const TICK_MS = 1000 / 60;
const MAX_CATCHUP = 5;

/**
 * 5 seconds between decisions — 12 requests/minute, under the free tier's
 * 15 RPM ceiling. Orders that change faster than units can carry them out are
 * noise anyway.
 */
const COMMAND_INTERVAL_TICKS = 300;
/** Matches the audio engine's MAX_DIST: if you can hear it, you can map it. */
const HEARING_RANGE = 1400;
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
let wantGrenade = false;

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
    if (wantGrenade) {
      wantGrenade = false;
      throwGrenade(w, e, screenToWorld(rs, inp.mouseX, inp.mouseY));
    }
    if (inp.firing && canFire(w, e)) fire(w, e, e.aim);
  };
}

let world: World;
let controllers: Map<number, Controller>;
let playerId: number;
let commander: Commander | null = null;
let scripted: ScriptedCommander | null = null;
let commanderEnabled = true;

/**
 * Cleared after this long, so a transient rate limit doesn't disable the
 * commander for the whole browser session.
 */
let quotaBlockedUntil = 0;

const ask = ((base) => async (system: string, user: string) => {
  try {
    return await base(system, user);
  } catch (e) {
    if (e instanceof QuotaError) quotaBlockedUntil = Date.now() + 10 * 60 * 1000;
    throw e;
  }
})(createBrowserAsk(MODEL));

let loadout: WeaponId = 'rifle';
let scale: Scale = 'skirmish';

/**
 * Larger squads make matches roughly 35% longer, not dramatically so: more
 * units means more simultaneous engagements, so casualties accumulate faster
 * and the two effects nearly cancel. Both configurations are balanced within
 * a few points of even.
 */
const SCALES: Record<Scale, { mapW: number; mapH: number; allies: number; enemies: number }> = {
  skirmish: { mapW: 64, mapH: 48, allies: 3, enemies: 4 },
  battle: { mapW: 96, mapH: 72, allies: 5, enemies: 6 },
};

/**
 * `attract` puts a bot in the player's slot, so a match plays out behind the
 * title screen instead of a frozen frame.
 */
function newMatch(seed = Math.floor(Math.random() * 1e9), attract = false): void {
  // Varied weapons in play; the evaluation harness keeps the uniform default
  // so its published numbers stay reproducible.
  world = createWorld(seed, {
    ...SCALES[scale],
    weapons: 'varied',
    playerWeapon: loadout,
    grenades: 2,
    revives: true,
  });
  rs.anims.clear();
  rs.stats = new MatchStats();

  const bot = makeBotController();
  const player = makePlayerController(input);
  controllers = new Map();
  playerId = world.entities.find((e) => e.team === 'player')!.id;
  for (const e of world.entities) {
    controllers.set(e.id, e.id === playerId && !attract ? player : bot);
  }
  rs.attract = attract;

  // Side 1 is the hostile squad. No commander in attract mode: nobody is
  // watching closely enough to justify spending API quota while the title
  // screen sits open. Once the budget is gone the squad keeps coordinating via
  // the scripted commander rather than reverting to fighting individually.
  commander = null;
  scripted = null;
  if (commanderEnabled && !attract) {
    if (Date.now() < quotaBlockedUntil) {
      scripted = new ScriptedCommander(createKnowledge(1), COMMAND_INTERVAL_TICKS);
    } else {
      commander = new Commander(createKnowledge(1), ask, {
        intervalTicks: COMMAND_INTERVAL_TICKS,
        mode: 'async',
        maxCalls: 60,
        timeoutMs: 6000,
      });
    }
  }

  // The player's side tracks contacts too — for the minimap's fog of war, and
  // now for validating the player's own squad orders.
  rs.knowledge = createKnowledge(0);
  spectateId = null;
  rs.commandToast = null;
  rs.commandMark = null;

  rs.camera.x = world.entities[0].pos.x;
  rs.camera.y = world.entities[0].pos.y;
}

function syncCommanderView(): void {
  if (scripted) {
    rs.commander = {
      enabled: true,
      thinking: false,
      calls: 0,
      model: 'scripted fallback — LLM budget spent',
      lastTick: world.tick,
      currentTick: world.tick,
      orders: scripted.lastOrders,
      error: null,
    };
    return;
  }
  if (!commander) {
    rs.commander = commanderEnabled
      ? null
      : {
          enabled: false,
          thinking: false,
          calls: 0,
          model: MODEL,
          lastTick: 0,
          currentTick: world.tick,
          orders: [],
          error: null,
        };
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

/**
 * Who the camera follows. Normally the player; once they are out it moves to a
 * living squadmate so the rest of the match is watchable rather than a fixed
 * shot of your own corpse.
 */
let spectateId: number | null = null;

function livingSquad(): number[] {
  return world.entities
    .filter((e) => e.alive && !e.downed && sideOf(e.team) === 0 && e.id !== playerId)
    .map((e) => e.id);
}

function followId(): number {
  const me = world.entities.find((e) => e.id === playerId);
  if (me && me.alive) return playerId;

  const squad = livingSquad();
  if (squad.length === 0) return playerId;
  if (spectateId === null || !squad.includes(spectateId)) spectateId = squad[0];
  return spectateId;
}

let paused = false;

const menu = setupMenu({
  onStart: (weapon, chosenScale) => {
    audio.unlock(); // the PLAY click is the gesture browsers require
    loadout = weapon;
    scale = chosenScale;
    paused = false;
    newMatch();
  },
  onResume: () => {
    audio.unlock();
    paused = false;
  },
  onVolume: (v) => audio.setVolume(v),
});

resize();
menu.open(false);
newMatch(undefined, true); // attract-mode match behind the title screen

let last = performance.now();
let acc = 0;

function frame(now: number): void {
  acc += now - last;
  last = now;

  // Escape pauses a live match rather than discarding it. From the title
  // screen it does nothing — there is no match to return to.
  if (input.consumePress('escape')) {
    if (menu.isOpen()) {
      if (paused) {
        paused = false;
        menu.close();
      }
    } else if (!rs.attract) {
      paused = true;
      menu.open(true);
    }
  }

  if (!menu.isOpen() && input.consumePress('r')) {
    const me = world.entities.find((e) => e.id === playerId);
    if (world.over || !me || !me.alive) newMatch();
    else wantReload = true;
  }

  // C toggles the hostile commander between matches; O hides the overlay.
  if (!menu.isOpen() && input.consumePress('c')) {
    commanderEnabled = !commanderEnabled;
    newMatch();
  }
  // Queued rather than thrown here: throwing belongs inside the fixed-timestep
  // controller, not in the render loop.
  if (!menu.isOpen() && !paused && input.consumePress('q')) wantGrenade = true;
  if (input.consumePress('o')) rs.showCommander = !rs.showCommander;
  if (input.consumePress('m')) rs.muted = audio.toggleMute();
  if (input.consumePress('n')) rs.showMinimap = !rs.showMinimap;

  // Cycling spectator targets. Left-click is free once the player is out —
  // it is the fire button only while alive.
  if (rs.spectating && input.consumeLeftClick()) {
    const squad = livingSquad();
    if (squad.length > 0) {
      const i = spectateId === null ? -1 : squad.indexOf(spectateId);
      spectateId = squad[(i + 1) % squad.length];
    }
  }

  // --- squad command --------------------------------------------------------
  // Right-click is contextual: on a known hostile it suppresses, otherwise it
  // moves. F/G/H cover the orders that need no aim point. Every one of these
  // goes through the same validator the LLM commander does.
  if (!menu.isOpen() && !paused && !rs.attract && rs.knowledge && !world.over) {
    const k = rs.knowledge;
    const m = screenToWorld(rs, input.mouseX, input.mouseY);
    let issued: string | null = null;

    if (input.consumeRightClick()) {
      const tid = hostileAt(world, k, m);
      issued = commandSquad(world, k, playerId, tid ? 'suppress' : 'advance_to', m, tid);
      rs.commandMark = { x: m.x, y: m.y, life: 1 };
    } else if (input.consumePress('f')) {
      issued = commandSquad(world, k, playerId, 'flank', m, null);
      rs.commandMark = { x: m.x, y: m.y, life: 1 };
    } else if (input.consumePress('g')) {
      issued = commandSquad(world, k, playerId, 'regroup', null, null);
    } else if (input.consumePress('h')) {
      issued = commandSquad(world, k, playerId, 'hold', null, null);
    }

    if (issued) rs.commandToast = { text: issued, life: 1 };
  }

  // Attract-mode matches loop so the title screen never sits on a dead frame.
  if (rs.attract && world.over && !paused) newMatch(undefined, true);

  // Quota can run out mid-match. Swap in the scripted commander straight away
  // rather than leaving the squad uncoordinated until the next restart.
  if (Date.now() < quotaBlockedUntil && commander && !scripted && !rs.attract) {
    scripted = new ScriptedCommander(commander.knowledge, COMMAND_INTERVAL_TICKS);
    commander = null;
  }

  let steps = 0;
  while (acc >= TICK_MS && steps < MAX_CATCHUP) {
    acc -= TICK_MS;
    steps++;
    if (!world.over && !paused) {
      step(world, controllers);
      ingestEvents(rs, world, world.events, playerId);
      rs.stats?.ingest(world.events);
      audio.ingest(world, rs, world.events, playerId, canvas.width / rs.zoom);

      if (rs.knowledge) {
        // Muzzle flashes are checked every tick — a single shot is one event
        // and missing it would lose the contact entirely.
        markHeard(world, rs.knowledge, world.events, HEARING_RANGE);
        // Line-of-sight is cheap but not free; six times a second is well past
        // what the eye can follow on a 176px map.
        if (world.tick % 10 === 0) {
          const halfDiag = Math.hypot(canvas.width / rs.zoom, VIEW_H) / 2;
          updateKnowledge(world, rs.knowledge, halfDiag);
        }
      }

      // Fire-and-forget: async mode never blocks the render loop.
      commander?.update(world);
      scripted?.update(world);
      // Player-issued orders need expiry too, and neither commander runs when
      // the hostile commander is switched off.
      if (!commander && !scripted) expireOrders(world);
    }
  }
  if (acc > TICK_MS * 10) acc = 0;

  const cam = followId();
  rs.spectating = cam !== playerId;
  syncCommanderView();
  render(ctx, world, rs, cam);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);