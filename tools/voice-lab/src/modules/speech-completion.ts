// "Is this utterance over?" — the rule that both sides of the lab must agree on.
//
// Defect 3 in the lab: the client declared playback complete as soon as its
// scheduled sources ran out, which happens *before* synthesis reaches EOF for a
// slow stream. A short or empty buffer therefore ended an utterance the agent was
// still speaking. Completion now requires both facts:
//
//   synthesisEnded  the server sent `playback: ended` for this generation
//   drained         the client's own scheduled audio has all been played
//
// The main app implements the same rule in src/main/voice/floor.ts.

export class SpeechCompletion {
  private ended = false;
  private drained = false;

  markSynthesisEnded(): void {
    this.ended = true;
  }

  markDrained(): void {
    this.drained = true;
  }

  /** True only when synthesis finished *and* the output buffer drained. */
  get complete(): boolean {
    return this.ended && this.drained;
  }

  get sawSynthesisEnd(): boolean {
    return this.ended;
  }

  /** A drained buffer may only be reported once EOF is known. */
  get canReportDrained(): boolean {
    return this.ended;
  }

  reset(): void {
    this.ended = false;
    this.drained = false;
  }
}
