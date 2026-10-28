/**
 * Updates of Tune Studio as the renderer offers them (main finds, downloads and installs them, `electron/updates/`):
 * a toast at start in the first window, and the settings' "Check for updates". Installing downloads with the
 * progress in the toast, then restarts into the new version.
 */
import { toast, toastError } from "~/components/ui/toast";

import { native } from "./native/client";
import { percentOf } from "./native/progress";
import type { AvailableUpdate } from "./native/types";

/** Downloads the update in its toast, then quits to install it. */
async function install(id: string, update: AvailableUpdate) {
  const downloading = (percent?: number) =>
    toast.update(id, {
      title: `Downloading Tune Studio ${update.version}`,
      description:
        percent === undefined
          ? "Tune Studio restarts when it's done."
          : `${percent}%. Tune Studio restarts when it's done.`,
      actionProps: undefined,
    });
  downloading();
  try {
    const iterator = await native.updates.download();
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      downloading(percentOf(next.value));
    }
    toast.update(id, {
      title: `Restarting into Tune Studio ${update.version}`,
      description: "Saving your work first.",
    });
    await native.updates.restart();
  } catch (error) {
    toast.close(id);
    toastError("Couldn't update Tune Studio", error);
  }
}

/** Tells the user about `update`, with the button that installs it (or opens its release page to download it). */
export function offerUpdate(update: AvailableUpdate) {
  const id = toast.add({
    title: `Tune Studio ${update.version} is available`,
    description: update.installable
      ? "Update now and Tune Studio restarts with it. Your work is saved first."
      : "This copy can't update itself. Download the new version from its release page.",
    timeout: 0,
    actionProps: update.installable
      ? { children: "Update and restart", onClick: () => void install(id, update) }
      : { children: "Download", onClick: () => window.open(update.page) },
  });
}

/** At start: shows the update main found, in the first window that asks. */
export async function announceUpdate() {
  const update = await native.updates.announce().catch(() => null);
  if (update) offerUpdate(update);
}

/** The settings' button: asks GitHub now, and says so when this is the latest version. */
export async function checkForUpdates() {
  try {
    const update = await native.updates.check();
    if (update) offerUpdate(update);
    else toast.add({ type: "success", title: "Tune Studio is up to date" });
  } catch (error) {
    toastError("Couldn't check for updates", error);
  }
}
