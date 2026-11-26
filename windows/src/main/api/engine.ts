// The API-key engines: Anthropic, OpenAI or Gemini through the Vercel AI SDK, with Bol's own tool loop and
// the minimal tool set in tools.ts. Same Engine interface and events as the Claude Code engine, so the voice
// bar can't tell them apart. What they don't have (yet): background tasks, skills and Claude Code's memory.
//
// One conversation at a time, like the original's thread: requests queue while one is running, it's kept
// in ~/.bol/api-threads/<id>.json, and it's left behind after a day idle.

import { generateText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from 'ai'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrainEvent, Command } from '../../shared/events'
import type { Settings } from '../../shared/settings'
import {
	API_SESSION_FILE,
	API_THREADS_DIR,
	API_TOOLS_PROMPT,
	BACKUPS_DIR,
	BOL_VOICE_PROMPT,
	IDLE_CONVERSATION_MS,
	PROMPT_FILE,
	SAFETY_PROMPT,
	WORKSPACE_DIR,
} from '../brain/constants'
import { loadCustomServers, watchCustomServers } from '../brain/mcp-config'
import { emit, log } from '../brain/protocol'
import { summarizeTool } from '../brain/session'
import { exhaustiveGuard } from '../brain/utils'
import type { Engine } from '../engine'
import { DEFAULT_MODELS, makeModel, missingKeyMessage } from './providers'
import { getApiKey, type KeyProvider } from './secrets'
import { connectMcpServers, makeTools, type McpConnection, type ToolContext } from './tools'

/** A long job still ends: the model gets this many steps (model calls) per request. */
const MAX_STEPS = 60

type Thread = { id: string; backend: KeyProvider; createdAt: string; updatedAt: string; messages: ModelMessage[] }

const threadFile = (id: string) => join(API_THREADS_DIR, `${id}.json`)

async function loadThread({ id }: { id: string }): Promise<Thread | null> {
	try {
		return JSON.parse(await readFile(threadFile(id), 'utf8')) as Thread
	} catch {
		return null
	}
}

/**
 * Screenshots are the bulk of a long conversation. Once a request is answered, its images have done their
 * job: earlier turns keep a note instead, so each new request doesn't re-send (and re-pay for) them.
 */
export function dropOldImages({ messages }: { messages: ModelMessage[] }): ModelMessage[] {
	return messages.map((message) => {
		if (message.role !== 'tool' && message.role !== 'user') return message
		if (typeof message.content === 'string') return message
		const content = (message.content as any[]).map((part) => {
			if (part.type === 'tool-result' && part.output?.type === 'content') {
				const value = (part.output.value as any[]).map((item) =>
					item.type === 'file' && String(item.mediaType).startsWith('image/')
						? { type: 'text', text: '[screenshot no longer attached]' }
						: item,
				)
				return { ...part, output: { ...part.output, value } }
			}
			if (part.type === 'image' || (part.type === 'file' && String(part.mediaType).startsWith('image/')))
				return { type: 'text', text: '[image no longer attached]' }
			return part
		})
		return { ...message, content } as ModelMessage
	})
}

/** A failure the user can act on, in one spoken sentence. */
function describeError({ error, provider }: { error: unknown; provider: KeyProvider }): string {
	const e = error as { statusCode?: number; message?: string }
	const status = e?.statusCode
	if (status === 401 || status === 403) return `${providerLabel(provider)} rejected the API key. Check it and try again.`
	if (status === 429) return `${providerLabel(provider)} says we're over the rate limit or out of credit. Try again shortly.`
	if (status === 404) return `${providerLabel(provider)} doesn't know that model. Check the model in settings.`
	if (status != null && status >= 500) return `${providerLabel(provider)} is having trouble right now. Try again in a moment.`
	return `Sorry, the request failed: ${(e?.message ?? String(error)).slice(0, 200)}`
}

