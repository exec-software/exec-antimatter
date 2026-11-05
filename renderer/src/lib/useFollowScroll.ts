import { useCallback, useLayoutEffect, useRef, useState } from 'react';

// Within this many pixels of the bottom, the view keeps following new content.
const FOLLOW_THRESHOLD = 80;

const isNearLatest = (container: HTMLElement): boolean =>
  container.scrollHeight - container.scrollTop - container.clientHeight < FOLLOW_THRESHOLD;

interface FollowScrollOptions {
  /** Leave a reader who scrolled up in place and report subsequent activity. */
  preservePosition?: boolean;
}

/**
 * Keeps a scroll container on its newest content until the reader scrolls up. Later activity is
 * then reported instead of moving the viewport out from under them.
 *
 * `preservePosition` is opt-in so existing compact/structured views keep their historical
 * behavior of following a newly added row even after the reader moved away from the bottom.
 */
export function useFollowScroll(itemCount: number, content: unknown, options: FollowScrollOptions = {}) {
  const preservePosition = options.preservePosition ?? false;
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const initializedRef = useRef(false);
  const countRef = useRef(itemCount);
  const [hasNewActivity, setHasNewActivity] = useState(false);

  const scrollToLatest = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const added = itemCount > countRef.current;
    countRef.current = itemCount;

    if (!initializedRef.current) {
      initializedRef.current = true;
      followRef.current = true;
      scrollToLatest();
      return;
    }

    if (followRef.current || (added && !preservePosition)) {
      followRef.current = true;
      scrollToLatest();
      setHasNewActivity(false);
    } else if (preservePosition) {
      setHasNewActivity(true);
    }
  }, [itemCount, content, preservePosition, scrollToLatest]);

  // Streaming text, expanded action details, fonts, and viewport changes can all alter the
  // transcript without adding an item. Keep the latest edge pinned only while the reader has not
  // deliberately left it. Observing both nodes covers content growth and viewport resizing.
  useLayoutEffect(() => {
    const container = scrollRef.current;
    const transcript = contentRef.current;
    if (!container || !transcript || typeof ResizeObserver === 'undefined') return;

    let frame = 0;
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (followRef.current) {
          scrollToLatest();
        } else if (isNearLatest(container)) {
          followRef.current = true;
          setHasNewActivity(false);
        }
      });
    });

    observer.observe(container);
    observer.observe(transcript);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [scrollToLatest]);

  const onScroll = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const following = isNearLatest(container);
    followRef.current = following;
    if (following) setHasNewActivity(false);
  }, []);

  const jumpToLatest = useCallback(() => {
    followRef.current = true;
    setHasNewActivity(false);
    scrollToLatest();
  }, [scrollToLatest]);

  return { scrollRef, contentRef, onScroll, hasNewActivity, jumpToLatest };
}
