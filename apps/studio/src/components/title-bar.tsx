import type { JSX } from "@solidjs/web";

import { BrandMark } from "~/components/brand-mark";
import { appVersion, platform } from "~/lib/desktop";

/**
 * The app's own title bar. The window has no native one (`titleBarStyle: "hidden"`): on macOS
 * the traffic lights sit at its left, on Windows and Linux the caption buttons at its right.
 * The bar drags the window; interactive children must opt out with `app-no-drag`.
 */
export function TitleBar(props: { children?: JSX.Element }) {
  return (
    <header
      data-slot="title-bar"
      data-platform={platform}
      class="relative z-20 flex h-(--titlebar-h) shrink-0 items-center gap-3 border-b border-bar-border bg-bar pr-4 pl-4 app-drag data-[platform=linux]:pr-[150px] data-[platform=macos]:pl-[84px] data-[platform=windows]:pr-[150px]"
    >
      <div class="flex items-center gap-2.5">
        <BrandMark class="size-[18px]" />
        <span class="text-[13px] font-semibold tracking-[-0.2px] text-foreground">Tune Studio</span>
        <span class="rounded-[4px] border border-gray-27 px-1.5 py-px font-mono text-[9.5px] text-faint-foreground">
          v{appVersion}
        </span>
      </div>
      <div class="ml-auto flex items-center gap-1 app-no-drag">{props.children}</div>
    </header>
  );
}
