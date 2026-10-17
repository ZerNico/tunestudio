/**
 * Drawing on a canvas that covers part of the editor: sized to it at the screen's pixel density. Its bitmap is only
 * made anew when that size changes (setting the size throws the bitmap away, which is slow to do every frame).
 */

/** The canvas ready to draw on in CSS pixels, cleared; null when it has no size yet. */
export function fitCanvas(canvas: HTMLCanvasElement, width: number, height: number): CanvasRenderingContext2D | null {
  const context = canvas.getContext("2d");
  if (!context || width <= 0 || height <= 0) return null;
  const scale = window.devicePixelRatio || 1;
  const pixelWidth = Math.round(width * scale);
  const pixelHeight = Math.round(height * scale);
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, width, height);
  return context;
}
