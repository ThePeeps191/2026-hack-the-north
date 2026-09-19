export type TranscriptLine = {
  kind: "final" | "provisional";
  utteranceId: string;
  text: string;
};

export class TranscriptLog {
  private finals: Array<{ utteranceId: string; text: string }> = [];
  private provisional: { utteranceId: string; text: string } | null = null;

  applyPartial(utteranceId: string, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.provisional = { utteranceId, text: trimmed };
  }

  applyFinal(utteranceId: string, text: string): void {
    const trimmed = text.trim();
    if (this.provisional?.utteranceId === utteranceId) {
      this.provisional = null;
    }
    if (!trimmed) return;
    const existing = this.finals.findIndex((item) => item.utteranceId === utteranceId);
    const next = { utteranceId, text: trimmed };
    if (existing >= 0) {
      this.finals[existing] = next;
    } else {
      this.finals.push(next);
    }
  }

  snapshot(): {
    finals: Array<{ utteranceId: string; text: string }>;
    provisional: { utteranceId: string; text: string } | null;
  } {
    return {
      finals: this.finals.map((item) => ({ ...item })),
      provisional: this.provisional ? { ...this.provisional } : null
    };
  }

  displayLines(): TranscriptLine[] {
    const lines: TranscriptLine[] = this.finals.map((item) => ({
      kind: "final",
      utteranceId: item.utteranceId,
      text: item.text
    }));
    if (this.provisional) {
      lines.push({
        kind: "provisional",
        utteranceId: this.provisional.utteranceId,
        text: this.provisional.text
      });
    }
    return lines;
  }

  clear(): void {
    this.finals = [];
    this.provisional = null;
  }
}
