import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { chartInputsKey } from "../../src/lib/chart-inputs";
import type { ImportProgress } from "../../src/lib/native/types";
import { DEFAULT_SETTINGS, type Settings } from "../../src/lib/settings";
import { createDraftProject, listenToDraft, makeDraftChart } from "../drafts/draft-project";
import { projectOverview } from "../project/overview";
import { sungPitch } from "../project/pitch";
import { Projects, projectsLayer } from "../project/projects";
import { AppLog } from "../services/app-log";
import { Drafts, draftsLayer } from "../services/drafts";
import { AppSettings, settingsLayer } from "../services/settings";
import { fakeModels, fakeNative, recordingDesktop, tempDir } from "../testing";
import { DownloadFailed, Downloads } from "../tools/downloads";
import { Tools } from "../tools/tools";
import { gainTags, parseLoudness } from "./loudness";
import { downloadVideo, inspectVideo, videoFormat, videoLanguage, youtubeError } from "./youtube";
import { downloadIntoDraft } from "./youtube-draft";

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.toReversed()) cleanup();
  cleanups = [];
});

/** What a fake tool was asked to do. */
type Call = { tool: string; args: string[] };

/**
 * A stand-in for yt-dlp and FFmpeg: a Node script that records its arguments in `calls.jsonl`
 * and behaves as the real tool does for Tune Studio's commands, steered by `behavior.json`.
 */
const FAKE_TOOL = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const dir = __dirname;
// The updated yt-dlp is the same fake, told apart for "fails until updated" behaviour.
const updated = process.argv[2] === "yt-dlp-new";
const tool = updated ? "yt-dlp" : process.argv[2];
const args = process.argv.slice(3);
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ tool, args }) + "\n");
const behavior = JSON.parse(fs.readFileSync(path.join(dir, "behavior.json"), "utf8"));
const value = (flag) => args[args.indexOf(flag) + 1];
const fail = (message) => { process.stderr.write("WARNING: something\nERROR: [youtube] abcdefghijk: " + message + "\n"); process.exit(1); };

if (tool === "yt-dlp") {
  if (behavior.failAll) fail(behavior.failAll);
  if (args.includes("--dump-single-json")) {
    process.stdout.write(JSON.stringify(behavior.video));
    process.exit(0);
  }
  const format = value("-f");
  // A video the length filter turns away is skipped without a word, as yt-dlp does with --quiet.
  console.log("@duration " + behavior.video.duration);
  const filter = /^duration<=\?(\d+)$/.exec(value("--match-filters") ?? "");
  if (filter && behavior.video.duration > Number(filter[1])) process.exit(0);
  if (format.startsWith("bestvideo") && behavior.failVideo) fail(behavior.failVideo);
  if (format.startsWith("bestvideo") && behavior.failVideoUntilUpdated && !updated) fail(behavior.failVideoUntilUpdated);
  if (behavior.forbidden) {
    const counter = path.join(dir, "forbidden-count");
    const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
    if (count < behavior.forbidden) {
      fs.writeFileSync(counter, String(count + 1));
      process.stderr.write("ERROR: unable to download video data: HTTP Error 403: Forbidden\n");
      process.exit(1);
    }
  }
  const codecs = { m4a: "m4a", mp3: "mp3", vorbis: "ogg", opus: "opus" };
  const ext = args.includes("-x") ? codecs[value("--audio-format")] : format.startsWith("bestvideo") ? "mp4" : "webm";
  const template = args[args.lastIndexOf("-o") + 1];
  const file = template.replace("%(ext)s", ext);
  fs.writeFileSync(file, "media:" + ext);
  if (args.includes("--write-thumbnail")) {
    const thumbnail = args.find((arg) => arg.startsWith("thumbnail:")).slice("thumbnail:".length);
    fs.writeFileSync(thumbnail.replace("%(ext)s", "jpg"), "thumbnail");
  }
  console.log("@progress 50 100 NA");
  console.log("@progress 100 100 NA");
  console.log("@file " + file);
  process.exit(0);
}

if (tool === "ffprobe") {
  // Opus states no bitrate for its stream, only for the file.
  console.log("N/A");
  console.log(String(behavior.bitrate ?? 128000));
  process.exit(0);
}

