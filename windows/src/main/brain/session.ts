// Claude Agent SDK sessions: the thread, one long-lived conversation with the user (resumed across
// restarts, left behind after a day idle), plus tasks: named sessions the thread starts for real work
// (see tasks.ts), each running on its own and messageable later.
// Ported from the macOS brain: only the runtime (settings instead of env vars, Node instead of Bun) and
// the safety hooks changed.

import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { BrainEvent } from '../../shared/events'
import type { Settings } from '../../shared/settings'
import {
	BOL_PROMPT,
	IDLE_CONVERSATION_MS,
	MEMORY_DIR,
	PROMPT_FILE,
	SAFETY_PROMPT,
	SESSION_FILE,
	THREADS_FILE,
	WORKSPACE_DIR,
} from './constants'
import { makeSafetyHooks } from './safety'
import { answerElicitation, signIn } from './mcp-sign-in'
import {
	loadTaskRecords,
	makeThreadTools,
	recordTask,
	taskPrompt,
	THREAD_TASK_PROMPT,
	type TaskStatus,
	type ThreadHandlers,
} from './tasks'
import { lastActivity, makeThreadArchive } from './thread-archive'

import { loadCustomServers, type CustomServers } from './mcp-config'
import { emit, log } from './protocol'
import { makeBolTools } from './screen'
import { exhaustiveGuard, sleep } from './utils'

/** What the shell gives the brain: the user's settings and the Claude Code to drive. */
type Runtime = { settings: Settings; claudeBinary: string }
let runtime: Runtime | null = null

/** Called before anything else, and again whenever settings change (new conversations pick them up). */
export function configureSession(next: Runtime) {
	runtime = next
}

function getRuntime(): Runtime {
	if (runtime == null) throw new Error('configureSession() was not called')
	return runtime
}

class InputQueue implements AsyncIterable<SDKUserMessage> {
	private items: SDKUserMessage[] = []
	private waiter: ((r: IteratorResult<SDKUserMessage>) => void) | null = null
	private isClosed = false
	push({ text }: { text: string }) {
		const msg: SDKUserMessage = {
			type: 'user',
			message: { role: 'user', content: text },
			parent_tool_use_id: null,
		}
		if (this.waiter != null) {
			const w = this.waiter
			this.waiter = null
			w({ value: msg, done: false })
		} else this.items.push(msg)
	}
	close() {
		this.isClosed = true
		if (this.waiter != null) {
			const w = this.waiter
			this.waiter = null
			w({ value: undefined as any, done: true })
		}
	}
	[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
		return {
			next: () => {
				const item = this.items.shift()
				if (item != null) return Promise.resolve({ value: item, done: false })
				if (this.isClosed) return Promise.resolve({ value: undefined as any, done: true })
				return new Promise((resolve) => (this.waiter = resolve))
			},
		}
	}
}

/**
 * How a conversation starts: fresh, resuming the saved thread (unless it's been idle a day), continuing a
 * thread picked in the Threads window, or reopening a finished task's session to message it.
 */
type Origin =
	| { kind: 'fresh' }
	| { kind: 'resume' }
	| { kind: 'continue'; sessionId: string }
	| { kind: 'reopen'; sessionId: string }

/** Tools that hand the request to a task: the thread's reply after them is just "on it". */
const TASK_HANDOFF_TOOLS = ['mcp__bol__start_task', 'mcp__bol__message_task']

/** Mirrors every transcript to ~/.bol/threads and resumes from there. */
const archive = makeThreadArchive()

