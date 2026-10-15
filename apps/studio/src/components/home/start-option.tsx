import type { JSX } from "@solidjs/web";

export type StartOptionTone = "youtube" | "lime" | "violet";

/** One of the "start a new project" cards: an icon, a title, a short text and its controls. */
export function StartOption(props: {
  id: string;
  tone: StartOptionTone;
  icon: JSX.Element;
  title: string;
  description: string;
  children: JSX.Element;
}) {
  return (
    <section
      aria-labelledby={`${props.id}-title`}
      data-testid={`start-${props.id}`}
      data-tone={props.tone}
      class="group/option relative flex min-w-0 flex-col gap-4 overflow-hidden rounded-xl border border-border bg-card p-[18px] transition-colors focus-within:border-sage-35-2 hover:border-sage-29"
    >
      <div
        aria-hidden="true"
        class="pointer-events-none absolute -top-24 -right-20 size-56 rounded-full opacity-[0.07] blur-2xl group-data-[tone=lime]/option:bg-primary group-data-[tone=violet]/option:bg-violet group-data-[tone=youtube]/option:bg-youtube"
      />
      <div class="flex items-center gap-3">
        <span class="flex size-9 shrink-0 items-center justify-center rounded-[9px] border group-data-[tone=lime]/option:border-primary-line group-data-[tone=lime]/option:bg-primary-soft group-data-[tone=lime]/option:text-primary group-data-[tone=violet]/option:border-violet-line group-data-[tone=violet]/option:bg-violet-soft group-data-[tone=violet]/option:text-violet group-data-[tone=youtube]/option:border-stone-39 group-data-[tone=youtube]/option:bg-youtube-soft group-data-[tone=youtube]/option:text-youtube [&>svg]:size-[18px]">
          {props.icon}
        </span>
      </div>
      <div class="flex flex-col gap-1">
        <h3
          id={`${props.id}-title`}
          class="m-0 text-[14px] leading-tight font-semibold tracking-[-0.1px] text-foreground"
        >
          {props.title}
        </h3>
        <p class="m-0 text-[11.5px] leading-normal text-muted-foreground">{props.description}</p>
      </div>
      <div class="mt-auto flex flex-col gap-2 pt-1">{props.children}</div>
    </section>
  );
}
