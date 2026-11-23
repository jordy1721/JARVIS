import { app, globalShortcut, ipcMain, Menu, nativeImage, session, systemPreferences, Tray } from 'electron'
import type { ConfirmRequest, ConnectionStatus, DashboardData, MemoryFact, Settings, Task } from '@shared/types'
import * as store from './store'
import { Agent } from './brain/agent'
import { hasApiKey, resetClient } from './brain/client'
import { claudeVersion, findClaude, openInstaller, openSignIn, testConnection } from './brain/claudeCli'
import { startToolServer } from './brain/toolServer'
import { controlAvailable, loadNut } from './computer/control'
import { applyChange, rejectChange, revertChange, sourceRoot } from './selfmod/selfmod'
import { startActivityTracker, startScheduler } from './services/scheduler'
import { dayKey, usageSummary } from './services/usage'
import * as win from './windows'

if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => win.showMain())

let tray: Tray | null = null

// ---------------- Confirmations ----------------
const pendingConfirms = new Map<string, (ok: boolean) => void>()
function confirm(req: Omit<ConfirmRequest, 'id'>): Promise<boolean> {
  const id = store.newId()
  return new Promise((resolve) => {
    pendingConfirms.set(id, resolve)
    win.showMain()
    win.sendMain('confirm', { ...req, id })
    win.setHud({ state: 'idle', caption: `Waiting for your approval: ${req.title}` })
    // Auto-deny after 2 minutes so the agent never hangs forever.
    setTimeout(() => {
      if (pendingConfirms.has(id)) {
        pendingConfirms.delete(id)
        win.sendMain('confirm:closed', id)
        resolve(false)
      }
    }, 120_000)
  })
}

// ---------------- Agent ----------------
const agent = new Agent({
  emitChat: (e) => win.sendMain('chat', e),
  emitStream: (id, delta, done, speak) => win.sendMain('stream', { id, delta, done, speak }),
  emitReply: (e, speak, streamed) => win.sendMain('reply', { entry: e, speak, streamed }),
  setState: (state, caption) => {
    win.sendMain('state', state)
    win.setHud({ state, caption })
    if (state === 'idle') win.resetControlFlags()
  },
  confirm,
  beforeScreenshot: win.beforeScreenshot,
  afterScreenshot: win.afterScreenshot,
  showGuide: win.showGuide,
  clearGuide: win.clearGuide,
  onSettingsChanged: () => broadcastSettings(),
  onChangeProposed: () => {
    win.sendMain('code:changed')
    win.setHud({ caption: 'A code change is waiting for your review in Code Lab' })
  },
  onTasksChanged: () => win.sendMain('tasks:changed')
})

async function connectionStatus(force = false): Promise<ConnectionStatus> {
  const s = store.getSettings()
  const claudePath = await findClaude(force)
  const version = force && claudePath ? await claudeVersion() : null
  return {
    provider: s.provider,
    ready: s.provider === 'subscription' ? !!claudePath : hasApiKey(),
    claudeInstalled: !!claudePath,
    claudeVersion: version,
    claudePath,
    hasApiKey: hasApiKey()
  }
}

function broadcastSettings() {
  const s = store.getSettings()
  win.sendMain('settings', s)
  win.setHud({ visible: s.showHud })
  registerHotkeys()
}

// ---------------- Hotkeys ----------------
function registerHotkeys() {
  globalShortcut.unregisterAll()
  const s = store.getSettings()
  const tryReg = (accel: string, fn: () => void) => {
    if (!accel) return
    try {
      if (!globalShortcut.register(accel, fn)) console.warn('Hotkey in use:', accel)
    } catch (e) {
      console.warn('Bad hotkey', accel, e)
    }
  }
  tryReg(s.pushToTalkHotkey, () => win.sendMain('ptt:toggle'))
  tryReg(s.stopHotkey, () => {
    agent.stop()
    win.sendMain('stop-all')
  })
}