// ffmpeg
const filter = args.find((arg) => arg.startsWith("loudnorm") || arg.startsWith("crop")) ?? "";
if (filter.includes("print_format=json")) {
  process.stderr.write('[Parsed_loudnorm_0] \n{\n "input_i" : "-13.10",\n "input_tp" : "-0.44",\n "input_lra" : "6.20",\n "input_thresh" : "-23.30",\n "target_offset" : "0.10"\n}\n');
  process.exit(0);
}
const output = args.at(-1);
fs.writeFileSync(output, filter.startsWith("crop") ? "cover" : fs.readFileSync(value("-i")));
process.exit(0);
`;

interface Behavior {
  video?: unknown;
  /** How many downloads YouTube refuses before one works. */
  forbidden?: number;
  failAll?: string;
  failVideo?: string;
  /** The video fails with the installed yt-dlp and works with the updated one. */
  failVideoUntilUpdated?: string;
  /** The bitrate ffprobe reports for the downloaded audio. */
  bitrate?: number;
}

const VIDEO_JSON = {
  id: "dQw4w9WgXcQ",
  title: "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)",
  channel: "Rick Astley",
  duration: 213,
  release_year: null,
  live_status: "not_live",
  thumbnails: [{ url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg", width: 480 }],
  formats: [{ format_id: "140" }],
};

/** Fake tools in a temp folder; `updated` is what a forced update installs. */
function fakeTools() {
  const { dir, cleanup } = tempDir();
  cleanups.push(cleanup);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "fake.cjs"), FAKE_TOOL);
  const executable = (name: string, tool: string) => {
    const file = path.join(bin, name);
    fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, "fake.cjs")}" ${tool} "$@"\n`, {
      mode: 0o755,
    });
    return file;
  };
  const tools = {
    ytDlp: executable("yt-dlp", "yt-dlp"),
    updated: executable("yt-dlp-new", "yt-dlp-new"),
    ffmpeg: executable("ffmpeg", "ffmpeg"),
    ffprobe: executable("ffprobe", "ffprobe"),
  };
  const state = { forced: 0 };
  const behave = (behavior: Behavior) =>
    fs.writeFileSync(path.join(bin, "behavior.json"), JSON.stringify({ video: VIDEO_JSON, ...behavior }));
  behave({});
  const calls = (): Call[] =>
    fs.existsSync(path.join(bin, "calls.jsonl"))
      ? fs
          .readFileSync(path.join(bin, "calls.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Call)
      : [];
  const layer = Layer.succeed(Tools, {
    folder: path.join(dir, "tools"),
    status: Effect.succeed([]),
    ensure: (_names, options) =>
      Effect.sync(() => {
        if (options?.force) state.forced++;
        return {
          "yt-dlp": { "yt-dlp": options?.force ? tools.updated : tools.ytDlp },
          quickjs: { qjs: "/tools/qjs" },
          ffmpeg: { ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe },
        };
      }),
    remove: () => Effect.void,
  });
  return { dir, layer, behave, calls, state };
}

const lines: string[] = [];
const log = Layer.succeed(AppLog, {
  write: (level, _target, message) => Effect.sync(() => void lines.push(`${level} ${message}`)),
});
/** Offline: the preview thumbnail can't be fetched. */
const offline = Layer.succeed(Downloads, {
  json: (url) => Effect.fail(new DownloadFailed({ url, message: "No connection." })),
  text: (url) => Effect.fail(new DownloadFailed({ url, message: "No connection." })),
  redirect: (url) => Effect.fail(new DownloadFailed({ url, message: "No connection." })),
  file: (url) => Effect.fail(new DownloadFailed({ url, message: "No connection." })),
});

function setup() {
  const fake = fakeTools();
  const desktop = recordingDesktop(path.join(fake.dir, "Music"));
  const layer = Layer.mergeAll(
    fake.layer,
    offline,
    log,
    desktop.layer,
    projectsLayer("0.0.0-test"),
    settingsLayer(path.join(fake.dir, "settings.json")),
    draftsLayer(path.join(fake.dir, "drafts")),
    fakeNative,
    fakeModels,
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const work = path.join(fake.dir, "work");
  fs.mkdirSync(work);
  return { ...fake, layer, work };
}

const ytDlpCalls = (calls: Call[]) => calls.filter((call) => call.tool === "yt-dlp").map((call) => call.args);

const settings = (change: { audio?: Partial<Settings["audio"]>; video?: Partial<Settings["video"]> }): Settings => ({
  audio: { ...DEFAULT_SETTINGS.audio, ...change.audio },
  video: { ...DEFAULT_SETTINGS.video, ...change.video },
  newProject: DEFAULT_SETTINGS.newProject,
});

describe("videoLanguage", () => {
  it("is the language the uploader set, else the one the captions were heard in", () => {
    expect(videoLanguage({ language: "en-US", automatic_captions: { "de-orig": [] } })).toBe("en");
    expect(videoLanguage({ language: null, automatic_captions: { de: [], "de-orig": [], en: [] } })).toBe("de");
    // Translated captions say nothing about the song.
    expect(videoLanguage({ automatic_captions: { de: [], en: [] } })).toBeNull();
    expect(videoLanguage({})).toBeNull();
  });
});

describe("inspectVideo", () => {
  it.effect("reads the details with only the bundled QuickJS and suggests the song", () => {
    const { layer, calls } = setup();
    return Effect.gen(function* () {
      const video = yield* inspectVideo("dQw4w9WgXcQ");
      expect(video).toEqual({
        videoId: "dQw4w9WgXcQ",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        title: "Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)",
        channel: "Rick Astley",
        duration: 213,
        // Offline, so there is no preview; the details are still there.
        thumbnail: null,
        artist: "Rick Astley",
        songTitle: "Never Gonna Give You Up",
        year: null,
        language: null,
      });
      const [args] = ytDlpCalls(calls());
      expect(args).toContain("--ignore-config");
      expect(args!.slice(args!.indexOf("--no-js-runtimes"), args!.indexOf("--no-js-runtimes") + 3)).toEqual([
        "--no-js-runtimes",
        "--js-runtimes",
        "quickjs:/tools/qjs",
      ]);
      // The link comes last, after "--", so it can never be read as an option.
      expect(args!.slice(-2)).toEqual(["--", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses anything but a video ID without running yt-dlp", () => {
    const { layer, calls } = setup();
    return Effect.gen(function* () {
      const error = yield* Effect.flip(inspectVideo("--exec=rm"));
      expect(error._tag).toBe("VideoUnavailable");
      expect(calls()).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("explains an unavailable video without updating yt-dlp", () => {
    const { layer, behave, state } = setup();
    behave({ failAll: "Private video. Sign in if you've been granted access to this video" });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(inspectVideo("dQw4w9WgXcQ"));
      expect(error).toMatchObject({
        _tag: "VideoUnavailable",
        message: "This video is private, so it can't be downloaded.",
      });
      expect(state.forced).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("updates yt-dlp and tries again when it fails for another reason", () => {
    const { layer, behave, calls, state } = setup();
    behave({ failAll: "Some YouTube change" });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(inspectVideo("dQw4w9WgXcQ"));
      expect(state.forced).toBe(1);
      // Both the installed and the updated yt-dlp ran.
      expect(calls().filter((call) => call.tool === "yt-dlp")).toHaveLength(2);
      expect(error.message).toBe("Couldn't get the video from YouTube: Some YouTube change");
    }).pipe(Effect.provide(layer));
  });
});

describe("downloadVideo", () => {
  it.effect("downloads the audio as M4A, the video as set, and a square cover", () => {
    const { layer, calls, work } = setup();
    return Effect.gen(function* () {
      const progress: ImportProgress[] = [];
      const media = yield* downloadVideo("dQw4w9WgXcQ", DEFAULT_SETTINGS, work, (step) =>
        Effect.sync(() => void progress.push(step)),
      );
      expect(media).toEqual({
        audio: path.join(work, "audio.m4a"),
        video: path.join(work, "video.mp4"),
        videoProblem: null,
        cover: path.join(work, "cover.jpg"),
        vocals: null,
        instrumental: null,
      });
      const [audio, video] = ytDlpCalls(calls());
      expect(audio).toEqual(expect.arrayContaining(["-x", "--audio-format", "m4a", "--audio-quality", "256K"]));
      expect(audio![audio!.indexOf("-f") + 1]).toBe("bestaudio[ext=m4a]/bestaudio/bestaudio*");
      expect(video![video!.indexOf("-f") + 1]).toBe(videoFormat(DEFAULT_SETTINGS.video));
      expect(progress).toContainEqual({ step: "Downloading the audio", done: 50, total: 100 });
      expect(progress).toContainEqual({ step: "Downloading the video", done: 100, total: 100 });
      // No volume step when normalization is off.
      expect(progress.map((step) => step.step)).not.toContain("Adjusting the volume");
    }).pipe(Effect.provide(layer));
  });

  it.effect("normalizes by encoding once at the target loudness, without the video", () => {
    const { layer, calls, work } = setup();
    return Effect.gen(function* () {
      const media = yield* downloadVideo(
        "dQw4w9WgXcQ",
        settings({ audio: { format: "opus", bitrate: 160, normalization: "rewrite" }, video: { download: false } }),
        work,
        () => Effect.void,
      );
      expect(media.audio).toBe(path.join(work, "audio.opus"));
      expect(media.video).toBeNull();
      const [audio, ...others] = ytDlpCalls(calls());
      expect(audio).not.toContain("-x");
      expect(others).toEqual([]);
      const encode = calls().find((call) => call.tool === "ffmpeg" && call.args.includes("libopus"))!.args;
      expect(encode).toEqual(expect.arrayContaining(["-b:a", "160k", "-ar", "48000"]));
      expect(encode.find((arg) => arg.startsWith("loudnorm"))).toContain("I=-23:");
      expect(encode.find((arg) => arg.startsWith("loudnorm"))).toContain("measured_I=-13.1:");
    }).pipe(Effect.provide(layer));
  });

  it.effect("writes ReplayGain tags without encoding the audio again", () => {
    const { layer, calls, work } = setup();
    return Effect.gen(function* () {
      yield* downloadVideo(
        "dQw4w9WgXcQ",
        settings({ audio: { normalization: "replaygain" }, video: { download: false } }),
        work,
        () => Effect.void,
      );
      const tag = calls().find((call) => call.tool === "ffmpeg" && call.args.includes("copy"))!.args;
      expect(tag).toEqual(
        expect.arrayContaining(["-metadata", "REPLAYGAIN_TRACK_GAIN=-4.90 dB", "-movflags", "use_metadata_tags"]),
      );
      expect(fs.readdirSync(work)).toContain("audio.m4a");
    }).pipe(Effect.provide(layer));
  });

  it.live("starts over with a fresh link when YouTube refuses one", () => {
    const { layer, behave, calls, work } = setup();
    behave({ forbidden: 1 });
    return Effect.gen(function* () {
      const settingsWithoutVideo = settings({ video: { download: false } });
      const media = yield* downloadVideo("dQw4w9WgXcQ", settingsWithoutVideo, work, () => Effect.void);
      expect(media.audio).toBe(path.join(work, "audio.m4a"));
      expect(ytDlpCalls(calls())).toHaveLength(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("updates yt-dlp and tries the video again when only the video fails", () => {
    const { layer, behave, work, state } = setup();
    behave({ failVideoUntilUpdated: "Some YouTube change" });
    return Effect.gen(function* () {
      const media = yield* downloadVideo("dQw4w9WgXcQ", DEFAULT_SETTINGS, work, () => Effect.void);
      expect(state.forced).toBe(1);
      expect(media.video).toBe(path.join(work, "video.mp4"));
      expect(media.videoProblem).toBeNull();
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps the audio when the video can't be downloaded, and says why", () => {
    const { layer, behave, work } = setup();
    behave({ failVideo: "Requested format is not available" });
    return Effect.gen(function* () {
      const media = yield* downloadVideo("dQw4w9WgXcQ", DEFAULT_SETTINGS, work, () => Effect.void);
      expect(media.audio).toBe(path.join(work, "audio.m4a"));
      expect(media.video).toBeNull();
      expect(media.videoProblem).toBe("Couldn't get the video from YouTube: Requested format is not available");
    }).pipe(Effect.provide(layer));
  });
});

describe("downloadVideo's length limit", () => {
  it.effect("doesn't download a video longer than a song can be", () => {
    const { layer, behave, calls, work } = setup();
    behave({ video: { ...VIDEO_JSON, duration: 3600 } });
    return Effect.gen(function* () {
      const error = yield* Effect.flip(downloadVideo("dQw4w9WgXcQ", DEFAULT_SETTINGS, work, () => Effect.void));
      expect(error).toMatchObject({
        _tag: "VideoUnavailable",
        message: expect.stringContaining("longer than 20 minutes"),
      });
      const [audio] = ytDlpCalls(calls());
      expect(audio![audio!.indexOf("--match-filters") + 1]).toBe("duration<=?1200");
      expect(fs.readdirSync(work)).toEqual([]);
    }).pipe(Effect.provide(layer));
  });
});

describe("downloadIntoDraft", () => {
  it.effect("separates vocals and instrumental and encodes them like the audio, at no more than its bitrate", () => {
    const { layer, calls } = setup();
    const progress: ImportProgress[] = [];
    return Effect.gen(function* () {
      yield* AppSettings.use((stored) => stored.set(settings({ audio: { format: "mp3", bitrate: 192 } })));
      const { draftId } = yield* downloadIntoDraft("dQw4w9WgXcQ", (step) =>
        Effect.sync(() => void progress.push(step)),
      );
      const draft = yield* Drafts.use((drafts) => drafts.get(draftId));
      // The fake decoder hands over the audio file's bytes as samples; the fake engine halves them.
      const audio = fs.readFileSync(draft.media!.audio);
      const mix = new Float32Array(audio.buffer.slice(audio.byteOffset, audio.byteOffset + 8));
      const vocals = fs.readFileSync(draft.media!.vocals!);
      expect(draft.media!.vocals).toBe(path.join(draft.folder, "vocals.mp3"));
      expect([...new Float32Array(vocals.buffer.slice(vocals.byteOffset, vocals.byteOffset + 8))]).toEqual(
        [...mix].map((sample) => sample / 2),
      );
      // The instrumental is the song without the vocals.
      const instrumental = fs.readFileSync(draft.media!.instrumental!);
      expect(draft.media!.instrumental).toBe(path.join(draft.folder, "instrumental.mp3"));
      expect([
        ...new Float32Array(instrumental.buffer.slice(instrumental.byteOffset, instrumental.byteOffset + 8)),
      ]).toEqual([...mix].map((sample) => sample - sample / 2));
      const [decode, encode] = calls()
        .filter((call) => call.tool === "ffmpeg" && call.args.includes("f32le"))
        .map((call) => call.args);
      expect(decode).toEqual(
        expect.arrayContaining(["-i", draft.media!.audio, "-f", "f32le", "-ar", "44100", "-ac", "2"]),
      );
      // The song has 128 kbit/s; storing the vocals at the setting's 192 would add nothing.
      expect(encode).toEqual(expect.arrayContaining(["-f", "f32le", "-c:a", "libmp3lame", "-b:a", "128k"]));
      // The raw samples in between are gone.
      expect(fs.readdirSync(draft.folder).filter((name) => name.endsWith(".f32"))).toEqual([]);
      expect(progress).toContainEqual({ step: "Separating the voice", done: 50, total: 100, unit: "percent" });
      expect(lines).toContainEqual(expect.stringMatching(/^INFO Separated 0 s of audio on the GPU/));
    }).pipe(Effect.provide(layer));
  });
});

describe("listenToDraft", () => {
  it.effect("hears only where something is sung in the vocals, without made-up captions", () => {
    const { layer, calls } = setup();
    const progress: ImportProgress[] = [];
    return Effect.gen(function* () {
      const { draftId } = yield* downloadIntoDraft("dQw4w9WgXcQ");
      const draft = yield* Drafts.use((drafts) => drafts.get(draftId));
      // The fake decoder hands the file over as samples: two sung lines, far apart.
      const rate = 16_000;
      const vocals = new Float32Array(12 * rate);
      const lines: [from: number, to: number][] = [
        [1, 3],
        [8, 10],
      ];
      for (const [from, to] of lines) {
        for (let i = from * rate; i < to * rate; i++) vocals[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / rate);
      }
      fs.writeFileSync(draft.media!.vocals!, new Uint8Array(vocals.buffer));

      const heard = yield* listenToDraft(draftId, { language: null, mixed: false }, (step) =>
        Effect.sync(() => void progress.push(step)),
      );
      expect(heard).toEqual({
        language: "en",
        mixed: false,
        lines: [
          { start: 0.8, end: 3.2, text: "Line 1" },
          { start: 7.8, end: 10.2, text: "Line 2" },
        ],
      });
      const decode = calls().findLast((call) => call.tool === "ffmpeg")!.args;
      expect(decode).toEqual(expect.arrayContaining(["-i", draft.media!.vocals!, "-ar", "16000", "-ac", "1"]));
      expect(progress).toContainEqual({ step: "Listening to the song", done: 100, total: 100, unit: "percent" });
      expect(fs.readdirSync(draft.folder).filter((name) => name.endsWith(".f32"))).toEqual([]);

      // In the language the user chose.
      expect((yield* listenToDraft(draftId, { language: "de", mixed: false })).language).toBe("de");
    }).pipe(Effect.provide(layer));
  });
});

describe("createDraftProject", () => {
  it.effect("writes the song details, an empty chart and the media into a new project", () => {
    const { layer, dir } = setup();
    const target = path.join(dir, "Rick Astley - Never Gonna Give You Up.tunestudio");
    const downloads = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("tunestudio-youtube-"));
    const before = downloads();
    return Effect.gen(function* () {
      yield* AppSettings.use((stored) => stored.set(settings({ video: { download: false } })));
      const { draftId } = yield* downloadIntoDraft("dQw4w9WgXcQ");
      const session = yield* createDraftProject({
        draftId,
        artist: "Rick Astley",
        title: "Never Gonna Give You Up",
        year: 1987,
        genre: "Pop",
        cover: { kind: "thumbnail" },
        lyrics: {
          source: "lrclib",
          lrclibId: 7,
          lines: [
            { start: 19.32, text: "We're out walking by the sea" },
            { start: 23.21, text: "You hold the light and so do I" },
          ],
        },
        language: "en",
        chart: "empty",
        target,
      });
      const overview = yield* projectOverview(session);
      yield* Projects.use((projects) => projects.close(session.id));
      expect(overview.song).toMatchObject({
        artist: "Rick Astley",
        title: "Never Gonna Give You Up",
        year: 1987,
        genre: "Pop",
        language: ["English"],
      });
      expect(overview.notes).toBe(0);
      expect(overview.lyrics).toEqual({
        source: "lrclib",
        synced: true,
        lines: [
          { start: 19.32, text: "We're out walking by the sea" },
          { start: 23.21, text: "You hold the light and so do I" },
        ],
      });
      expect(overview.importedFrom).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
      expect(overview.media.map((file) => [file.role, file.fileName])).toEqual([
        ["audio", "Rick Astley - Never Gonna Give You Up.m4a"],
        ["vocals", "Rick Astley - Never Gonna Give You Up [VOC].m4a"],
        ["instrumental", "Rick Astley - Never Gonna Give You Up [INSTR].m4a"],
        ["cover", "Rick Astley - Never Gonna Give You Up [CO].jpg"],
      ]);
      // The downloads were temporary.
      expect(downloads()).toEqual(before);
    }).pipe(Effect.provide(layer));
  });
});

describe("makeDraftChart", () => {
  const lines = [{ start: null, text: "We're out walking by the sea" }];

  it.effect("fails without keeping a chart when it can't be made", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* AppSettings.use((stored) => stored.set(settings({ video: { download: false } })));
      const { draftId } = yield* downloadIntoDraft("dQw4w9WgXcQ");
      yield* Drafts.use((drafts) => drafts.setChart(draftId, { chart: tinyChart(), madeFrom: "before", pitch: PITCH }));
      // The fake FFmpeg "decodes" a few bytes: far too little song to chart.
      const error = yield* Effect.flip(makeDraftChart({ draftId, lines, language: "en" }));
      expect(error._tag).toBe("ChartFailed");
      expect((yield* Drafts.use((drafts) => drafts.get(draftId))).chart).toBeNull();
    }).pipe(Effect.provide(layer));
  });

  it.effect("doesn't try in a language charts can't be made in yet", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const { draftId } = yield* downloadIntoDraft("dQw4w9WgXcQ");
      const error = yield* Effect.flip(
        makeDraftChart({ draftId, lines: [{ start: null, text: "Bonjour" }], language: "fr" }),
      );
      expect(error).toMatchObject({
        _tag: "ChartFailed",
        message: "Charts can't be made in French yet, only in English and German.",
      });
    }).pipe(Effect.provide(layer));
  });
});

describe("createDraftProject with a made chart", () => {
  const lyrics = { source: "user" as const, lines: [{ start: null, text: "We're out walking by the sea" }] };
  const create = (draftId: string, target: string, language = "en") =>
    createDraftProject({
      draftId,
      artist: "Rick Astley",
      title: "Never Gonna Give You Up",
      year: 1987,
      genre: null,
      cover: { kind: "none" },
      lyrics,
      language,
      chart: "made",
      target,
    });

  it.effect("saves the chart made for the draft with the chosen song details", () => {
    const { layer, dir } = setup();
    return Effect.gen(function* () {
      const { draftId } = yield* downloadIntoDraft("dQw4w9WgXcQ");
      const madeFrom = chartInputsKey(lyrics.lines, "en");
      yield* Drafts.use((drafts) => drafts.setChart(draftId, { chart: tinyChart(), madeFrom, pitch: PITCH }));
      const session = yield* create(draftId, path.join(dir, "song.tunestudio"));
      const overview = yield* projectOverview(session);
      // The pitch the chart followed is kept with the vocals, so the editor doesn't work it out again.
      const pitch = yield* sungPitch(session);
      yield* Projects.use((projects) => projects.close(session.id));
      expect(pitch).toEqual({ hop: 0.01, midi: [64, 64.5, null] });
      expect(overview.notes).toBe(2);
      expect(overview.song).toMatchObject({
        artist: "Rick Astley",
        title: "Never Gonna Give You Up",
        year: 1987,
        language: ["English"],
        bpm: 400,
      });
      // Offered first for the next new project.
      expect((yield* AppSettings.use((stored) => stored.get)).newProject.language).toBe("en");
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a chart made from other lyrics or in another language, or none", () => {
    const { layer, dir } = setup();
    const target = path.join(dir, "song.tunestudio");
    return Effect.gen(function* () {
      const { draftId } = yield* downloadIntoDraft("dQw4w9WgXcQ");
      expect((yield* Effect.flip(create(draftId, target)))._tag).toBe("ChartOutdated");
      yield* Drafts.use((drafts) =>
        drafts.setChart(draftId, { chart: tinyChart(), madeFrom: chartInputsKey(lyrics.lines, "en"), pitch: PITCH }),
      );
      expect((yield* Effect.flip(create(draftId, target, "de")))._tag).toBe("ChartOutdated");
      expect(fs.existsSync(target)).toBe(false);
      // The draft is still there to try again.
      expect((yield* Drafts.use((drafts) => drafts.get(draftId))).chart).not.toBeNull();
    }).pipe(Effect.provide(layer));
  });
});

/** The sung pitch a made chart carries: MIDI per 10 ms, NaN where nothing is sung. */
const PITCH = Float32Array.of(64, 64.5, Number.NaN);

/** A made chart with one line of two notes; its song details are placeholders. */
function tinyChart() {
  const note = (start: number, lyric: string) => ({ start, duration: 0.3, pitch: 5, lyric, type: "normal" as const });
  return {
    song: {
      title: "",
      artist: "",
      language: [],
      year: null,
      genre: null,
      edition: null,
      creator: null,
      bpm: 400,
      gap: 1,
      videoGap: null,
      start: null,
      end: null,
      previewStart: null,
      medleyStart: null,
      medleyEnd: null,
      extraHeaders: [],
    },
    singers: [
      {
        index: 1,
        name: null,
        lines: [{ switchStart: null, switchEnd: null, notes: [note(1, "We're "), note(1.5, "no")] }],
      },
    ],
  };
}

describe("createDraftProject with a chosen cover", () => {
  it.effect("uses the video's thumbnail and says so when the chosen cover can't be downloaded", () => {
    const { layer, dir } = setup();
    return Effect.gen(function* () {
      yield* AppSettings.use((stored) => stored.set(settings({ video: { download: false } })));
      const { draftId } = yield* downloadIntoDraft("dQw4w9WgXcQ");
      const session = yield* createDraftProject({
        draftId,
        artist: "Rick Astley",
        title: "Never Gonna Give You Up",
        year: null,
        genre: null,
        cover: { kind: "found", url: "https://is1-ssl.mzstatic.com/image/thumb/album/1200x1200bb.jpg" },
        lyrics: null,
        language: null,
        chart: "empty",
        target: path.join(dir, "song.tunestudio"),
      });
      const overview = yield* projectOverview(session);
      yield* Projects.use((projects) => projects.close(session.id));
      expect(overview.media.find((file) => file.role === "cover")?.fileName).toBe(
        "Rick Astley - Never Gonna Give You Up [CO].jpg",
      );
      expect(overview.importWarnings).toEqual([
        "The chosen cover couldn't be downloaded, so the video's thumbnail is the cover.",
      ]);
    }).pipe(Effect.provide(layer));
  });
});

describe("createDraftProject with a cover from elsewhere", () => {
  it.effect("only downloads covers from the cover catalogs", () => {
    const { layer, dir } = setup();
    const requested: string[] = [];
    const recording = Layer.succeed(Downloads, {
      json: (url) => Effect.fail(new DownloadFailed({ url, message: "No." })),
      text: (url) => Effect.fail(new DownloadFailed({ url, message: "No." })),
      redirect: (url) => Effect.fail(new DownloadFailed({ url, message: "No." })),
      file: (url) =>
        Effect.suspend(() => {
          requested.push(url);
          return Effect.fail(new DownloadFailed({ url, message: "No." }));
        }),
    });
    return Effect.gen(function* () {
      yield* AppSettings.use((stored) => stored.set(settings({ video: { download: false } })));
      const { draftId } = yield* downloadIntoDraft("dQw4w9WgXcQ");
      const session = yield* createDraftProject({
        draftId,
        artist: "Rick Astley",
        title: "Never Gonna Give You Up",
        year: null,
        genre: null,
        cover: { kind: "found", url: "https://github.com/someone/tool/releases/download/v1/big.zip" },
        lyrics: null,
        language: null,
        chart: "empty",
        target: path.join(dir, "song.tunestudio"),
      }).pipe(Effect.provide(recording));
      const overview = yield* projectOverview(session);
      yield* Projects.use((projects) => projects.close(session.id));
      expect(requested).toEqual([]);
      expect(overview.importWarnings).toEqual([
        "The chosen cover couldn't be downloaded, so the video's thumbnail is the cover.",
      ]);
    }).pipe(Effect.provide(layer));
  });
});

describe("createDraftProject with the user's cover or none", () => {
  const create = (cover: Parameters<typeof createDraftProject>[0]["cover"], target: string) =>
    Effect.gen(function* () {
      yield* AppSettings.use((stored) => stored.set(settings({ video: { download: false } })));
      const { draftId } = yield* downloadIntoDraft("dQw4w9WgXcQ");
      const session = yield* createDraftProject({
        draftId,
        artist: "Rick Astley",
        title: "Never Gonna Give You Up",
        year: null,
        genre: null,
        cover,
        lyrics: null,
        language: null,
        chart: "empty",
        target,
      });
      const overview = yield* projectOverview(session);
      yield* Projects.use((projects) => projects.close(session.id));
      return overview;
    });

  it.effect("stores an image the user picked, as it is", () => {
    const { layer, dir } = setup();
    const image = path.join(dir, "my cover.png");
    fs.writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
    return Effect.gen(function* () {
      const overview = yield* create({ kind: "file", path: image }, path.join(dir, "song.tunestudio"));
      expect(overview.media.find((file) => file.role === "cover")).toMatchObject({
        fileName: "Rick Astley - Never Gonna Give You Up [CO].png",
        size: 11,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a file that isn't a JPEG or PNG", () => {
    const { layer, dir } = setup();
    const image = path.join(dir, "notes.txt");
    fs.writeFileSync(image, "not an image");
    return Effect.gen(function* () {
      const error = yield* Effect.flip(create({ kind: "file", path: image }, path.join(dir, "song.tunestudio")));
      expect(error).toMatchObject({ _tag: "ImageUnreadable", message: "“notes.txt” isn't a JPEG or PNG image." });
      expect(fs.existsSync(path.join(dir, "song.tunestudio"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("creates the project without a cover when none is wanted", () => {
    const { layer, dir } = setup();
    return Effect.gen(function* () {
      const overview = yield* create({ kind: "none" }, path.join(dir, "song.tunestudio"));
      expect(overview.media.map((file) => file.role)).toEqual(["audio", "vocals", "instrumental"]);
    }).pipe(Effect.provide(layer));
  });
});

describe("drafts", () => {
  it.effect("keep the download until the project is saved, then go away", () => {
    const { layer, dir } = setup();
    return Effect.gen(function* () {
      yield* AppSettings.use((stored) => stored.set(settings({ video: { download: false } })));
      const draft = yield* downloadIntoDraft("dQw4w9WgXcQ");
      expect(draft).toMatchObject({ audio: { size: "media:m4a".length }, video: null, videoProblem: null });
      const folder = (yield* Drafts.use((drafts) => drafts.get(draft.draftId))).folder;
      expect(fs.readdirSync(folder)).toContain("audio.m4a");

      const session = yield* createDraftProject({
        draftId: draft.draftId,
        artist: "Rick Astley",
        title: "Never Gonna Give You Up",
        year: null,
        genre: null,
        cover: { kind: "none" },
        lyrics: null,
        language: null,
        chart: "empty",
        target: path.join(dir, "song.tunestudio"),
      });
      yield* Projects.use((projects) => projects.close(session.id));
      expect(fs.existsSync(folder)).toBe(false);
      const gone = yield* Effect.flip(Drafts.use((drafts) => drafts.get(draft.draftId)));
      expect(gone._tag).toBe("DraftGone");
    }).pipe(Effect.provide(layer));
  });

  it.effect("are removed when discarded, and when a download fails", () => {
    const { layer, behave, dir } = setup();
    return Effect.gen(function* () {
      const draft = yield* downloadIntoDraft("dQw4w9WgXcQ");
      yield* Drafts.use((drafts) => drafts.discard(draft.draftId));
      expect(fs.readdirSync(path.join(dir, "drafts"))).toEqual([]);

      behave({ failAll: "Video unavailable" });
      yield* Effect.flip(downloadIntoDraft("dQw4w9WgXcQ"));
      expect(fs.readdirSync(path.join(dir, "drafts"))).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it("clears drafts left behind by a crash when the app starts", async () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    const leftover = path.join(dir, "drafts", "crashed", "audio.m4a");
    fs.mkdirSync(path.dirname(leftover), { recursive: true });
    fs.writeFileSync(leftover, "audio");
    await Effect.runPromise(
      Effect.void.pipe(Effect.provide(draftsLayer(path.join(dir, "drafts")).pipe(Layer.provide(NodeServices.layer)))),
    );
    expect(fs.existsSync(path.join(dir, "drafts", "crashed"))).toBe(false);
  });
});

describe("pure parts", () => {
  it.each([
    ["ERROR: [youtube] abcdefghijk: Video unavailable", "This video isn't available on YouTube anymore."],
    [
      "ERROR: [youtube] abcdefghijk: Sign in to confirm your age. This video may be inappropriate for some users.",
      "YouTube only shows this video to signed-in adults, so it can't be downloaded.",
    ],
    [
      "ERROR: [youtube] abcdefghijk: Unable to download webpage: <urlopen error [Errno 8] nodename nor servname provided, or not known> (caused by getaddrinfo failed)",
      "Couldn't reach YouTube. Check your internet connection and try again.",
    ],
    [
      "ERROR: [youtube] abcdefghijk: Sign in to confirm you're not a bot",
      "YouTube asked to confirm this isn't a bot. Wait a while, then try again.",
    ],
  ])("explains %j", (stderr, message) => {
    expect(youtubeError(stderr).message).toBe(message);
  });

  it("builds USDB Syncer's video format choice", () => {
    // Every codec within the limits comes before any codec above them.
    const choices = ["bestvideo*[ext=mp4][vcodec~='^(avc|h264)']", "bestvideo*[ext=mp4]", "bestvideo*"];
    expect(videoFormat({ download: true, format: "mp4-avc", maxResolution: 720, maxFps: 30 })).toBe(
      [...choices.map((choice) => `${choice}[width<=?1280][height<=?720][fps<=?30]`), ...choices].join("/"),
    );
  });

  it("reads loudnorm's measurement and turns it into gain tags", () => {
    const measured = parseLoudness(
      'noise\n{\n "input_i" : "-13.10",\n "input_tp" : "-0.44",\n "input_lra" : "6.20",\n "input_thresh" : "-23.30",\n "target_offset" : "0.10"\n}\n',
    )!;
    expect(measured).toEqual({ integrated: -13.1, truePeak: -0.44, range: 6.2, threshold: -23.3, offset: 0.1 });
    expect(gainTags("mp3", measured)).toEqual({ REPLAYGAIN_TRACK_GAIN: "-4.90 dB", REPLAYGAIN_TRACK_PEAK: "0.950605" });
    expect(gainTags("opus", measured)).toEqual({ R128_TRACK_GAIN: String(Math.round(-9.9 * 256)) });
  });
});
