// Microphone capture: getUserMedia -> AudioWorklet -> 16 kHz Int16 mono frames.
//
// Ported from tools/voice-lab/src/client/main.ts (same worklet + resample path).
//
//  - the worklet is served from src/renderer/public/capture-processor.js, which
//    Vite copies as-is, so no bundler transformation touches the audio thread
//  - the microphone is never routed to the speakers: the worklet feeds a
//    zero-gain node
//  - frames are only forwarded while `setForwarding(true)`: muting stops audio at
//    the source and does not disturb capture, the VAD, or any running work

import { CAPTURE_SAMPLE_RATE } from '../../../shared/voice.ts'
import { float32ToPcm16, resampleLinear, rmsLevel } from './pcm.ts'

export interface CaptureHandle {
  stop(): void
  setForwarding(forwarding: boolean): void
  readonly deviceId: string | null
}

export interface CaptureInput {
  /** Shared AudioContext; the worklet runs in it and its rate is the input rate. */
  context: AudioContext
  deviceId?: string | null
  /** Worklet url. Defaults to /capture-processor.js from the renderer public dir. */
  workletUrl?: string
  onFrame(pcm: ArrayBuffer, capturedAt: number): void
  onLevel(level: number): void
  onError(error: Error): void
  mediaDevices?: MediaDevices
  now?: () => number
}

export const CAPTURE_WORKLET_NAME = 'huddle-capture'
export const CAPTURE_WORKLET_URL = './capture-processor.js'

export async function startCapture(input: CaptureInput): Promise<CaptureHandle> {
  const mediaDevices = input.mediaDevices ?? navigator.mediaDevices
  if (!mediaDevices?.getUserMedia) {
    throw new Error('This build has no microphone access (getUserMedia is unavailable).')
  }
  const now = input.now ?? (() => performance.now())
  let forwarding = true

  const constraints: MediaStreamConstraints = {
    audio: {
      ...(input.deviceId ? { deviceId: { exact: input.deviceId } } : {}),
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    },
    video: false
  }

  const stream = await mediaDevices.getUserMedia(constraints)
  let node: AudioWorkletNode
  let source: MediaStreamAudioSourceNode
  try {
    if (input.context.state === 'suspended') await input.context.resume()
    await input.context.audioWorklet.addModule(input.workletUrl ?? CAPTURE_WORKLET_URL)
    node = new AudioWorkletNode(input.context, CAPTURE_WORKLET_NAME)
    source = input.context.createMediaStreamSource(stream)
  } catch (error) {
    for (const track of stream.getTracks()) track.stop()
    throw error instanceof Error ? error : new Error(String(error))
  }

  const sink = input.context.createGain()
  sink.gain.value = 0
  node.port.onmessage = (event: MessageEvent<Float32Array>) => {
    if (!forwarding) return
    const block = event.data
    if (!block || block.length === 0) return
    try {
      const resampled = resampleLinear(block, input.context.sampleRate, CAPTURE_SAMPLE_RATE)
      const pcm = float32ToPcm16(resampled)
      // A fresh ArrayBuffer: the IPC boundary needs a plain ArrayBuffer, and the
      // typed-array view's own buffer is `ArrayBufferLike`.
      const buffer = new ArrayBuffer(pcm.byteLength)
      new Int16Array(buffer).set(pcm)
      input.onFrame(buffer, now())
      input.onLevel(Math.min(1, rmsLevel(resampled) * 4))
    } catch (error) {
      input.onError(error instanceof Error ? error : new Error(String(error)))
    }
  }
  source.connect(node)
  node.connect(sink)
  sink.connect(input.context.destination)

  const track = stream.getAudioTracks()[0] ?? null
  const deviceId = track ? (track.getSettings().deviceId ?? input.deviceId ?? null) : (input.deviceId ?? null)
  if (track) {
    track.addEventListener('ended', () => {
      input.onError(new Error('The microphone was disconnected.'))
    })
  }

  return {
    deviceId,
    setForwarding(value: boolean): void {
      forwarding = value
    },
    stop(): void {
      forwarding = false
      node.port.onmessage = null
      for (const streamTrack of stream.getTracks()) {
        try {
          streamTrack.stop()
        } catch {
          // already stopped
        }
      }
      try {
        source.disconnect()
      } catch {
        // ignore
      }
      try {
        node.disconnect()
      } catch {
        // ignore
      }
      try {
        sink.disconnect()
      } catch {
        // ignore
      }
    }
  }
}
