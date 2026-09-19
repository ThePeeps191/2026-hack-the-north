// local faster-whisper worker supervision, inside the helper process.
//
// Ported from tools/voice-lab/src/server/whisper-process.ts. The python worker
// (tools/voice-lab/python/transcribe_worker.py) keeps the model resident, so the
// child is spawned once per helper process and never per utterance.
//
// Microphone audio only ever travels main -> helper -> this child, as base64 PCM
// on a pipe. Nothing here talks to a network.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { dirname } from 'node:path'

export interface SttInfo {
  engine: 'faster-whisper'
  model: string
  device: string
  computeType: string
}

export interface SttWorkerOptions {
  pythonBin: string
  workerScript: string
  model: string
  device: string
  computeType: string
  cpuThreads: string
  onLog(line: string): void
}

export interface TranscribeInput {
  /** 16 kHz mono float32. */
  pcm: Float32Array
  isFinal: boolean
  initialPrompt?: string
}

interface Pending {
  resolve: (text: string) => void
  reject: (error: Error) => void
}

export class FasterWhisperWorker {
  private readonly options: SttWorkerOptions
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<string, Pending>()
  private info: SttInfo | null = null
  private starting: Promise<SttInfo> | null = null
  private disposed = false

  constructor(options: SttWorkerOptions) {
    this.options = options
  }

  get sttInfo(): SttInfo | null {
    return this.info
  }

  get running(): boolean {
    return this.child !== null && this.info !== null
  }

  start(): Promise<SttInfo> {
    if (this.disposed) return Promise.reject(new Error('local speech is disposed'))
    if (this.info) return Promise.resolve(this.info)
    if (this.starting) return this.starting

    this.starting = new Promise<SttInfo>((resolve, reject) => {
      let settled = false
      const finish = (error: Error | null, info?: SttInfo): void => {
        if (settled) return
        settled = true
        if (error) reject(error)
        else if (info) resolve(info)
      }

      let child: ChildProcessWithoutNullStreams
      try {
        child = spawn(this.options.pythonBin, ['-u', this.options.workerScript], {
          cwd: dirname(this.options.workerScript),
          env: {
            ...process.env,
            PYTHONUNBUFFERED: '1',
            WHISPER_MODEL: this.options.model,
            WHISPER_DEVICE: this.options.device,
            WHISPER_COMPUTE_TYPE: this.options.computeType,
            WHISPER_CPU_THREADS: this.options.cpuThreads,
            OMP_NUM_THREADS: this.options.cpuThreads,
            MKL_NUM_THREADS: this.options.cpuThreads,
            MKL_DISABLE_FAST_MM: '1',
            KMP_DUPLICATE_LIB_OK: 'TRUE'
          },
          stdio: ['pipe', 'pipe', 'pipe']
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        finish(
          new Error(
            `Could not start the local Whisper worker with "${this.options.pythonBin}": ${message}`
          )
        )
        return
      }
      this.child = child

      child.on('error', (error: Error) => {
        const failure = new Error(
          `Could not start the local Whisper worker with "${this.options.pythonBin}": ${error.message}`
        )
        for (const [, job] of this.pending) job.reject(failure)
        this.pending.clear()
        this.child = null
        finish(failure)
      })

      child.on('exit', (code, signal) => {
        const failure = new Error(`Local Whisper worker exited (code=${code}, signal=${signal})`)
        for (const [, job] of this.pending) job.reject(failure)
        this.pending.clear()
        this.child = null
        this.info = null
        if (!settled) finish(failure)
        else this.options.onLog(`whisper worker exited (code=${code})`)
      })

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8').trim()
        if (text) this.options.onLog(text)
      })

      child.stdout.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString('utf8')
        let newline = this.buffer.indexOf('\n')
        while (newline >= 0) {
          const line = this.buffer.slice(0, newline).trim()
          this.buffer = this.buffer.slice(newline + 1)
          if (line) this.handleLine(line, finish)
          newline = this.buffer.indexOf('\n')
        }
      })
    })

    return this.starting
  }

  async transcribe(input: TranscribeInput): Promise<string> {
    return this.transcribeEncoded({
      pcmBase64: Buffer.from(input.pcm.buffer, input.pcm.byteOffset, input.pcm.byteLength).toString(
        'base64'
      ),
      isFinal: input.isFinal,
      ...(input.initialPrompt ? { initialPrompt: input.initialPrompt } : {})
    })
  }

  /**
   * Same as `transcribe`, for callers that already hold base64 float32 PCM.
   * The helper forwards the main process' payload verbatim instead of decoding
   * and re-encoding a megabyte of audio per utterance.
   */
  async transcribeEncoded(input: {
    pcmBase64: string
    isFinal: boolean
    initialPrompt?: string
  }): Promise<string> {
    const child = this.child
    if (!child || !child.stdin.writable) {
      throw new Error('Local Whisper worker is not running.')
    }
    if (this.disposed) throw new Error('Local Whisper worker is shutting down.')

    const id = String(this.nextId++)
    const payload = {
      id,
      pcm: input.pcmBase64,
      isFinal: input.isFinal,
      sampleRate: 16000,
      ...(input.initialPrompt ? { initialPrompt: input.initialPrompt } : {})
    }
    const result = new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    child.stdin.write(`${JSON.stringify(payload)}\n`)
    return result
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const child = this.child
    this.child = null
    this.info = null
    if (!child) return
    try {
      child.stdin.write(`${JSON.stringify({ cmd: 'shutdown' })}\n`)
    } catch {
      // The child may already be gone.
    }
    const closed = new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
      setTimeout(resolve, 1500)
    })
    child.kill()
    await closed
  }

  private handleLine(
    line: string,
    finish: (error: Error | null, info?: SttInfo) => void
  ): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      this.options.onLog(line)
      return
    }

    if (message.event === 'loading') {
      this.options.onLog(
        `loading ${String(message.model ?? this.options.model)} on ${String(message.device ?? 'cpu')}`
      )
      return
    }
    if (message.event === 'ready') {
      this.info = {
        engine: 'faster-whisper',
        model: String(message.model ?? this.options.model),
        device: String(message.device ?? this.options.device),
        computeType: String(message.computeType ?? this.options.computeType)
      }
      finish(null, this.info)
      return
    }
    if (message.event === 'error' && !this.info) {
      finish(new Error(String(message.message ?? 'Whisper worker error')))
      return
    }
    if (typeof message.id === 'string') {
      const job = this.pending.get(message.id)
      if (!job) return
      this.pending.delete(message.id)
      if (message.ok) job.resolve(String(message.text ?? ''))
      else job.reject(new Error(String(message.error ?? 'transcription failed')))
    }
  }
}
