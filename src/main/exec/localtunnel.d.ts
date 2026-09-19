/**
 * Minimal type surface for `localtunnel`, which ships JavaScript only.
 *
 * Only the options Huddle passes are declared, so a wrong call is a compile
 * error rather than a silent `any`.
 */
declare module 'localtunnel' {
  export interface Tunnel {
    /** Public URL the tunnel is reachable on. */
    url: string
    clientId?: string
    close(): void
  }

  export interface TunnelOptions {
    /** Requested subdomain; the server may refuse it. */
    subdomain?: string
    host?: string
    local_host?: string
    port?: number
    allow_invalid_cert?: boolean
  }

  function localtunnel(port: number, options?: TunnelOptions): Promise<Tunnel>

  export default localtunnel
}
