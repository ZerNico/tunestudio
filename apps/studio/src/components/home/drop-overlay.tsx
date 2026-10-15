import { createSignal, onSettled, Show } from "solid-js";
import FileAudioIcon from "~icons/lucide/file-audio";
import FolderOpenIcon from "~icons/lucide/folder-open";

/** What was dropped on the window: the first item, and whether it is a folder. */
export interface Drop {
  file: File;
  isDirectory: boolean;
}

function carriesFiles(event: DragEvent) {
  return event.dataTransfer?.types.includes("Files") ?? false;
}

function over(event: DragEvent) {
  if (!carriesFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
}

/**
 * Makes the whole window a drop target for files and folders. Returns whether something is
 * being dragged over it. Drops never navigate the window (the main process blocks that too).
 */
export function createWindowDrop(onDrop: (drop: Drop) => void) {
  const [dragging, setDragging] = createSignal(false);

  onSettled(() => {
    let depth = 0;
    const enter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth++;
      setDragging(true);
    };
    const leave = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      event.preventDefault();
      depth = 0;
      setDragging(false);
      const entry = event.dataTransfer?.items[0]?.webkitGetAsEntry();
      const file = event.dataTransfer?.files[0];
      if (file) onDrop({ file, isDirectory: entry?.isDirectory ?? false });
    };

    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  });

  return dragging;
}

/** Full-window hint shown while files are dragged over the app. */
export function DropOverlay(props: { visible: boolean }) {
  return (
    <Show when={props.visible}>
      <div
        aria-hidden="true"
        data-testid="drop-overlay"
        class="pointer-events-none fixed inset-0 z-[90] flex animate-in items-center justify-center bg-gray-2-a72 p-6 backdrop-blur-[3px] duration-100 fade-in-0"
      >
        <div class="flex size-full flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed border-primary-line bg-primary/3">
          <div class="flex items-center gap-3 text-primary">
            <FileAudioIcon class="size-8" />
            <FolderOpenIcon class="size-8 text-violet" />
          </div>
          <p class="m-0 text-[20px] font-[550] tracking-[-0.4px] text-foreground">Drop to start a project</p>
          <p class="m-0 text-[12px] text-muted-foreground">
            An audio file becomes a new project, a song folder or chart is imported, and a project file opens.
          </p>
        </div>
      </div>
    </Show>
  );
}
