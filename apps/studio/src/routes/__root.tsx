import { createRootRoute } from "@tanstack/solid-router";

import { RootError } from "~/components/route-error";
import RootScreen from "~/screens/root";

export const Route = createRootRoute({
  component: RootScreen,
  errorComponent: RootError,
});