/** One SDK query: the thread (`job` null), or a task (`job` is its task id). */
class Conversation {
	input = new InputQueue()
	/** What was last sent, so it can be replayed if the saved session turns out to be gone. */
	private lastInput: string | null = null
	readonly job: string | null
	/** Set for a task: its name. */
	readonly taskName: string | null
	sessionId: string | null = null
	/** When the conversation last did anything (epoch ms), for the one-day idle rule. */
	lastActivityAt = Date.now()
	/** The request being worked on, or null when idle. */
	request: string | null = null
	private query: Query | null = null
	private isClosed = false
	/** Bol's own tools, kept so the server set can be replaced live without recreating them. */
	private readonly bolTools: ReturnType<typeof makeBolTools>
	/** Requests sent but not yet answered: a task stays open while more are queued. */
	private unanswered = 0
	/** This turn handed work to a task, so its reply is only an acknowledgement. */
	private hasDelegated = false
	/** What the model has said since its last tool call this turn; together they are the answer. */
	private answerParts: string[] = []
	/** The latest request's sequence number, echoed in `idle` so the app can tell a stale one. */
	private seq = 0
	/** Whether this Claude Code reports session state; older ones don't, and a result then means idle. */
	private hasStateEvents = false
	/** An interrupt was sent: the failed result that follows belongs to the stopped turn. */
	private isInterrupting = false
	/** Claude Code's own background tasks (long shell commands it moved aside) still running. */
	private liveTaskCount = 0
	/** A job's interim reply while its tasks still run ("still searching…"), delivered if nothing newer comes. */
	private heldResult: { text: string; isError: boolean } | null = null
	private heldTimer: ReturnType<typeof setTimeout> | null = null
	/** This turn's API call was rejected for auth (e.g. another Claude Code rotated the shared login). */
	private isAuthFailed = false
	/** Already restarted once for an auth failure; a second one is a real sign-out. */
	private hasRetriedAuth = false
	/** Tokens the next request re-sends (the last main-loop call's prompt + output). */
	private contextTokens = 0
	/** Fires just before the thread's prompt cache expires, to compact while it's still cheap. */
	private idleCompactTimer: ReturnType<typeof setTimeout> | null = null

	/** A `/compact` Bol sent itself is running: its result isn't an answer to anyone. */
	private isIdleCompacting = false

	constructor({ job, taskName }: { job: string | null; taskName: string | null }) {
		this.job = job
		this.taskName = taskName
		this.bolTools = makeBolTools({
			onScreen: ({ reason }) => this.emit({ type: 'screen', reason }),
			isScreenEnabled: getRuntime().settings.screen !== 'off',
			// Only the thread starts tasks; a task does its own work.
			extraTools: taskName == null ? makeThreadTools({ handlers: threadHandlers }) : [],
		})
	}

	/** `context` is sent ahead of the request (notes about background work) but isn't part of it. */
	say({ text, context, seq }: { text: string; context: string[]; seq: number }) {
		this.cancelIdleCompact()
		this.request = text
		this.seq = seq
		this.unanswered += 1
		this.lastInput = [...context, text].join('\n\n')
		this.input.push({ text: this.lastInput })
	}

	async interrupt() {
		if (this.request == null) return
		this.isInterrupting = true
		await this.query?.interrupt()
	}

	/** More requests are waiting for an answer. */
	get hasQueued(): boolean {
		return this.unanswered > 0
	}

	close() {
		this.isClosed = true
		if (this.heldTimer != null) clearTimeout(this.heldTimer)
		this.cancelIdleCompact()
		try {
			this.input.close()
			this.query?.close()
		} catch {}
	}

