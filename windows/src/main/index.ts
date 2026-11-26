// Bol for Windows: the Electron main process. It owns the tray icon, the global hotkey, the voice bar
// window and the native layer, and runs the brain (an Engine) in-process.

import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command, type BrainEvent } from '../shared/events'
import type { Settings } from '../shared/settings'
import { ACTIONS_FILE, BOL_DIR, SETTINGS_FILE } from './brain/constants'
import { setControlExecutor } from './brain/control'
import { emit, log, onEvent } from './brain/protocol'
import { setApprover } from './brain/safety'
import { setUrlOpener } from './brain/utils'
import type { Engine } from './engine'
import { createEngine } from './engines'
import { createWindowsControl } from './native/windows-control'
import { loadSettings, watchSettings } from './settings-store'

const here = dirname(fileURLToPath(import.meta.url))
const BAR_WIDTH = 640
const BAR_HEIGHT = 200

if (!app.requestSingleInstanceLock()) app.quit()

let settings: Settings
let engine: Engine | null = null
let bar: BrowserWindow | null = null
let tray: Tray | null = null
let seq = 0
/** The engine's state, for a bar that loads after `ready` went out. */
let status: { isReady: boolean; backend: string | null; error: string | null } = { isReady: false, backend: null, error: null }
/** Recent log lines, for "Copy log" in the tray menu. */
const logLines: string[] = []

function resource(name: string): string {
	return app.isPackaged ? join(process.resourcesPath, 'resources', name) : join(app.getAppPath(), 'resources', name)
}

function createBar(): BrowserWindow {
	const win = new BrowserWindow({
		width: BAR_WIDTH,
		height: BAR_HEIGHT,
		show: false,
		frame: false,
		transparent: true,
		resizable: false,
		movable: true,
		skipTaskbar: true,
		alwaysOnTop: true,
		focusable: true,
		hasShadow: false,
		webPreferences: {
			preload: join(here, '../preload/index.cjs'),
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
		},
	})
	win.setAlwaysOnTop(true, 'screen-saver')
	if (process.env.ELECTRON_RENDERER_URL != null) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
	else void win.loadFile(join(here, '../renderer/index.html'))
	// Links in replies open in the browser, never inside the bar.
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:\/\//.test(url)) void shell.openExternal(url)
		return { action: 'deny' }
	})
	return win
}

/** Bottom-centre of the screen the pointer is on, like the original's voice bar. */
function placeBar(win: BrowserWindow) {
	const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
	const { x, y, width, height } = display.workArea
	win.setBounds({ x: Math.round(x + (width - BAR_WIDTH) / 2), y: y + height - BAR_HEIGHT - 24, width: BAR_WIDTH, height: BAR_HEIGHT })
}

function showBar({ isListening }: { isListening: boolean }) {
	if (bar == null || bar.isDestroyed()) bar = createBar()
	if (!bar.isVisible()) placeBar(bar)
	bar.show()
	bar.focus()
	bar.webContents.send('bol:show', { isListening })
}

function hideBar() {
	bar?.hide()
}

function toggleBar() {
	if (bar?.isVisible() === true && bar.isFocused()) hideBar()
	else showBar({ isListening: true })
}

function send(event: BrainEvent) {
	if (bar != null && !bar.isDestroyed()) bar.webContents.send('bol:event', event)
}

function registerHotkey() {
	globalShortcut.unregisterAll()
	try {
		if (!globalShortcut.register(settings.hotkey, toggleBar)) throw new Error('taken by another app')
		log({ msg: `hotkey ${settings.hotkey}` })
	} catch (e) {
		log({ msg: `couldn't register hotkey ${settings.hotkey}: ${e}` })
		emit({ type: 'result', text: `The shortcut ${settings.hotkey} is taken. Pick another in settings.json.`, isError: true })
	}
}

