import { createFileRoute } from "@tanstack/solid-router";

import { native } from "~/lib/native/client";
import SettingsScreen from "~/screens/settings";

/** App settings, with what is installed of the download tools. */
export const Route = createFileRoute("/settings")({
  loader: async () => {
    const [settings, tools] = await Promise.all([native.settings.get(), native.tools.status()]);
    return { settings, tools };
  },
  component: SettingsScreen,
});