	/** Runs until closed. Every event carries the conversation's job at the moment it's sent. */
	async run({ origin }: { origin: Origin }) {
		const [resume, prompt, custom] = await Promise.all([resumeId({ origin }), currentPrompt(), loadCustomServers()])
		const append =
			prompt + SAFETY_PROMPT + (this.taskName == null ? THREAD_TASK_PROMPT : taskPrompt({ name: this.taskName }))
		if (origin.kind === 'resume' && resume != null) {
			this.lastActivityAt = (await lastActivity({ sessionId: resume }))?.getTime() ?? Date.now()
		}
		if (this.isClosed) return
		const { settings, claudeBinary } = getRuntime()
		const cwd = settings.workspace ?? WORKSPACE_DIR
		const q = query({
			prompt: this.input,
			options: {
				cwd,
				sessionStore: archive,
				model: settings.model ?? undefined,
				effort: settings.effort,
				// Every tool call runs without asking: Bol never stops to confirm an action. The safety hooks
				// below still refuse the hard-block list, keep copies before overwrites and log every call.
				permissionMode: 'bypassPermissions',
				allowDangerouslySkipPermissions: true,
				pathToClaudeCodeExecutable: claudeBinary,
				// An npm-installed Claude Code is a .js entry point, run with the user's Node.
				...(claudeBinary.endsWith('.js') ? { executable: 'node' as const } : {}),
				systemPrompt: { type: 'preset', preset: 'claude_code', append },
				resume,
				hooks: makeSafetyHooks({
					job: this.job,
					cwd,
					isAskFirst: () => getRuntime().settings.askFirst,
					summarize: summarizeTool,
				}),
				// The user's Claude Code skills, by name or when a request fits one.
				skills: 'all',
				onElicitation: answerElicitation,
				...(this.taskName != null && origin.kind === 'fresh' ? { title: this.taskName } : {}),
				// Claude Code's own memory system, pointed at a single global directory:
				// MEMORY.md index is loaded each session; individual memories are read on demand.
				settings: { autoMemoryEnabled: true, autoMemoryDirectory: MEMORY_DIR },
				extraArgs: settings.chrome ? { chrome: null } : {},
				mcpServers: this.mcpServers({ custom }),
				// No product telemetry / error reporting (Datadog etc.) from Bol's Claude process.
				env: {
					...process.env,
					CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
					// Report when the session is really idle, not just between queued turns.
					CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
					DISABLE_TELEMETRY: '1',
					DISABLE_ERROR_REPORTING: '1',
				},
			},
		})
		this.query = q
		// Control requests are answered before the first turn, so Settings lists skills right away.
		if (this.job == null) void this.reportSkills()

		try {
			for await (const m of q) {
				if (this.isClosed) break
				this.lastActivityAt = Date.now()
				switch (m.type) {
					case 'system':
						if (m.subtype === 'background_tasks_changed') {
							this.liveTaskCount = m.tasks.length
							if (this.liveTaskCount === 0) this.releaseHeldResult()
							break
						}
						if (m.subtype === 'compact_boundary') {
							const { trigger, pre_tokens, post_tokens } = m.compact_metadata
							log({
								msg: `compacted (${this.isIdleCompacting ? 'idle' : trigger}): ${pre_tokens} -> ${post_tokens ?? '?'} tokens`,
							})
							if (post_tokens != null) this.contextTokens = post_tokens
							break
						}
						if (m.subtype === 'session_state_changed') {
							// The authoritative "nothing left to do", unlike a result, which queued requests follow.
							this.hasStateEvents = true
							if (m.state === 'idle' && this.job == null) emit({ type: 'idle', seq: this.seq })
							break
						}
						if (m.subtype === 'init') {
							// Claude Code re-sends init after a compaction: same session, nothing new to record.
							if (this.sessionId === m.session_id) break
							this.sessionId = m.session_id
							if (this.job == null) {
								await writeFile(SESSION_FILE, m.session_id)
								await recordThread({ sessionId: m.session_id })
							} else {
								await taskSessionStarted({ taskId: this.job, sessionId: m.session_id })
							}
							log({
								msg: `session ${m.session_id} model=${m.model} effort=${settings.effort}${this.job == null ? '' : ` job=${this.job}`}`,
							})
							log({
								msg: `mcp servers: ${m.mcp_servers.map((s) => `${s.name}=${s.status}`).join(', ')}`,
							})
							if (this.job == null) void this.reportMcpStatus({ problems: custom.problems })
							const chromeTools = m.tools.filter((t) => t.includes('chrome'))
							log({
								msg: `tools: ${m.tools.length} total, chrome: ${chromeTools.length}`,
							})
						}
						break
					case 'assistant':
						if (m.parent_tool_use_id != null) break // ignore subagent chatter
						if (this.isIdleCompacting) break
						{
							const u = m.message.usage
							if (u != null)
								this.contextTokens =
									(u.input_tokens ?? 0) +
									(u.cache_read_input_tokens ?? 0) +
									(u.cache_creation_input_tokens ?? 0) +
									(u.output_tokens ?? 0)
						}
						if (m.error === 'authentication_failed') {
							// Claude Code's synthetic "Failed to authenticate" message: not something to say.
							this.isAuthFailed = true
							break
						}
						for (const block of m.message.content as any[]) {
							if (block.type === 'tool_use' && TASK_HANDOFF_TOOLS.includes(block.name))
								this.hasDelegated = true
							if (block.type === 'tool_use')
								this.answerParts = [] // what came before was narration
							else if (
								block.type === 'text' &&
								typeof block.text === 'string' &&
								block.text.trim() !== ''
							)
								this.answerParts.push(block.text.trim())
							if (block.type === 'tool_use')
								this.emit({
									type: 'tool',
									name: block.name,
									summary: summarizeTool({
										name: block.name,
										input: block.input,
									}),
								})
							else if (
								block.type === 'text' &&
								typeof block.text === 'string' &&
								block.text.trim() !== ''
							)
								this.emit({ type: 'text', text: block.text })
						}
						break
					case 'result': {
						const isSuccess = m.subtype === 'success'
						if (!isSuccess)
							log({
								msg: `result ${m.subtype}${this.job == null ? '' : ` job=${this.job}`}`,
							})
						if (this.isIdleCompacting) {
							this.isIdleCompacting = false
							this.answerParts = []
							if (!isSuccess || m.is_error) log({ msg: `idle compaction failed: ${m.subtype}` })
							break
						}
						if (this.isInterrupting) {
							this.isInterrupting = false
							if (!isSuccess) {
								this.answerParts = []
								// The stopped turn's leftover: never an answer to whatever was asked next.
								this.emit({
									type: 'result',
									text: '',
									isError: true,
									isInterrupted: true,
								})
								break
							}
						}
						// The SDK's result is only the last thing said. When the model answers and then adds to
						// or corrects itself in a second message, the whole answer is both.
						const parts = this.answerParts
						this.answerParts = []
						let text: string
						if (m.subtype === 'success') {
							const isWholeAnswer = parts.length > 1 && parts[parts.length - 1] === m.result.trim()
							text = isWholeAnswer ? parts.join(' ') : m.result
						} else text = m.errors.length > 0 ? m.errors.join('; ') : `Error: ${m.subtype}`
						const isAuthFailed = this.isAuthFailed || ((!isSuccess || m.is_error) && isAuthError({ text }))
						this.isAuthFailed = false
						if (isAuthFailed && !this.hasRetriedAuth && this.sessionId != null && !this.isClosed) {
							// This Claude process still holds a token that's since been replaced in the keychain.
							// A new process reads the current login; the conversation is resumed, not lost.
							log({
								msg: `auth failed${this.job == null ? '' : ` (job ${this.job})`}: ${text}; restarting Claude Code`,
							})
							this.hasRetriedAuth = true
							await this.restartResumed({ sessionId: this.sessionId })
							return
						}
						if (isAuthFailed) {
							log({ msg: `auth failed again${this.job == null ? '' : ` (job ${this.job})`}: ${text}` })
							this.hasRetriedAuth = false
							this.finished({
								text: "I'm signed out of Claude. Run claude, then /login, in a terminal and ask me again.",
								isError: true,
							})
							break
						}
						if (isSuccess && !m.is_error) this.hasRetriedAuth = false
						if (
							!isSuccess &&
							this.sessionId == null &&
							origin.kind !== 'fresh' &&
							isMissingSession({ text })
						) {
							// Claude Code deleted the transcript (cleanupPeriodDays): start over instead of failing forever.
							log({
								msg: `session ${resume} is gone${this.job == null ? '' : ` (job ${this.job})`}, starting fresh`,
							})
							await this.restartFresh()
							return
						}
						this.finished({ text, isError: !isSuccess || m.is_error })
						break
					}
					case 'user':
					case 'stream_event':
					case 'tool_progress':
					case 'tool_use_summary':
					case 'auth_status':
					case 'rate_limit_event':
					case 'prompt_suggestion':
					case 'conversation_reset':
						break
					default:
						// A newer Claude Code than this SDK knows can send message types it doesn't list
						// (e.g. active_goal). Ignore them rather than ending the conversation.
						log({ msg: `ignored message type ${(m as { type?: string }).type ?? '?'}` })
				}
			}
		} catch (e: any) {
			if (
				!this.isClosed &&
				this.sessionId == null &&
				origin.kind !== 'fresh' &&
				isMissingSession({ text: String(e?.message ?? e) })
			) {
				log({
					msg: `session ${resume} is gone${this.job == null ? '' : ` (job ${this.job})`}, starting fresh`,
				})
				await this.restartFresh()
				return
			}
			if (!this.isClosed) {
				log({
					msg: `session error${this.job == null ? '' : ` (job ${this.job})`}: ${e?.stack ?? e}`,
				})
				this.finished({
					text: 'Sorry, my connection to Claude failed.',
					isError: true,
				})
				if (this.job == null && this.hasStateEvents) emit({ type: 'idle', seq: this.seq }) // the session is gone
				if (this.job == null && foreground === this) foreground = null
			}
		}
	}

