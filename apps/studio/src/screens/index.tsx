import { getRouteApi, useNavigate, useRouter } from "@tanstack/solid-router";
import { createMemo, createSignal, onSettled } from "solid-js";
import FolderOpenIcon from "~icons/lucide/folder-open";

import { AudioOption } from "~/components/home/audio-option";
import { createWindowDrop, type Drop, DropOverlay } from "~/components/home/drop-overlay";
import { type Flow, FlowDialog } from "~/components/home/flow-dialogs";
import { NavRail, type RailItem } from "~/components/home/nav-rail";
import { RecentProjects } from "~/components/home/recent-projects";
import { SongOption } from "~/components/home/song-option";
import { YoutubeOption } from "~/components/home/youtube-option";
import { TitleBar } from "~/components/title-bar";
import { Button } from "~/components/ui/button";
import { toast } from "~/components/ui/toast";
import { pathForFile } from "~/lib/desktop";
import { AUDIO_ACCEPT, dropKind, isAudioFile, summarizeAudioFile } from "~/lib/import-files";
import { native } from "~/lib/native/client";
import { errorMessage } from "~/lib/native/errors";
import type { OpenedProject } from "~/lib/native/types";
import { type RecentProject, toEntry } from "~/lib/recent-projects";
import { sectionReached } from "~/lib/scroll-spy";

const route = getRouteApi("/");

function unsupported(name: string, hint: string) {
  toast.add({ type: "error", title: `Can't start a project from “${name}”`, description: hint });
}

