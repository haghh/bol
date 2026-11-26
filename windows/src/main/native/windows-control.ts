// The Windows ControlExecutor: performs the brain's control actions (see brain/control.ts) through a
// long-lived PowerShell host (control-host.ps1.ts) that calls Win32 SendInput, SetCursorPos and GDI.
//
// Screenshots are scaled down (long side at most MAX_SIDE) to keep them cheap for the model, so every
// coordinate the model sends is in screenshot pixels and is mapped back to physical screen pixels here,
// using the last screenshot's origin and scale. That mirrors what the Swift app did on macOS.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { ControlAction, ControlExecutor, ControlResult } from '../brain/control'
import { log } from '../brain/protocol'
import { sleep } from '../brain/utils'
import { CONTROL_HOST_SCRIPT } from './control-host.ps1'
import { parseCombo } from './keys'

/** Long side of a screenshot sent to the model. Claude's computer-use guidance tops out around here. */
const MAX_SIDE = 1568
/** Zooms get more detail. */
const ZOOM_MAX_SIDE = 1568

type Rect = { x: number; y: number; width: number; height: number }
type Shot = Rect & { imageWidth: number; imageHeight: number }
type Screen = Rect & { name: string; isPrimary: boolean }
type Foreground = Rect & { handle: number; app: string; path: string; title: string }

type HostReply = { ok: boolean; id?: number; error?: string } & Record<string, any>

class PowerShellHost {
	private proc: ChildProcessWithoutNullStreams | null = null
	private seq = 0
	private pending = new Map<number, (reply: HostReply) => void>()
	private ready: Promise<void> | null = null

