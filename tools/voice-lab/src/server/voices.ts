import { PRESET_VOICES, type VoiceLabConfig } from "./config.ts";
import type { VoiceInfo } from "../shared/protocol.ts";

export async function loadVoices(config: VoiceLabConfig): Promise<VoiceInfo[]> {
  const presets: VoiceInfo[] = PRESET_VOICES.map((voice) => ({
    id: voice.id,
    name: voice.name,
    label: voice.label
  }));
  if (!config.elevenLabsApiKey.trim()) return presets;

  try {
    const response = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": config.elevenLabsApiKey }
    });
    if (!response.ok) return presets;
    const body = (await response.json()) as {
      voices?: Array<{ voice_id: string; name: string }>;
    };
    const remote = (body.voices ?? []).map((voice) => ({
      id: voice.voice_id,
      name: voice.name,
      label: voice.name
    }));
    const seen = new Set(presets.map((voice) => voice.id));
    return [...presets, ...remote.filter((voice) => !seen.has(voice.id))];
  } catch {
    return presets;
  }
}
