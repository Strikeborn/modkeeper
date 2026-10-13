import { useLayoutEffect, type RefObject } from 'react';

/** The element that scrolls the page (nearest scrollable ancestor). */
export function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/**
 * For grids that fill the rest of the window (`.grid-fill`): tells the CSS where the grid starts (--grid-top),
 * so its rows can share the height that's left and cards grow to use it.
 */
export function useGridTop(ref: RefObject<HTMLElement | null>, deps: unknown[]) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const top = el.getBoundingClientRect().top + (scrollParent(el)?.scrollTop ?? 0);
      el.style.setProperty('--grid-top', `${Math.max(0, Math.round(top))}px`);
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
    // the caller lists what changes the grid's position
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/**
 * Mouse-wheel paging: past the bottom of a page (or on a page that fits the screen) goes to the next one, at the
 * top goes back. One page per ~0.7 s so a single flick doesn't skip several.
 */
export function wheelPage(e: { deltaY: number }, grid: HTMLElement | null, last: { current: number }, go: (delta: 1 | -1) => void) {
  if (Math.abs(e.deltaY) < 1) return;
  const now = Date.now();
  if (now - last.current < 700) return;
  const sp = scrollParent(grid);
  const atBottom = !sp || sp.scrollTop + sp.clientHeight >= sp.scrollHeight - 40;
  const atTop = !sp || sp.scrollTop <= 40;
  if (e.deltaY > 0 && atBottom) {
    last.current = now;
    go(1);
  } else if (e.deltaY < 0 && atTop) {
    last.current = now;
    go(-1);
  }
}
