import { parseUltraStar, serializeUltraStar } from "@tunestudio/ultrastar";
import { describe, expect, it } from "vitest";

import { chartToProject, emptySingerWarnings, headerNumber, projectToChart } from "./chart-mapping";

const chart = (lines: string[]) => parseUltraStar(`${lines.join("\n")}\nE\n`).document;

describe("chartToProject", () => {
  it("models the known headers in seconds and keeps the rest in order", () => {
    const { chart: project, warnings } = chartToProject(
      chart([
        "#ENCODING:UTF8",
        "#TITLE: Spaced ",
        "#ARTIST:Artist",
        "#ZZZ:first",
        "#LANGUAGE:German; English",
        "#BPM:400",
        "#GAP:2000",
        "#START:1,5",
        "#END:90000",
        "#MEDLEYSTARTBEAT:40",
        "#MEDLEYEND:80000",
        "#AAA:second",
        "#MP3:song.mp3",
        ": 0 1 0 a",
      ]),
    );
    expect(warnings).toEqual([]);
    expect(project.song).toMatchObject({
      title: "Spaced",
      language: ["German", "English"],
      bpm: 400,
      gap: 2,
      start: 1.5,
      end: 90,
      medleyStart: 2 + 40 * (15 / 400),
      medleyEnd: 80,
      extraHeaders: [
        ["ZZZ", "first"],
        ["AAA", "second"],
      ],
    });
  });

  it("keeps values it can't read, with a warning", () => {
    const { chart: project, warnings } = chartToProject(
      chart(["#BPM:300", "#YEAR:199x", "#VIDEOGAP:soon", ": 0 1 0 a"]),
    );
    expect(project.song.year).toBeNull();
    expect(project.song.videoGap).toBeNull();
    expect(project.song.extraHeaders).toEqual([
      ["YEAR", "199x"],
      ["VIDEOGAP", "soon"],
    ]);
    expect(warnings).toHaveLength(2);
  });

  it("keeps a break at the default spot as default timing, and writes it back the same", () => {
    // Two steps before the next line (beat 10) is the default for an 8-beat gap: beat 8. The last line has no break.
    const lines = ["#BPM:300", ": 0 2 0 a", "- 8", ": 10 2 0 b", "- 15", ": 20 2 0 c", "- 24 26", ": 30 2 0 d"];
    const { chart: project } = chartToProject(chart(lines));
    expect(project.singers[0]!.lines.map((line) => line.switchStart === null)).toEqual([true, false, false, true]);
    const text = serializeUltraStar(projectToChart(project, {}));
    expect(text).toContain("\n- 8\n");
    expect(text).toContain("\n- 15\n");
    // The v1 format has one beat per break.
    expect(text).toContain("\n- 24\n");
  });

  it("prefers #P1 over #DUETSINGERP1 and groups lines per singer", () => {
    const { chart: project } = chartToProject(
      chart(["#BPM:300", "#DUETSINGERP1:Old", "#P1:New", "P2", ": 0 2 0 b", "P1", ": 0 2 0 a", "- 3", ": 4 2 0 c"]),
    );
    expect(project.singers.map((singer) => [singer.index, singer.name, singer.lines.length])).toEqual([
      [1, "New", 2],
      [2, null, 1],
    ]);
  });

  it("imports a part for both singers (P3) as notes of both, without its name header", () => {
    const { chart: project } = chartToProject(
      chart(["#BPM:300", "#P1:Anna", "#P2:Ben", "#P3:Both", "P1", ": 0 2 0 a", "P2", ": 0 2 5 b", "P3", ": 8 2 3 c"]),
    );
    expect(
      project.singers.map((singer) => [singer.name, singer.lines.map((line) => line.notes.map((n) => n.lyric))]),
    ).toEqual([
      ["Anna", [["a"], ["c"]]],
      ["Ben", [["b"], ["c"]]],
    ]);
    expect(project.song.extraHeaders.map(([key]) => key)).not.toContain("P3");
  });

  it("reads empty headers as absent, #AUTHOR as #CREATOR, and drops deprecated headers", () => {
    const { chart: project, warnings } = chartToProject(
      chart(["#BPM:300", "#YEAR:", "#END: ", "#GENRE:", "#NOTESGAP:12", "#RESOLUTION:4", "#AUTHOR: Ann ", ": 0 1 0 a"]),
    );
    expect(warnings).toEqual([]);
    expect(project.song).toMatchObject({ year: null, end: null, genre: null, creator: "Ann", extraHeaders: [] });
    expect(serializeUltraStar(projectToChart(project, {}))).toContain("\n#CREATOR:Ann\n");

    // Next to a #CREATOR of its own, a different #AUTHOR stays as it is.
    const both = chartToProject(chart(["#BPM:300", "#AUTHOR:Ann", "#CREATOR:Ben", ": 0 1 0 a"])).chart.song;
    expect(both).toMatchObject({ creator: "Ben", extraHeaders: [["AUTHOR", "Ann"]] });
  });

  it("gives an empty chart one singer", () => {
    expect(chartToProject(chart(["#BPM:300"])).chart.singers).toEqual([{ index: 1, name: null, lines: [] }]);
  });
});

