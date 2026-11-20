import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { isAppUrl } from './security'
import type { Handler } from './handlers'

/** Registers the handlers. Requests from anything but the app's own page are refused. */
export function registerIpc(handlers: Record<string, Handler>): void {
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, payload: unknown) => {
      if (!isAppUrl(event.senderFrame?.url ?? '')) {
        return { ok: false, error: { code: 'forbidden', message: 'Untrusted sender' } }
      }
      return handler(payload)
    })
  }
}
