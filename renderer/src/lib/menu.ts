export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * Where a context menu goes: down and to the right of the pointer, as every desktop menu opens,
 * flipped up or left when that would leave the window, and never closer to an edge than `margin`.
 * A row near the bottom of the sidebar is exactly where a menu that only ever opened downward
 * would be cut in half.
 */
export function placeMenu(anchor: Point, size: Size, viewport: Size, margin = 8): { left: number; top: number } {
  const left = anchor.x + size.width > viewport.width - margin ? anchor.x - size.width : anchor.x;
  const top = anchor.y + size.height > viewport.height - margin ? anchor.y - size.height : anchor.y;
  return {
    left: Math.max(margin, Math.min(left, viewport.width - margin - size.width)),
    top: Math.max(margin, Math.min(top, viewport.height - margin - size.height)),
  };
}
