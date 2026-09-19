export type PlaybackPushResult = {
  accepted: boolean;
  firstAudible: boolean;
};

export class PlaybackSession {
  private generation = 0;
  private active = false;
  private heardFirst = false;

  constructor(
    private readonly deps: {
      now: () => number;
      play: (pcm: Float32Array) => void;
      stopSink?: () => void;
    }
  ) {}

  begin(): number {
    this.deps.stopSink?.();
    this.generation += 1;
    this.active = true;
    this.heardFirst = false;
    return this.generation;
  }

  attach(generationId: number): void {
    this.deps.stopSink?.();
    this.generation = generationId;
    this.active = true;
    this.heardFirst = false;
  }

  push(generationId: number, pcm: Float32Array): PlaybackPushResult {
    if (!this.active || generationId !== this.generation) {
      return { accepted: false, firstAudible: false };
    }
    this.deps.play(pcm);
    const firstAudible = !this.heardFirst;
    this.heardFirst = true;
    return { accepted: true, firstAudible };
  }

  stop(): void {
    this.active = false;
    this.generation += 1;
    this.heardFirst = false;
    this.deps.stopSink?.();
  }

  isActive(): boolean {
    return this.active;
  }

  current(): number {
    return this.generation;
  }
}
