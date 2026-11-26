// Downloads the local engines on first use (whisper.cpp, a Whisper model, Piper, a Piper voice) into
// ~/.bol/voice. Everything is pinned to a release URL and a SHA-256, so a changed or tampered file is
// rejected. After the first download the engines work offline.

import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { VoiceError } from './errors'
import type { FetchFn } from './http'
import { runPowerShell } from './process'

export type Notice = (text: string) => void

export async function fileExists({ path }: { path: string }): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	)
}

/** Streams `url` to `dest` (via a .part file), checks the SHA-256 and only then moves it into place. */
export async function downloadVerified({
	url,
	dest,
	sha256,
	label,
	notice,
	fetchFn = fetch,
	signal,
}: {
	url: string
	dest: string
	sha256: string
	label: string
	notice?: Notice
	fetchFn?: FetchFn
	signal?: AbortSignal
}): Promise<void> {
	await mkdir(dirname(dest), { recursive: true })
	const part = `${dest}.part`
	try {
		notice?.(`Downloading ${label}…`)
		const res = await fetchFn(url, { signal, redirect: 'follow' })
		if (!res.ok || res.body == null) throw new VoiceError({ kind: 'network', message: `Couldn't download ${label} (error ${res.status}).` })
		const total = Number(res.headers.get('content-length') ?? 0)
		const hash = createHash('sha256')
		let received = 0
		let lastNoticeAt = 0
		const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>)
		body.on('data', (chunk: Buffer) => {
			hash.update(chunk)
			received += chunk.length
			if (total > 0 && Date.now() - lastNoticeAt > 1000) {
				lastNoticeAt = Date.now()
				notice?.(`Downloading ${label}… ${Math.round((received / total) * 100)}%`)
			}
		})
		await pipeline(body, createWriteStream(part))
		if (hash.digest('hex') !== sha256.toLowerCase()) {
			throw new VoiceError({ kind: 'failed', message: `The ${label} download didn't match its checksum, so it was discarded.` })
		}
		await rename(part, dest)
	} catch (e) {
		await rm(part, { force: true })
		if (e instanceof VoiceError || (e instanceof Error && e.name === 'AbortError')) throw e
		throw new VoiceError({ kind: 'network', message: `No network connection. Couldn't download ${label}.` })
	}
}

/** Unzips with Windows PowerShell into `to`, replacing it only when the whole archive extracted. */
export async function extractZip({ zip, to }: { zip: string; to: string }): Promise<void> {
	const staging = `${to}.extracting`
	await rm(staging, { recursive: true, force: true })
	const res = await runPowerShell({
		script: 'Expand-Archive -LiteralPath $env:BOL_ZIP -DestinationPath $env:BOL_TO -Force',
		env: { BOL_ZIP: zip, BOL_TO: staging },
		timeoutMs: 120_000,
	})
	if (res.code !== 0) {
		await rm(staging, { recursive: true, force: true })
		throw new VoiceError({ kind: 'setup', message: "Couldn't unpack the voice engine download." })
	}
	await rm(to, { recursive: true, force: true })
	await rename(staging, to)
}

const inFlight = new Map<string, Promise<unknown>>()

/** Runs `task` once per key even if several callers ask at the same time. */
export function once<T>({ key, task }: { key: string; task: () => Promise<T> }): Promise<T> {
	const running = inFlight.get(key)
	if (running != null) return running as Promise<T>
	const p = task().finally(() => inFlight.delete(key))
	inFlight.set(key, p)
	return p
}

export async function listFiles({ dir, extension }: { dir: string; extension: string }): Promise<string[]> {
	const names = await readdir(dir).catch(() => [] as string[])
	return names.filter((n) => n.toLowerCase().endsWith(extension)).sort()
}

export const joinPath = join
