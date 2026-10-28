/** Updating Tune Studio: the start's announcement, the settings' check, downloading and restarting into it. */
import { Updates } from "../../updates/updates";
import { type GroupHandlers, progressStream } from "./shared";

export const updateHandlers = {
  "updates.announce": () => Updates.use((updates) => updates.announce),
  "updates.check": () => Updates.use((updates) => updates.check({ force: true })),
  "updates.download": () => progressStream((onProgress) => Updates.use((updates) => updates.download(onProgress))),
  "updates.restart": () => Updates.use((updates) => updates.restart),
} satisfies GroupHandlers<"updates">;
