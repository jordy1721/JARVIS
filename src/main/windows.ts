import { BrowserWindow, screen, shell, app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import type { GuidePayload, GuideStep, HudPayload } from '@shared/types'
import { shotScaleToDip } from './computer/control'

let mainWin: BrowserWindow | null = null
let overlayWin: BrowserWindow | null = null
let quitting = false
let guide: GuidePayload | null = null
let hud: HudPayload = { state: 'idle', visible: true }

export function setQuitting(): void {
  quitting = true
}

function loadPage(win: BrowserWindow, page: 'index' | 'overlay') {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) win.loadURL(`${devUrl}/${page}.html`)
  else win.loadFile(path.join(__dirname, `../renderer/${page}.html`))
}

const preload = () => path.join(__dirname, '../preload/index.js')

export function createMainWindow(): BrowserWindow {
  mainWin = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'JARVIS',
    backgroundColor: '#05080f',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preload(),
      sandbox: false,
      contextIsolation: true,
      backgroundThrottling: false // keep the microphone/voice pipeline alive in the background
    }
  })
  mainWin.once('ready-to-show', () => mainWin?.show())
  mainWin.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      mainWin?.hide() // keep running in the tray
    }
  })
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  armWatchdog(mainWin)
  loadPage(mainWin, 'index')
  return mainWin
}

export function createOverlayWindow(): BrowserWindow {
  const d = screen.getPrimaryDisplay()
  overlayWin = new BrowserWindow({
    x: d.bounds.x,
    y: d.bounds.y,
    width: d.bounds.width,
    height: d.bounds.height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: { preload: preload(), sandbox: false, contextIsolation: true }
  })
  overlayWin.setAlwaysOnTop(true, 'screen-saver')
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  overlayWin.setIgnoreMouseEvents(true, { forward: true })
  overlayWin.once('ready-to-show', () => {
    overlayWin?.showInactive()
    pushOverlay()
  })
  loadPage(overlayWin, 'overlay')
  return overlayWin
}

// ---------------- blank-screen watchdog ----------------
// The UI reports "ready" after it renders. If that doesn't happen (e.g. a bad code change
// broke it), the main process notices and offers to undo the change.
let rendererReady = false
let watchdog: NodeJS.Timeout | undefined
const recentErrors: string[] = []
let onStuck: ((errors: string[]) => void) | null = null

export function setRendererStuckHandler(fn: (errors: string[]) => void): void {
  onStuck = fn
}
export function markRendererReady(): void {
  if (!rendererReady) log('[screen] ready')
  rendererReady = true
  clearTimeout(watchdog)
}
export function noteRendererError(msg: string): void {
  recentErrors.push(msg.slice(0, 500))
  if (recentErrors.length > 8) recentErrors.shift()
  log(`[screen error] ${msg}`)
}

/** Problems are printed in the start-jarvis window and saved to jarvis.log in the app-data folder. */
export function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}`
  console.log(line)
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'jarvis.log'), line + '\n')
  } catch {
    /* ignore */
  }
}

function armWatchdog(win: BrowserWindow) {
  win.webContents.on('did-start-loading', () => {
    rendererReady = false
    recentErrors.length = 0
  })
  win.webContents.on('did-finish-load', () => {
    clearTimeout(watchdog)
    log(`[screen] loaded ${win.webContents.getURL()}`)
    watchdog = setTimeout(() => {
      if (!rendererReady) {
        log('[screen] did not finish rendering within 20 s')
        onStuck?.([...recentErrors])
      }
    }, 20_000)
  })
  win.webContents.on('console-message', (e) => {
    const ev = e as unknown as { level?: string | number; message?: string }
    if (ev.level === 'error' || ev.level === 3) noteRendererError(String(ev.message ?? ''))
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    noteRendererError(`Could not load ${url}: ${desc} (${code})`)
  })
  win.webContents.on('preload-error', (_e, p, err) => noteRendererError(`Preload failed (${p}): ${err.message}`))
  win.webContents.on('render-process-gone', (_e, details) => {
    noteRendererError(`Renderer crashed: ${details.reason}`)
    onStuck?.([...recentErrors])
  })
}

export const getMainWindow = () => mainWin
export const getOverlayWindow = () => overlayWin

export function showMain(page?: string): void {
  if (!mainWin) return
  if (mainWin.isMinimized()) mainWin.restore()
  mainWin.show()
  mainWin.focus()
  if (page) mainWin.webContents.send('navigate', page)
}

export function sendMain(channel: string, ...args: unknown[]): void {
  mainWin?.webContents.send(channel, ...args)
}

function pushOverlay() {
  overlayWin?.webContents.send('overlay:update', { hud, guide })
}

export function setHud(patch: Partial<HudPayload>): void {
  hud = { ...hud, ...patch }
  pushOverlay()
}

export function setOverlayInteractive(interactive: boolean): void {
  overlayWin?.setIgnoreMouseEvents(!interactive, { forward: true })
}

export function showGuide(title: string, steps: GuideStep[]): void {
  const { sx, sy } = shotScaleToDip()
  const converted = steps.slice(0, 8).map((s) => {
    const hasBox = s.width !== undefined && s.height !== undefined
    const w = (s.width ?? 44) * sx
    const h = (s.height ?? 44) * sy
    const x = hasBox ? s.x * sx : s.x * sx - w / 2
    const y = hasBox ? s.y * sy : s.y * sy - h / 2
    return { ...s, x, y, width: w, height: h }
  })
  guide = { title, steps: converted, current: 0 }
  overlayWin?.showInactive()
  pushOverlay()
}

export function clearGuide(): void {
  guide = null
  setOverlayInteractive(false)
  pushOverlay()
}

let minimizedForControl = false
/** Hide the overlay (and get the main window out of the way) so screenshots show the real screen. */
export async function beforeScreenshot(): Promise<void> {
  if (mainWin && mainWin.isFocused() && !minimizedForControl) {
    mainWin.minimize()
    minimizedForControl = true
  }
  if (overlayWin?.isVisible()) {
    overlayWin.setOpacity(0)
    overlayWin.hide()
  }
  await new Promise((r) => setTimeout(r, 180))
}

export function afterScreenshot(): void {
  overlayWin?.setOpacity(1)
  overlayWin?.showInactive()
}

export function resetControlFlags(): void {
  minimizedForControl = false
}
