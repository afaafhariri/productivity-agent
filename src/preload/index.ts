import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  Channels,
  type ActivityEntry,
  type AgentApi,
  type RunEventParams
} from '../shared/ipc-contract'

// The renderer gets exactly one global, `window.agent`. Nothing else from Node or Electron.
const agent: AgentApi = {
  info: () => ipcRenderer.invoke(Channels.info),
  settings: () => ipcRenderer.invoke(Channels.settings),
  setSecret: (name, value) => ipcRenderer.invoke(Channels.setSecret, { name, value }),
  deleteSecret: (name) => ipcRenderer.invoke(Channels.deleteSecret, { name }),
  startRun: (conversationId, text) =>
    ipcRenderer.invoke(Channels.startRun, { conversationId, text }),
  cancelRun: (runId) => ipcRenderer.invoke(Channels.cancelRun, { runId }),
  respond: (runId, toolCallId, decision) =>
    ipcRenderer.invoke(Channels.respond, { runId, toolCallId, decision }),
  revokeAlways: (toolName) => ipcRenderer.invoke(Channels.revokeAlways, { toolName }),
  setTokenLimit: (limit) => ipcRenderer.invoke(Channels.setTokenLimit, { limit }),
  activity: () => ipcRenderer.invoke(Channels.activity),
  setModel: (provider, modelId) => ipcRenderer.invoke(Channels.setModel, { provider, modelId }),
  resetModel: () => ipcRenderer.invoke(Channels.resetModel),
  onRunEvent: (listener) => {
    const handler = (_event: IpcRendererEvent, params: RunEventParams): void => listener(params)
    ipcRenderer.on(Channels.runEvent, handler)
    return () => ipcRenderer.removeListener(Channels.runEvent, handler)
  },
  onActivity: (listener) => {
    const handler = (_event: IpcRendererEvent, entry: ActivityEntry): void => listener(entry)
    ipcRenderer.on(Channels.activityEvent, handler)
    return () => ipcRenderer.removeListener(Channels.activityEvent, handler)
  }
}

contextBridge.exposeInMainWorld('agent', Object.freeze(agent))