	private start(): Promise<void> {
		const encoded = Buffer.from(CONTROL_HOST_SCRIPT, 'utf16le').toString('base64')
		const proc = spawn(
			'powershell.exe',
			['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
			{ windowsHide: true },
		)
		this.proc = proc
		let err = ''
		proc.stderr.setEncoding('utf8').on('data', (d: string) => (err = (err + d).slice(-2000)))
		const ready = new Promise<void>((resolve, reject) => {
			const rl = createInterface({ input: proc.stdout })
			rl.on('line', (line) => {
				let reply: HostReply
				try {
					reply = JSON.parse(line)
				} catch {
					return // stray output from a cmdlet
				}
				if (reply.ready === true) return resolve()
				if (typeof reply.id !== 'number') return
				const done = this.pending.get(reply.id)
				this.pending.delete(reply.id)
				done?.(reply)
			})
			proc.on('error', reject)
			proc.on('exit', (code) => {
				log({ msg: `control host exited ${code}: ${err.trim().slice(0, 500)}` })
				reject(new Error(`PowerShell exited (${code}) ${err.trim().slice(0, 300)}`))
				for (const done of this.pending.values()) done({ ok: false, error: 'PowerShell exited' })
				this.pending.clear()
				this.proc = null
				this.ready = null
			})
		})
		return ready
	}

	async call(op: string, args: Record<string, unknown> = {}): Promise<HostReply> {
		if (this.ready == null) this.ready = this.start()
		await this.ready
		const id = ++this.seq
		return new Promise((resolve) => {
			this.pending.set(id, (reply) => resolve(reply))
			this.proc!.stdin.write(JSON.stringify({ op, id, ...args }) + '\n')
		})
	}

	/** Like call, but throws the host's error. */
	async must(op: string, args: Record<string, unknown> = {}): Promise<HostReply> {
		const reply = await this.call(op, args)
		if (!reply.ok) throw new Error(reply.error ?? `${op} failed`)
		return reply
	}

	close() {
		this.proc?.kill()
		this.proc = null
		this.ready = null
	}
}

export type WindowsControlOptions = {
	/** Hide Bol's own windows before a screenshot and show them after, so the bar isn't in the picture. */
	beforeCapture?: () => Promise<void>
	afterCapture?: () => Promise<void>
	/** Clipboard access, when the shell has a better one (Electron's clipboard module). */
	clipboard?: { read: () => Promise<string> | string; write: (text: string) => Promise<void> | void }
}

export function createWindowsControl(options: WindowsControlOptions = {}): {
	executor: ControlExecutor
	close: () => void
} {
	const host = new PowerShellHost()
	let lastShot: Shot | null = null
	/** A monitor picked with switch_display; null follows the frontmost window. */
	let pinnedDisplay: string | null = null
	const vkCache = new Map<string, number | null>()
	let isLeftHeld = false

	async function screens(): Promise<Screen[]> {
		return (await host.must('screens')).screens as Screen[]
	}

	/** The monitor screenshots capture: the pinned one, else the one holding the frontmost window. */
	async function activeScreen(): Promise<{ screen: Screen; all: Screen[] }> {
		const all = await screens()
		const pinned = pinnedDisplay == null ? undefined : all.find((s) => s.name === pinnedDisplay)
		if (pinned != null) return { screen: pinned, all }
		const fg = (await host.must('foreground')) as unknown as Foreground
		const cx = fg.x + fg.width / 2
		const cy = fg.y + fg.height / 2
		const holding = all.find((s) => cx >= s.x && cx < s.x + s.width && cy >= s.y && cy < s.y + s.height)
		return { screen: holding ?? all.find((s) => s.isPrimary) ?? all[0]!, all }
	}

	async function capture({ rect, maxSide }: { rect: Rect; maxSide: number }): Promise<{ shot: Shot; image: string }> {
		await options.beforeCapture?.()
		try {
			const reply = await host.must('capture', {
				x: Math.round(rect.x),
				y: Math.round(rect.y),
				width: Math.max(1, Math.round(rect.width)),
				height: Math.max(1, Math.round(rect.height)),
				maxSide,
			})
			const shot: Shot = {
				x: reply.x,
				y: reply.y,
				width: reply.width,
				height: reply.height,
				imageWidth: reply.imageWidth,
				imageHeight: reply.imageHeight,
			}
			return { shot, image: reply.image as string }
		} finally {
			await options.afterCapture?.()
		}
	}

	/** Screenshot pixels to physical screen pixels. */
	function toScreen(coordinate: unknown): { x: number; y: number } {
		if (!Array.isArray(coordinate) || coordinate.length !== 2) throw new Error('coordinate must be [x, y]')
		const [cx, cy] = coordinate as [number, number]
		if (lastShot == null) throw new Error('Take a screenshot first: coordinates are pixels in the latest screenshot.')
		return {
			x: Math.round(lastShot.x + (cx * lastShot.width) / lastShot.imageWidth),
			y: Math.round(lastShot.y + (cy * lastShot.height) / lastShot.imageHeight),
		}
	}

	function toShot({ x, y }: { x: number; y: number }): [number, number] {
		if (lastShot == null) return [x, y]
		return [
			Math.round(((x - lastShot.x) * lastShot.imageWidth) / lastShot.width),
			Math.round(((y - lastShot.y) * lastShot.imageHeight) / lastShot.height),
		]
	}

	async function resolveKeys(text: string): Promise<number[]> {
		const first = parseCombo({ text })
		for (const char of first.unknown) {
			if (char.length !== 1 || vkCache.has(char)) continue
			const reply = await host.call('vkScan', { char })
			const code = reply.ok ? Number(reply.code) : -1
			vkCache.set(char, code < 0 ? null : code & 0xff)
		}
		const { vks, unknown } = parseCombo({ text, lookup: (c) => vkCache.get(c) ?? null })
		if (unknown.length > 0) throw new Error(`Unknown key(s): ${unknown.join(', ')}`)
		return vks
	}

	async function withModifiers<T>(modifiers: unknown, fn: () => Promise<T>): Promise<T> {
		const vks = typeof modifiers === 'string' && modifiers.trim() !== '' ? await resolveKeys(modifiers) : []
		for (const vk of vks) await host.must('key', { vk, down: true })
		try {
			return await fn()
		} finally {
			for (const vk of [...vks].reverse()) await host.must('key', { vk, down: false })
		}
	}

	async function click({ action, button, count }: { action: ControlAction; button: string; count: number }) {
		const { x, y } = toScreen(action.coordinate)
		await withModifiers(action.text, async () => {
			await host.must('move', { x, y })
			for (let i = 0; i < count; i++) {
				await host.must('button', { button, down: true })
				await host.must('button', { button, down: false })
			}
		})
		return ok(`Clicked at ${String(action.coordinate)}.`)
	}

	const ok = (text: string, images: string[] = []): ControlResult => ({ text, isError: false, images })
	const fail = (text: string): ControlResult => ({ text, isError: true, images: [] })

	async function perform(action: ControlAction): Promise<ControlResult> {
		switch (action.name) {
			case 'screenshot': {
				const { screen, all } = await activeScreen()
				const { shot, image } = await capture({ rect: screen, maxSide: MAX_SIDE })
				lastShot = shot
				const others = all.filter((s) => s.name !== screen.name).map((s) => s.name)
				return ok(
					`Screenshot of monitor ${screen.name} (${shot.imageWidth}x${shot.imageHeight}).` +
						(others.length > 0 ? ` Other monitors: ${others.join(', ')}.` : ''),
					[image],
				)
			}
			case 'look_at_screen': {
				const fg = (await host.must('foreground')) as unknown as Foreground
				const isWindow = action.scope !== 'screen' && fg.width > 0 && fg.height > 0
				const rect = isWindow ? fg : (await activeScreen()).screen
				const { shot, image } = await capture({ rect, maxSide: MAX_SIDE })
				lastShot = shot
				const lines = [`Frontmost app: ${fg.app === '' ? 'unknown' : fg.app}`]
				if (fg.title !== '') lines.push(`Window: ${fg.title}`)
				return ok(lines.join('\n'), [image])
			}
			case 'zoom': {
				const region = action.region as [number, number, number, number] | undefined
				if (region == null || lastShot == null) return fail('Take a screenshot first, then zoom into part of it.')
				const a = toScreen([region[0], region[1]])
				const b = toScreen([region[2], region[3]])
				const keep = lastShot
				const { image } = await capture({
					rect: { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y },
					maxSide: ZOOM_MAX_SIDE,
				})
				lastShot = keep // coordinates still refer to the full screenshot
				return ok('Zoomed view (coordinates still refer to the full screenshot).', [image])
			}
			case 'left_click':
				return click({ action, button: 'left', count: 1 })
			case 'right_click':
				return click({ action, button: 'right', count: 1 })
			case 'middle_click':
				return click({ action, button: 'middle', count: 1 })
			case 'double_click':
				return click({ action, button: 'left', count: 2 })
			case 'triple_click':
				return click({ action, button: 'left', count: 3 })
			case 'left_click_drag': {
				const to = toScreen(action.coordinate)
				if (action.startCoordinate != null) await host.must('move', toScreen(action.startCoordinate))
				await host.must('button', { button: 'left', down: true })
				// Move in steps so apps that track drags see motion.
				const from = (await host.must('cursor')) as unknown as { x: number; y: number }
				for (let i = 1; i <= 10; i++) {
					await host.must('move', {
						x: Math.round(from.x + ((to.x - from.x) * i) / 10),
						y: Math.round(from.y + ((to.y - from.y) * i) / 10),
					})
					await sleep(15)
				}
				await host.must('button', { button: 'left', down: false })
				return ok('Dragged.')
			}
			case 'left_mouse_down':
				await host.must('button', { button: 'left', down: true })
				isLeftHeld = true
				return ok('Left button held.')
			case 'left_mouse_up':
				await host.must('button', { button: 'left', down: false })
				isLeftHeld = false
				return ok('Left button released.')
			case 'mouse_move':
				await host.must('move', toScreen(action.coordinate))
				return ok('Moved.')
			case 'scroll': {
				await host.must('move', toScreen(action.coordinate))
				const amount = Math.max(1, Math.min(50, Number(action.scrollAmount ?? 3)))
				const dir = String(action.scrollDirection ?? 'down')
				const isHorizontal = dir === 'left' || dir === 'right'
				const sign = dir === 'up' || dir === 'right' ? 1 : -1
				for (let i = 0; i < amount; i++) await host.must('wheel', { delta: sign * 120, horizontal: isHorizontal })
				return ok(`Scrolled ${dir} ${amount}.`)
			}
			case 'type':
				await host.must('type', { text: String(action.text ?? '') })
				return ok('Typed.')
			case 'key': {
				const vks = await resolveKeys(String(action.text ?? ''))
				const repeat = Math.max(1, Math.min(100, Number(action.repeat ?? 1)))
				for (let i = 0; i < repeat; i++) {
					for (const vk of vks) await host.must('key', { vk, down: true })
					for (const vk of [...vks].reverse()) await host.must('key', { vk, down: false })
				}
				return ok(`Pressed ${action.text}${repeat > 1 ? ` x${repeat}` : ''}.`)
			}
			case 'hold_key': {
				const vks = await resolveKeys(String(action.text ?? ''))
				const seconds = Math.max(0, Math.min(30, Number(action.duration ?? 1)))
				for (const vk of vks) await host.must('key', { vk, down: true })
				await sleep(seconds * 1000)
				for (const vk of [...vks].reverse()) await host.must('key', { vk, down: false })
				return ok(`Held ${action.text} for ${seconds}s.`)
			}
			case 'cursor_position': {
				const p = (await host.must('cursor')) as unknown as { x: number; y: number }
				return ok(`Pointer at ${JSON.stringify(toShot(p))}${isLeftHeld ? ', left button held' : ''}.`)
			}
			case 'open_application': {
				const reply = await host.must('open', { app: String(action.app ?? '') })
				const verb = reply.how === 'focused' ? 'Brought forward' : 'Opened'
				return ok(`${verb} ${reply.name ?? action.app}.`)
			}
			case 'switch_display': {
				const name = String(action.display ?? 'auto')
				if (name === 'auto') {
					pinnedDisplay = null
					return ok('Screenshots follow the frontmost window again.')
				}
				const all = await screens()
				const match = all.find((s) => s.name.toLowerCase() === name.toLowerCase())
				if (match == null) return fail(`No monitor named ${name}. Monitors: ${all.map((s) => s.name).join(', ')}.`)
				pinnedDisplay = match.name
				return ok(`Screenshots now capture ${match.name}.`)
			}
			case 'read_clipboard': {
				const text = options.clipboard != null ? await options.clipboard.read() : ((await host.must('readClipboard')).text as string)
				return ok(text === '' ? '(The clipboard is empty or holds no text.)' : text)
			}
			case 'write_clipboard':
				if (options.clipboard != null) await options.clipboard.write(String(action.text ?? ''))
				else await host.must('writeClipboard', { text: String(action.text ?? '') })
				return ok('Copied to the clipboard.')
			case 'wait': {
				const seconds = Math.max(0, Math.min(30, Number(action.duration ?? 1)))
				await sleep(seconds * 1000)
				return ok(`Waited ${seconds}s.`)
			}
			case 'computer_batch': {
				const steps = (action.actions as ControlAction[] | undefined) ?? []
				const texts: string[] = []
				const images: string[] = []
				for (const [i, step] of steps.entries()) {
					const result = await perform(step).catch((e): ControlResult => fail(String(e?.message ?? e)))
					texts.push(`${i + 1}. ${step.name}: ${result.text}`)
					images.push(...result.images)
					if (result.isError) return { text: texts.join('\n') + '\nStopped at the failed step.', isError: true, images }
				}
				return ok(texts.join('\n'), images)
			}
			default:
				return fail(`Unknown action ${action.name}.`)
		}
	}

	return {
		executor: (action) => perform(action).catch((e): ControlResult => fail(e instanceof Error ? e.message : String(e))),
		close: () => host.close(),
	}
}
