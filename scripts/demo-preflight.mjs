/** Local prerequisites only. Provider values are never printed. */
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parse } from 'dotenv'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const envPath = resolve(root, '.env')
const env = { ...(existsSync(envPath) ? parse(readFileSync(envPath)) : {}), ...process.env }
let missing = 0
function check(label, ok, remedy) {
  console.log(`${ok ? 'READY' : 'MISSING'} ${label}${ok ? '' : ` - ${remedy}`}`)
  if (!ok) missing++
}
check('Node 22+', Number(process.versions.node.split('.')[0]) >= 22, 'Install Node.js 22 or newer.')
check('Git', spawnSync('git', ['--version'], { windowsHide: true }).status === 0, 'Install Git and add it to PATH.')
check('Electron', existsSync(resolve(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app' : 'electron')), 'Run npm install.')
check('Demo project', existsSync(resolve(root, 'demo/sketch-night/package.json')), 'Run from the complete Huddle checkout.')
check('Local VAD model', existsSync(resolve(root, 'tools/voice-lab/models/silero_vad.onnx')), 'Run node tools/voice-lab/scripts/setup.mjs.')
const python = env.HUDDLE_PYTHON || resolve(root, 'tools/voice-lab/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
check('Local Whisper', spawnSync(python, ['-c', 'import faster_whisper'], { windowsHide: true, stdio: 'ignore', timeout: 30000 }).status === 0, 'Run node tools/voice-lab/scripts/setup.mjs.')
for (const key of ['OPENAI_API_KEY', 'ELEVENLABS_API_KEY', 'BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID']) {
  check(`${key} configured`, Boolean(env[key]?.trim()), 'Set it in .env or Huddle Settings; this check only reads .env/environment.')
}
console.log('\nThis checks local prerequisites, not provider access, microphone recording, or audible playback.')
console.log('Use Settings -> Refresh capabilities for provider checks; npm run verify:voice for local speech verification.')
process.exitCode = missing ? 1 : 0