function buildTray() {
	const icon = nativeImage.createFromPath(resource('tray.png')).resize({ width: 16, height: 16 })
	tray = new Tray(icon)
	tray.setToolTip('Bol')
	tray.on('click', () => showBar({ isListening: true }))
	tray.setContextMenu(
		Menu.buildFromTemplate([
			{ label: `Talk to Bol (${settings.hotkey})`, click: () => showBar({ isListening: true }) },
			{ label: 'New conversation', click: () => void engine?.send({ type: 'reset' }) },
			{ label: 'Stop', click: () => void engine?.send({ type: 'interrupt' }) },
			{ type: 'separator' },
			{ label: 'Settings (settings.json)…', click: () => void shell.openPath(SETTINGS_FILE) },
			{ label: 'Action log…', click: () => void shell.openPath(ACTIONS_FILE) },
			{ label: 'Open Bol folder', click: () => void shell.openPath(BOL_DIR) },
			{ label: 'Copy log', click: () => clipboard.writeText(logLines.join('\n')) },
			{ type: 'separator' },
			{ label: 'Quit Bol', click: () => app.quit() },
		]),
	)
}

/** Starts the engine for the current backend, replacing any running one. */
async function startEngine() {
	engine?.close()
	status = { isReady: false, backend: null, error: null }
	engine = createEngine({ settings })
	try {
		await engine.start()
	} catch (e) {
		const text = e instanceof Error ? e.message : String(e)
		log({ msg: `engine failed to start: ${text}` })
		status = { isReady: false, backend: null, error: text }
		showBar({ isListening: false })
		emit({ type: 'result', text, isError: true })
	}
}

/** "Ask first" mode: each tool call waits for Allow or Deny in the voice bar. */
const approvals = new Map<string, (isAllowed: boolean) => void>()
setApprover(
	(request) =>
		new Promise((resolve) => {
			approvals.set(request.id, resolve)
			showBar({ isListening: false })
			bar?.webContents.send('bol:approval', request)
		}),
)

ipcMain.handle('bol:command', async (_e, raw: unknown) => {
	const parsed = Command.safeParse(raw)
	if (!parsed.success) return { ok: false, error: parsed.error.message }
	const cmd = parsed.data.type === 'say' ? { ...parsed.data, seq: ++seq } : parsed.data
	await engine?.send(cmd)
	return { ok: true, seq: cmd.type === 'say' ? cmd.seq : undefined }
})
ipcMain.on('bol:hide', () => hideBar())
ipcMain.on('bol:approve', (_e, { id, isAllowed }: { id: string; isAllowed: boolean }) => {
	approvals.get(id)?.(isAllowed === true)
	approvals.delete(id)
})
ipcMain.handle('bol:settings', () => settings)
ipcMain.handle('bol:status', () => status)

app.on('second-instance', () => showBar({ isListening: true }))
app.on('window-all-closed', () => {
	// A tray app keeps running with no windows.
})
app.on('will-quit', () => {
	globalShortcut.unregisterAll()
	engine?.close()
})

app.whenReady().then(async () => {
	app.setAppUserModelId('dev.bol.windows')
	settings = await loadSettings()

	onEvent((event) => {
		if (event.type === 'ready') status = { isReady: true, backend: event.backend, error: null }
		if (event.type === 'log') {
			logLines.push(`${new Date().toISOString()} ${event.msg}`)
			if (logLines.length > 2000) logLines.splice(0, logLines.length - 2000)
			if (!app.isPackaged) console.log('[brain]', event.msg)
		}
		send(event)
	})

	setUrlOpener((url) => shell.openExternal(url))
	const control = createWindowsControl({
		// Keep the bar out of screenshots: it would cover what the user means.
		beforeCapture: async () => {
			if (bar?.isVisible() === true) {
				bar.setOpacity(0)
				await new Promise((r) => setTimeout(r, 60))
			}
		},
		afterCapture: async () => {
			bar?.setOpacity(1)
		},
		clipboard: { read: () => clipboard.readText(), write: (text) => clipboard.writeText(text) },
	})
	setControlExecutor(control.executor)
	app.on('will-quit', () => control.close())

	buildTray()
	registerHotkey()
	bar = createBar()

	watchSettings({
		onChange: (next) => {
			const isHotkeyChanged = next.hotkey !== settings.hotkey
			const isBackendChanged = next.backend !== settings.backend
			settings = next
			if (isHotkeyChanged) registerHotkey()
			if (isBackendChanged) void startEngine()
			else void engine?.updateSettings(next)
			bar?.webContents.send('bol:settings', next)
		},
	})

	await startEngine()
})