	/** Replays the pending request on a brand-new session, dropping the dead saved id. */
	private async restartFresh() {
		const pending = this.lastInput
		try {
			this.query?.close()
		} catch {}
		this.query = null
		this.input = new InputQueue()
		if (pending != null) this.input.push({ text: pending })
		if (this.job == null) await writeFile(SESSION_FILE, '').catch(() => {})
		await this.run({ origin: { kind: 'fresh' } })
	}

	/**
	 * The thread's prompt cache (1 hour on a subscription) is about to lapse with a long context in it:
	 * compact now, while re-reading it is a cache hit, so the next request doesn't re-send it all
	 * uncached. Claude Code's own idle compaction only runs in attended sessions (not the SDK) and
	 * only past 200k tokens.
	 */
	private armIdleCompact() {
		this.cancelIdleCompact()
		if (this.contextTokens < IDLE_COMPACT_MIN_TOKENS) return
		this.idleCompactTimer = setTimeout(() => {
			this.idleCompactTimer = null
			if (this.isClosed || this.request != null || this.unanswered > 0 || this.liveTaskCount > 0) return
			log({
				msg: `idle ${Math.round(IDLE_COMPACT_AFTER_MS / 60_000)}m with ${this.contextTokens} tokens, compacting before the cache expires`,
			})
			this.isIdleCompacting = true
			this.input.push({ text: '/compact' })
		}, IDLE_COMPACT_AFTER_MS)
	}