/** The start screen: start a new project, import a song, or reopen a project. */
export default function HomeScreen() {
  const loaded = route.useLoaderData();
  const navigate = useNavigate();
  const router = useRouter();
  const [removed, setRemoved] = createSignal<ReadonlySet<string>>(new Set());
  const projects = createMemo(() => loaded().filter((project) => !removed().has(project.id)));

  const [flow, setFlow] = createSignal<Flow | null>(null);
  const [activeRail, setActiveRail] = createSignal<RailItem>("home");

  let scroller: HTMLElement | undefined;
  let searchInput: HTMLInputElement | undefined;
  let audioInput: HTMLInputElement | undefined;
  /** Set while a rail click scrolls smoothly, so the highlight doesn't pass through the other item. */
  let pinned = false;
  let unpinTimer: ReturnType<typeof setTimeout> | undefined;

  const showProject = (project: OpenedProject) => {
    setFlow(null);
    void navigate({ to: "/project/$id", params: { id: project.id } });
  };

  const openProject = async (path: string) => {
    try {
      showProject(await native.project.open({ path }));
    } catch (error) {
      toast.add({ type: "error", title: "Couldn't open the project", description: errorMessage(error) });
      // A file that is gone also drops out of the list.
      void router.invalidate();
    }
  };

  const chooseProject = async () => {
    try {
      const path = await native.dialogs.chooseProject();
      if (path) await openProject(path);
    } catch (error) {
      toast.add({ type: "error", title: "Couldn't open the project", description: errorMessage(error) });
    }
  };

  const chooseSong = async () => {
    try {
      const path = await native.dialogs.chooseSong();
      if (path) setFlow({ kind: "song", path });
    } catch (error) {
      toast.add({ type: "error", title: "Couldn't import the song", description: errorMessage(error) });
    }
  };

  const startFromAudio = (file: File) => {
    if (!isAudioFile(file.name)) {
      unsupported(file.name, "Choose an audio file, such as MP3, M4A, FLAC, OGG, OPUS or WAV.");
      return;
    }
    setFlow({ kind: "audio", file: summarizeAudioFile(file) });
  };

  const handleDrop = async (drop: Drop) => {
    if (flow()) return;
    const kind = dropKind(drop.file.name, drop.isDirectory);
    if (kind === "audio") return startFromAudio(drop.file);
    if (kind === "unknown") {
      return unsupported(
        drop.file.name,
        "Drop an audio file, an UltraStar song folder or chart (.txt), or a Tune Studio project.",
      );
    }
    const dropped = await pathForFile(drop.file);
    if (!dropped) {
      return unsupported(drop.file.name, "Tune Studio can't tell where this file is. Choose it with a button instead.");
    }
    if (kind === "project") await openProject(dropped.path);
    else setFlow({ kind: "song", path: dropped.path });
  };
  const dragging = createWindowDrop((drop) => void handleDrop(drop));

  const projectActions = {
    onOpen: (project: RecentProject) => void openProject(project.path),
    onReveal: (project: RecentProject) => {
      native.files.reveal({ path: project.path }).catch((error: unknown) => {
        toast.add({ type: "error", title: "Couldn't show the project", description: errorMessage(error) });
      });
    },
    onRemove: (project: RecentProject) => {
      setRemoved((current) => new Set([...current, project.id]));
      native.recents.remove({ path: project.path }).catch((error: unknown) => console.error(error));
      toast.add({
        type: "success",
        title: "Removed from recents",
        description: `${project.artist}, “${project.title}”. The project file stays where it is.`,
        actionProps: {
          children: "Undo",
          onClick: () => {
            setRemoved((current) => {
              const next = new Set(current);
              next.delete(project.id);
              return next;
            });
            native.recents.restore(toEntry(project)).catch((error: unknown) => console.error(error));
          },
        },
      });
    },
  };

  /** Highlights Recent once its section is in view, Home otherwise. */
  const updateRail = () => {
    const recent = document.getElementById("recent");
    if (pinned || !scroller || !recent) return;
    const reached = sectionReached({
      sectionTop: recent.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
      scrollTop: scroller.scrollTop,
      clientHeight: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
    });
    setActiveRail(reached ? "recent" : "home");
  };

  const unpin = () => {
    clearTimeout(unpinTimer);
    pinned = false;
    updateRail();
  };

  // Recent in the rail of another screen comes here with #recent.
  onSettled(() => {
    if (router.state.location.hash !== "recent") return;
    document.getElementById("recent")?.scrollIntoView({ block: "start" });
    setActiveRail("recent");
  });

  onSettled(() => {
    const element = scroller;
    if (!element) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        updateRail();
      });
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener("scrollend", unpin);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(unpinTimer);
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("scrollend", unpin);
    };
  });

  const selectRail = (item: RailItem) => {
    if (item === "settings") {
      void navigate({ to: "/settings" });
      return;
    }
    setActiveRail(item);
    // The spy takes over again when the smooth scroll ends (or right away if nothing scrolls).
    pinned = true;
    clearTimeout(unpinTimer);
    unpinTimer = setTimeout(unpin, 1000);
    if (item === "home") {
      scroller?.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      document.getElementById("recent")?.scrollIntoView({ behavior: "smooth", block: "start" });
      searchInput?.focus({ preventScroll: true });
    }
  };

  return (
    <div class="flex h-dvh min-h-0 flex-col bg-background" data-testid="home">
      <TitleBar />
      <div class="flex min-h-0 flex-1">
        <NavRail active={activeRail()} onSelect={selectRail} />
        <main
          ref={(element) => (scroller = element)}
          class="min-h-0 flex-1 scrollbar-thin overflow-y-auto"
          aria-labelledby="home-title"
          data-testid="home-scroller"
        >
          <div class="mx-auto flex max-w-[1200px] flex-col gap-9 px-10 pt-9 pb-16">
            <header class="flex flex-col gap-2">
              <p class="m-0 eyebrow text-sage-65">TunePerfect Studio</p>
              <h1 id="home-title" class="m-0 text-[27px] leading-tight font-[550] tracking-[-0.8px] text-foreground">
                Welcome to Tune Studio
              </h1>
              <p class="m-0 max-w-[620px] text-[13px] leading-[1.6] text-muted-foreground">
                Turn a song into a singable UltraStar chart. Start from a link or an audio file, or import a chart you
                already have.
              </p>
            </header>

            <section aria-labelledby="start-title" class="flex flex-col gap-4">
              <h2 id="start-title" class="m-0 text-[15px] font-semibold tracking-[-0.2px]">
                Start a new project
              </h2>
              <div class="grid grid-cols-3 gap-4">
                <YoutubeOption onStart={(url, videoId) => setFlow({ kind: "youtube", url, videoId })} />
                <AudioOption onChoose={() => audioInput?.click()} />
                <SongOption onChoose={() => void chooseSong()} />
              </div>
            </section>

            <RecentProjects
              projects={projects()}
              searchRef={(element) => (searchInput = element)}
              onOpen={projectActions.onOpen}
              onReveal={projectActions.onReveal}
              onRemove={projectActions.onRemove}
              headerActions={
                <Button variant="outline" size="sm" onClick={() => void chooseProject()} data-testid="open-project">
                  <FolderOpenIcon />
                  Open project…
                </Button>
              }
            />
          </div>
        </main>
      </div>

      <input
        ref={(element) => (audioInput = element)}
        type="file"
        accept={AUDIO_ACCEPT}
        class="hidden"
        tabindex="-1"
        aria-hidden="true"
        data-testid="audio-input"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) startFromAudio(file);
        }}
      />

      <FlowDialog flow={flow()} onClose={() => setFlow(null)} onOpened={showProject} />
      <DropOverlay visible={dragging()} />
    </div>
  );
}
