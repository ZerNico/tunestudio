import { render, screen, within } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

import type { ProjectOverview } from "~/lib/native/types";

import { ChartStats, ImportNotes, LyricsList, MediaList, SongDetails } from "./project-panels";

const overview: ProjectOverview = {
  id: "s",
  path: "/p.tunestudio",
  fileSize: 1000,
  createdAt: "2026-10-14T12:00:00Z",
  song: {
    title: "Duet",
    artist: "Two Voices",
    language: ["English", "German"],
    year: 2024,
    genre: null,
    edition: "SingStar",
    creator: null,
    bpm: 312.5,
    gap: -0.2505,
    videoGap: null,
    previewStart: 12.5,
    start: null,
    end: null,
    medleyStart: 30,
    medleyEnd: 60,
    extraHeaders: [["COMMENT", "kept"]],
  },
  singers: [
    { index: 1, name: "Low voice", lines: 3, notes: 20 },
    { index: 2, name: null, lines: 2, notes: 12 },
  ],
  lines: 5,
  notes: 32,
  goldenNotes: 4,
  chartStart: 10,
  chartEnd: 231,
  media: [
    {
      id: 1,
      role: "audio",
      fileName: "mix.mp3",
      mime: "audio/mpeg",
      size: 4_200_000,
      duration: 241,
      url: "media://s/1",
    },
    { id: 2, role: "cover", fileName: "front.jpg", mime: "image/jpeg", size: 2048, duration: null, url: "media://s/2" },
  ],
  importWarnings: [],
  importedFrom: null,
  lyrics: null,
};

describe("project panels", () => {
  it("shows the chart's numbers and each duet singer", () => {
    render(() => <ChartStats overview={overview} />);
    expect(screen.getByTestId("stat-notes")).toHaveTextContent("32");
    expect(screen.getByTestId("stat-singers")).toHaveTextContent("2");
    expect(screen.getByTestId("stat-length")).toHaveTextContent("3:41");
    expect(screen.getByText("Low voice")).toBeInTheDocument();
    expect(screen.getByText("Singer 2")).toBeInTheDocument();
    expect(screen.getByText("Golden notes")).toBeInTheDocument();
  });

  it("lists only the song details that are set, and the extra headers", () => {
    render(() => <SongDetails overview={overview} />);
    const terms = screen.getAllByRole("term").map((term) => term.textContent);
    expect(terms).toEqual(["BPM", "GAP", "Language", "Year", "Edition", "Preview from", "Medley"]);
    expect(screen.getByText("-0.251 s")).toBeInTheDocument();
    expect(screen.getByText("30 s to 60 s")).toBeInTheDocument();
    expect(screen.getByText("#COMMENT")).toBeInTheDocument();
  });

  it("lists media with role, name, size and known length", () => {
    render(() => <MediaList media={overview.media} />);
    const rows = within(screen.getByRole("list", { name: "Media" })).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual(["Audiomix.mp34.0 MB4:01", "Coverfront.jpg2.0 KB"]);
  });

  it("says when there is no media, and lists import notes", () => {
    render(() => (
      <>
        <MediaList media={[]} />
        <ImportNotes warnings={["The cover is missing."]} />
      </>
    ));
    expect(screen.getByText("This project has no media.")).toBeInTheDocument();
    expect(screen.getByTestId("import-notes")).toHaveTextContent("The cover is missing.");
  });
});

describe("LyricsList", () => {
  it("shows every line's text, also when the chorus repeats", () => {
    const chorus = ["Du brauchst ein bisschen mehr Liebe", "Schenk dir ein bisschen mehr Liebe"];
    render(() => (
      <LyricsList
        lines={[
          { start: 33.08, text: chorus[0]! },
          { start: 36.28, text: chorus[1]! },
          { start: 46.74, text: chorus[0]! },
          { start: 49.91, text: chorus[1]! },
        ]}
      />
    ));
    const items = within(screen.getByRole("list", { name: "Lyrics" })).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      `0:33${chorus[0]}`,
      `0:36${chorus[1]}`,
      `0:47${chorus[0]}`,
      `0:50${chorus[1]}`,
    ]);
  });
});
