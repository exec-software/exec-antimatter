import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';
import { placeMenu, type Point } from '../lib/menu';

/**
 * A right-click menu the app owns.
 *
 * Built for more than one list: a conversation row is its first user, and its entries are data so
 * the next option is one more line rather than one more menu. It renders into the document body,
 * because a sidebar that scrolls clips anything positioned inside it, and it measures itself
 * before it shows so it can open upward near the bottom of the window.
 *
 * It behaves like the platform's menus do: the first item takes focus, arrow keys move between
 * items, Escape puts focus back where it was, and a click anywhere else, a scroll, a resize or the
 * window losing focus closes it — a menu left floating over content that moved is a menu pointing
 * at the wrong thing.
 */

export type MenuEntry =
  | {
      kind?: 'item';
      id: string;
      label: string;
      icon?: LucideIcon;
      /** Destructive actions read as such on hover and focus. */
      tone?: 'danger';
      disabled?: boolean;
      onSelect(): void;
    }
  | { kind: 'separator'; id: string };

interface Props {
  /** Where it was opened: the pointer, or under the row when it came from the keyboard. */
  at: Point;
  /** Names the menu for assistive technology, e.g. "Conversation actions". */
  label: string;
  entries: MenuEntry[];
  onClose(): void;
}

export function ContextMenu({ at, label, entries, onClose }: Props) {
  const menu = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const rect = menu.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition(placeMenu(at, { width: rect.width, height: rect.height }, { width: window.innerWidth, height: window.innerHeight }));
  }, [at.x, at.y]);

  const items = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];

  const placed = position !== null;
  useEffect(() => {
    if (placed) items()[0]?.focus({ preventScroll: true });
  }, [placed]);

  useEffect(() => {
    const close = () => onClose();
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      const list = items();
      const index = list.indexOf(document.activeElement as HTMLButtonElement);
      const move = (next: number) => {
        event.preventDefault();
        list[(next + list.length) % list.length]?.focus({ preventScroll: true });
      };
      switch (event.key) {
        case 'Escape':
          event.preventDefault();
          event.stopPropagation();
          onClose();
          opener.current?.focus({ preventScroll: true });
          break;
        case 'ArrowDown':
          move(index + 1);
          break;
        case 'ArrowUp':
          move(index <= 0 ? list.length - 1 : index - 1);
          break;
        case 'Home':
          move(0);
          break;
        case 'End':
          move(list.length - 1);
          break;
        case 'Tab':
          onClose();
          break;
      }
    };

    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    // Capture: the list that scrolled is an element, not the window.
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menu}
      role="menu"
      aria-label={label}
      onContextMenu={(event) => event.preventDefault()}
      className="fixed z-50 min-w-[190px] rounded-xl border border-line bg-surface-2 p-1 shadow-xl shadow-black/40"
      style={position ?? { left: at.x, top: at.y, visibility: 'hidden' }}
    >
      {entries.map((entry) => {
        if (entry.kind === 'separator') {
          return <div key={entry.id} role="separator" className="mx-1 my-1 border-t border-line-soft" />;
        }
        const Icon = entry.icon;
        return (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            onClick={() => {
              onClose();
              entry.onSelect();
            }}
            className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-ink-2 transition focus:outline-none disabled:opacity-40 ${
              entry.tone === 'danger'
                ? 'hover:bg-danger/10 hover:text-danger focus:bg-danger/10 focus:text-danger'
                : 'hover:bg-surface-3 hover:text-ink focus:bg-surface-3 focus:text-ink'
            }`}
          >
            {Icon && <Icon size={13} className="shrink-0 opacity-80" />}
            {entry.label}
          </button>
        );
      })}
    </div>,
    document.body
  );
}
