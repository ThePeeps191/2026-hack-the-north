/**
 * Electron main entry point.
 *
 * Everything Huddle actually does — room state, agent sessions, execution,
 * remote browser sessions and voice — is composed in `app-main.ts`. This file
 * only exists because `electron.vite.config.ts` names `index` as the main
 * process entry.
 */

import { startHuddle } from './app-main.ts'

startHuddle()
