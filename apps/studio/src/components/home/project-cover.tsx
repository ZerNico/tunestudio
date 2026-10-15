import { Show } from "solid-js";

import { cn } from "~/lib/utils";

const FALLBACK_TONES = ["sage", "violet", "amber", "slate"] as const;

function toneFor(id: string) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return FALLBACK_TONES[hash % FALLBACK_TONES.length];
}

/**
 * A project's cover, or fallback art (level bars, tinted per project) when the
 * song has no cover image.
 */
export function ProjectCover(props: { id: string; src?: string; class?: string }) {
  return (
    <div
      data-slot="project-cover"
      data-tone={toneFor(props.id)}
      class={cn(
        "relative isolate flex shrink-0 items-center justify-center overflow-hidden rounded-[7px] bg-linear-to-br data-[tone=amber]:from-amber-33 data-[tone=amber]:to-gray-11 data-[tone=sage]:from-sage-28 data-[tone=sage]:to-gray-11 data-[tone=slate]:from-slate-36 data-[tone=slate]:to-gray-11 data-[tone=violet]:from-violet-22 data-[tone=violet]:to-gray-11",
        props.class,
      )}
    >
      <Show
        when={props.src}
        fallback={
          <>
            <span class="flex h-[34%] w-[34%] items-center justify-between [&>i]:w-[11%] [&>i]:rounded-full [&>i]:bg-white/30">
              <i class="h-[45%]" />
              <i class="h-full" />
              <i class="h-[72%]" />
              <i class="h-[38%]" />
            </span>
          </>
        }
      >
        {(src) => <img src={src()} alt="" draggable={false} class="absolute inset-0 size-full object-cover" />}
      </Show>
      {/* A faint inner edge over the art, so dark covers don't melt into the background. */}
      <span
        aria-hidden="true"
        class="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-white/5 ring-inset"
      />
    </div>
  );
}
