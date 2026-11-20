import { app, BrowserWindow, safeStorage } from 'electron'
import { join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerTools } from '../core/integrations'
import { ConfigError, llmConfigFromEnv } from '../core/llm/config'
import { MemorySecretStore, systemClock, type Logger, type SecretStore } from '../core/ports'
import { AgentService } from '../core/service'
import { ToolRegistry } from '../core/tools'
import { Channels, type AgentInfo } from '../shared/ipc-contract'
import { createHandlers } from './handlers'
import { registerIpc } from './ipc'
import { JsonFilePreferenceStore } from './preferences'
import { SafeStorageSecretStore } from './secrets'
import { applyAppHardening } from './security'

const APP_ID = 'dev.afaafhariri.personal-productivity-agent'

/** Logs go to stderr as one line each. Callers never pass secrets. */
const logger: Logger = {
  debug: (message, fields) =>
    process.env['LOG_LEVEL'] === 'debug' && console.error('DEBUG', message, fields ?? ''),
  info: (message, fields) => console.error('INFO', message, fields ?? ''),
  warn: (message, fields) => console.error('WARN', message, fields ?? ''),
  error: (message, fields) => console.error('ERROR', message, fields ?? '')
}

let mainWindow: BrowserWindow | null = null

function loadDevEnv(): void {
  // A .env file is a dev convenience for non-secret settings (LLM_PROVIDER, LLM_MODEL_ID).
  if (app.isPackaged) return
  try {
    process.loadEnvFile(join(app.getAppPath(), '.env'))
  } catch {
    // No .env: defaults apply.
  }
}

function startAgent(): { service: AgentService | null; info: AgentInfo } {
  const version = app.getVersion()
  try {
    const config = llmConfigFromEnv(process.env)
    const secrets: SecretStore =
      process.env['PRODUCTIVITY_AGENT_SECRETS'] === 'memory'
        ? new MemorySecretStore()
        : new SafeStorageSecretStore(join(app.getPath('userData'), 'secrets.json'), safeStorage)
    const service = new AgentService({
      config,
      registry: registerTools(new ToolRegistry()),
      secrets,
      preferences: new JsonFilePreferenceStore(join(app.getPath('userData'), 'preferences.json')),
      clock: systemClock,
      logger,
      onEvent: (params) => mainWindow?.webContents.send(Channels.runEvent, params)
    })
    logger.info('agent started', { provider: config.provider, model: config.modelId ?? null })
    return { service, info: { version, configError: null } }
  } catch (error) {
    const message =
      error instanceof ConfigError ? error.message : 'The agent could not start. See logs.'
    logger.error('agent not started', {
      error: error instanceof Error ? error.message : String(error)
    })
    return { service: null, info: { version, configError: message } }
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: '#161616',
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false
    }
  })
  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => (mainWindow = null))

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId(APP_ID)
  applyAppHardening()
  loadDevEnv()

  const { service, info } = startAgent()
  registerIpc(createHandlers(service, info))
  // Quitting stops every run, so a write waiting for approval never executes.
  app.on('before-quit', () => service?.cancelAll())

  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when the last window closes, on every platform, until a tray mode exists.
app.on('window-all-closed', () => app.quit())
