// Mouse / keyboard / screen control. nut-js is loaded lazily so the app still runs
// (chat, voice, tasks...) on machines where the native module can't load.
import { desktopCapturer, screen as eScreen } from 'electron'

type Nut = typeof import('@nut-tree-fork/nut-js')
let nut: Nut | null = null
let nutError = ''

export async function loadNut(): Promise<Nut | null> {
  if (nut || nutError) return nut
  try {
    nut = await import('@nut-tree-fork/nut-js')
    nut.mouse.config.mouseSpeed = 3000
    nut.mouse.config.autoDelayMs = 40
    nut.keyboard.config.autoDelayMs = 8
  } catch (e) {
    nutError = String(e)
    console.warn('[control] nut-js unavailable:', nutError)
  }
  return nut
}

export function controlAvailable(): boolean {
  return !!nut
}

// ---------------- Screenshots ----------------
// Screenshots are downscaled so the long edge is <= 1366px. This keeps each image
// around 1,300-1,500 input tokens, which is the single biggest lever on computer-use cost.
const MAX_W = 1366
const MAX_H = 900

export interface Shot {
  base64: string
  width: number // screenshot pixel size (what Claude sees)
  height: number
}

let lastShot = { width: 1280, height: 800 }

export async function takeScreenshot(region?: [number, number, number, number]): Promise<Shot> {
  const display = eScreen.getPrimaryDisplay()
  const phys = {
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor)
  }
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: phys })
  const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
  if (!src) throw new Error('No screen available to capture (check screen recording permission).')
  let img = src.thumbnail
  const full = img.getSize()
  const scale = Math.min(1, MAX_W / full.width, MAX_H / full.height)
  const shotW = Math.round(full.width * scale)
  const shotH = Math.round(full.height * scale)

  if (region) {
    // region is in screenshot space -> crop on the full-res image, then fit to the usual size
    const [x0, y0, x1, y1] = region
    const crop = {
      x: Math.max(0, Math.round(Math.min(x0, x1) / scale)),
      y: Math.max(0, Math.round(Math.min(y0, y1) / scale)),
      width: Math.max(1, Math.round(Math.abs(x1 - x0) / scale)),
      height: Math.max(1, Math.round(Math.abs(y1 - y0) / scale))
    }
    img = img.crop(crop)
    const s = Math.min(MAX_W / crop.width, MAX_H / crop.height, 2)
    img = img.resize({ width: Math.round(crop.width * s), height: Math.round(crop.height * s), quality: 'good' })
  } else {
    lastShot = { width: shotW, height: shotH }
    if (scale < 1) img = img.resize({ width: shotW, height: shotH, quality: 'good' })
  }
  const size = img.getSize()
  // JPEG is much smaller to transmit than PNG; token cost depends only on pixel size.
  return { base64: img.toJPEG(80).toString('base64'), width: size.width, height: size.height }
}

/** Convert a screenshot-space point to Electron DIP coordinates (used by the overlay). */
export function shotToDip(x: number, y: number): { x: number; y: number } {
  const d = eScreen.getPrimaryDisplay()
  return {
    x: d.bounds.x + (x * d.size.width) / lastShot.width,
    y: d.bounds.y + (y * d.size.height) / lastShot.height
  }
}
export function shotScaleToDip(): { sx: number; sy: number } {
  const d = eScreen.getPrimaryDisplay()
  return { sx: d.size.width / lastShot.width, sy: d.size.height / lastShot.height }
}

/** Convert screenshot-space point to nut-js space (which may be physical pixels). */
async function toNut(x: number, y: number) {
  const n = (await loadNut())!
  const [w, h] = await Promise.all([n.screen.width(), n.screen.height()])
  return new n.Point(Math.round((x * w) / lastShot.width), Math.round((y * h) / lastShot.height))
}
async function fromNut(p: { x: number; y: number }) {
  const n = (await loadNut())!
  const [w, h] = await Promise.all([n.screen.width(), n.screen.height()])
  return { x: Math.round((p.x * lastShot.width) / w), y: Math.round((p.y * lastShot.height) / h) }
}

// ---------------- Keys ----------------
const KEY_ALIASES: Record<string, string> = {
  ctrl: 'LeftControl', control: 'LeftControl', shift: 'LeftShift', alt: 'LeftAlt', option: 'LeftAlt',
  super: process.platform === 'darwin' ? 'LeftCmd' : 'LeftSuper',
  win: 'LeftWin', windows: 'LeftWin', meta: process.platform === 'darwin' ? 'LeftCmd' : 'LeftSuper',
  cmd: 'LeftCmd', command: 'LeftCmd',
  enter: 'Enter', return: 'Return', esc: 'Escape', escape: 'Escape', tab: 'Tab', space: 'Space',
  backspace: 'Backspace', delete: 'Delete', del: 'Delete', insert: 'Insert', home: 'Home', end: 'End',
  pageup: 'PageUp', page_up: 'PageUp', prior: 'PageUp', pagedown: 'PageDown', page_down: 'PageDown', next: 'PageDown',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', capslock: 'CapsLock', caps_lock: 'CapsLock',
  minus: 'Minus', equal: 'Equal', plus: 'Add', comma: 'Comma', period: 'Period', slash: 'Slash',
  backslash: 'Backslash', semicolon: 'Semicolon', quote: 'Quote', apostrophe: 'Quote', grave: 'Grave',
  bracketleft: 'LeftBracket', bracketright: 'RightBracket', print: 'Print', printscreen: 'Print',
  volumeup: 'AudioVolUp', volumedown: 'AudioVolDown', mute: 'AudioMute',
  xf86audioraisevolume: 'AudioVolUp', xf86audiolowervolume: 'AudioVolDown', xf86audiomute: 'AudioMute',
  xf86audioplay: 'AudioPlay', xf86audionext: 'AudioNext', xf86audioprev: 'AudioPrev'
}

