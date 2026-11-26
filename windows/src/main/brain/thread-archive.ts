// Bol's own copy of every conversation, in ~/.bol/threads/<session id>.jsonl, through the Agent SDK's
// sessionStore: each transcript line Claude Code writes is mirrored here, and resuming reads from here.
// Claude Code's cleanup (cleanupPeriodDays) never touches it, so Bol keeps its threads on its own terms,
// and any of them can be continued, whichever folder it ran in.

import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { CLAUDE_PROJECTS_DIR, THREADS_DIR } from './constants'
import { log } from './protocol'

/** The main transcript is `<id>.jsonl`; a subagent's is `<id>/<subpath>.jsonl`. Projects don't matter: ids are unique. */
function fileOf({ sessionId, subpath }: { sessionId: string; subpath?: string }): string {
	const file =
		subpath == null ? join(THREADS_DIR, `${sessionId}.jsonl`) : join(THREADS_DIR, sessionId, `${subpath}.jsonl`)
	if (relative(THREADS_DIR, file).startsWith('..')) throw new Error(`bad session key ${sessionId}/${subpath}`)
	return file
}

function parseLines({ text }: { text: string }): SessionStoreEntry[] {
	const entries: SessionStoreEntry[] = []
	for (const line of text.split('\n')) {
		if (line.trim() === '') continue
		try {
			entries.push(JSON.parse(line))
		} catch {} // a line cut short by a crash
	}
	return entries
}

/** A session from before Bol kept its own copy: Claude Code's transcript, in whichever project folder it ran. */
async function findLegacy({ sessionId }: { sessionId: string }): Promise<string | null> {
	const projects = await readdir(CLAUDE_PROJECTS_DIR).catch(() => [] as string[])
	for (const project of projects) {
		const file = join(CLAUDE_PROJECTS_DIR, project, `${sessionId}.jsonl`)
		if ((await stat(file).catch(() => null)) != null) return file
	}
	return null
}

/** When the conversation last changed (Bol's copy, else Claude Code's), or null if it's nowhere. */
export async function lastActivity({ sessionId }: { sessionId: string }): Promise<Date | null> {
	const file =
		(await stat(fileOf({ sessionId })).catch(() => null)) != null
			? fileOf({ sessionId })
			: await findLegacy({ sessionId })
	if (file == null) return null
	return (await stat(file).catch(() => null))?.mtime ?? null
}

export function makeThreadArchive(): SessionStore {
	/** uuids already in each file, so a retried batch isn't written twice. */
	const written = new Map<string, Set<string>>()
	/** Writes to one file run in order. */
	const queues = new Map<string, Promise<void>>()

	async function knownIds({ file }: { file: string }): Promise<Set<string>> {
		let ids = written.get(file)
		if (ids == null) {
			const text = await readFile(file, 'utf8').catch(() => '')
			ids = new Set(parseLines({ text }).flatMap((e) => (typeof e.uuid === 'string' ? [e.uuid] : [])))
			written.set(file, ids)
		}
		return ids
	}

	return {
		append(key: SessionKey, entries: SessionStoreEntry[]) {
			const file = fileOf(key)
			const previous = queues.get(file) ?? Promise.resolve()
			const next = previous.then(async () => {
				const ids = await knownIds({ file })
				const fresh = entries.filter((e) => typeof e.uuid !== 'string' || !ids.has(e.uuid))
				if (fresh.length === 0) return
				await mkdir(dirname(file), { recursive: true })
				await appendFile(file, fresh.map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 })
				for (const e of fresh) if (typeof e.uuid === 'string') ids.add(e.uuid)
			})
			queues.set(
				file,
				next.catch((e) => log({ msg: `thread archive: ${e}` })),
			)
			return next
		},

		async load(key: SessionKey) {
			const text = await readFile(fileOf(key), 'utf8').catch(() => null)
			if (text != null) return parseLines({ text })
			if (key.subpath != null) return null
			const legacy = await findLegacy({ sessionId: key.sessionId })
			const legacyText = legacy == null ? null : await readFile(legacy, 'utf8').catch(() => null)
			if (legacyText == null) return null
			// Adopt it, so what this resume adds lands after its history in Bol's copy.
			await writeFile(fileOf(key), legacyText, { mode: 0o600, flag: 'wx' }).catch(() => {})
			return parseLines({ text: legacyText })
		},

		async listSessions() {
			const names = await readdir(THREADS_DIR).catch(() => [] as string[])
			const sessions = await Promise.all(
				names
					.filter((name) => name.endsWith('.jsonl'))
					.map(async (name) => {
						const info = await stat(join(THREADS_DIR, name)).catch(() => null)
						return { sessionId: name.slice(0, -'.jsonl'.length), mtime: Math.floor(info?.mtimeMs ?? 0) }
					}),
			)
			return sessions
		},

		async delete(key: SessionKey) {
			await rm(fileOf(key), { force: true })
			if (key.subpath == null) await rm(join(THREADS_DIR, key.sessionId), { recursive: true, force: true })
		},

		async listSubkeys(key: { projectKey: string; sessionId: string }) {
			const dir = join(THREADS_DIR, key.sessionId)
			const names = await readdir(dir, { recursive: true }).catch(() => [] as string[])
			return names.filter((name) => name.endsWith('.jsonl')).map((name) => name.slice(0, -'.jsonl'.length))
		},
	}
}
