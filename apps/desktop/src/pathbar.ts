// The web picker's path bar shows the folder being listed, but a listing can
// land after the user has started typing a path. Pure, so a smoke script can
// test it.

/** Counts edits typed into the path bar. */
export class PathBarEdits {
  private edits = 0;
  /** The user changed the path bar's text. */
  typed(): void {
    this.edits++;
  }
  /** Call when a listing starts; pass the result to `listingMayReplace` when it lands. */
  mark(): number {
    return this.edits;
  }
  /** A listing may write its path into the bar only if nothing was typed since it started. */
  listingMayReplace(mark: number): boolean {
    return this.edits === mark;
  }
}