function parseCombo(n: Nut, combo: string) {
  return combo
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((raw) => {
      const k = raw.toLowerCase().replace(/^key_/, '')
      let name = KEY_ALIASES[k]
      if (!name) {
        if (/^[a-z]$/.test(k)) name = k.toUpperCase()
        else if (/^[0-9]$/.test(k)) name = 'Num' + k
        else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(k)) name = k.toUpperCase()
        else name = raw
      }
      const key = (n.Key as unknown as Record<string, number>)[name]
      if (key === undefined) throw new Error(`Unknown key "${raw}"`)
      return key as unknown as InstanceType<never>
    }) as unknown as import('@nut-tree-fork/nut-js').Key[]
}

async function withModifiers<T>(mods: string | undefined, fn: () => Promise<T>): Promise<T> {
  const n = (await loadNut())!
  const keys = mods ? parseCombo(n, mods) : []
  if (keys.length) await n.keyboard.pressKey(...keys)
  try {
    return await fn()
  } finally {
    if (keys.length) await n.keyboard.releaseKey(...keys)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------- Computer toolset executor ----------------
export type ComputerResult = { kind: 'text'; text: string } | { kind: 'image'; shot: Shot }

export async function runComputerAction(name: string, input: Record<string, any>): Promise<ComputerResult> {
  if (name === 'screenshot') return { kind: 'image', shot: await takeScreenshot() }
  if (name === 'zoom') return { kind: 'image', shot: await takeScreenshot(input.region) }
  if (name === 'wait') {
    await sleep(Math.min(300, Number(input.duration ?? 1)) * 1000)
    return { kind: 'text', text: 'OK' }
  }

  const n = await loadNut()
  if (!n) throw new Error('Mouse/keyboard control is unavailable on this machine (native module failed to load).')
  const { mouse, keyboard, Button } = n
  const moveTo = async (c?: [number, number]) => {
    if (c) await mouse.setPosition(await toNut(c[0], c[1]))
  }

  switch (name) {
    case 'left_click':
    case 'right_click':
    case 'middle_click':
    case 'double_click':
    case 'triple_click': {
      await moveTo(input.coordinate)
      await withModifiers(input.text, async () => {
        if (name === 'left_click') await mouse.click(Button.LEFT)
        else if (name === 'right_click') await mouse.click(Button.RIGHT)
        else if (name === 'middle_click') await mouse.click(Button.MIDDLE)
        else if (name === 'double_click') await mouse.doubleClick(Button.LEFT)
        else {
          await mouse.doubleClick(Button.LEFT)
          await mouse.click(Button.LEFT)
        }
      })
      break
    }
    case 'left_click_drag': {
      await moveTo(input.start_coordinate)
      await withModifiers(input.text, async () => {
        await mouse.pressButton(Button.LEFT)
        await mouse.move(n.straightTo(await toNut(input.coordinate[0], input.coordinate[1])))
        await mouse.releaseButton(Button.LEFT)
      })
      break
    }
    case 'mouse_move':
      await moveTo(input.coordinate)
      break
    case 'left_mouse_down':
      await mouse.pressButton(Button.LEFT)
      break
    case 'left_mouse_up':
      await mouse.releaseButton(Button.LEFT)
      break
    case 'cursor_position': {
      const p = await fromNut(await mouse.getPosition())
      return { kind: 'text', text: `X=${p.x}, Y=${p.y}` }
    }
    case 'scroll': {
      await moveTo(input.coordinate)
      const amt = Math.max(1, Number(input.scroll_amount ?? 3)) * 3
      await withModifiers(input.text, async () => {
        const dir = input.scroll_direction
        if (dir === 'up') await mouse.scrollUp(amt)
        else if (dir === 'down') await mouse.scrollDown(amt)
        else if (dir === 'left') await mouse.scrollLeft(amt)
        else await mouse.scrollRight(amt)
      })
      break
    }
    case 'type':
      await keyboard.type(String(input.text ?? ''))
      break
    case 'key': {
      const keys = parseCombo(n, String(input.text))
      const repeat = Math.min(100, Math.max(1, Number(input.repeat ?? 1)))
      for (let i = 0; i < repeat; i++) {
        await keyboard.pressKey(...keys)
        await keyboard.releaseKey(...keys)
      }
      break
    }
    case 'hold_key': {
      const keys = parseCombo(n, String(input.text))
      await keyboard.pressKey(...keys)
      await sleep(Math.min(300, Number(input.duration ?? 1)) * 1000)
      await keyboard.releaseKey(...keys)
      break
    }
    default:
      throw new Error(`Unsupported computer action: ${name}`)
  }
  return { kind: 'text', text: 'OK' }
}

/** Title of the focused window (used for activity learning). */
export async function activeWindowTitle(): Promise<string> {
  const n = await loadNut()
  if (!n) return ''
  try {
    const w = await n.getActiveWindow()
    return (await w.getTitle()) || ''
  } catch {
    return ''
  }
}
