import { ORPCError } from "@orpc/client";
import { cleanup, render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Dialog, DialogContent } from "~/components/ui/dialog";
import type {
  CoverCandidate,
  DownloadedDraft,
  FoundLyrics,
  HeardLyrics,
  ImportProgress,
  OpenedProject,
  ToolProgress,
  ToolStatus,
  YoutubeVideo,
} from "~/lib/native/types";
import { DEFAULT_SETTINGS } from "~/lib/settings";

import { describeSource } from "./lyrics-review";
import { describeDownload, downloadTasks, YoutubeFlow } from "./youtube-flow";

// The main process isn't there in jsdom: its client is the one thing replaced.
const native = vi.hoisted(() => ({
  tools: { prepare: vi.fn() },
  models: { status: vi.fn() },
  youtube: {
    inspect: vi.fn(),
    download: vi.fn(),
    listen: vi.fn(),
    create: vi.fn(),
    findCovers: vi.fn(),
    findLyrics: vi.fn(),
  },
  drafts: { discard: vi.fn() },
  settings: { get: vi.fn() },
  dialogs: { chooseProjectLocation: vi.fn(), chooseCoverImage: vi.fn() },
}));
vi.mock("~/lib/native/client", () => ({ native }));

const VIDEO: YoutubeVideo = {
  videoId: "dQw4w9WgXcQ",
  url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  title: "Rick Astley - Never Gonna Give You Up (Official Video)",
  channel: "Rick Astley",
  duration: 213,
  thumbnail: null,
  artist: "Rick Astley",
  songTitle: "Never Gonna Give You Up",
  year: null,
};

const DRAFT: DownloadedDraft = { draftId: "draft-1", audio: { size: 3_400_000 }, video: null, videoProblem: null };
const PROJECT: OpenedProject = { id: "p1", path: "/Music/Rick.tunestudio" };

const COVER: CoverCandidate = {
  url: "https://is1-ssl.mzstatic.com/image/thumb/whenever/1200x1200bb.jpg",
  preview: "data:image/jpeg;base64,AAAA",
  source: "itunes",
  release: "album",
  artist: "Rick Astley",
  title: "Never Gonna Give You Up",
  album: "Whenever You Need Somebody",
  year: 1987,
  genre: "Pop",
  confident: true,
};

const LYRICS: FoundLyrics = {
  source: "lrclib",
  id: 42,
  artist: "Rick Astley",
  title: "Never Gonna Give You Up",
  album: "Whenever You Need Somebody",
  duration: 214,
  synced: true,
  instrumental: false,
  lines: [
    { start: 19.32, text: "We're no strangers to love" },
    { start: 23.21, text: "You know the rules and so do I" },
  ],
};

const HEARD: HeardLyrics = {
  language: "en",
  mixed: false,
  lines: [
    { start: 19.4, end: 22.9, text: "We're no strangers to love" },
    { start: 23.3, end: 26.8, text: "You know the rules and so do I" },
  ],
};

/** Tools that are ready at once. */
const toolsReady = (): AsyncIterator<ToolProgress, ToolStatus[]> => ({
  next: async () => ({ done: true, value: [] }),
});

/** Progress, then (once `gate` opens) a result, like main's long calls. */
async function* steps<R>(progress: ImportProgress[], result: R, gate: Promise<void> = Promise.resolve()) {
  for (const step of progress) yield step;
  await gate;
  return result;
}

function setup() {
  const onOpened = vi.fn();
  const view = render(() => (
    <Dialog open>
      <DialogContent>
        <YoutubeFlow
          videoId="dQw4w9WgXcQ"
          url="https://youtu.be/dQw4w9WgXcQ"
          open
          onOpened={onOpened}
          header={(step) => <h2 data-testid="step">{step}</h2>}
        />
      </DialogContent>
    </Dialog>
  ));
  return { onOpened, view, user: userEvent.setup() };
}

