/** Class strings shared by the DropdownMenu, ContextMenu and Select popups (shadcn base-nova, studio density). */
export const menuPopupClass =
  "z-50 max-h-(--available-height) min-w-[184px] origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg border border-popover-border bg-popover p-1 text-[11px] text-popover-foreground shadow-[0_12px_40px_#000a] outline-none scrollbar-thin duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95";
export const menuItemClass =
  "group/menu-item relative flex cursor-default items-center gap-2 rounded-md px-2 py-[6px] outline-hidden select-none data-highlighted:bg-sage-23 data-highlighted:text-white data-inset:pl-[30px] data-[variant=destructive]:text-destructive data-[variant=destructive]:data-highlighted:bg-stone-19 data-disabled:pointer-events-none data-disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:text-lime-70 [&_svg:not([class*='size-'])]:size-3.5 data-[variant=destructive]:[&_svg]:text-destructive";
export const menuCheckItemClass =
  "relative flex cursor-default items-center gap-2 rounded-md py-[6px] pr-8 pl-2 outline-hidden select-none data-highlighted:bg-sage-23 data-highlighted:text-white data-inset:pl-[30px] data-disabled:pointer-events-none data-disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5";
export const menuLabelClass =
  "px-2 py-1 text-[9px] font-[650] tracking-[1.2px] text-popover-muted uppercase data-inset:pl-[30px]";
export const menuSeparatorClass = "-mx-1 my-1 h-px bg-popover-line";
export const menuShortcutClass =
  "ml-auto pl-4 font-mono text-[9px] tracking-wide text-popover-muted group-data-highlighted/menu-item:text-primary-text";
