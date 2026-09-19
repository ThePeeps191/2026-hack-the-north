// Microphone capture worklet, served as-is from src/renderer/public by Vite.
//
// Ported from tools/voice-lab/src/client/public/capture-processor.js. It only
// forwards raw float blocks at the AudioContext rate; resampling to the 16 kHz
// capture rate and PCM16 conversion happen on the main thread in
// src/renderer/src/voice/capture.ts.
//
// The node is connected to a zero-gain sink so Chromium keeps pulling audio
// through it without ever routing the microphone to the speakers.

class HuddleCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel && channel.length > 0) {
      // A copy: the render quantum buffer is reused on the next call.
      this.port.postMessage(channel.slice())
    }
    return true
  }
}

registerProcessor('huddle-capture', HuddleCaptureProcessor)
