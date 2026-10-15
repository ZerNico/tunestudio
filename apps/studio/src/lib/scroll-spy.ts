export interface ScrollState {
  /** The section's top edge, relative to the scroller's top edge. */
  sectionTop: number;
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/**
 * Whether a section counts as reached: its top has passed the upper third of the scroller, or
 * the scroller is scrolled to the bottom (when the page is too short for the top to get there).
 */
export function sectionReached(state: ScrollState): boolean {
  const atBottom = state.scrollTop > 0 && state.scrollTop + state.clientHeight >= state.scrollHeight - 2;
  return state.sectionTop <= state.clientHeight / 3 || atBottom;
}
