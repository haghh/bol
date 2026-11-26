import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { delimiter, extname, join } from 'node:path'

/** Compile-time proof that every case of a union is handled. */
export function exhaustiveGuard(arg: never): never {
	throw new Error(`Unhandled case: ${JSON.stringify(arg)}`)
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Run a command (no shell) and return its trimmed stdout. Rejects on a non-zero exit. */
export function sh({ cmd, input, timeoutMs }: { cmd: string[]; input?: string; timeoutMs?: number }): Promise<string> {
	const [file, ...args] = cmd
	if (file == null) return Promise.reject(new Error('empty command'))
	return new Promise((resolve, reject) => {
		const p = spawn(file, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
		let out = ''
		let err = ''
		const timer = timeoutMs == null ? null : setTimeout(() => p.kill(), timeoutMs)
		p.stdout.setEncoding('utf8').on('data', (d: string) => (out += d))
		p.stderr.setEncoding('utf8').on('data', (d: string) => (err += d))
		p.on('error', reject)
		p.on('close', (code) => {
			if (timer != null) clearTimeout(timer)
			if (code === 0) resolve(out.trim())
			else reject(new Error(`${file} exited ${code}: ${err.trim().slice(0, 500)}`))
		})
		p.stdin.end(input ?? '')
	})
}

/** Runs a PowerShell script (Windows PowerShell 5.1, always present) and returns its trimmed stdout. */
export function powershell({ script, timeoutMs }: { script: string; timeoutMs?: number }): Promise<string> {
	// -EncodedCommand takes UTF-16LE base64, which sidesteps every quoting problem.
	const encoded = Buffer.from(script, 'utf16le').toString('base64')
	return sh({
		cmd: ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
		timeoutMs: timeoutMs ?? 30_000,
	})
}

/** Like `where`/`which`: the first match on PATH, trying Windows' executable extensions. */
export async function which(name: string): Promise<string | null> {
	const dirs = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter((d) => d !== '')
	const exts =
		process.platform === 'win32' && extname(name) === ''
			? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase())
			: ['']
	for (const dir of dirs) {
		for (const ext of exts) {
			const candidate = join(dir, name + ext)
			if (await exists(candidate)) return candidate
		}
	}
	return null
}

export async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	)
}

/** Opens a web page in the default browser. Electron's shell.openExternal is used when the shell sets one. */
let urlOpener: ((url: string) => Promise<void>) | null = null
export function setUrlOpener(fn: (url: string) => Promise<void>) {
	urlOpener = fn
}
export async function openUrl({ url }: { url: string }) {
	if (urlOpener != null) return urlOpener(url)
	// rundll32 opens a URL without cmd's quoting rules for & and ^.
	if (process.platform === 'win32') await sh({ cmd: ['rundll32', 'url.dll,FileProtocolHandler', url] })
	else await sh({ cmd: ['xdg-open', url] })
}
