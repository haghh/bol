// Runs a child process (whisper-cli, piper, PowerShell) with stdin, a timeout and an abort signal.

import { spawn } from 'node:child_process'
import { VoiceError } from './errors'

export type ProcessResult = { code: number | null; stdout: Buffer; stderr: string }

export function runProcess({
	file,
	args,
	input,
	cwd,
	env,
	signal,
	timeoutMs = 60_000,
}: {
	file: string
	args: string[]
	input?: string
	cwd?: string
	env?: Record<string, string>
	signal?: AbortSignal
	timeoutMs?: number
}): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted === true) return reject(signal.reason)
		const proc = spawn(file, args, { cwd, env: { ...process.env, ...env }, windowsHide: true })
		const out: Buffer[] = []
		let err = ''
		let isDone = false
		const finish = (fn: () => void) => {
			if (isDone) return
			isDone = true
			clearTimeout(timer)
			signal?.removeEventListener('abort', onAbort)
			fn()
		}
		const timer = setTimeout(() => {
			proc.kill()
			finish(() => reject(new VoiceError({ kind: 'failed', message: 'The voice engine took too long.' })))
		}, timeoutMs)
		const onAbort = () => {
			proc.kill()
			finish(() => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')))
		}
		signal?.addEventListener('abort', onAbort)
		proc.stdout.on('data', (d: Buffer) => out.push(d))
		proc.stderr.setEncoding('utf8').on('data', (d: string) => (err = (err + d).slice(-4000)))
		proc.on('error', (e) =>
			finish(() => reject(new VoiceError({ kind: 'setup', message: `Couldn't start ${file.split(/[\\/]/).pop()}: ${(e as NodeJS.ErrnoException).code ?? 'error'}.` }))),
		)
		proc.on('close', (code) => finish(() => resolve({ code, stdout: Buffer.concat(out), stderr: err })))
		// A process that exits early closes stdin under us (EPIPE); the exit code tells the story.
		proc.stdin.on('error', () => {})
		proc.stdin.end(input ?? '')
	})
}

/** Runs a script in Windows PowerShell. Inputs go in `env`, never into the script text, so there's no quoting. */
export function runPowerShell({
	script,
	env,
	signal,
	timeoutMs,
}: {
	script: string
	env?: Record<string, string>
	signal?: AbortSignal
	timeoutMs?: number
}): Promise<ProcessResult> {
	const encoded = Buffer.from(script, 'utf16le').toString('base64')
	return runProcess({
		file: 'powershell.exe',
		args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
		env,
		signal,
		timeoutMs,
	})
}