/** From the song step to the lyrics step, with the default answers. */
async function toLyrics(user: ReturnType<typeof userEvent.setup>) {
  await vi.waitFor(() => expect(screen.getByTestId("youtube-next")).toBeEnabled());
  await user.click(screen.getByTestId("youtube-next"));
  await screen.findByTestId("lyrics-review");
}

beforeEach(() => {
  vi.resetAllMocks();
  native.tools.prepare.mockImplementation(async () => toolsReady());
  native.settings.get.mockResolvedValue(DEFAULT_SETTINGS);
  native.models.status.mockResolvedValue({ separation: true, whisper: true });
  native.youtube.inspect.mockResolvedValue(VIDEO);
  native.youtube.findCovers.mockResolvedValue([]);
  native.youtube.findLyrics.mockResolvedValue(null);
  native.youtube.download.mockImplementation(async () => steps([], DRAFT));
  native.youtube.listen.mockImplementation(async () => steps([], HEARD));
  native.youtube.create.mockImplementation(async () => steps([], PROJECT));
  native.drafts.discard.mockResolvedValue(undefined);
  native.dialogs.chooseProjectLocation.mockResolvedValue("/Music/Rick.tunestudio");
});

describe("song step", () => {
  it("looks the video up and suggests the song", async () => {
    setup();
    expect(await screen.findByTestId("youtube-video")).toHaveTextContent("Rick Astley · 3:33");
    expect(screen.getByTestId("youtube-artist")).toHaveValue("Rick Astley");
    expect(screen.getByTestId("youtube-title")).toHaveValue("Never Gonna Give You Up");
    expect(await screen.findByTestId("youtube-download-summary")).toHaveTextContent(
      "Audio as M4A (AAC), video as MP4 (best codec) up to 1080p. You can change this in Settings.",
    );
    expect(screen.getByTestId("step")).toHaveTextContent("0");
  });

  it("shows the search in front of the other choices, and keeps the thumbnail chosen when covers come", async () => {
    let found!: (covers: CoverCandidate[]) => void;
    native.youtube.findCovers.mockReturnValue(new Promise((resolve) => (found = resolve)));
    setup();
    await screen.findByTestId("youtube-video");
    expect(screen.getByTestId("cover-loading")).toHaveTextContent("Looking for covers");
    expect(screen.getByRole("radio", { name: "Video thumbnail" })).toBeChecked();
    found([COVER]);
    await screen.findByRole("radio", { name: /^Rick Astley, / });
    expect(screen.queryByTestId("cover-loading")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Video thumbnail" })).toBeChecked();
  });

  it("goes on while covers are still searched for, but needs an artist and a title", async () => {
    native.youtube.findCovers.mockReturnValue(new Promise(() => {}));
    const { user } = setup();
    await screen.findByTestId("youtube-video");
    await vi.waitFor(() => expect(screen.getByTestId("youtube-next")).toBeEnabled());
    await user.clear(screen.getByTestId("youtube-artist"));
    expect(screen.getByTestId("youtube-next")).toBeDisabled();
  });

  it("explains a video that can't be used, and looks again on request", async () => {
    native.youtube.inspect
      .mockRejectedValueOnce(
        new ORPCError("BAD_REQUEST", { message: "This video is private, so it can't be downloaded." }),
      )
      .mockResolvedValueOnce(VIDEO);
    const { user } = setup();
    expect(await screen.findByTestId("youtube-error")).toHaveTextContent(
      "This video is private, so it can't be downloaded.",
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("youtube-video")).toBeInTheDocument();
  });
});

describe("download step", () => {
  it("ticks off each download, then moves on to the lyrics", async () => {
    let finish!: () => void;
    native.youtube.download.mockImplementation(async () =>
      steps(
        [
          { step: "Downloading the audio", done: 3_400_000, total: 3_400_000 },
          { step: "Downloading the video", done: 10 * 1024 * 1024, total: 40 * 1024 * 1024 },
        ],
        DRAFT,
        new Promise<void>((resolve) => (finish = resolve)),
      ),
    );
    const { user } = setup();
    await vi.waitFor(() => expect(screen.getByTestId("youtube-next")).toBeEnabled());
    await user.click(screen.getByTestId("youtube-next"));
    expect(await screen.findByText("Downloading the song")).toBeInTheDocument();
    expect(screen.getByTestId("step")).toHaveTextContent("1");
    await vi.waitFor(() => expect(screen.getByText("10 MB of 40 MB")).toBeInTheDocument());
    const items = screen.getAllByRole("listitem");
    expect(items.map((item) => item.dataset.state)).toEqual(["done", "active", "waiting"]);
    expect(items.at(-1)).toHaveTextContent("Separating the voice");
    expect(native.youtube.download).toHaveBeenCalledWith({ videoId: "dQw4w9WgXcQ" }, expect.anything());

    finish();
    expect(await screen.findByTestId("lyrics-review")).toBeInTheDocument();
    expect(screen.getByTestId("step")).toHaveTextContent("2");
  });

  it("gets the voice separation model the first time, then shows how far the separation is", async () => {
    native.models.status.mockResolvedValue({ separation: false, whisper: false });
    let finish!: () => void;
    native.youtube.download.mockImplementation(async () =>
      steps(
        [
          { step: "Getting the voice separation model", done: 100 * 1024 * 1024, total: 400 * 1024 * 1024 },
          { step: "Separating the voice", done: 40, total: 100, unit: "percent" },
        ],
        DRAFT,
        new Promise<void>((resolve) => (finish = resolve)),
      ),
    );
    const { user } = setup();
    await vi.waitFor(() => expect(screen.getByTestId("youtube-next")).toBeEnabled());
    await user.click(screen.getByTestId("youtube-next"));
    await vi.waitFor(() => expect(screen.getByText("40%")).toBeInTheDocument());
    const items = screen.getAllByRole("listitem");
    expect(items.map((item) => item.textContent?.replace(/\s*40%$/, ""))).toEqual([
      "Downloading the audio",
      "Downloading the video",
      "Getting the voice separation model",
      "Separating the voice",
    ]);
    expect(items.map((item) => item.dataset.state)).toEqual(["done", "done", "done", "active"]);
    finish();
    expect(await screen.findByTestId("lyrics-review")).toBeInTheDocument();
  });

  it("explains a failed download and tries again", async () => {
    native.youtube.download
      .mockRejectedValueOnce(new ORPCError("BAD_REQUEST", { message: "Couldn't reach YouTube." }))
      .mockImplementationOnce(async () => steps([], DRAFT));
    const { user } = setup();
    await vi.waitFor(() => expect(screen.getByTestId("youtube-next")).toBeEnabled());
    await user.click(screen.getByTestId("youtube-next"));
    expect(await screen.findByTestId("youtube-error")).toHaveTextContent("Couldn't reach YouTube.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("lyrics-review")).toBeInTheDocument();
  });
});

describe("lyrics step and saving", () => {
  it("shows the found lyrics and saves the project with every choice", async () => {
    native.youtube.findCovers.mockResolvedValue([COVER]);
    native.youtube.findLyrics.mockResolvedValue(LYRICS);
    const { user, onOpened } = setup();
    await user.click(await screen.findByRole("radio", { name: /^Rick Astley, / }));
    await toLyrics(user);
    expect(await screen.findByTestId("lyrics-summary")).toHaveTextContent(
      "2 lines from LRCLIB, matching the song's length",
    );
    expect(screen.getByRole("button", { name: "Found online" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("textbox", { name: "Lyrics" })).toHaveValue(
      "We're no strangers to love\nYou know the rules and so do I",
    );
    expect(native.youtube.findLyrics).toHaveBeenCalledWith({
      artist: "Rick Astley",
      title: "Never Gonna Give You Up",
      duration: 213,
    });

    await user.click(screen.getByTestId("youtube-create"));
    await vi.waitFor(() => expect(onOpened).toHaveBeenCalledWith(PROJECT));
    expect(native.dialogs.chooseProjectLocation).toHaveBeenCalledWith({
      name: "Rick Astley - Never Gonna Give You Up",
    });
    expect(native.youtube.create).toHaveBeenCalledWith(
      {
        draftId: "draft-1",
        artist: "Rick Astley",
        title: "Never Gonna Give You Up",
        year: 1987,
        genre: "Pop",
        cover: { kind: "found", url: COVER.url },
        lyrics: { source: "lrclib", lrclibId: 42, lines: LYRICS.lines },
        target: "/Music/Rick.tunestudio",
      },
      expect.anything(),
    );
  });

  it("keeps fallback lyrics available with a warning and saves them without listening", async () => {
    native.youtube.findLyrics.mockResolvedValue({ ...LYRICS, versionMismatch: true });
    const { user, onOpened } = setup();
    await toLyrics(user);
    expect(await screen.findByText(/Words and timing may differ/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Found online" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("textbox", { name: "Lyrics" })).toHaveValue(
      "We're no strangers to love\nYou know the rules and so do I",
    );
    await user.click(screen.getByTestId("youtube-create"));
    await vi.waitFor(() => expect(onOpened).toHaveBeenCalledWith(PROJECT));
    expect(native.youtube.listen).not.toHaveBeenCalled();
    expect(native.youtube.create).toHaveBeenCalledWith(
      expect.objectContaining({ lyrics: { source: "lrclib", lrclibId: 42, lines: LYRICS.lines } }),
      expect.anything(),
    );
  });

  it("makes changed lyrics the user's own, without LRCLIB's timing, and keeps the found ones", async () => {
    native.youtube.findLyrics.mockResolvedValue(LYRICS);
    const { user } = setup();
    await toLyrics(user);
    const text = await screen.findByRole("textbox", { name: "Lyrics" });
    await user.click(text);
    await user.keyboard(
      "{Control>}{End}{/Control}{Meta>}{ArrowDown}{/Meta}{Enter}A full commitment's what I'm thinking of",
    );
    expect(screen.getByTestId("lyrics-summary")).toHaveTextContent("3 lines, written by you");
    expect(screen.getByRole("button", { name: "Your own" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByTestId("youtube-create"));
    await vi.waitFor(() =>
      expect(native.youtube.create).toHaveBeenCalledWith(
        expect.objectContaining({
          lyrics: {
            source: "user",
            lines: [
              { start: null, text: "We're no strangers to love" },
              { start: null, text: "You know the rules and so do I" },
              { start: null, text: "A full commitment's what I'm thinking of" },
            ],
          },
        }),
        expect.anything(),
      ),
    );
  });

  it("listens to the song when nothing was found online, waits for it, and saves what it heard", async () => {
    let finish!: () => void;
    native.youtube.listen.mockImplementation(async () =>
      steps(
        [{ step: "Listening to the song", done: 40, total: 100, unit: "percent" }],
        HEARD,
        new Promise<void>((resolve) => (finish = resolve)),
      ),
    );
    native.models.status.mockResolvedValue({ separation: true, whisper: false });
    const { user } = setup();
    await toLyrics(user);
    // Listening waits until asked; nothing else does.
    const listen = await screen.findByRole("button", { name: "Listen to the song" });
    expect(screen.getByRole("button", { name: "Heard in the song" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Found online" })).toBeDisabled();
    expect(screen.getByText(/The first time, it downloads what it needs for that \(574 MB\)\./)).toBeInTheDocument();
    expect(native.youtube.listen).not.toHaveBeenCalled();
    expect(screen.getByTestId("youtube-create")).toBeEnabled();

    await user.click(listen);
    expect(await screen.findByText("Listening to the song… 40%")).toBeInTheDocument();
    expect(screen.getByTestId("youtube-create")).toBeDisabled();
    expect(native.youtube.listen).toHaveBeenCalledWith(
      { draftId: "draft-1", language: null, mixed: false },
      expect.anything(),
    );

    finish();
    expect(
      await screen.findByText("2 lines heard in English. Words can be misheard, so check them."),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Lyrics" })).toHaveValue(
      "We're no strangers to love\nYou know the rules and so do I",
    );
    await user.click(screen.getByTestId("youtube-create"));
    await vi.waitFor(() =>
      expect(native.youtube.create).toHaveBeenCalledWith(
        expect.objectContaining({
          lyrics: {
            source: "whisper",
            language: "en",
            lines: [
              { start: 19.4, text: "We're no strangers to love" },
              { start: 23.3, text: "You know the rules and so do I" },
            ],
          },
        }),
        expect.anything(),
      ),
    );
  });

  it("listens only when asked while lyrics were found, and again in another language", async () => {
    native.youtube.findLyrics.mockResolvedValue(LYRICS);
    native.youtube.listen
      .mockImplementationOnce(async () => steps([], HEARD))
      .mockImplementationOnce(async () =>
        steps([], { language: "de", mixed: false, lines: [{ start: 19.4, end: 22, text: "Wir sind keine Fremden" }] }),
      )
      .mockImplementationOnce(async () => steps([], { ...HEARD, mixed: true }));
    const { user } = setup();
    await toLyrics(user);
    await screen.findByText("2 lines from LRCLIB, matching the song's length");
    expect(native.youtube.listen).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Heard in the song" }));
    expect(screen.queryByText(/The first time/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Listen to the song" }));
    expect(await screen.findByText(/2 lines heard in English/)).toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Language of the song" }));
    await user.click(await screen.findByRole("option", { name: "German" }));
    expect(await screen.findByText(/1 line heard in German/)).toBeInTheDocument();
    expect(native.youtube.listen).toHaveBeenLastCalledWith(
      { draftId: "draft-1", language: "de", mixed: false },
      expect.anything(),
    );

    // A song in several languages: each part is heard in its own.
    await user.click(screen.getByRole("combobox", { name: "Language of the song" }));
    await user.click(await screen.findByRole("option", { name: "Several languages" }));
    expect(await screen.findByText(/2 lines heard in several languages, mostly English/)).toBeInTheDocument();
    expect(native.youtube.listen).toHaveBeenLastCalledWith(
      { draftId: "draft-1", language: null, mixed: true },
      expect.anything(),
    );

    // The found lyrics are still one click away.
    await user.click(screen.getByRole("button", { name: "Found online" }));
    expect(screen.getByRole("textbox", { name: "Lyrics" })).toHaveValue(
      "We're no strangers to love\nYou know the rules and so do I",
    );
  });

  it("says when listening failed, offers to try again, and lets the user write their own", async () => {
    native.youtube.listen
      .mockRejectedValueOnce(new ORPCError("BAD_REQUEST", { message: "Couldn't listen to the song: out of memory" }))
      .mockImplementationOnce(async () => steps([], HEARD));
    const { user } = setup();
    await toLyrics(user);
    await user.click(await screen.findByRole("button", { name: "Listen to the song" }));
    expect(await screen.findByText("Couldn't listen to the song: out of memory")).toBeInTheDocument();
    expect(screen.getByTestId("youtube-create")).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/2 lines heard in English/)).toBeInTheDocument();
  });

  it("says when the lyrics service can't be reached, and looks again on request", async () => {
    native.youtube.findLyrics
      .mockRejectedValueOnce(new ORPCError("BAD_REQUEST", { message: "LRCLIB can't be reached right now." }))
      .mockResolvedValueOnce(LYRICS);
    const { user } = setup();
    await toLyrics(user);
    expect(await screen.findByText("Couldn't look for lyrics online right now.")).toBeInTheDocument();
    expect(screen.getByTestId("youtube-create")).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("2 lines from LRCLIB, matching the song's length")).toBeInTheDocument();
  });

  it("goes back to the song without downloading again, and searches lyrics again for a new title", async () => {
    const { user } = setup();
    await toLyrics(user);
    await user.click(screen.getByTestId("youtube-back"));
    await user.type(await screen.findByTestId("youtube-title"), " (Live)");
    await vi.waitFor(() => expect(screen.getByTestId("youtube-next")).toBeEnabled());
    await user.click(screen.getByTestId("youtube-next"));
    await screen.findByTestId("lyrics-review");
    expect(native.youtube.download).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(native.youtube.findLyrics).toHaveBeenLastCalledWith(
        expect.objectContaining({ title: "Never Gonna Give You Up (Live)" }),
      ),
    );
  });

  it("stays on the lyrics when the save dialog is cancelled", async () => {
    native.dialogs.chooseProjectLocation.mockResolvedValue(null);
    const { user } = setup();
    await toLyrics(user);
    await user.click(await screen.findByTestId("youtube-create"));
    await vi.waitFor(() => expect(native.dialogs.chooseProjectLocation).toHaveBeenCalled());
    expect(native.youtube.create).not.toHaveBeenCalled();
    expect(screen.getByTestId("lyrics-review")).toBeInTheDocument();
  });

  it("throws the draft away when the dialog closes without saving", async () => {
    const { user } = setup();
    await toLyrics(user);
    cleanup();
    expect(native.drafts.discard).toHaveBeenCalledWith({ draftId: "draft-1" });
  });

  it("throws away a draft whose download finishes after the dialog closed", async () => {
    let finish!: () => void;
    native.youtube.download.mockImplementation(async () =>
      steps([], DRAFT, new Promise<void>((resolve) => (finish = resolve))),
    );
    const { user } = setup();
    await vi.waitFor(() => expect(screen.getByTestId("youtube-next")).toBeEnabled());
    await user.click(screen.getByTestId("youtube-next"));
    await screen.findByText("Downloading the song");
    cleanup();
    finish();
    await vi.waitFor(() => expect(native.drafts.discard).toHaveBeenCalledWith({ draftId: "draft-1" }));
  });

  it("keeps Create waiting while listening, whichever lyrics are shown", async () => {
    native.youtube.findLyrics.mockResolvedValue(LYRICS);
    native.youtube.listen.mockImplementation(async () =>
      steps([{ step: "Listening to the song", done: 10, total: 100, unit: "percent" }], HEARD, new Promise(() => {})),
    );
    const { user } = setup();
    await toLyrics(user);
    await screen.findByText("2 lines from LRCLIB, matching the song's length");
    await user.click(screen.getByRole("button", { name: "Heard in the song" }));
    await user.click(screen.getByRole("button", { name: "Listen to the song" }));
    await screen.findByText("Listening to the song… 10%");
    await user.click(screen.getByRole("button", { name: "Found online" }));
    expect(screen.getByTestId("youtube-create")).toBeDisabled();
  });

  it("tries again in the language that was asked for", async () => {
    native.youtube.findLyrics.mockResolvedValue(LYRICS);
    native.youtube.listen
      .mockImplementationOnce(async () => steps([], HEARD))
      .mockRejectedValueOnce(new ORPCError("BAD_REQUEST", { message: "Couldn't listen to the song: busy" }))
      .mockImplementationOnce(async () => steps([], { ...HEARD, mixed: true }));
    const { user } = setup();
    await toLyrics(user);
    await user.click(await screen.findByRole("button", { name: "Heard in the song" }));
    await user.click(screen.getByRole("button", { name: "Listen to the song" }));
    await user.click(await screen.findByRole("combobox", { name: "Language of the song" }));
    await user.click(await screen.findByRole("option", { name: "Several languages" }));
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    await screen.findByText(/several languages/);
    expect(native.youtube.listen).toHaveBeenLastCalledWith(
      { draftId: "draft-1", language: null, mixed: true },
      expect.anything(),
    );
  });
});

describe("covers", () => {
  it("takes year and genre from the match that is surely the song, whichever cover is chosen", async () => {
    const album: CoverCandidate = {
      ...COVER,
      url: "https://is1-ssl.mzstatic.com/image/thumb/best/1200x1200bb.jpg",
      year: 2001,
      genre: "Compilation",
      confident: false,
    };
    native.youtube.findCovers.mockResolvedValue([album, COVER]);
    const { user } = setup();
    await screen.findAllByTestId("cover-option");
    await toLyrics(user);
    await user.click(await screen.findByTestId("youtube-create"));
    await vi.waitFor(() =>
      expect(native.youtube.create).toHaveBeenCalledWith(
        expect.objectContaining({ cover: { kind: "thumbnail" }, year: 1987, genre: "Pop" }),
        expect.anything(),
      ),
    );
  });

  it("drops the covers found for the old details as soon as they change", async () => {
    native.youtube.findCovers.mockResolvedValueOnce([COVER]).mockReturnValue(new Promise(() => {}));
    const { user } = setup();
    await screen.findByTestId("cover-option");
    await user.type(screen.getByTestId("youtube-title"), " (Live)");
    expect(screen.queryByTestId("cover-option")).not.toBeInTheDocument();
    expect(screen.getByTestId("cover-loading")).toBeInTheDocument();
  });

  it("won't make a project from a video that is far too long for a song", async () => {
    native.youtube.inspect.mockResolvedValue({ ...VIDEO, duration: 3 * 60 * 60 });
    setup();
    expect(await screen.findByTestId("youtube-too-long")).toHaveTextContent("longer than 20 minutes");
    expect(screen.getByTestId("youtube-next")).toBeDisabled();
  });

  it("can use an image the user picks, or no cover", async () => {
    native.youtube.findCovers.mockResolvedValue([COVER]);
    native.dialogs.chooseCoverImage.mockResolvedValue({
      path: "/Pictures/rick.png",
      preview: "data:image/jpeg;base64,BB",
    });
    const { user } = setup();
    await screen.findByTestId("cover-option");
    await user.click(screen.getByRole("button", { name: "Choose an image…" }));
    expect(await screen.findByRole("radio", { name: "Your image" })).toBeChecked();
    expect(screen.getByTestId("cover-file")).toHaveAttribute("title", "rick.png");
    await user.click(screen.getByRole("radio", { name: "No cover" }));
    await toLyrics(user);
    await user.click(await screen.findByTestId("youtube-create"));
    await vi.waitFor(() =>
      expect(native.youtube.create).toHaveBeenCalledWith(
        // Year and genre describe the song: they come from the best match whatever the cover.
        expect.objectContaining({ cover: { kind: "none" }, year: 1987, genre: "Pop" }),
        expect.anything(),
      ),
    );
  });
});

describe("wording", () => {
  it("describes the download and its tasks from the settings", () => {
    expect(describeDownload({ ...DEFAULT_SETTINGS, video: { ...DEFAULT_SETTINGS.video, download: false } })).toBe(
      "Audio as M4A (AAC), without the video",
    );
    const ready = { separation: true, whisper: false };
    expect(downloadTasks(DEFAULT_SETTINGS, ready)).toEqual([
      "Downloading the audio",
      "Downloading the video",
      "Separating the voice",
    ]);
    expect(
      downloadTasks(
        {
          audio: { ...DEFAULT_SETTINGS.audio, normalization: "rewrite" },
          video: { ...DEFAULT_SETTINGS.video, download: false },
        },
        { separation: false, whisper: false },
      ),
    ).toEqual([
      "Downloading the audio",
      "Adjusting the volume",
      "Getting the voice separation model",
      "Separating the voice",
    ]);
  });

  it("warns about fallback lyrics even when the two recordings have the same length", () => {
    expect(
      describeSource(
        "found",
        { status: "done", found: { ...LYRICS, duration: 213, versionMismatch: true } },
        { status: "idle" },
        0,
        213,
      ),
    ).toEqual({
      text: "2 lines from LRCLIB for another version. Words and timing may differ; check them.",
      tone: "warning",
    });
  });

  it("only warns about the lyrics' length when they are likely for another version", () => {
    const idle = { status: "idle" } as const;
    expect(describeSource("found", { status: "done", found: { ...LYRICS, duration: 219 } }, idle, 0, 213)).toEqual({
      text: "2 lines from LRCLIB, matching the song's length",
      tone: "plain",
    });
    expect(describeSource("found", { status: "done", found: { ...LYRICS, duration: 260 } }, idle, 0, 213)).toEqual({
      text: "2 lines from LRCLIB, maybe for another version of the song. Check them.",
      tone: "warning",
    });
  });
});