// ---------------- Tray ----------------
function createTray() {
  // 16x16 cyan ring drawn as a data URL so no binary asset is needed.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="11" fill="none" stroke="#38e1ff" stroke-width="5"/></svg>`
  const icon = nativeImage.createFromDataURL('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'))
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }))
  tray.setToolTip('JARVIS')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open JARVIS', click: () => win.showMain() },
      { label: 'Talk (push-to-talk)', click: () => win.sendMain('ptt:toggle') },
      { label: 'Stop current action', click: () => agent.stop() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ])
  )
  tray.on('click', () => win.showMain())
}

// ---------------- IPC ----------------
function registerIpc() {
  ipcMain.handle('settings:get', () => store.getSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    const s = store.updateSettings(patch)
    if ('launchAtLogin' in patch) app.setLoginItemSettings({ openAtLogin: !!patch.launchAtLogin })
    broadcastSettings()
    return s
  })
  ipcMain.handle('secret:set', (_e, name: 'anthropic' | 'elevenlabs', value: string) => {
    store.setSecret(name, value.trim())
    if (name === 'anthropic') resetClient()
    return true
  })
  ipcMain.handle('secret:has', (_e, name: string) => (name === 'anthropic' ? hasApiKey() : !!store.getSecret(name)))

  // Claude subscription connection (via the user's own Claude Code install)
  ipcMain.handle('claude:status', () => connectionStatus(true))
  ipcMain.handle('claude:test', () => testConnection())
  ipcMain.handle('claude:signin', () => openSignIn())
  ipcMain.handle('claude:install', () => openInstaller())

  ipcMain.handle('chat:send', (_e, text: string, spoken: boolean) => {
    agent.send(text, { spoken })
  })
  ipcMain.handle('chat:history', () => store.chat.all())
  ipcMain.handle('chat:stop', () => agent.stop())
  ipcMain.handle('chat:new', () => agent.newSession())
  ipcMain.handle('chat:clear', () => {
    store.chat.clear()
    agent.newSession()
  })

  ipcMain.handle('confirm:respond', (_e, id: string, ok: boolean) => {
    const r = pendingConfirms.get(id)
    pendingConfirms.delete(id)
    r?.(ok)
  })

  ipcMain.handle('memory:list', () => store.memory.all())
  ipcMain.handle('memory:add', (_e, f: Pick<MemoryFact, 'text' | 'category' | 'importance'>) =>
    store.memory.add({ ...f, source: 'explicit' })
  )
  ipcMain.handle('memory:update', (_e, id: string, patch: Partial<MemoryFact>) => store.memory.update(id, patch))
  ipcMain.handle('memory:remove', (_e, id: string) => store.memory.remove(id))
  ipcMain.handle('memory:clear', () => store.memory.set([]))
  ipcMain.handle('journal:list', () => store.journal.all().slice().reverse())
  ipcMain.handle('journal:remove', (_e, id: string) => store.journal.remove(id))
  ipcMain.handle('journal:clear', () => store.journal.clear())

  ipcMain.handle('tasks:list', () => store.tasks.all())
  ipcMain.handle('tasks:add', (_e, t: Partial<Task> & { title: string }) => store.tasks.add(t))
  ipcMain.handle('tasks:update', (_e, id: string, patch: Partial<Task>) => store.tasks.update(id, patch))
  ipcMain.handle('tasks:remove', (_e, id: string) => store.tasks.remove(id))
  ipcMain.handle('tasks:run', (_e, id: string) => {
    const t = store.tasks.get(id)
    if (t?.automation) agent.send(`[Automation "${t.title}"] ${t.automation.prompt}`, { purpose: 'automation' })
  })

  ipcMain.handle('actions:list', () => store.actions.all().slice(-300).reverse())
  ipcMain.handle('usage:summary', () => usageSummary())

  ipcMain.handle('code:list', () => store.codeChanges.all().slice().reverse())
  ipcMain.handle('code:apply', (_e, id: string) => applyChange(id))
  ipcMain.handle('code:reject', (_e, id: string) => rejectChange(id))
  ipcMain.handle('code:revert', (_e, id: string) => revertChange(id))
  ipcMain.handle('code:root', () => sourceRoot())
  ipcMain.handle('app:restart', () => {
    win.setQuitting()
    app.relaunch()
    app.exit(0)
  })

  ipcMain.handle('dashboard:get', async (): Promise<DashboardData> => {
    const all = store.tasks.all()
    const endOfDay = new Date()
    endOfDay.setHours(23, 59, 59, 999)
    const today = store.activity.all()[dayKey(Date.now())]
    return {
      usage: usageSummary(),
      tasks: {
        open: all.filter((t) => t.status !== 'done').length,
        dueToday: all.filter((t) => t.status !== 'done' && t.due && t.due <= endOfDay.getTime()).length,
        done: all.filter((t) => t.status === 'done').length,
        upcoming: all
          .filter((t) => t.status !== 'done')
          .sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity))
          .slice(0, 6)
      },
      memoryCount: store.memory.all().length,
      journalCount: store.journal.all().length,
      recentActions: store.actions.all().slice(-8).reverse(),
      activity: today
        ? {
            day: dayKey(Date.now()),
            apps: Object.entries(today)
              .map(([name, minutes]) => ({ name, minutes }))
              .sort((a, b) => b.minutes - a.minutes)
              .slice(0, 8)
          }
        : null,
      pendingChanges: store.codeChanges.all().filter((c) => c.status === 'pending').length,
      connection: await connectionStatus(),
      computerControlAvailable: controlAvailable()
    }
  })

  // Voice state reported by the renderer (listening / transcribing / speaking) for the HUD.
  ipcMain.on('voice:state', (_e, state, caption?: string) => win.setHud({ state, caption }))

  // ElevenLabs TTS (optional premium voice). The key never leaves the main process.
  ipcMain.handle('tts:eleven', async (_e, text: string) => {
    const key = store.getSecret('elevenlabs')
    const voice = store.getSettings().elevenLabsVoiceId
    if (!key || !voice) return null
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_64`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5' })
    })
    if (!res.ok) return null
    return Buffer.from(await res.arrayBuffer()).toString('base64')
  })

  // Overlay
  ipcMain.on('overlay:interactive', (_e, on: boolean) => win.setOverlayInteractive(on))
  ipcMain.on('guide:next', () => {
    win.clearGuide()
    agent.send('[Guide] I have done the steps you showed. Take a new screenshot and show me the next steps, or clear the guide if we are finished.', {
      silent: true
    })
  })
  ipcMain.on('guide:close', () => win.clearGuide())
  ipcMain.on('show-main', (_e, page?: string) => win.showMain(page))
}

// ---------------- Startup ----------------
app.whenReady().then(async () => {
  // Allow microphone access for the voice pipeline.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'))
  if (process.platform === 'darwin') {
    systemPreferences.askForMediaAccess('microphone').catch(() => undefined)
  }
  registerIpc()
  await startToolServer((name, input, isComputer) => agent.executeTool(name, input, isComputer))
  findClaude().catch(() => undefined)
  win.createMainWindow()
  win.createOverlayWindow()
  win.setHud({ visible: store.getSettings().showHud })
  createTray()
  registerHotkeys()
  await loadNut()
  startScheduler({
    remind: (t) => {
      win.sendMain('reminder', t)
      win.setHud({ caption: `Reminder: ${t.title}` })
    },
    runAutomation: (t) => agent.send(`[Automation "${t.title}"] ${t.automation!.prompt}`, { purpose: 'automation' })
  })
  startActivityTracker()
})

app.on('before-quit', () => {
  win.setQuitting()
  store.flushStore()
})
app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => {
  // Stay alive in the tray.
})
