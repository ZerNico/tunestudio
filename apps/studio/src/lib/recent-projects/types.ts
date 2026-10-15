/** A project on the start screen's recent list. */
export interface RecentProject {
  /** The project file's path, which identifies it. */
  id: string;
  title: string;
  artist: string;
  /** The `.tunestudio` file. */
  path: string;
  /** ISO timestamp. */
  lastOpened: string;
  /** Cover thumbnail URL; the card draws fallback art without one. */
  coverUrl?: string;
}
