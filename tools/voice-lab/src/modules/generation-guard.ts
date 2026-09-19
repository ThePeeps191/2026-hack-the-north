export class GenerationGuard {
  private generation = 0;
  private playing = false;

  begin(): number {
    this.generation += 1;
    this.playing = true;
    return this.generation;
  }

  stop(): number {
    this.generation += 1;
    this.playing = false;
    return this.generation;
  }

  accepts(generationId: number): boolean {
    return this.playing && generationId === this.generation;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  current(): number {
    return this.generation;
  }
}
