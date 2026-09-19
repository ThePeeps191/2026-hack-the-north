export type TimingSnapshot = {
  interruptionMs: number | null;
  finalTranscriptMs: number | null;
  firstAudibleMs: number | null;
};

export class TimingTracker {
  private nowFn: () => number;
  private vadSpeechStartAt: number | null = null;
  private speechEndAt: number | null = null;
  private speakRequestedAt: number | null = null;
  private speakOpen = false;
  private values: TimingSnapshot = {
    interruptionMs: null,
    finalTranscriptMs: null,
    firstAudibleMs: null
  };

  constructor(now: () => number = () => Date.now()) {
    this.nowFn = now;
  }

  setNow(now: () => number): void {
    this.nowFn = now;
  }

  markVadSpeechStart(): void {
    this.vadSpeechStartAt = this.nowFn();
  }

  markSpeechEnd(): void {
    this.speechEndAt = this.nowFn();
  }

  markSpeakRequested(): void {
    this.speakRequestedAt = this.nowFn();
    this.speakOpen = true;
    this.values.firstAudibleMs = null;
  }

  markPlaybackStopped(_reason: "interrupted" | "stopped" | "ended"): void {
    if (this.vadSpeechStartAt != null) {
      this.values.interruptionMs = this.nowFn() - this.vadSpeechStartAt;
    }
    this.speakOpen = false;
  }

  markFinalTranscript(): void {
    if (this.speechEndAt != null) {
      this.values.finalTranscriptMs = this.nowFn() - this.speechEndAt;
    }
  }

  markFirstAudible(): void {
    if (!this.speakOpen || this.speakRequestedAt == null) return;
    this.values.firstAudibleMs = this.nowFn() - this.speakRequestedAt;
  }

  snapshot(): TimingSnapshot {
    return { ...this.values };
  }
}
