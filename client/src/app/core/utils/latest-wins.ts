/** A generation counter: each `begin()` outdates every token handed out before it. */
export class LatestWins {
  private gen = 0;

  begin(): number {
    return ++this.gen;
  }

  isCurrent(token: number): boolean {
    return token === this.gen;
  }

  /** Outdates every token without starting a run. */
  cancel(): void {
    this.gen++;
  }
}