	private cancelIdleCompact() {
		if (this.idleCompactTimer != null) clearTimeout(this.idleCompactTimer)
		this.idleCompactTimer = null
	}

	/** Replays the pending request in a new Claude Code process that resumes this same session. */
	private async restartResumed({ sessionId }: { sessionId: string }) {
		const pending = this.lastInput
		try {
			this.query?.close()
		} catch {}
		this.query = null
		this.input = new InputQueue()
		if (pending != null) this.input.push({ text: pending })
		await this.run({ origin: this.job == null ? { kind: 'continue', sessionId } : { kind: 'reopen', sessionId } })
	}

	/** The user's servers plus Bol's own, which always keeps its name. */
	private mcpServers({ custom }: { custom: CustomServers }) {
		// An SDK MCP server connects to one query at a time, so each conversation has its own.
		return { ...custom.servers, bol: this.bolTools }
	}

	/** mcp.json changed: swap the servers in the running session, no restart. */
	async applyMcpServers({ custom }: { custom: CustomServers }) {
		if (this.query == null || this.isClosed) return
		try {
			const result = await this.query.setMcpServers(this.mcpServers({ custom }))
			log({
				msg: `mcp servers updated${this.job == null ? '' : ` job=${this.job}`}: +[${result.added.join(', ')}] -[${result.removed.join(', ')}]`,
			})
		} catch (e) {
			log({ msg: `mcp servers update failed: ${e}` })
		}
		if (this.job == null) void this.reportMcpStatus({ problems: custom.problems })
	}

	/**
	 * Tells the app how every MCP server is doing (Bol's own, the user's, Claude Code's), for
	 * Settings. Servers connect in the background, so it reports again until none is pending.
	 */
	async reportMcpStatus({ problems }: { problems: CustomServers['problems'] }) {
		for (const delayMs of [0, 1500, 4000, 10000]) {
			if (delayMs > 0) await sleep(delayMs)
			if (this.query == null || this.isClosed) return
			const statuses = await this.query.mcpServerStatus().catch(() => null)
			if (statuses == null) return
			emit({
				type: 'mcpStatus',
				servers: statuses
					.filter((s) => s.name !== 'bol')
					.map((s) => ({
						name: s.name,
						status: s.status,
						error: s.error ?? null,
						source: s.source ?? s.scope ?? null,
						tools: s.tools?.length ?? null,
					})),
				problems,
			})
			if (!statuses.some((s) => s.status === 'pending')) return
		}
	}

	/** Tells the app which skills Bol can use (the user's, plugins' and projects', not Claude Code's own commands). */
	async reportSkills() {
		const commands = await this.query?.supportedCommands().catch(() => null)
		if (commands == null) return
		emit({
			type: 'skills',
			skills: commands
				.filter((c) => c.builtin !== true)
				.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint })),
		})
	}

	/** Starts an MCP server's sign-in from this session (the tokens are Claude Code's, shared by every session). */
	async signIn({ server }: { server: string }): Promise<string> {
		if (this.query == null) return 'Bol is still starting; try again in a moment.'
		return signIn({ query: this.query, server })
	}

	emit(event: BrainEvent) {
		emit((this.job == null ? event : { ...event, job: this.job }) as BrainEvent)
	}

	/** Claude Code's tasks ended: if no newer answer follows within a minute, the held one is final. */
	private releaseHeldResult() {
		if (this.heldResult == null || this.heldTimer != null) return
		this.heldTimer = setTimeout(() => {
			this.heldTimer = null
			const held = this.heldResult
			this.heldResult = null
			if (held != null && !this.isClosed) this.finished(held)
		}, 60_000)
	}

	private finished({ text, isError }: { text: string; isError: boolean }) {
		if (this.job != null && this.liveTaskCount > 0 && !isError) {
			// Claude Code is still running a command it moved aside; its real answer comes later.
			this.heldResult = { text, isError }
			log({
				msg: `job ${this.job}: interim reply while ${this.liveTaskCount} task(s) run: ${text.slice(0, 120)}`,
			})
			return
		}
		this.heldResult = null
		if (this.heldTimer != null) clearTimeout(this.heldTimer)
		this.heldTimer = null
		const request = this.request
		this.request = null
		this.unanswered = Math.max(0, this.unanswered - 1)
		const isDelegated = this.hasDelegated
		this.hasDelegated = false
		this.emit({ type: 'result', text, isError, ...(isDelegated ? { isDelegated: true } : {}) })
		if (this.job == null) {
			this.armIdleCompact()

			if (!this.hasStateEvents) emit({ type: 'idle', seq: this.seq })
			return
		}
		taskFinished({ conversation: this, text, isError, request })
	}
}

