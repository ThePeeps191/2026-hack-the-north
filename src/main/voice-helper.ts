/**
 * Voice helper entry point.
 *
 * `electron.vite.config.ts` builds this file as a second, standalone bundle
 * (`out/main/voice-helper.js`) that the main process spawns under system Node.
 * It is a separate process on purpose: `onnxruntime-node` then never has to
 * match Electron's ABI, native inference cannot block the UI lifecycle, and a
 * crashed helper takes nobody else down with it.
 *
 * The implementation lives in `src/main/voice/helper/**`.
 */

import { runVoiceHelper } from './voice/helper/run.ts'

void runVoiceHelper()
