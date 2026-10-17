import { createFileRoute } from "@tanstack/solid-router";

import { RouteError } from "~/components/route-error";
import { native } from "~/lib/native/client";
import SettingsScreen from "~/screens/settings";

/** App settings, with what is installed of the download tools and the models. */
export const Route = createFileRoute("/settings")({
  loader: async () => {
    const [settings, tools, models] = await Promise.all([
      native.settings.get(),
      native.tools.status(),
      native.models.list(),
    ]);
    return { settings, tools, models };
  },
  component: SettingsScreen,
  errorComponent: RouteError,
});
