/**
 * The app's name and identifier, shared by the main process and the packaging script.
 * Electron derives the data and log directories from the name; the identifier is only a
 * packaging concept (bundle ID on macOS, AppUserModelId on Windows).
 */
export const PRODUCT_NAME = "Tune Studio";

export const APP_ID = "org.tuneperfect.studio";

/** The GitHub repository whose releases the app updates from. */
export const REPOSITORY = "ZerNico/tunestudio";

export const COPYRIGHT = `© ${new Date().getFullYear()} Nico Franke`;

/** The window background, painted before the renderer's first frame to avoid a white flash. */
export const BACKGROUND_COLOR = "#101214";

/** The argument main passes the app's version to the preload with, which can't ask `app` (it is sandboxed). */
export const VERSION_ARGUMENT = "--tunestudio-version=";
