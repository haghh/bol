// API keys for the API-key engines. Stored in ~/.bol/keys.json, each encrypted with Windows DPAPI for the
// current user (the same protection Windows gives saved Wi-Fi and browser passwords), so the file is useless
// to anyone who copies it off the PC. Environment variables win, which is handy for development.
// Never logged, never sent anywhere but the provider's own API.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Settings } from '../../shared/settings'
import { BOL_DIR } from '../brain/constants'
import { powershell } from '../brain/utils'

export type KeyProvider = Exclude<Settings['backend'], 'claude-code'>

export const KEYS_FILE = join(BOL_DIR, 'keys.json')

/** The environment variable each provider's own SDK reads. */
export const KEY_ENV: Record<KeyProvider, string> = {
	anthropic: 'ANTHROPIC_API_KEY',
	openai: 'OPENAI_API_KEY',
	gemini: 'GOOGLE_GENERATIVE_AI_API_KEY',
}

type KeysFile = Partial<Record<KeyProvider, string>>

async function readKeysFile(): Promise<KeysFile> {
	try {
		return JSON.parse(await readFile(KEYS_FILE, 'utf8')) as KeysFile
	} catch {
		return {}
	}
}

/** DPAPI through PowerShell's SecureString cmdlets: works in Electron and in the terminal brain alike. */
async function protect(secret: string): Promise<string> {
	const b64 = Buffer.from(secret, 'utf8').toString('base64')
	return powershell({
		script: `$s = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
ConvertTo-SecureString -String $s -AsPlainText -Force | ConvertFrom-SecureString`,
	})
}

async function unprotect(sealed: string): Promise<string> {
	if (!/^[0-9a-f]+$/i.test(sealed)) throw new Error('not a DPAPI blob')
	return powershell({
		script: `$ss = ConvertTo-SecureString -String '${sealed}'
$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss)
try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }`,
	})
}

/** The key for a provider, or null if there is none. */
export async function getApiKey({ provider }: { provider: KeyProvider }): Promise<string | null> {
	const fromEnv = process.env[KEY_ENV[provider]]
	if (fromEnv != null && fromEnv.trim() !== '') return fromEnv.trim()
	const sealed = (await readKeysFile())[provider]
	if (sealed == null || process.platform !== 'win32') return null
	return (await unprotect(sealed).catch(() => '')).trim() || null
}

export async function setApiKey({ provider, key }: { provider: KeyProvider; key: string | null }) {
	if (process.platform !== 'win32') throw new Error(`Set ${KEY_ENV[provider]} in the environment instead.`)
	const keys = await readKeysFile()
	if (key == null || key.trim() === '') delete keys[provider]
	else keys[provider] = await protect(key.trim())
	await mkdir(dirname(KEYS_FILE), { recursive: true })
	await writeFile(KEYS_FILE, JSON.stringify(keys, null, '\t') + '\n', { mode: 0o600 })
}