const providerLabel = (p: KeyProvider) => ({ anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Gemini' })[p]

/** `languageModel` replaces the provider's model (tests use a mock). */
export const createApiEngine = ({
	settings: initial,
	languageModel,
}: {
	settings: Settings
	languageModel?: LanguageModel
}): Engine => {
	let settings: Settings = initial
	const provider = initial.backend as KeyProvider
	let thread: Thread | null = null
	let model: LanguageModel | null = languageModel ?? null
	let mcp: McpConnection | null = null
	let stopWatching: (() => void) | null = null
	const queue: { text: string; seq: number }[] = []
	let isRunning = false
	let abort: AbortController | null = null
	let latestSeq = 0
	let lastActivityAt = Date.now()

	const cwd = () => settings.workspace ?? WORKSPACE_DIR

	const context: ToolContext = {
		get cwd() {
			return cwd()
		},
		job: null,
		isAskFirst: () => settings.askFirst,
		emit: (event: BrainEvent) => emit(event),
		summarize: summarizeTool,
	}

	async function ensureModel(): Promise<LanguageModel | null> {
		if (model != null) return model
		const apiKey = await getApiKey({ provider })
		if (apiKey == null) return null
		model = makeModel({ provider, model: settings.model, apiKey })
		return model
	}

	async function saveThread({ target }: { target: Thread }) {
		target.updatedAt = new Date().toISOString()
		await mkdir(API_THREADS_DIR, { recursive: true })
		await writeFile(threadFile(target.id), JSON.stringify(target), { mode: 0o600 })
		if (target === thread) await writeFile(API_SESSION_FILE, target.id).catch(() => {})
	}

	function newThread(): Thread {
		const now = new Date().toISOString()
		return { id: randomUUID(), backend: provider, createdAt: now, updatedAt: now, messages: [] }
	}

	/** The saved conversation, unless it's a day old or from another provider (their histories don't mix). */
	async function resumeThread(): Promise<Thread> {
		const id = (await readFile(API_SESSION_FILE, 'utf8').catch(() => '')).trim()
		const saved = id === '' ? null : await loadThread({ id })
		if (saved == null || saved.backend !== provider) return newThread()
		if (Date.now() - Date.parse(saved.updatedAt) > IDLE_CONVERSATION_MS) {
			log({ msg: `api thread ${saved.id} idle since ${saved.updatedAt}, starting a new conversation` })
			return newThread()
		}
		return saved
	}

	async function systemPrompt(): Promise<string> {
		const custom = (await readFile(PROMPT_FILE, 'utf8').catch(() => '')).trim()
		const now = new Date()
		return [
			custom === '' ? BOL_VOICE_PROMPT : '\n' + custom + '\n',
			API_TOOLS_PROMPT,
			SAFETY_PROMPT,
			`\n# Context\n- Now: ${now.toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' })} (${Intl.DateTimeFormat().resolvedOptions().timeZone}).\n- Workspace folder: ${cwd()}\n`,
		].join('')
	}

	async function connectMcp() {
		const custom = await loadCustomServers()
		const previous = mcp
		mcp = await connectMcpServers({ servers: custom.servers, context })
		mcp.problems.push(...custom.problems)
		await previous?.close()
		reportMcpStatus()
	}

	function reportMcpStatus() {
		const toolCount = new Map<string, number>()
		for (const name of Object.keys(mcp?.tools ?? {})) {
			const server = name.split('__')[1] ?? ''
			toolCount.set(server, (toolCount.get(server) ?? 0) + 1)
		}
		emit({
			type: 'mcpStatus',
			servers: [...toolCount].map(([name, tools]) => ({ name, status: 'connected', error: null, source: 'bol', tools })),
			problems: mcp?.problems ?? [],
		})
	}

	function tools(): ToolSet {
		return { ...makeTools({ context, isScreenEnabled: settings.screen !== 'off' }), ...(mcp?.tools ?? {}) }
	}

	/** Works through queued requests one at a time; `idle` once there are none left. */
	async function drain() {
		if (isRunning) return
		isRunning = true
		try {
			while (queue.length > 0) {
				const next = queue.shift()!
				await runTurn({ text: next.text })
			}
		} finally {
			isRunning = false
			emit({ type: 'idle', seq: latestSeq })
		}
	}

	async function runTurn({ text }: { text: string }) {
		const llm = await ensureModel()
		if (llm == null) {
			emit({ type: 'result', text: missingKeyMessage({ provider }), isError: true })
			return
		}
		if (thread == null || (thread.messages.length > 0 && Date.now() - lastActivityAt > IDLE_CONVERSATION_MS)) {
			thread = newThread()
		}
		// A reset during this turn swaps `thread`; this turn's messages still belong to the one it started in.
		const current = thread
		lastActivityAt = Date.now()
		const userMessage: ModelMessage = { role: 'user', content: text }
		const controller = new AbortController()
		abort = controller
		try {
			const result = await generateText({
				model: llm,
				system: await systemPrompt(),
				messages: [...dropOldImages({ messages: current.messages }), userMessage],
				tools: tools(),
				stopWhen: stepCountIs(MAX_STEPS),
				abortSignal: controller.signal,
				reasoning: settings.effort,
				onStepFinish: (step) => {
					// What the model says between tool calls, for the voice bar (the original's `text` event).
					if (step.toolCalls.length > 0 && step.text.trim() !== '') emit({ type: 'text', text: step.text })
				},
			})
			current.messages.push(userMessage, ...(result.response.messages as ModelMessage[]))
			await saveThread({ target: current })
			const answer = result.text.trim()
			const isCut = result.steps.length >= MAX_STEPS && result.finishReason === 'tool-calls'
			emit({
				type: 'result',
				text: answer !== '' ? answer : isCut ? "I hit my step limit before finishing. Say continue and I'll pick it up." : 'Done.',
				isError: false,
			})
		} catch (error) {
			if (controller.signal.aborted) {
				// Keep the request so "continue" has something to continue from.
				current.messages.push(userMessage, { role: 'assistant', content: '(Stopped by the user.)' })
				await saveThread({ target: current })
				emit({ type: 'result', text: '', isError: true, isInterrupted: true })
				return
			}
			log({ msg: `api turn failed: ${error instanceof Error ? (error.stack ?? error.message) : error}` })
			emit({ type: 'result', text: describeError({ error, provider }), isError: true })
		} finally {
			abort = null
			lastActivityAt = Date.now()
		}
	}

	const engine: Engine = {
		name: provider,

		async start() {
			await Promise.all([API_THREADS_DIR, WORKSPACE_DIR, BACKUPS_DIR].map((dir) => mkdir(dir, { recursive: true })))
			thread = await resumeThread()
			log({ msg: `${provider} engine, model ${settings.model ?? DEFAULT_MODELS[provider]}, thread ${thread.id}` })
			if (languageModel == null && (await getApiKey({ provider })) == null) log({ msg: missingKeyMessage({ provider }) })
			await connectMcp()
			stopWatching = watchCustomServers({ onChange: () => void connectMcp() })
			emit({ type: 'ready', backend: engine.name })
		},

		async send(cmd: Command) {
			try {
				switch (cmd.type) {
					case 'say':
						latestSeq = cmd.seq ?? latestSeq
						queue.push({ text: cmd.text, seq: latestSeq })
						void drain()
						break
					case 'interrupt':
						queue.length = 0
						abort?.abort()
						break
					case 'reset':
						queue.length = 0
						abort?.abort()
						thread = newThread()
						await writeFile(API_SESSION_FILE, '').catch(() => {})
						log({ msg: 'conversation reset' })
						break
					case 'continue': {
						const saved = await loadThread({ id: cmd.sessionId })
						if (saved == null) log({ msg: `no api thread ${cmd.sessionId}` })
						else {
							thread = saved
							await writeFile(API_SESSION_FILE, saved.id).catch(() => {})
						}
						break
					}
					case 'forgetThread':
						await rm(threadFile(cmd.sessionId), { force: true })
						if (thread?.id === cmd.sessionId) thread = newThread()
						break
					case 'mcpStatus':
						reportMcpStatus()
						break
					case 'mcpSignIn':
						emit({
							type: 'mcpSignIn',
							name: cmd.name,
							url: null,
							error: "Signing in to MCP servers only works with the Claude Code backend so far. Add the server's token to mcp.json instead.",
						})
						break
					case 'messageTask':
					case 'stopTask':
						log({ msg: `${cmd.type}: the ${provider} engine has no tasks` })
						break
					default:
						exhaustiveGuard(cmd)
				}
			} catch (e) {
				log({ msg: `${cmd.type} failed: ${e instanceof Error ? (e.stack ?? e.message) : e}` })
			}
		},

		async updateSettings(next: Settings) {
			const isModelChanged = next.model !== settings.model
			settings = next
			if (isModelChanged) model = null
		},

		close() {
			abort?.abort()
			stopWatching?.()
			void mcp?.close()
		},
	}
	return engine
}
