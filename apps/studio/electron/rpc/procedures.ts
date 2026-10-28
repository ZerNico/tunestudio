/**
 * The handlers of the calls in `NativeRpcs` (`src/lib/native/contract.ts`), on the main process services, one file per
 * area in `handlers/`. Every path from the renderer goes through `allowedPath` first.
 */
import { NativeRpcs } from "../../src/lib/native/contract";
import { appHandlers } from "./handlers/app";
import { dialogHandlers } from "./handlers/dialogs";
import { modelHandlers, toolHandlers } from "./handlers/downloads";
import { gameHandlers, tryHandlers } from "./handlers/games";
import { audioHandlers, draftHandlers, youtubeHandlers } from "./handlers/new-project";
import { projectHandlers } from "./handlers/project";
import { songHandlers } from "./handlers/song";
import { updateHandlers } from "./handlers/updates";

export { Callers, progressStream } from "./handlers/shared";

export const nativeHandlers = NativeRpcs.toLayer({
  ...appHandlers,
  ...dialogHandlers,
  ...songHandlers,
  ...projectHandlers,
  ...tryHandlers,
  ...gameHandlers,
  ...youtubeHandlers,
  ...audioHandlers,
  ...draftHandlers,
  ...modelHandlers,
  ...toolHandlers,
  ...updateHandlers,
});