/** The thread; null until first needed or after a failure. */
let foreground: Conversation | null = null
/** Context for the thread (task results, mostly), sent along with its next request. */
const notes: string[] = []

/** A task Bol started: live while its session runs, kept (by name) so it can be messaged later. */
type Task = {
	id: string
	name: string
	/** The thread that started it. */
	threadId: string | null
	sessionId: string | null
	conversation: Conversation | null
	status: TaskStatus
	/** Its latest result, for list_tasks. */
	result: string
}
const tasks = new Map<string, Task>()

/** Earlier tasks, from ~/.bol/tasks.jsonl, so they can be messaged after a restart. */
export async function loadTasks() {
	for (const record of await loadTaskRecords()) {
		if (tasks.has(record.taskId)) continue
		tasks.set(record.taskId, {
			id: record.taskId,
			name: record.name,
			threadId: record.threadId,
			sessionId: record.sessionId,
			conversation: null,
			status: 'done',
			result: '',
		})
	}
}

/** The thread's task with this name (case and spacing aside); failing that, the latest anywhere. */
function findTask({ name }: { name: string }): Task | null {
	const key = name.trim().toLowerCase()
	const matching = [...tasks.values()].filter((task) => task.name.toLowerCase() === key)
	const threadId = foreground?.sessionId ?? null
	return matching.findLast((task) => task.threadId === threadId) ?? matching.at(-1) ?? null
}

function taskEvent({ task }: { task: Task }) {
	emit({ type: 'task', job: task.id, name: task.name, status: task.status, sessionId: task.sessionId })
}

async function taskSessionStarted({ taskId, sessionId }: { taskId: string; sessionId: string }) {
	const task = tasks.get(taskId)
	if (task == null) return
	if (task.sessionId === sessionId) return
	task.sessionId = sessionId
	taskEvent({ task })
	await recordTask({ taskId, name: task.name, sessionId, threadId: task.threadId, at: new Date().toISOString() })
}

function taskFinished({
	conversation,
	text,
	isError,
	request,
}: {
	conversation: Conversation
	text: string
	isError: boolean
	request: string | null
}) {
	const task = conversation.job == null ? undefined : tasks.get(conversation.job)
	if (task == null || task.conversation !== conversation) {
		conversation.close()
		return
	}
	task.result = text
	// A follow-up came in while it was answering: it carries on with that.
	if (!conversation.hasQueued) {
		conversation.close() // reopened if it's messaged again
		task.conversation = null
		task.status = isError ? 'failed' : 'done'
		taskEvent({ task })
	}
	notes.push(
		`[Task "${task.name}" ${isError ? 'failed' : 'finished'}; the user was already told, so don't repeat it unless asked. Last request: "${request ?? ''}". Result: ${text}]`,
	)
}

/** Sends `text` to a task: into its running session, or by reopening its finished one. */
function sendToTask({ task, text }: { task: Task; text: string }) {
	if (task.conversation == null) {
		const conversation = new Conversation({ job: task.id, taskName: task.name })
		task.conversation = conversation
		void conversation.run({
			origin: task.sessionId == null ? { kind: 'fresh' } : { kind: 'reopen', sessionId: task.sessionId },
		})
	}
	task.status = 'running'
	task.conversation.say({ text, context: [], seq: 0 })
	taskEvent({ task })
}

