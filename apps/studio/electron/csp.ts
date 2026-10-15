/**
 * Content Security Policy for the app's pages. Everything the app needs is bundled; `data:`
 * covers inlined fonts and cover thumbnails, `media:` the media of open projects. Vite's HMR
 * socket is only reachable in development.
 */
export function contentSecurityPolicy(development: boolean): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    // Solid sets some styles through the style attribute, and Vite injects CSS as <style>
    // tags in development. Inline styles can't run code, so allowing them costs little.
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob: media:",
    "media-src 'self' blob: media:",
    `connect-src 'self'${development ? " ws://localhost:*" : ""}`,
    "frame-src 'none'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join("; ");
}
