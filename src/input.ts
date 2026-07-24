export interface InputState {
  keys: Set<string>;
  mouseX: number; // canvas-space pixels
  mouseY: number;
  firing: boolean;
  /** True once per physical key press, then cleared. */
  consumePress: (key: string) => boolean;
}

export function attachInput(canvas: HTMLCanvasElement): InputState {
  const keys = new Set<string>();
  const pressed = new Set<string>();

  const state: InputState = {
    keys,
    mouseX: 0,
    mouseY: 0,
    firing: false,
    consumePress: (key: string) => {
      if (!pressed.has(key)) return false;
      pressed.delete(key);
      return true;
    },
  };

  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (!keys.has(k)) pressed.add(k); // ignore OS key-repeat
    keys.add(k);
    // stop the page scrolling under the canvas
    if ([' ', 'w', 'a', 's', 'd'].includes(k)) e.preventDefault();
  });

  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => {
    keys.clear();
    pressed.clear();
    state.firing = false;
  });

  canvas.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    // Canvas backing store may differ from CSS size; scale into canvas space.
    state.mouseX = (e.clientX - r.left) * (canvas.width / r.width);
    state.mouseY = (e.clientY - r.top) * (canvas.height / r.height);
  });

  canvas.addEventListener('mousedown', () => {
    state.firing = true;
  });
  window.addEventListener('mouseup', () => {
    state.firing = false;
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  return state;
}

export function moveAxis(keys: Set<string>): { x: number; y: number } {
  let x = 0;
  let y = 0;
  if (keys.has('a') || keys.has('arrowleft')) x -= 1;
  if (keys.has('d') || keys.has('arrowright')) x += 1;
  if (keys.has('w') || keys.has('arrowup')) y -= 1;
  if (keys.has('s') || keys.has('arrowdown')) y += 1;
  const len = Math.hypot(x, y);
  if (len > 0) {
    x /= len;
    y /= len;
  }
  return { x, y };
}