/**
 * IPC channels main asks a page on to save what is still waiting (before its window closes, the app quits or the page
 * reloads), and the page answers on once it is saved. Shared by main (`flush.ts`) and the preload.
 */
export const FLUSH_CHANNEL = "tunestudio:flush";
export const FLUSH_DONE_CHANNEL = "tunestudio:flush-done";
