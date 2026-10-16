import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";

import { testSong } from "~/lib/editor/test-chart";

import { listFrom, SongDetailsDialog, type SongDetailsSinger, yearFrom } from "./song-details-dialog";

function setup(singers: SongDetailsSinger[] = [{ id: 1, index: 1, name: null }]) {
  const onChange = vi.fn();
  const onSingerName = vi.fn();
  render(() => (
    <SongDetailsDialog
      open
      onOpenChange={() => {}}
      song={{ ...testSong, year: 2024, tags: ["live"] }}
      bpm={300}
      gap={1.25}
      singers={singers}
      otherHeaders={[["COMMENT", "kept"]]}
      onChange={onChange}
      onSingerName={onSingerName}
    />
  ));
  /** Types into a field and leaves it. */
  const enter = (testid: string, text: string) => {
    const input = screen.getByTestId(testid) as HTMLInputElement;
    input.value = text;
    fireEvent.change(input);
    return input;
  };
  return { onChange, onSingerName, enter };
}

describe("song details", () => {
  it("reads lists and years as typed", () => {
    expect(listFrom(" English,, German ")).toEqual(["English", "German"]);
    expect([yearFrom(""), yearFrom(" 1999 "), yearFrom("99"), yearFrom("abcd")]).toEqual([
      null,
      1999,
      undefined,
      undefined,
    ]);
  });

  it("saves each field as its own edit when it is left", async () => {
    const { onChange, enter } = setup();
    expect(await screen.findByTestId("song-title")).toHaveValue("Night Signals");
    expect(screen.getByTestId("song-tags")).toHaveValue("live");
    enter("song-title", "  Day Signals ");
    expect(onChange).toHaveBeenLastCalledWith("Change title", { title: "Day Signals" });
    enter("song-tags", "live, acoustic");
    expect(onChange).toHaveBeenLastCalledWith("Change tags", { tags: ["live", "acoustic"] });
    enter("song-genre", " ");
    expect(onChange).toHaveBeenLastCalledWith("Change genre", { genre: null });
    expect(screen.getByTestId("song-grid")).toHaveTextContent("300 BPM");
    expect(screen.getByText("#COMMENT")).toBeInTheDocument();
  });

  it("takes a YouTube link as the song's video, and leaves anything else as it was", async () => {
    const { onChange, enter } = setup();
    expect(await screen.findByTestId("song-youtube")).toHaveValue("");
    enter("song-youtube", "https://youtu.be/kPBzTxZQG5Q?si=abc");
    expect(onChange).toHaveBeenLastCalledWith("Change YouTube video", { youtubeId: "kPBzTxZQG5Q" });
    onChange.mockClear();
    enter("song-youtube", "not a video");
    expect(onChange).not.toHaveBeenCalled();
    enter("song-youtube", " ");
    expect(onChange).toHaveBeenLastCalledWith("Change YouTube video", { youtubeId: null });
  });

  it("puts back a title left empty and a year that isn't one", async () => {
    const { onChange, enter } = setup();
    await screen.findByTestId("song-title");
    expect(enter("song-title", "  ")).toHaveValue("Night Signals");
    expect(enter("song-year", "20x4")).toHaveValue("2024");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("names a duet's singers", async () => {
    const { onSingerName, enter } = setup([
      { id: 1, index: 1, name: null },
      { id: 2, index: 2, name: "Kai" },
    ]);
    expect(await screen.findByTestId("singer-name-2")).toHaveValue("Kai");
    enter("singer-name-1", "Mia");
    expect(onSingerName).toHaveBeenCalledWith(1, "Mia");
  });

  it("keeps the singers' fields (and their focus) when their names change", async () => {
    const [singers, setSingers] = createSignal<SongDetailsSinger[]>([
      { id: 1, index: 1, name: null },
      { id: 2, index: 2, name: "Kai" },
    ]);
    render(() => (
      <SongDetailsDialog
        open
        onOpenChange={() => {}}
        song={testSong}
        bpm={300}
        gap={1}
        singers={singers()}
        otherHeaders={[]}
        onChange={() => {}}
        onSingerName={(id, name) =>
          setSingers(singers().map((item) => (item.id === id ? { ...item, name } : { ...item })))
        }
      />
    ));
    const second = await screen.findByTestId("singer-name-2");
    const first = screen.getByTestId("singer-name-1") as HTMLInputElement;
    first.value = "Mia";
    fireEvent.change(first);
    expect(screen.getByTestId("singer-name-2")).toBe(second);
    expect(screen.getByTestId("singer-name-1")).toHaveValue("Mia");
  });
});
