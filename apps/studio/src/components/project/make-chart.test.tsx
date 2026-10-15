import { render, screen, waitFor } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ImportProgress, ProjectOverview } from "~/lib/native/types";

import { describeChartProgress, MakeChart } from "./make-chart";

// The main process isn't there in jsdom: its client is the one thing replaced.
const native = vi.hoisted(() => ({ project: { makeChart: vi.fn() } }));
vi.mock("~/lib/native/client", () => ({ native }));

const project = (overrides: Partial<ProjectOverview> = {}): ProjectOverview => ({
  id: "s",
  path: "/p.tunestudio",
  fileSize: 1000,
  createdAt: "2026-10-15T12:00:00Z",
  song: {
    title: "Song",
    artist: "Artist",
    language: ["English"],
    year: null,
    genre: null,
    edition: null,
    creator: null,
    bpm: 300,
    gap: 0,
    videoGap: null,
    previewStart: null,
    start: null,
    end: null,
    medleyStart: null,
    medleyEnd: null,
    extraHeaders: [],
  },
  singers: [],
  lines: 0,
  notes: 0,
  goldenNotes: 0,
  chartStart: null,
  chartEnd: null,
  media: [
    { id: 1, role: "audio", fileName: "song.m4a", mime: "audio/mp4", size: 1, duration: 200, url: "media://s/1" },
    { id: 2, role: "vocals", fileName: "vocals.m4a", mime: "audio/mp4", size: 1, duration: 200, url: "media://s/2" },
  ],
  importWarnings: [],
  importedFrom: null,
  lyrics: { source: "lrclib", synced: true, lines: [{ start: 1, text: "Hello there" }] },
  ...overrides,
});

async function* progress(steps: ImportProgress[], result: ProjectOverview) {
  for (const step of steps) yield step;
  return result;
}

beforeEach(() => native.project.makeChart.mockReset());

describe("MakeChart", () => {
  it("says what's missing before a chart can be made", () => {
    render(() => <MakeChart overview={project({ lyrics: null })} onDone={() => {}} />);
    expect(screen.getByRole("button", { name: "Make the chart" })).toBeDisabled();
    expect(screen.getByText("Add the lyrics first.")).toBeInTheDocument();
  });

  it("makes the chart, showing progress, and hands over the new overview", async () => {
    const made = project({ notes: 120, lines: 30 });
    native.project.makeChart.mockResolvedValue(
      progress([{ step: "Timing the lyrics", done: 40, total: 100, unit: "percent" }], made),
    );
    const onDone = vi.fn();
    render(() => <MakeChart overview={project()} onDone={onDone} />);
    await userEvent.click(screen.getByRole("button", { name: "Make the chart" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledExactlyOnceWith(made));
    expect(native.project.makeChart).toHaveBeenCalledExactlyOnceWith({ id: "s" }, expect.anything());
  });

  it("asks before replacing notes the song already has", async () => {
    native.project.makeChart.mockResolvedValue(progress([], project({ notes: 90 })));
    render(() => <MakeChart overview={project({ notes: 42 })} onDone={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Make the chart" }));
    expect(await screen.findByText("The song already has 42 notes.")).toBeInTheDocument();
    expect(native.project.makeChart).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(native.project.makeChart).toHaveBeenCalledOnce());
  });

  it("describes downloads in bytes and steps in percent", () => {
    expect(describeChartProgress({ step: "Getting the chart models", done: 1_000_000, total: 2_000_000 })).toMatch(
      /^Getting the chart models… .* of .*$/,
    );
    expect(describeChartProgress({ step: "Writing the notes", done: 50, total: 100, unit: "percent" })).toBe(
      "Writing the notes… 50%",
    );
  });
});
