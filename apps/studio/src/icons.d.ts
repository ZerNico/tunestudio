/**
 * Types for `unplugin-icons` imports (`~icons/lucide/check`). The package ships Solid types that import
 * `JSX` from `solid-js`, which Solid 2 no longer exports, so these point at `@solidjs/web` instead.
 */
declare module "~icons/*" {
  import type { JSX } from "@solidjs/web";

  const component: (props: JSX.SvgSVGAttributes<SVGSVGElement>) => JSX.Element;
  export default component;
}
