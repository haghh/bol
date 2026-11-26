// Reads and writes ~/.bol/settings.json. The file is the source of truth: editing it by hand works, and the
// app picks the change up.

import { watch } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { parseSettings, type Settings } from '../shared/settings'
import { SETTINGS_FILE } from './brain/constants'

export async function loadSettings(): Promise<Settings> {
	const text = await readFile(SETTINGS_FILE, 'utf8').catch(() => null)
	if (text == null) {
		const defaults = parseSettings({})
		await saveSettings(defaults) // so the user can find and edit it
		return defaults
	}
	try {
		return parseSettings(JSON.parse(text))
	} catch {
		return parseSettings({})
	}
}

export async function saveSettings(settings: Settings) {
	await mkdir(dirname(SETTINGS_FILE), { recursive: true })
	await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, '\t') + '\n')
}

/** Calls `onChange` with the new settings (debounced) when the file changes. Returns a stop function. */
export function watchSettings({ onChange }: { onChange: (settings: Settings) => void }): () => void {
	let timer: ReturnType<typeof setTimeout> | null = null
	try {
		const watcher = watch(dirname(SETTINGS_FILE), (_event, file) => {
			if (file != null && file !== basename(SETTINGS_FILE)) return
			if (timer != null) clearTimeout(timer)
			timer = setTimeout(() => void loadSettings().then(onChange), 300)
		})
		return () => watcher.close()
	} catch {
		return () => {}
	}
}
