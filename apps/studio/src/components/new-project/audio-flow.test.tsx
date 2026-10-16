import { cleanup, render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Dialog, DialogContent } from "~/components/ui/dialog";
import { MediaUnreadable } from "~/lib/errors";
import { summarizeAudioFile } from "~/lib/import-files";
import type { AudioFileDetails, DownloadedDraft, ImportProgress, ToolProgress, ToolStatus } from "~/lib/native/types";
import { DEFAULT_SETTINGS } from "~/lib/settings";

import { AudioFlow, importTasks } from "./audio-flow";

// The main process isn't there in jsdom: its client is the one thing replaced.
const native = vi.hoisted(() => ({
  tools: { prepare: vi.fn() },
  models: { status: vi.fn() },
  audio: { inspect: vi.fn(), import: vi.fn() },
  youtube: { findCovers: vi.fn(), findLyrics: vi.fn() },
  drafts: { discard: vi.fn(), listen: vi.fn(), makeChart: vi.fn(), create: vi.fn() },
  settings: { get: vi.fn() },
  dialogs: { chooseProjectLocation: vi.fn(), chooseCoverImage: vi.fn() },
}));
vi.mock("~/lib/native/client", () => ({ native }));

const PATH = "/Music/Carla Ahad - Blauer Himmel.mp3";
const FILE = summarizeAudioFile({ name: "Carla Ahad - Blauer Himmel.mp3", size: 5_200_000 });
const DETAILS: AudioFileDetails = {
  name: "Carla Ahad - Blauer Himmel.mp3",
  size: 5_200_000,
  format: "MP3",
  duration: 145,
  artist: "Carla Ahad",
  title: "Blauer Himmel Odyssee",
  year: 2024,
  artwork: null,
};
const DRAFT: DownloadedDraft = { draftId: "draft-1", audio: { size: 5_200_000 }, video: null, videoProblem: null };

const toolsReady = (): AsyncIterator<ToolProgress, ToolStatus[]> => ({
  next: async () => ({ done: true, value: [] }),
});

async function* steps<R>(progress: ImportProgress[], result: R) {
  for (const step of progress) yield step;
  return result;
}

function setup() {
  render(() => (
    <Dialog open>
      <DialogContent>
        <AudioFlow
          path={PATH}
          file={FILE}
          open
          onOpened={() => {}}
          header={(step) => <h2 data-testid="step">{step}</h2>}
        />
      </DialogContent>
    </Dialog>
  ));
  return userEvent.setup();
}

beforeEach(() => {
  vi.resetAllMocks();
  native.tools.prepare.mockImplementation(async () => toolsReady());
  native.settings.get.mockResolvedValue(DEFAULT_SETTINGS);
  native.models.status.mockResolvedValue({ separation: true, whisper: true, chart: true });
  native.audio.inspect.mockResolvedValue(DETAILS);
  native.audio.import.mockImplementation(async () => steps([], DRAFT));
  native.youtube.findCovers.mockResolvedValue([]);
  native.youtube.findLyrics.mockResolvedValue(null);
  native.drafts.discard.mockResolvedValue(undefined);
});

describe("AudioFlow", () => {
  it("installs only FFmpeg, reads the file and suggests the song from its tags", async () => {
    setup();
    expect(await screen.findByTestId("audio-artist")).toHaveValue("Carla Ahad");
    expect(screen.getByTestId("audio-title")).toHaveValue("Blauer Himmel Odyssee");
    expect(native.tools.prepare).toHaveBeenCalledWith({ tools: ["ffmpeg"] }, expect.anything());
    expect(native.audio.inspect).toHaveBeenCalledWith({ path: PATH });
    expect(screen.getByTestId("audio-file")).toHaveTextContent("MP3 · 5.0 MB · 2:25");
  });

  it("offers the file's artwork as the cover when it has some, and starts without a cover when not", async () => {
    setup();
    await screen.findByTestId("audio-artist");
    expect(screen.queryByTestId("cover-thumbnail")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "No cover" })).toBeChecked();
    native.audio.inspect.mockResolvedValue({ ...DETAILS, artwork: "data:image/jpeg;base64,AAAA" });
    cleanup();
    setup();
    await screen.findByTestId("audio-artist");
    expect(screen.getByRole("radio", { name: "The file's artwork" })).toBeChecked();
  });

  it("copies the song into a draft on Next and goes on to the lyrics", async () => {
    const user = setup();
    await screen.findByTestId("audio-artist");
    await user.click(screen.getByTestId("flow-next"));
    await screen.findByTestId("lyrics-review");
    expect(native.audio.import).toHaveBeenCalledWith({ path: PATH }, expect.anything());
    expect(screen.getByTestId("step")).toHaveTextContent("1");
  });

  it("says why the file can't be used, and tries again", async () => {
    native.audio.inspect.mockRejectedValueOnce(
      new MediaUnreadable({ message: "Tune Studio can't read “x.mp3” as audio." }),
    );
    const user = setup();
    expect(await screen.findByTestId("audio-error")).toHaveTextContent("can't read");
    await user.click(screen.getByTestId("audio-retry"));
    expect(await screen.findByTestId("audio-artist")).toHaveValue("Carla Ahad");
  });

  it("lists the separation model only when it still has to be downloaded", () => {
    expect(importTasks({ separation: true, whisper: true, chart: true })).toEqual([
      "Copying the song",
      "Separating the voice",
    ]);
    expect(importTasks({ separation: false, whisper: true, chart: true })).toContain(
      "Getting the voice separation model",
    );
  });
});
