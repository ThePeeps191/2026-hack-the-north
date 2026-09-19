export type InterruptPolicyOptions = {
  minSpeechMs: number;
  speechThreshold: number;
  playbackSpeechThreshold: number;
  frameMs: number;
};

export class InterruptPolicy {
  private consecutiveMs = 0;

  constructor(private readonly opts: InterruptPolicyOptions) {}

  observe(input: { probability: number; playbackActive: boolean }): boolean {
    if (!input.playbackActive) {
      this.consecutiveMs = 0;
      return false;
    }

    const threshold = this.opts.playbackSpeechThreshold;
    if (input.probability >= threshold) {
      this.consecutiveMs += this.opts.frameMs;
      return this.consecutiveMs >= this.opts.minSpeechMs;
    }

    this.consecutiveMs = 0;
    return false;
  }

  reset(): void {
    this.consecutiveMs = 0;
  }
}
