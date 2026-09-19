// Silero VAD ONNX session, inside the helper process.
//
// Ported from tools/voice-lab/src/modules/vad-engine.ts (`loadSileroVadSession`)
// with two changes:
//
//  1. The inferencer is an object with `infer` *and* `reset`, so the recurrent
//     state (Silero `h`/`c` or `state`, plus the 64-sample context window) can be
//     cleared between capture sessions. Sharing LSTM state across rooms was the
//     reason a second join mis-detected speech.
//  2. Inference is serialised behind one promise chain: onnxruntime-node is
//     async, and two frames running concurrently would corrupt the state.

import { InferenceSession, Tensor } from 'onnxruntime-node'
import type { VadInferencer } from '../vad.ts'

export interface SileroVadSession {
  createInferencer(): VadInferencer
  inputNames: readonly string[]
  outputNames: readonly string[]
}

export async function loadSileroVadSession(modelPath: string): Promise<SileroVadSession> {
  const session = await InferenceSession.create(modelPath)
  const inputNames = session.inputNames
  const outputNames = session.outputNames
  const usesState = inputNames.includes('state')
  const usesHc = inputNames.includes('h') && inputNames.includes('c')

  return {
    inputNames,
    outputNames,
    createInferencer: (): VadInferencer => {
      let state = new Float32Array(2 * 1 * 128)
      let h = new Float32Array(2 * 1 * 64)
      let c = new Float32Array(2 * 1 * 64)
      // The official Silero streaming graph prepends 64 samples of context at 16 kHz.
      let context = new Float32Array(64)
      let chain: Promise<unknown> = Promise.resolve()

      const reset = (): void => {
        state = new Float32Array(2 * 1 * 128)
        h = new Float32Array(2 * 1 * 64)
        c = new Float32Array(2 * 1 * 64)
        context = new Float32Array(64)
      }

      const inferOnce = async (frame: Float32Array): Promise<number> => {
        const window = new Float32Array(context.length + frame.length)
        window.set(context, 0)
        window.set(frame, context.length)
        context = window.slice(window.length - context.length)

        const feeds: Record<string, Tensor> = {
          input: new Tensor('float32', window, [1, window.length])
        }
        if (inputNames.includes('sr')) {
          feeds.sr = new Tensor('int64', BigInt64Array.from([16000n]), [])
        }
        if (usesState) feeds.state = new Tensor('float32', state, [2, 1, 128])
        if (usesHc) {
          feeds.h = new Tensor('float32', h, [2, 1, 64])
          feeds.c = new Tensor('float32', c, [2, 1, 64])
        }

        const result = await session.run(feeds)
        const outputName = outputNames[0]
        if (!outputName) throw new Error('Silero VAD ONNX model exposes no output tensor')
        const output = result[outputName]
        if (!output) throw new Error('Silero VAD inference returned no speech probability')
        const probability = Number(output.data[0] ?? 0)

        if (usesState) {
          const next = result.stateN ?? result.state ?? result.onnx_state
          if (next && next.data instanceof Float32Array) state = Float32Array.from(next.data)
        }
        if (usesHc) {
          const nextH = result.hn ?? result.h
          const nextC = result.cn ?? result.c
          if (nextH && nextH.data instanceof Float32Array) h = Float32Array.from(nextH.data)
          if (nextC && nextC.data instanceof Float32Array) c = Float32Array.from(nextC.data)
        }
        return probability
      }

      return {
        reset,
        infer: (frame: Float32Array): Promise<number> => {
          // One frame at a time, in order: the graph is stateful.
          const next = chain.then(() => inferOnce(frame))
          chain = next.catch(() => undefined)
          return next
        }
      }
    }
  }
}
