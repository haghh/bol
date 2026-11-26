// API keys, encrypted. Each key is encrypted with the operating system's store (Electron safeStorage: DPAPI
// on Windows, so only this Windows user can decrypt it) and kept in ~/.bol/secrets.json. Keys never live in
// settings.json, never go to the renderer, and are never logged. If the OS store isn't available, keys are
// refused rather than saved in plain text.
//
// The crypto is passed in so this file doesn't import Electron and can be tested on its own.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type SecretCrypto = {
	isAvailable: () => boolean
	encrypt: (text: string) => Buffer
	decrypt: (data: Buffer) => string
}

export type SecretStore = {
	get: (args: { name: string }) => Promise<string | null>
	/** `value: null` removes the key. Throws a short, user-fit message on failure. */
	set: (args: { name: string; value: string | null }) => Promise<void>
	has: (args: { names: readonly string[] }) => Promise<Record<string, boolean>>
}

export function createSecretStore({ file, crypto }: { file: string; crypto: SecretCrypto }): SecretStore {
	let queue: Promise<unknown> = Promise.resolve()
	/** Writes go one at a time so two quick saves can't overwrite each other. */
	const serial = <T>(fn: () => Promise<T>): Promise<T> => {
		const next = queue.then(fn, fn)
		queue = next.catch(() => {})
		return next
	}

	async function read(): Promise<Record<string, string>> {
		const text = await readFile(file, 'utf8').catch(() => null)
		if (text == null) return {}
		try {
			const parsed: unknown = JSON.parse(text)
			if (parsed == null || typeof parsed !== 'object') return {}
			return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string'))
		} catch {
			return {}
		}
	}

	return {
		async get({ name }) {
			const stored = (await read())[name]
			if (stored == null || !crypto.isAvailable()) return null
			try {
				return crypto.decrypt(Buffer.from(stored, 'base64'))
			} catch {
				return null // saved under another Windows user or a reset store: treat as not set
			}
		},
		set: ({ name, value }) =>
			serial(async () => {
				const all = await read()
				if (value == null || value.trim() === '') {
					delete all[name]
				} else {
					const key = value.trim()
					if (/\s/.test(key) || key.length > 500) throw new Error("That doesn't look like an API key.")
					if (!crypto.isAvailable()) throw new Error("Secure storage isn't available on this PC, so the key wasn't saved.")
					all[name] = crypto.encrypt(key).toString('base64')
				}
				await mkdir(dirname(file), { recursive: true })
				await writeFile(`${file}.tmp`, JSON.stringify(all, null, '\t') + '\n')
				await rename(`${file}.tmp`, file)
			}),
		async has({ names }) {
			const all = await read()
			return Object.fromEntries(names.map((n) => [n, all[n] != null]))
		},
	}
}
