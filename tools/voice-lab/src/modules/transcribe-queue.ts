export type TranscribeJob = {
  utteranceId: string;
  pcm: Float32Array;
  isFinal: boolean;
  textHint?: string;
};

type QueuedJob = TranscribeJob & {
  resolve: (value: string | null) => void;
  reject: (error: unknown) => void;
  stale: boolean;
};

export class TranscribeQueue {
  private pending: QueuedJob[] = [];
  private inFlight: QueuedJob | null = null;
  private running = false;

  constructor(private readonly transcribe: (job: TranscribeJob) => Promise<string>) {}

  enqueue(job: TranscribeJob): Promise<string | null> {
    return new Promise((resolve, reject) => {
      if (!job.isFinal) {
        this.pending = this.pending.filter((queued) => {
          if (!queued.isFinal && queued.utteranceId === job.utteranceId) {
            queued.resolve(null);
            return false;
          }
          return true;
        });
        if (
          this.inFlight &&
          !this.inFlight.isFinal &&
          this.inFlight.utteranceId === job.utteranceId
        ) {
          this.inFlight.stale = true;
        }
      }

      this.pending.push({
        ...job,
        resolve,
        reject,
        stale: false
      });
      void this.kick();
    });
  }

  async drain(): Promise<void> {
    while (this.running || this.pending.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private async kick(): Promise<void> {
    if (this.running) return;
    const job = this.pending.shift();
    if (!job) return;

    this.running = true;
    this.inFlight = job;
    try {
      const text = await this.transcribe(job);
      job.resolve(job.stale ? null : text);
    } catch (error) {
      job.reject(error);
    } finally {
      this.running = false;
      this.inFlight = null;
      void this.kick();
    }
  }
}
