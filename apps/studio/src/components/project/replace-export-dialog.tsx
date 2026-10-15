import type { JSX } from "@solidjs/web";
import { createMemo } from "solid-js";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";

/** Asks before an export replaces a song folder that is already there. */
export function ReplaceExportDialog(props: {
  /** The export folder chosen and the existing song folder in it; null keeps the dialog closed. */
  target: { folder: string; existing: string } | null;
  onCancel: () => void;
  onReplace: (folder: string) => void;
}) {
  // Keeps the text while the dialog animates out.
  const shown = createMemo<{ folder: string; existing: string } | null>((previous) => props.target ?? previous ?? null);
  const name = () => shown()?.existing.split(/[\\/]/).pop() ?? "";
  return (
    <Dialog
      open={props.target !== null}
      onOpenChange={(open: boolean) => {
        if (!open) props.onCancel();
      }}
    >
      <DialogContent class="w-[min(480px,calc(100vw-32px))]" data-testid="replace-export">
        <DialogHeader>
          <DialogTitle>Replace “{name()}”?</DialogTitle>
          <DialogDescription>This folder already exists where you are exporting to.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <p class="m-0 text-[11.5px] leading-[1.6] text-popover-foreground">
            Replacing it removes everything in the folder, including files Tune Studio didn't write, and puts the new
            export in its place.
          </p>
          <p class="m-0 truncate font-mono text-[10.5px] text-popover-muted" title={shown()?.existing}>
            {shown()?.existing}
          </p>
        </DialogBody>
        <DialogFooter>
          <DialogClose
            render={(closeProps: JSX.HTMLAttributes<HTMLButtonElement>) => <Button variant="outline" {...closeProps} />}
          >
            Cancel
          </DialogClose>
          <Button
            variant="destructive"
            onClick={() => {
              const target = props.target;
              if (target) props.onReplace(target.folder);
            }}
            data-testid="confirm-replace"
          >
            Replace
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