const threadHandlers: ThreadHandlers = {
	async start({ name, brief }) {
		const existing = findTask({ name })
		if (existing != null && existing.threadId === (foreground?.sessionId ?? null)) {
			return `There's already a task named "${existing.name}" (${existing.status}). Use message_task to change it, or pick another name.`
		}
		const task: Task = {
			id: 't' + crypto.randomUUID().slice(0, 8),
			name: name.trim(),
			threadId: foreground?.sessionId ?? null,
			sessionId: null,
			conversation: null,
			status: 'running',
			result: '',
		}
		tasks.set(task.id, task)
		sendToTask({ task, text: brief })
		log({ msg: `task ${task.id} "${task.name}" started: ${brief.slice(0, 160)}` })
		return `Started task "${task.name}". Its result will reach the user when it's done; reply in one short sentence.`
	},
	async message({ name, text }) {
		const task = findTask({ name })
		if (task == null) return `No task named "${name}". ${await threadHandlers.list()}`
		sendToTask({ task, text })
		log({ msg: `task ${task.id} "${task.name}" messaged: ${text.slice(0, 160)}` })
		return `Sent to "${task.name}"${task.sessionId == null ? '' : ', which is working on it again'}.`
	},
	async list() {
		const threadId = foreground?.sessionId ?? null
		const own = [...tasks.values()].filter((task) => task.threadId === threadId)
		if (own.length === 0) return 'No tasks in this conversation yet.'
		return own
			.map(
				(task) => `- ${task.name}: ${task.status}${task.result === '' ? '' : `. ${task.result.slice(0, 200)}`}`,
			)
			.join('\n')
	},
	async stop({ name }) {
		const task = findTask({ name })
		if (task == null) return `No task named "${name}".`
		stopTask({ job: task.id })
		return `Stopped "${task.name}".`
	},
	async signIn({ server }) {
		ensureSession()
		return foreground!.signIn({ server })
	},
}

/** Settings → Sign In on a server that needs it. */
export async function signInToServer({ name }: { name: string }) {
	ensureSession()
	await foreground!.signIn({ server: name })
}

/** Messages a task from the Threads window. */
export function messageTask({ job, text }: { job: string; text: string }) {
	const task = tasks.get(job)
	if (task == null) {
		log({ msg: `message for unknown task ${job}` })
		return
	}
	sendToTask({ task, text })
	notes.push(`[The user sent task "${task.name}" a message from the Threads window: "${text}"]`)
	log({ msg: `task ${task.id} "${task.name}" messaged from Threads: ${text.slice(0, 160)}` })
}

/**
 * The user deleted a thread in the Bol window (the app deletes the files): let go of it and of its
 * tasks, and start a new conversation if it was the current one.
 */
export async function forgetThread({ sessionId }: { sessionId: string }) {
	for (const task of [...tasks.values()]) {
		if (task.threadId !== sessionId) continue
		task.conversation?.close()
		tasks.delete(task.id)
	}
	const saved = (await readFile(SESSION_FILE, 'utf8').catch(() => '')).trim()
	if (foreground?.sessionId === sessionId || (foreground?.sessionId == null && saved === sessionId)) {
		resetSession()
	}
	log({ msg: `thread ${sessionId} deleted` })
}

export function stopTask({ job }: { job: string }) {
	const task = tasks.get(job)
	if (task == null || task.conversation == null) return
	task.conversation.close()
	task.conversation = null
	task.status = 'stopped'
	taskEvent({ task })
	log({ msg: `task ${job} "${task.name}" stopped` })
}

async function resumeId({ origin }: { origin: Origin }): Promise<string | undefined> {
	switch (origin.kind) {
		case 'fresh':
			return undefined
		case 'resume': {
			const id = (await readFile(SESSION_FILE, 'utf8').catch(() => '')).trim()
			if (id === '') return undefined
			const last = await lastActivity({ sessionId: id })
			if (last != null && Date.now() - last.getTime() > IDLE_CONVERSATION_MS) {
				log({ msg: `session ${id} idle since ${last.toISOString()}, starting a new conversation` })
				await writeFile(SESSION_FILE, '').catch(() => {})
				return undefined
			}
			return id
		}
		case 'continue':
			await writeFile(SESSION_FILE, origin.sessionId).catch(() => {})
			return origin.sessionId
		case 'reopen':
			return origin.sessionId
		default:
			return exhaustiveGuard(origin)
	}
}

/** Appends to the threads index, which the app's Threads window lists. */
async function recordThread({ sessionId }: { sessionId: string }) {
	const line = JSON.stringify({ sessionId, job: null, forkedFrom: null, at: new Date().toISOString() })
	await appendFile(THREADS_FILE, line + '\n').catch((e) => log({ msg: `threads index: ${e}` }))
}

