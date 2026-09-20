/** Discord-style join/leave cues. Files live in the renderer public folder. */

const JOIN_SRC = '/sounds/user_join.mp3'
const LEAVE_SRC = '/sounds/user_leave.mp3'

let current: HTMLAudioElement | null = null

export function playCallCue(kind: 'join' | 'leave'): void {
  try {
    current?.pause()
    const audio = new Audio(kind === 'join' ? JOIN_SRC : LEAVE_SRC)
    audio.volume = 0.7
    current = audio
    void audio.play().catch(() => {
      // Autoplay can be blocked if join was not a user gesture; ignore.
    })
  } catch {
    // Missing file or no audio output: the call still proceeds.
  }
}
