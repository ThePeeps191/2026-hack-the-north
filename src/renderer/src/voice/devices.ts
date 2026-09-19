/** Select an actual device or explain why it cannot be selected. */
export async function selectOutputDevice(context: { setSinkId?: (id: string) => Promise<void> }, deviceId: string | null): Promise<void> {
  if (context.setSinkId) await context.setSinkId(deviceId ?? '')
  else if (deviceId) throw new Error('This build cannot select an output device. Choose the system default output device.')
}
