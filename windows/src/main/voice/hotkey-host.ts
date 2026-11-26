// Runs the push-to-talk keyboard hook (hotkey-host.ps1.ts) and reports when the combo goes down and up.

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Combo } from './hotkey'
import { HOTKEY_HOST_SCRIPT } from './hotkey-host.ps1'

export type PushToTalkHook = { stop: () => void }

/**
 * Starts the hook. `onFailed` is called once if it can't start or dies, so the caller can fall back to a plain
 * toggle shortcut. Not on Windows, it fails straight away.
 */
export function startPushToTalkHook({
	combo,
	onDown,
	onUp,
	onFailed,
	onLog,
}: {
	combo: Combo
	onDown: () => void
	onUp: () => void
	onFailed: (reason: string) => void
	onLog?: (msg: string) => void
}): PushToTalkHook {
	let isStopped = false
	let isFailed = false
	const fail = (reason: string) => {
		if (isStopped || isFailed) return
		isFailed = true
		onFailed(reason)
	}
	if (process.platform !== 'win32') {
		queueMicrotask(() => fail('push-to-talk needs Windows'))
		return { stop: () => (isStopped = true) }
	}
	const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(HOTKEY_HOST_SCRIPT, 'utf16le').toString('base64')], {
		windowsHide: true,
		env: {
			...process.env,
			BOL_VK: String(combo.vk),
			BOL_ALT: combo.isAlt ? '1' : '0',
			BOL_CTRL: combo.isCtrl ? '1' : '0',
			BOL_SHIFT: combo.isShift ? '1' : '0',
			BOL_WIN: combo.isWin ? '1' : '0',
		},
	})
	let isReady = false
	let err = ''
	const readyTimer = setTimeout(() => {
		if (!isReady) {
			proc.kill()
			fail('the keyboard hook took too long to start')
		}
	}, 20_000)
	proc.stderr.setEncoding('utf8').on('data', (d: string) => (err = (err + d).slice(-1000)))
	createInterface({ input: proc.stdout }).on('line', (line) => {
		const msg = line.trim()
		if (msg === 'ready') {
			isReady = true
			clearTimeout(readyTimer)
			onLog?.('push-to-talk hook ready')
		} else if (msg === 'down') onDown()
		else if (msg === 'up') onUp()
		else if (msg.startsWith('error')) fail(msg)
	})
	proc.on('error', (e) => fail(`couldn't start PowerShell: ${e.message}`))
	proc.on('exit', (code) => {
		clearTimeout(readyTimer)
		if (isStopped) return
		onLog?.(`push-to-talk hook exited ${code}: ${err.trim().slice(0, 300)}`)
		fail(`the keyboard hook exited (${code})`)
	})
	return {
		stop() {
			isStopped = true
			clearTimeout(readyTimer)
			proc.stdin.end() // the script exits when stdin closes
			setTimeout(() => proc.kill(), 1000).unref()
		},
	}
}
