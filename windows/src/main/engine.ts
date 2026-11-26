// The swappable model backend. The Claude Code engine (brain/index.ts) is the original Bol brain; the
// API-key engines (Anthropic, OpenAI, Gemini via the Vercel AI SDK, with a minimal tool set) implement
// the same interface later. The shell only ever talks to an Engine: it sends Commands and listens to
// BrainEvents on the bus (brain/protocol.ts), whichever engine is running.

import type { Command } from '../shared/events'
import type { Settings } from '../shared/settings'

export interface Engine {
	/** Shown in logs and Settings, e.g. "claude-code". */
	readonly name: string
	/** Prepares folders, finds binaries, starts the first conversation; emits `ready` when it can take requests. */
	start(): Promise<void>
	/** Handles one command from the shell (voice bar, tray, CLI). Never throws: failures become events. */
	send(command: Command): Promise<void>
	/** Settings changed: apply what can be applied (new conversations pick up the rest). */
	updateSettings(settings: Settings): Promise<void>
	/** Stops every conversation. */
	close(): void
}

export type EngineFactory = (args: { settings: Settings }) => Engine
