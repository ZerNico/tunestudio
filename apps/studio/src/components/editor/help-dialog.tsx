/**
 * The editor's help (the ? button in the title bar, or ?): every key (from `shortcuts.ts`, which tooltips and the note
 * menu read too), what the mouse does where nothing shows it, what the roll's colours and marks mean, and the song's
 * timing words.
 */
import type { JSX } from "@solidjs/web";
import { For } from "solid-js";

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Kbd } from "~/components/ui/kbd";
import { platform } from "~/lib/desktop";
import { NOTE_FLAGS, type NoteFlag } from "~/lib/editor/edits";
import { shortcutGroups } from "~/lib/editor/shortcuts";
import { TIMING_WORDS } from "~/lib/editor/timing-words";

/** The modifier as said on this computer. */
const MOD = platform === "macos" ? "Cmd" : "Ctrl";

/** What the mouse does, where nothing on screen says so. */
const MOUSE: { term: string; says: string }[] = [
  {
    term: "A note",
    says: `Click to select it (Shift: a range, ${MOD}: add or take out), drag to move it, drag its edges to change its length, double-click to type its syllable.`,
  },
  {
    term: "Empty space in the roll",
    says: "Drag to select with a box, double-click to add a note, click to move the playhead.",
  },
  {
    term: "The time ruler",
    says: "Click to move the playhead, drag to loop a range (drag its edges to change it), double-click it to remove the range.",
  },
  {
    term: "A line break marker",
    says: "Drag to move it (it is set by hand then), double-click to remove it, right-click to reset its timing.",
  },
  { term: "The line break lane", says: "Double-click to add a line break there." },
  {
    term: "The ruler's markers",
    says: "Drag the start and end handles, the preview flag or the medley band to move them. Drag the playhead's head, or its line in the roll, to scrub and hear the audio as you go.",
  },
  {
    term: "A singer's chip (duets)",
    says: "Click to sing as them, double-click to rename, right-click for Show only, Rename and Remove.",
  },
  {
    term: "A line's lyrics (below the roll)",
    says: "Double-click to edit the whole line as text: syllables with -, held notes as ~.",
  },
  {
    term: "Right-click",
    says: "The note menu: everything the keys do, and more. Shift+F10 opens it from the keyboard.",
  },
  { term: `${MOD} + wheel, or pinch`, says: "Zoom at the pointer. The wheel scrolls through the song (Shift too)." },
];

const TIMING: { term: string; says: string }[] = [
  { term: "Gap", says: TIMING_WORDS.gap },
  { term: "Video offset", says: TIMING_WORDS.videoOffset },
  { term: "Start and End", says: TIMING_WORDS.startEnd },
  { term: "Preview", says: TIMING_WORDS.preview },
  { term: "Medley", says: TIMING_WORDS.medley },
];

/** What each note type means, with its key. */
const NOTE_MEANINGS: Record<NoteFlag, string> = {
  golden: "Golden: more points",
  rap: "Rap: spoken, any pitch",
  freestyle: "Freestyle: not scored",
};

/** Terms and what they say, in two columns. */
function TermList(props: { items: { term: string; says: string }[] }) {
  return (
    <ul class="m-0 flex list-none flex-col gap-1.5 p-0">
      <For each={props.items}>
        {(item) => (
          <li class="grid grid-cols-[180px_minmax(0,1fr)] gap-3 text-[12px]">
            <span class="text-sage-68">{item.term}</span>
            <span class="text-foreground">{item.says}</span>
          </li>
        )}
      </For>
    </ul>
  );
}

function Section(props: { title: string; children: JSX.Element }) {
  return (
    <section class="flex flex-col gap-2">
      <h3 class="m-0 eyebrow">{props.title}</h3>
      {props.children}
    </section>
  );
}

/** A note as the roll draws it, for the legend. */
function NoteSample(props: { type?: string; overlap?: boolean; singer?: 2; label: string; class?: string }) {
  return (
    <span
      class={`roll-note relative inline-block h-5 text-[11px] leading-[18px] ${props.class ?? "w-16"}`}
      data-type={props.type}
      data-singer={props.singer}
      data-overlap={props.overlap ? "" : undefined}
    >
      {props.label}
    </span>
  );
}

function LegendRow(props: { sample: JSX.Element; means: string }) {
  return (
    <li class="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-3">
      <span class="flex items-center">{props.sample}</span>
      <span class="text-[12px] text-muted-foreground">{props.means}</span>
    </li>
  );
}

export function HelpDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={props.open} onOpenChange={(open: boolean) => props.onOpenChange(open)}>
      <DialogContent class="w-[min(720px,calc(100vw-32px))]" data-testid="help">
        <DialogHeader>
          <DialogTitle>Help</DialogTitle>
          <DialogDescription>Keys, what the mouse does, and what the roll shows.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div class="flex flex-col gap-6">
            <Section title="Keys">
              {/* Groups flow down two columns, whole (they differ in length a lot). */}
              <div class="columns-2 gap-x-6">
                <For each={shortcutGroups()}>
                  {(group) => (
                    <div class="mb-4 flex break-inside-avoid flex-col gap-1.5" data-testid="help-keys">
                      <span class="text-[11px] font-medium text-sage-68">{group.title}</span>
                      <ul class="m-0 flex list-none flex-col gap-1 p-0">
                        <For each={group.rows}>
                          {(row) => (
                            <li class="grid grid-cols-[92px_minmax(0,1fr)] items-baseline gap-2 text-[12px]">
                              <span class="flex flex-wrap gap-1">
                                <For each={row.keys}>{(key) => <Kbd>{key}</Kbd>}</For>
                              </span>
                              <span class="text-foreground">{row.does}</span>
                            </li>
                          )}
                        </For>
                      </ul>
                    </div>
                  )}
                </For>
              </div>
            </Section>

            <Section title="Mouse">
              <TermList items={MOUSE} />
            </Section>

            <Section title="What the roll shows">
              <ul class="m-0 grid list-none grid-cols-2 gap-x-6 gap-y-2 p-0">
                <LegendRow sample={<NoteSample label="la" />} means="A note, sung on its pitch" />
                <For each={NOTE_FLAGS}>
                  {(flag) => (
                    <LegendRow
                      sample={<NoteSample type={flag.flag} label="la" />}
                      means={`${NOTE_MEANINGS[flag.flag]} (${flag.key})`}
                    />
                  )}
                </For>
                <LegendRow sample={<NoteSample overlap label="⚠ la" />} means="Overlaps another note" />
                <LegendRow
                  sample={<span class="break-marker inline-block h-3 w-2 rounded-[2px]" data-auto="" />}
                  means="Line break with default timing: follows the gap as notes change"
                />
                <LegendRow
                  sample={<span class="break-marker inline-block h-3 w-2 rounded-[2px]" />}
                  means="Line break set by hand: stays where it is"
                />
                <LegendRow
                  sample={<span class="inline-block h-0.5 w-16 rounded-full bg-info opacity-80" />}
                  means="What is sung in the vocals"
                />
                <LegendRow
                  sample={<span class="inline-block h-0.5 w-16 rounded-full bg-warning opacity-80" />}
                  means="Your voice, singing along"
                />
                <LegendRow
                  sample={
                    <span class="flex gap-1">
                      <NoteSample label="P1" class="w-[30px]" />
                      <NoteSample label="P2" singer={2} class="w-[30px]" />
                    </span>
                  }
                  means="In a duet: who sings, green for P1 and violet for P2"
                />
              </ul>
            </Section>

            <Section title="Song timing">
              <TermList items={TIMING} />
            </Section>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
