import icons from "unplugin-icons/vite";

/** `~icons/*` imports as Solid components, shared by the Vite and Vitest configs. */
export function iconsPlugin() {
  return icons({
    compiler: "solid",
    // Lucide sets `stroke-width="2"` on every path. Moving it to the <svg> lets a call site
    // override it (`stroke-width={2.4}`), and 1.75 matches the studio's lighter strokes.
    transform: (svg, collection) =>
      collection === "lucide"
        ? svg
            .replaceAll(' stroke-width="2"', "")
            .replace("<svg ", '<svg stroke-width="1.75" aria-hidden="true" data-slot="icon" ')
        : svg,
    iconCustomizer: (_collection, _icon, props) => {
      props.width = "18";
      props.height = "18";
    },
  });
}
