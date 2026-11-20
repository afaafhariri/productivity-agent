import { app, session, shell } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const EXTERNAL_SCHEMES = new Set(['https:', 'http:', 'mailto:'])

export function openExternalSafely(url: string): void {
  try {
    if (EXTERNAL_SCHEMES.has(new URL(url).protocol)) void shell.openExternal(url)
  } catch {
    // Not a valid URL: ignore.
  }
}

/** Is `url` the app's own page (dev server or the packaged renderer folder)? */
export function isAppUrl(url: string): boolean {
  try {
    const dev = process.env['ELECTRON_RENDERER_URL']
    if (dev && new URL(url).origin === new URL(dev).origin) return true
    return url.startsWith(pathToFileURL(join(__dirname, '../renderer/')).href)
  } catch {
    return false
  }
}

/** App-wide guards: no new windows, no navigating away, no <webview>, no permission grants. */
export function applyAppHardening(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false)
  )
  session.defaultSession.setPermissionCheckHandler(() => false)

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      openExternalSafely(url)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      if (!isAppUrl(url)) {
        event.preventDefault()
        openExternalSafely(url)
      }
    })
    contents.on('will-attach-webview', (event) => event.preventDefault())
  })
}
