import { contextBridge } from 'electron'

// The renderer gets exactly one global, `window.agent`. Its typed API arrives with the IPC
// contract; nothing else from Node or Electron is exposed.
contextBridge.exposeInMainWorld('agent', Object.freeze({}))
