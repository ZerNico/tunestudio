/**
 * Where the video preview sits in the editor area: its distance from the area's top and right edges and its width
 * (its height follows from the video's 16:9 box). Dragged or resized, and when the area shrinks, it stays inside.
 */

export interface VideoBox {
  top: number;
  right: number;
  width: number;
}

/** Where it starts: in the roll's top corner, under the ruler and the break lane. */
export const FIRST_BOX: VideoBox = { top: 52, right: 12, width: 240 };
const MIN_WIDTH = 160;
const ASPECT = 16 / 9;

/** `box` kept inside an area `width` × `height` px, at least `MIN_WIDTH` wide where it fits. */
export function clampBox(box: VideoBox, area: { width: number; height: number }): VideoBox {
  const widest = Math.max(0, Math.min(area.width, area.height * ASPECT));
  const width = Math.min(Math.max(MIN_WIDTH, box.width), widest);
  return {
    width,
    top: Math.min(Math.max(0, box.top), Math.max(0, area.height - width / ASPECT)),
    right: Math.min(Math.max(0, box.right), Math.max(0, area.width - width)),
  };
}

/** `box` dragged `dx`, `dy` px. */
export function movedBox(box: VideoBox, dx: number, dy: number, area: { width: number; height: number }): VideoBox {
  return clampBox({ ...box, top: box.top + dy, right: box.right - dx }, area);
}

/** `box` resized from its bottom-left corner dragged `dx` px (left is wider); its top-right corner stays. */
export function resizedBox(box: VideoBox, dx: number, area: { width: number; height: number }): VideoBox {
  const width = box.width - dx;
  // Wider only as far as the area's left and bottom edges.
  const room = Math.min(area.width - box.right, (area.height - box.top) * ASPECT);
  return clampBox({ ...box, width: Math.min(width, Math.max(MIN_WIDTH, room)) }, area);
}
