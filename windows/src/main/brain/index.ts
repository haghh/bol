// The Claude Code engine: Bol's original brain, driving the user's installed Claude Code through the
// Claude Agent SDK. On macOS this was a separate Bun executable spoken to over stdio; here it runs in the
// Electron main process (or scripts/brain-cli.ts) behind the Engine interface.

import { mkdir, writeFile } from 'node:fs/promises'
import type { Command } from '../../shared/events'
import type { Settings } from '../../shared/settings'
import type { Engine, EngineFactory } from '../engine'
import { BACKUPS_DIR, BOL_PROMPT, DEFAULT_PROMPT_FILE, findClaudeBinary, MEMORY_DIR, THREADS_DIR, WORKSPACE_DIR } from './constants'
import { watchCustomServers } from './mcp-config'
import { emit, log } from './protocol'
import {
	closeSession,
	configureSession,
	continueSession,
	ensureSession,
	forgetThread,
	interruptSession,
	loadTasks,
	messageTask,
	reloadCustomServers,
	requestMcpStatus,
	resetSession,
	say,
	signInToServer,
	stopTask,
} from './session'
import { exhaustiveGuard } from './utils'

export const createClaudeCodeEngine: EngineFactory = ({ settings: initial }) => {
	let settings: Settings = initial
	let claudeBinary: string | null = null
	let stopWatching: (() => void) | null = null
	/** Commands that arrive while starting wait for it. */
	let markStarted: (isOk: boolean) => void = () => {}
	const started = new Promise<boolean>((resolve) => (markStarted = resolve))

	async function startEngine() {
		await Promise.all(
			[MEMORY_DIR, THREADS_DIR, WORKSPACE_DIR, BACKUPS_DIR].map((dir) => mkdir(dir, { recursive: true })),
		)
		await writeFile(DEFAULT_PROMPT_FILE, BOL_PROMPT.trim() + '\n').catch(() => {})
		claudeBinary = await findClaudeBinary({ settings })
		configureSession({ settings, claudeBinary })
		log({ msg: `claude code: ${claudeBinary}` })
		await loadTasks()
		ensureSession()
		stopWatching = watchCustomServers({ onChange: () => void reloadCustomServers() })
	}

	const engine: Engine = {
		name: 'claude-code',

		async start() {
			try {
				await startEngine()
				markStarted(true)
			} catch (e) {
				markStarted(false)
				throw e
			}
			emit({ type: 'ready', backend: engine.name })
		},

		async send(cmd: Command) {
			if (!(await started)) {
				emit({ type: 'result', text: "Bol couldn't start. Check the log from the tray menu.", isError: true })
				return
			}
			try {
				switch (cmd.type) {
					case 'say':
						say({ text: cmd.text, seq: cmd.seq ?? 0 })
						break
					case 'messageTask':
						messageTask({ job: cmd.job, text: cmd.text })
						break
					case 'stopTask':
						stopTask({ job: cmd.job })
						break
					case 'interrupt':
						await interruptSession()
						break
					case 'reset':
						resetSession()
						log({ msg: 'conversation reset' })
						break
					case 'continue':
						continueSession({ sessionId: cmd.sessionId })
						break
					case 'mcpStatus':
						await requestMcpStatus()
						break
					case 'mcpSignIn':
						await signInToServer({ name: cmd.name })
						break
					case 'forgetThread':
						await forgetThread({ sessionId: cmd.sessionId })
						break
					default:
						exhaustiveGuard(cmd)
				}
			} catch (e) {
				log({ msg: `${cmd.type} failed: ${e instanceof Error ? (e.stack ?? e.message) : e}` })
			}
		},

		async updateSettings(next: Settings) {
			const needsBinary = next.claudePath !== settings.claudePath
			settings = next
			if (needsBinary || claudeBinary == null) claudeBinary = await findClaudeBinary({ settings })
			configureSession({ settings, claudeBinary })
		},

		close() {
			stopWatching?.()
			closeSession()
		},
	}
	return engine
}
