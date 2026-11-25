import { contextBridge, ipcRenderer } from 'electron'

/**
 * The page's door to the rest of the app: the small set of things a web page cannot do by
 * itself. The page sees this object as `window.sottoDesktop` (web/src/app/platform.ts).
 */
contextBridge.exposeInMainWorld('sottoDesktop', {
  os: process.platform,
  version: ipcRenderer.sendSync('sotto:version') as string,
  paste: (text: string, restoreClipboard: boolean) => ipcRenderer.invoke('sotto:paste', text, restoreClipboard),
  http: (request: unknown) => ipcRenderer.invoke('sotto:http', request),
  getSecret: (name: string) => ipcRenderer.invoke('sotto:secret-get', name),
  setSecret: (name: string, value: string) => ipcRenderer.invoke('sotto:secret-set', name, value),
  configure: (options: unknown) => ipcRenderer.send('sotto:configure', options),
  setPhase: (phase: string) => ipcRenderer.send('sotto:phase', phase),
  keyListener: () => ipcRenderer.invoke('sotto:key-listener'),
  onKey: (listener: (event: string) => void) => ipcRenderer.on('sotto:key', (_event, key: string) => listener(key)),
  onCommand: (listener: (command: string) => void) => ipcRenderer.on('sotto:command', (_event, command: string) => listener(command)),
})
