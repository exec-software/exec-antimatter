import type { PointerEvent as ReactPointerEvent } from 'react';

/**
 * Pointer dragging for the tool window chrome.
 *
 * Listeners go on the window rather than the element, so a drag keeps working when the pointer
 * outruns the panel being resized — which it will, every time.
 */
export function beginDrag(
  event: ReactPointerEvent,
  onMove: (delta: { dx: number; dy: number }) => void,
  onEnd?: () => void
): void {
  event.preventDefault();
  event.stopPropagation();

  const startX = event.clientX;
  const startY = event.clientY;
  const move = (next: PointerEvent) => onMove({ dx: next.clientX - startX, dy: next.clientY - startY });
  const finish = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);
    document.body.style.removeProperty('user-select');
    document.body.style.removeProperty('cursor');
    onEnd?.();
  };

  document.body.style.userSelect = 'none';
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', finish);
}
