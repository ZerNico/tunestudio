import { parseUltraStar, serializeUltraStar } from "@tunestudio/ultrastar";
import { describe, expect, it } from "vitest";

import { chartToProject, headerNumber, projectToChart } from "./chart-mapping";

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

  it("prefers #P1 over #DUETSINGERP1 and groups lines per singer", () => {
    const { chart: project } = chartToProject(
      chart(["#BPM:300", "#DUETSINGERP1:Old", "#P1:New", "P2", ": 0 2 0 b", "P1", ": 0 2 0 a", "- 3", ": 4 2 0 c"]),
    );
    expect(project.singers.map((singer) => [singer.index, singer.name, singer.lines.length])).toEqual([
      [1, "New", 2],
      [2, null, 1],
    ]);
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
        "- 3 4",
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

  it("formats header numbers without float noise", () => {
    expect(headerNumber(0.2505 * 1000)).toBe("250.5");
    expect(headerNumber(-0.2505 * 1000)).toBe("-250.5");
    expect(headerNumber(1.1 * 3)).toBe("3.3");
    expect(headerNumber(1000)).toBe("1000");
  });
});
