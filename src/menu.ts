import type { WeaponId } from './core/entity';

export type Scale = 'skirmish' | 'battle';

export interface MenuHooks {
  onStart: (weapon: WeaponId, scale: Scale) => void;
  onResume: () => void;
  onVolume: (v: number) => void;
}

export interface Menu {
  /** `paused` switches the primary action from starting fresh to resuming. */
  open(paused: boolean): void;
  close(): void;
  isOpen(): boolean;
}

const VOLUME_KEY = 'vorion.volume';
const WEAPON_KEY = 'vorion.weapon';
const SCALE_KEY = 'vorion.scale';

/**
 * Title screen as a DOM overlay rather than canvas-drawn UI, so type stays
 * crisp at any DPI. Doubles as the pause screen: same panel, different verb.
 */
export function setupMenu(hooks: MenuHooks): Menu {
  const root = document.getElementById('menu');
  const startBtn = document.getElementById('start') as HTMLButtonElement | null;
  const restartBtn = document.getElementById('restart') as HTMLButtonElement | null;
  const volume = document.getElementById('volume') as HTMLInputElement | null;
  const title = document.getElementById('menu-title');
  const weapon = document.getElementById('weapon') as HTMLSelectElement | null;
  const scale = document.getElementById('scale') as HTMLSelectElement | null;

  if (!root || !startBtn || !restartBtn || !volume || !title || !weapon || !scale) {
    throw new Error(
      'menu markup missing — need #menu, #start, #restart, #volume, #menu-title, #weapon, #scale',
    );
  }

  let paused = false;
  let openState = true;

  // Volume survives reloads; nothing else about a session is worth persisting.
  const saved = Number(localStorage.getItem(VOLUME_KEY));
  const initial = Number.isFinite(saved) && saved >= 0 ? saved : 90;
  volume.value = String(initial);
  hooks.onVolume(initial / 100);

  volume.addEventListener('input', () => {
    const v = Number(volume.value);
    hooks.onVolume(v / 100);
    localStorage.setItem(VOLUME_KEY, String(v));
  });

  const savedWeapon = localStorage.getItem(WEAPON_KEY);
  if (savedWeapon) weapon.value = savedWeapon;
  weapon.addEventListener('change', () => localStorage.setItem(WEAPON_KEY, weapon.value));

  const savedScale = localStorage.getItem(SCALE_KEY);
  if (savedScale) scale.value = savedScale;
  scale.addEventListener('change', () => localStorage.setItem(SCALE_KEY, scale.value));

  function close(): void {
    openState = false;
    root!.classList.add('hidden');
  }

  const startFresh = (): void => {
    hooks.onStart(weapon.value as WeaponId, scale.value as Scale);
    close();
  };

  startBtn.addEventListener('click', () => {
    if (paused) {
      hooks.onResume();
      close();
    } else {
      startFresh();
    }
  });

  // Resuming keeps the match you paused, so loadout changes cannot apply to
  // it. This gives that choice somewhere to go instead of silently doing
  // nothing when the dropdown is changed mid-match.
  restartBtn.addEventListener('click', startFresh);

  return {
    open(isPaused: boolean): void {
      paused = isPaused;
      openState = true;
      startBtn.textContent = isPaused ? 'RESUME' : 'PLAY';
      restartBtn.style.display = isPaused ? 'block' : 'none';
      title.textContent = isPaused ? 'PAUSED' : '';
      root.classList.remove('hidden');
      startBtn.focus();
    },
    close,
    isOpen: () => openState,
  };
}