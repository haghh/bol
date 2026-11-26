// Key names the model uses ("ctrl+shift+t", "enter", "win+d") to Windows virtual-key codes.

const NAMED: Record<string, number> = {
	ctrl: 0x11,
	control: 0x11,
	shift: 0x10,
	alt: 0x12,
	option: 0x12,
	win: 0x5b,
	windows: 0x5b,
	super: 0x5b,
	meta: 0x5b,
	// The model was trained on Mac shortcuts too: cmd means ctrl on Windows (cmd+c is ctrl+c).
	cmd: 0x11,
	command: 0x11,
	enter: 0x0d,
	return: 0x0d,
	escape: 0x1b,
	esc: 0x1b,
	tab: 0x09,
	space: 0x20,
	backspace: 0x08,
	delete: 0x2e,
	del: 0x2e,
	insert: 0x2d,
	home: 0x24,
	end: 0x23,
	pageup: 0x21,
	page_up: 0x21,
	pagedown: 0x22,
	page_down: 0x22,
	up: 0x26,
	down: 0x28,
	left: 0x25,
	right: 0x27,
	arrowup: 0x26,
	arrowdown: 0x28,
	arrowleft: 0x25,
	arrowright: 0x27,
	capslock: 0x14,
	printscreen: 0x2c,
	prtsc: 0x2c,
	menu: 0x5d,
	apps: 0x5d,
	volumeup: 0xaf,
	volumedown: 0xae,
	volumemute: 0xad,
	mute: 0xad,
	playpause: 0xb3,
	nexttrack: 0xb0,
	prevtrack: 0xb1,
	numlock: 0x90,
}

export type KeyCombo = { vks: number[]; unknown: string[] }

/** Parses "ctrl+shift+t" into virtual-key codes, modifiers first. `lookup` resolves punctuation for the layout. */
export function parseCombo({ text, lookup }: { text: string; lookup?: (char: string) => number | null }): KeyCombo {
	const vks: number[] = []
	const unknown: string[] = []
	// "ctrl++" means ctrl and plus.
	const parts = text.trim().replace(/\+\+$/, '+plus').split(/[+\s]+/).filter((p) => p !== '')
	for (const raw of parts) {
		const part = raw.toLowerCase()
		const named = NAMED[part.replace(/[-_]/g, '')] ?? NAMED[part]
		if (named != null) vks.push(named)
		else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(part)) vks.push(0x70 + Number(part.slice(1)) - 1)
		else if (/^[a-z]$/.test(part)) vks.push(part.toUpperCase().charCodeAt(0))
		else if (/^[0-9]$/.test(part)) vks.push(part.charCodeAt(0))
		else if (part === 'plus') vks.push(0xbb)
		else if (part === 'minus') vks.push(0xbd)
		else if (raw.length === 1 && lookup != null) {
			const vk = lookup(raw)
			if (vk == null) unknown.push(raw)
			else vks.push(vk)
		} else unknown.push(raw)
	}
	return { vks, unknown }
}
