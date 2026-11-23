import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

function on(channel: string, cb: (...args: any[]) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...args)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api = {
  platform: process.platform,
  invoke,
  on,
  send: (channel: string, ...args: unknown[]) => ipcRenderer.send(channel, ...args)
}

contextBridge.exposeInMainWorld('jarvis', api)
export type JarvisApi = typeof api
