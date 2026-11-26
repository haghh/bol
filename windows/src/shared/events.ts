// What the brain says and hears. Shared by the main process (brain + shell) and the renderer (voice bar).
// These follow the original Bol's stdio protocol (src/typescript/protocol.ts upstream), minus `control`,
// which the main process now performs itself.

import { z } from 'zod'

export type McpServerStatus = {
	name: string
	status: string
	error: string | null
	source: string | null
	tools: number | null
}

export type TaskStatus = 'running' | 'done' | 'failed' | 'stopped'

/** `job` is set when an event comes from a task rather than the main conversation (the thread). */
export type BrainEvent =
	| { type: 'ready'; backend: string }
	| { type: 'log'; msg: string }
	| { type: 'tool'; name: string; summary: string; job?: string }
	| { type: 'text'; text: string; job?: string }
	/** `isDelegated`: the turn only handed the request to a task, so the reply is an acknowledgement. */
	| { type: 'result'; text: string; isError: boolean; isInterrupted?: boolean; isDelegated?: boolean; job?: string }
	| { type: 'screen'; reason: string; job?: string }
	/** The thread has nothing left to do; `seq` is the latest `say` it received. */
	| { type: 'idle'; seq: number }
	| { type: 'mcpStatus'; servers: McpServerStatus[]; problems: { name: string; error: string }[] }
	| { type: 'task'; job: string; name: string; status: TaskStatus; sessionId: string | null }
	| { type: 'skills'; skills: { name: string; description: string; argumentHint?: string }[] }
	| { type: 'mcpSignIn'; name: string; url: string | null; error: string | null }
	| { type: 'mcpSignInDone'; name: string; status: string }
	/** A tool call was refused by the hard-block list (see safety.ts). */
	| { type: 'blocked'; tool: string; reason: string; job?: string }

const sessionId = z.string().regex(/^[0-9a-f-]{36}$/)

/** What the shell (voice bar, tray, CLI) can ask of the brain. */
export const Command = z.discriminatedUnion('type', [
	z.object({ type: z.literal('say'), text: z.string(), seq: z.number().optional() }),
	z.object({ type: z.literal('messageTask'), job: z.string(), text: z.string().min(1) }),
	z.object({ type: z.literal('stopTask'), job: z.string() }),
	z.object({ type: z.literal('interrupt') }),
	z.object({ type: z.literal('reset') }),
	z.object({ type: z.literal('continue'), sessionId }),
	z.object({ type: z.literal('mcpStatus') }),
	z.object({ type: z.literal('mcpSignIn'), name: z.string().min(1) }),
	z.object({ type: z.literal('forgetThread'), sessionId }),
])
export type Command = z.infer<typeof Command>
