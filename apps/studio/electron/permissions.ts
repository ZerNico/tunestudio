/**
 * Which web permissions the app's own pages get: writing the clipboard, and the microphone (audio only, for singing
 * along). Everything else is denied, for requests and for the synchronous checks behind `navigator.permissions`.
 */

const ALWAYS = new Set(["clipboard-sanitized-write"]);

/**
 * Whether `permission` is allowed for a page of `origin` (`appOrigin`: the app's own). `mediaTypes`: what a media
 * request or check is for.
 */
export function allowsPermission(
  origin: string | null,
  appOrigin: string,
  permission: string,
  mediaTypes: readonly string[] = [],
): boolean {
  if (origin !== appOrigin) return false;
  if (ALWAYS.has(permission)) return true;
  return permission === "media" && mediaTypes.length > 0 && mediaTypes.every((type) => type === "audio");
}
