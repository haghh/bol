// Parses an Electron-style accelerator ("Alt+Space") into what the keyboard hook needs: Windows virtual-key
// code and modifiers. Only plain combos are supported (modifiers + one key); anything else returns null and
// the app falls back to a normal toggle shortcut.

export type Combo = { vk: number; isAlt: boolean; isCtrl: boolean; isShift: boolean; isWin: boolean }

const NAMED_KEYS: Record<string, number> = {
	space: 0x20,
	tab: 0x09,
	enter: 0x0d,
	return: 0x0d,
	escape: 0x1b,
	esc: 0x1b,
	backspace: 0x08,
	insert: 0x2d,
	delete: 0x2e,
	home: 0x24,
	end: 0x23,
	pageup: 0x21,
	pagedown: 0x22,
	up: 0x26,
	down: 0x28,
	left: 0x25,
	right: 0x27,
	'`': 0xc0,
	';': 0xba,
	'=': 0xbb,
	',': 0xbc,
	'-': 0xbd,
	'.': 0xbe,
	'/': 0xbf,
}

export function parseHotkey({ accelerator }: { accelerator: string }): Combo | null {
	const combo: Combo = { vk: 0, isAlt: false, isCtrl: false, isShift: false, isWin: false }
	let isKeySet = false
	for (const raw of accelerator.split('+')) {
		const part = raw.trim().toLowerCase()
		if (part === '') return null
		if (part === 'alt' || part === 'option') combo.isAlt = true
		else if (part === 'ctrl' || part === 'control' || part === 'commandorcontrol' || part === 'cmdorctrl') combo.isCtrl = true
		else if (part === 'shift') combo.isShift = true
		else if (part === 'super' || part === 'meta' || part === 'win' || part === 'windows' || part === 'cmd' || part === 'command') combo.isWin = true
		else {
			if (isKeySet) return null
			isKeySet = true
			const named = NAMED_KEYS[part]
			if (named != null) combo.vk = named
			else if (/^[a-z]$/.test(part)) combo.vk = part.toUpperCase().charCodeAt(0)
			else if (/^[0-9]$/.test(part)) combo.vk = part.charCodeAt(0)
			else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(part)) combo.vk = 0x70 + Number(part.slice(1)) - 1
			else return null
		}
	}
	// A bare key with no modifier would swallow ordinary typing, so one is required (F-keys excepted).
	const isFunctionKey = combo.vk >= 0x70 && combo.vk <= 0x87
	if (!isKeySet || (!combo.isAlt && !combo.isCtrl && !combo.isShift && !combo.isWin && !isFunctionKey)) return null
	return combo
}