describe("projectToChart", () => {
  it("writes the modelled headers, then the extra ones, and the notes back on the grid", () => {
    const original = chart([
      "#TITLE:T",
      "#ARTIST:A",
      "#X:kept",
      "#BPM:300",
      "#GAP:1000",
      ": 0 2 0 a",
      "- 3 4",
      "* 4 2 1 b",
    ]);
    const { chart: project } = chartToProject(original);
    const text = serializeUltraStar(projectToChart(project, { AUDIO: "A - T.mp3", MP3: "A - T.mp3" }));
    expect(text).toBe(
      [
        "#VERSION:1.2.0",
        "#TITLE:T",
        "#ARTIST:A",
        "#AUDIO:A - T.mp3",
        "#MP3:A - T.mp3",
        "#BPM:300",
        "#GAP:1000",
        "#X:kept",
        ": 0 2 0 a",
        "- 3",
        "* 4 2 1 b",
        "E",
        "",
      ].join("\n"),
    );
  });

  it("rewrites source metadata for games instead of reviving imported sources", () => {
    const { chart: project } = chartToProject(chart(["#BPM:300"]));
    project.song.extraHeaders = [["VIDEO", "a=dQw4w9WgXcQ,v=kPBzTxZQG5Q,co=cover.jpg"]];
    project.song.youtubeId = "rl0IjlamWPI";
    project.song.youtubeAudioId = "dQw4w9WgXcQ";
    expect(projectToChart(project, {}).metadata.VIDEO).toBe("a=dQw4w9WgXcQ,v=rl0IjlamWPI,co=cover.jpg");
    project.song.youtubeAudioId = null;
    expect(projectToChart(project, {}).metadata.VIDEO).toBe("v=rl0IjlamWPI,co=cover.jpg");
    project.song.youtubeId = null;
    expect(projectToChart(project, {}).metadata.VIDEO).toBe("co=cover.jpg");
    expect(projectToChart(project, { VIDEO: "clip.mp4" }).metadata.VIDEO).toBe("clip.mp4");
    project.song.extraHeaders = [["VIDEO", "a=dQw4w9WgXcQ,v=kPBzTxZQG5Q"]];
    expect(projectToChart(project, {}).metadata.VIDEO).toBeUndefined();
  });

  it("exports a duet whose second singer has no notes as a solo chart, and says so", () => {
    const { chart: project } = chartToProject(chart(["#BPM:300", "#P1:Anna", ": 0 2 0 a"]));
    const solo = serializeUltraStar(projectToChart(project, {}));
    project.singers.push({ index: 2, name: "Ben", lines: [{ switchStart: null, switchEnd: null, notes: [] }] });
    expect(serializeUltraStar(projectToChart(project, {}))).toBe(solo);
    expect(emptySingerWarnings(project)).toEqual(["Ben has no notes, so the song is exported as a solo chart."]);

    // Only P2 sings: its notes, without a player marker or a name for a singer the file doesn't have.
    project.singers[0]!.lines = [];
    project.singers[1]!.lines[0]!.notes.push({ start: 1, duration: 0.4, pitch: 60, lyric: "b", type: "normal" });
    const text = serializeUltraStar(projectToChart(project, {}));
    expect(text).not.toMatch(/^P\d|#P[12]:/m);
    expect(text).toContain("\n: 20 8 0 b\n");
    expect(emptySingerWarnings(project)).toEqual(["Anna has no notes, so the song is exported as a solo chart."]);
  });

  it("names both singers of a duet, even unnamed ones", () => {
    const { chart: project } = chartToProject(chart(["#BPM:300", "#P2:Ben", "P1", ": 0 2 0 a", "P2", ": 4 2 0 b"]));
    const metadata = projectToChart(project, {}).metadata;
    expect([metadata.P1, metadata.P2]).toEqual(["P1", "Ben"]);
    project.singers[1]!.name = " ";
    expect(projectToChart(project, {}).metadata.P2).toBe("P2");
  });

  it("writes #END in whole milliseconds and the medley headers only as a pair", () => {
    const { chart: project } = chartToProject(chart(["#BPM:300", ": 0 2 0 a"]));
    project.song.end = 61.2345;
    project.song.medleyStart = 1;
    const only = projectToChart(project, {}).metadata;
    expect(only.END).toBe("61235");
    expect(only.MEDLEYSTARTBEAT).toBeUndefined();
    project.song.medleyEnd = 2;
    expect(projectToChart(project, {}).metadata).toMatchObject({ MEDLEYSTARTBEAT: "20", MEDLEYENDBEAT: "40" });
    // USDX drops a medley that ends before it starts.
    project.song.medleyEnd = 0.5;
    expect(projectToChart(project, {}).metadata.MEDLEYENDBEAT).toBeUndefined();
  });

  it("drops deprecated headers an older project kept", () => {
    const { chart: project } = chartToProject(chart(["#BPM:300", ": 0 2 0 a"]));
    project.song.extraHeaders = [
      ["NOTESGAP", "3"],
      ["RESOLUTION", "4"],
      ["X", "kept"],
    ];
    expect(Object.keys(projectToChart(project, {}).metadata)).toEqual(["VERSION", "BPM", "GAP", "X"]);
  });

  it("formats header numbers without float noise", () => {
    expect(headerNumber(0.2505 * 1000)).toBe("250.5");
    expect(headerNumber(-0.2505 * 1000)).toBe("-250.5");
    expect(headerNumber(1.1 * 3)).toBe("3.3");
    expect(headerNumber(1000)).toBe("1000");
  });
});