/** Compact the idle thread at 90% of the 1-hour prompt cache TTL, as Claude Code does. */
const IDLE_COMPACT_AFTER_MS = 54 * 60_000
/** Below this the thread is mostly system prompt and tools; compacting saves little. */
const IDLE_COMPACT_MIN_TOKENS = 80_000

function isAuthError({ text }: { text: string }): boolean {
	return /Failed to authenticate|OAuth token (revoked|has expired)|authentication_error/i.test(text)
}

function isMissingSession({ text }: { text: string }): boolean {
	return text.includes('No conversation found with session ID')
}

async function currentPrompt(): Promise<string> {
	const custom = (await readFile(PROMPT_FILE, 'utf8').catch(() => '')).trim()
	return custom === '' ? BOL_PROMPT : '\n' + custom + '\n'
}

export function summarizeTool({ name, input: inp }: { name: string; input: any }): string {
	if (name === 'Bash')
		return typeof inp?.description === 'string' && inp.description !== ''
			? inp.description
			: String(inp?.command ?? '').slice(0, 80)
	if (name === 'Read' || name === 'Write' || name === 'Edit')
		return String(inp?.file_path ?? '').replace(homedir(), '~')
	if (name === 'WebSearch') return String(inp?.query ?? '')
	if (name === 'WebFetch') return String(inp?.url ?? '')
	if (name === 'Glob' || name === 'Grep') return String(inp?.pattern ?? '')
	if (name === 'mcp__bol__key' || name === 'mcp__bol__hold_key') return String(inp?.text ?? '')
	if (name === 'mcp__bol__open_application') return String(inp?.app ?? '')
	if (name === 'mcp__bol__move_to_recycle_bin') return (inp?.paths ?? []).join(', ').replace(homedir(), '~')
	return ''
}

function startForeground({ origin }: { origin: Origin }): Conversation {
	const conversation = new Conversation({ job: null, taskName: null })
	foreground = conversation
	void conversation.run({ origin })
	return conversation
}

function liveConversations(): Conversation[] {
	return [foreground, ...[...tasks.values()].map((task) => task.conversation)].filter(
		(c): c is Conversation => c != null,
	)
}

/** mcp.json changed: every live conversation picks up the new servers. */
export async function reloadCustomServers() {
	const custom = await loadCustomServers()
	log({
		msg: `mcp.json: ${Object.keys(custom.servers).length} server(s)${custom.problems.length > 0 ? `, ${custom.problems.length} problem(s)` : ''}`,
	})
	await Promise.all(liveConversations().map((c) => c.applyMcpServers({ custom })))
}

/** Settings asked how the MCP servers are doing. */
export async function requestMcpStatus() {
	ensureSession()
	const custom = await loadCustomServers()
	void foreground?.reportSkills()
	await foreground?.reportMcpStatus({ problems: custom.problems })
}

export function ensureSession() {
	if (foreground == null) startForeground({ origin: { kind: 'resume' } })
}

/** The one-day rule: a thread idle that long is left behind, and the next request starts a new one. */
function leaveIdleConversation() {
	if (foreground == null || foreground.request != null) return
	const idleMs = Date.now() - foreground.lastActivityAt
	if (foreground.sessionId == null || idleMs <= IDLE_CONVERSATION_MS) return
	log({
		msg: `session ${foreground.sessionId} idle for ${Math.round(idleMs / 3_600_000)}h, starting a new conversation`,
	})
	resetSession()
}

export function say({ text, seq }: { text: string; seq: number }) {
	leaveIdleConversation()
	ensureSession()
	foreground!.say({ text, context: notes.splice(0), seq })
}

/** Makes a thread picked in the Threads window the conversation again, however old it is. */
export function continueSession({ sessionId }: { sessionId: string }) {
	if (foreground?.sessionId === sessionId) return
	foreground?.close()
	notes.splice(0)
	startForeground({ origin: { kind: 'continue', sessionId } })
	log({ msg: `continuing session ${sessionId}` })
}

export async function interruptSession() {
	if (foreground == null) return
	await foreground.interrupt()
	if (foreground != null) foreground.request = null
}

export function closeSession() {
	for (const conversation of liveConversations()) conversation.close()
	foreground = null
}

/** A new thread. Running tasks carry on; they belong to the thread that started them. */
export function resetSession() {
	foreground?.close()
	notes.splice(0)
	void writeFile(SESSION_FILE, '').catch(() => {})
	startForeground({ origin: { kind: 'fresh' } })
}
