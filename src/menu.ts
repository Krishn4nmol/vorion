export interface Menu {
  open(): void;
  close(): void;
  isOpen(): boolean;
}

/**
 * Title screen as a DOM overlay rather than canvas-drawn UI, so type stays
 * crisp at any DPI. The game runs underneath as an attract-mode match.
 */
export function setupMenu(onStart: () => void): Menu {
  const root = document.getElementById('menu');
  const startBtn = document.getElementById('start') as HTMLButtonElement | null;

  // Fail loudly rather than leaving the game in attract mode with no visible
  // menu and no obvious cause.
  if (!root || !startBtn) {
    throw new Error('menu markup missing from index.html — need #menu and #start');
  }

  let openState = true;

  function close(): void {
    openState = false;
    root!.classList.add('hidden');
  }

  startBtn.addEventListener('click', () => {
    onStart();
    close();
  });

  return {
    open(): void {
      openState = true;
      root.classList.remove('hidden');
      startBtn.focus();
    },
    close,
    isOpen: () => openState,
  };
}