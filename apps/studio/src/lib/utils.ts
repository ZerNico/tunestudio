import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn's class helper: conditional classes (clsx) with Tailwind conflict resolution (tailwind-merge). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Resolves a Base UI `class` prop (a class value or a function of the component state) so the
 * shadcn-style wrappers can merge it with their own classes: `class={s => cn(base, stateClass(props.class, s))}`.
 */
export function stateClass<S>(value: unknown, state: S): ClassValue {
  return typeof value === "function" ? (value as (state: S) => ClassValue)(state) : (value as ClassValue);
}
