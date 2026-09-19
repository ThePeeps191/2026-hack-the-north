import type { ReactElement } from 'react'
import type { CallScreenProps } from '../state/view-model'
import { CallShell } from './CallShell'
import '../styles/call.css'
import '../styles/panels.css'

/**
 * Huddle's call screen.
 *
 * The integration lead renders exactly this component and supplies the snapshot,
 * the actions and the workspace surface bodies. Everything else — rooms sidebar,
 * participant gallery, call dock, share frame, spotlight, chat rail and settings
 * — lives inside `call/**`, reads its truth from props, and calls back through
 * `props.actions`. It never touches `window.huddle` and never invents state.
 */
export function CallScreen(props: CallScreenProps): ReactElement {
  return <CallShell {...props} />
}
