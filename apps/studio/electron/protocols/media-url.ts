/** Media of open projects (`media.ts`): `media://<project session>/<media id>`. */
export const MEDIA_SCHEME = "media";

/** The URL that serves a project's media file while the project is open. */
export function mediaUrl(sessionId: string, mediaId: number): string {
  return `${MEDIA_SCHEME}://${sessionId}/${mediaId}`;
}
