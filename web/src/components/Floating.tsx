import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

/**
 * A panel anchored to a field but rendered outside it.
 *
 * A dropdown positioned inside its own field is clipped the moment that field
 * sits in anything that scrolls — the bulk entry grid, a wide table — because
 * an overflow container clips its own descendants. The symptom is a menu that
 * opens into a two-line slot you have to scroll to read, which is no menu at
 * all: the whole point of type-to-search is seeing the matches at a glance.
 *
 * So the panel goes into a portal at the end of the document and positions
 * itself against the viewport. It opens downwards when there is room, upwards
 * when there is not, and never taller than the space it actually has.
 */

const GAP = 4;
/** Keep the panel off the very edge of the window. */
const MARGIN = 8;
/**
 * A grid column can be 110px wide, and a menu that narrow truncates the very
 * colour names it exists to let you read.
 */
const MIN_WIDTH = 200;

interface Placement {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

/**
 * @param wanted how tall the list would be if nothing constrained it, once it
 *   has been measured. Unknown on the first pass, when the cap stands in.
 */
function place(anchor: HTMLElement, cap: number, wanted: number): Placement {
  const r = anchor.getBoundingClientRect();
  const below = window.innerHeight - r.bottom - GAP - MARGIN;
  const above = r.top - GAP - MARGIN;

  // Open on the side that shows more of the list. Downwards is what people
  // expect, so it wins ties and wins outright whenever the whole list fits
  // there — flipping for a few extra pixels would just be twitchy.
  const need = Math.min(cap, wanted);
  const openUp = below < need && above > below;
  const room = Math.max(0, openUp ? above : below);

  const width = Math.min(
    Math.max(r.width, MIN_WIDTH),
    Math.max(MIN_WIDTH, window.innerWidth - 2 * MARGIN),
  );
  const left = Math.min(Math.max(MARGIN, r.left), Math.max(MARGIN, window.innerWidth - width - MARGIN));

  return openUp
    ? { left, width, maxHeight: Math.min(cap, room), bottom: window.innerHeight - r.top + GAP }
    : { left, width, maxHeight: Math.min(cap, room), top: r.bottom + GAP };
}

export function Floating({
  anchor, children, className, id, role, panelRef, maxHeight = 292,
}: {
  anchor: HTMLElement | null;
  children: ReactNode;
  className?: string;
  id?: string;
  role?: string;
  /** so the owner can tell a click inside the panel from a click outside it */
  panelRef?: RefObject<HTMLDivElement | null>;
  maxHeight?: number;
}) {
  const own = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<Placement | null>(null);

  const reposition = useCallback(() => {
    if (!anchor) return;
    // scrollHeight is the list's full height whatever the panel is capped to,
    // so measuring it does not fight the max-height we then apply.
    const wanted = own.current?.scrollHeight ?? maxHeight;
    setAt(place(anchor, maxHeight, wanted));
  }, [anchor, maxHeight]);

  useLayoutEffect(() => {
    if (!anchor) return;
    reposition();

    // Capture, so a scroll in any container between the field and the window
    // moves the panel with it rather than leaving it stranded.
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);

    // The list grows and shrinks as somebody types, and a taller list may no
    // longer fit below.
    const ro = new ResizeObserver(reposition);
    if (own.current) ro.observe(own.current);

    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      ro.disconnect();
    };
  }, [anchor, reposition]);

  if (!anchor || !at) return null;

  return createPortal(
    <div
      ref={(node) => {
        own.current = node;
        if (panelRef) panelRef.current = node;
      }}
      id={id}
      role={role}
      className={className}
      style={{
        position: 'fixed',
        left: at.left,
        width: at.width,
        maxHeight: at.maxHeight,
        ...(at.top === undefined ? { bottom: at.bottom } : { top: at.top }),
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
