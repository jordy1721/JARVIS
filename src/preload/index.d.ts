export interface JarvisBridge {
  platform: string
  invoke<T = any>(channel: string, ...args: unknown[]): Promise<T>
  on(channel: string, cb: (...args: any[]) => void): () => void
  send(channel: string, ...args: unknown[]): void
}
declare global {
  interface Window {
    jarvis: JarvisBridge
  }
}
export {}
