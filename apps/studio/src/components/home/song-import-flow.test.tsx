import { render, screen, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Dialog, DialogContent } from "~/components/ui/dialog";
import type { ImportProgress, OpenedProject, SongInspection } from "~/lib/native/types";

import { SongImportFlow } from "./song-import-flow";

// The main process isn't there in jsdom: its client is the one thing replaced.
const native = vi.hoisted(() => ({
  song: { inspect: vi.fn(), import: vi.fn() },
  dialogs: { chooseProjectLocation: vi.fn() },
}));
vi.mock("~/lib/native/client", () => ({ native }));

const inspection = (overrides: Partial<SongInspection> = {}): SongInspection => ({
  folder: "/Songs/Night Signals",
  chart: "song.txt",
  charts: ["song.txt"],
  title: "Night Signals",
  artist: "Test Artist",
  notes: 42,
  singers: 1,
  media: [
    { role: "audio", fileName: "song.mp3", size: 4_200_000, found: true },
    { role: "video", fileName: "clip.mp4", size: 9_000_000, found: true },
    { role: "cover", fileName: "cover.jpg", found: false },
  ],
  warnings: ["The cover “cover.jpg” is missing, so it isn't imported."],
  blocker: null,
  suggestedName: "Test Artist - Night Signals",
  ...overrides,
});

async function* progress(steps: ImportProgress[], result: OpenedProject) {
  for (const step of steps) yield step;
  return result;
}

function setup() {
  const onOpened = vi.fn();
  render(() => (
    <Dialog open>
      <DialogContent>
        <SongImportFlow path="/Songs/Night Signals" open onOpened={onOpened} header={() => <h2>Import</h2>} />
      </DialogContent>
    </Dialog>
  ));
  return { onOpened, user: userEvent.setup() };
}

beforeEach(() => vi.resetAllMocks());

describe("SongImportFlow", () => {
  it("lists what the folder holds, with missing files and warnings", async () => {
    native.song.inspect.mockResolvedValue(inspection());
    setup();
    expect(await screen.findByText("Test Artist · Night Signals")).toBeInTheDocument();
    const files = within(screen.getByRole("list", { name: "Song files" })).getAllByRole("listitem");
    expect(files.map((file) => file.textContent)).toEqual([
      "Chartsong.txt",
      "Audiosong.mp34.0 MB",
      "Videoclip.mp48.6 MB",
      "Covercover.jpgMissing",
    ]);
    expect(screen.getByRole("note")).toHaveTextContent("The cover “cover.jpg” is missing");
    expect(screen.getByRole("switch", { name: "Include video" })).toBeChecked();
    expect(native.song.inspect).toHaveBeenCalledExactlyOnceWith({ path: "/Songs/Night Signals" });
  });

  it("can't create a project without the main audio", async () => {
    native.song.inspect.mockResolvedValue(
      inspection({ blocker: "The audio file “song.mp3” is missing from the song folder." }),
    );
    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent("The audio file “song.mp3” is missing");
    expect(screen.getByRole("button", { name: "Create project…" })).toBeDisabled();
  });

  it("shows why a folder can't be read, and tries again", async () => {
    native.song.inspect.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(inspection());
    const { user } = setup();
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Test Artist · Night Signals")).toBeInTheDocument();
  });

  it("asks where to save, imports without the video when switched off, and reports the project", async () => {
    native.song.inspect.mockResolvedValue(inspection());
    native.dialogs.chooseProjectLocation.mockResolvedValue("/Projects/Night Signals.tunestudio");
    const opened = { id: "session-1", path: "/Projects/Night Signals.tunestudio" };
    native.song.import.mockResolvedValue(progress([{ step: "Copying song.mp3", done: 10, total: 20 }], opened));
    const { onOpened, user } = setup();

    await user.click(await screen.findByRole("switch", { name: "Include video" }));
    await user.click(screen.getByRole("button", { name: "Create project…" }));
    await vi.waitFor(() => expect(onOpened).toHaveBeenCalledExactlyOnceWith(opened));
    expect(native.dialogs.chooseProjectLocation).toHaveBeenCalledExactlyOnceWith({
      name: "Test Artist - Night Signals",
    });
    expect(native.song.import).toHaveBeenCalledExactlyOnceWith(
      {
        path: "/Songs/Night Signals",
        chart: "song.txt",
        includeVideo: false,
        target: "/Projects/Night Signals.tunestudio",
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("goes back to the summary when the save dialog is cancelled", async () => {
    native.song.inspect.mockResolvedValue(inspection());
    native.dialogs.chooseProjectLocation.mockResolvedValue(null);
    const { user } = setup();
    await user.click(await screen.findByRole("button", { name: "Create project…" }));
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Create project…" })).toBeEnabled());
    expect(native.song.import).not.toHaveBeenCalled();
  });
});
