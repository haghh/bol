// Tasks: named Claude Agent SDK sessions the thread starts for real work. Each runs on its own from a
// brief Bol writes, reports its result, and can be messaged again later (by voice through Bol, or from
// the Threads window), resuming its session if it had finished. The thread gets these as tools.

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { appendFile, readFile } from 'node:fs/promises'
import { z } from 'zod'
import { TASKS_FILE } from './constants'
import { log } from './protocol'

export type TaskStatus = 'running' | 'done' | 'failed' | 'stopped'

/** One line of ~/.bol/tasks.jsonl: which session a task is, and which thread started it. */
export type TaskRecord = { taskId: string; name: string; sessionId: string; threadId: string | null; at: string }

const TaskRecordSchema = z.object({
	taskId: z.string(),
	name: z.string(),
	sessionId: z.string(),
	threadId: z.string().nullable(),
	at: z.string(),
})

export async function recordTask(record: TaskRecord) {
	await appendFile(TASKS_FILE, JSON.stringify(record) + '\n', { mode: 0o600 }).catch((e) =>
		log({ msg: `tasks index: ${e}` }),
	)
}

/** A task deleted with its thread (the app appends these): earlier lines for it no longer count. */
const DeletedSchema = z.object({ taskId: z.string(), isDeleted: z.literal(true) })

/** Every task Bol has started and not deleted, latest line per task. */
export async function loadTaskRecords(): Promise<TaskRecord[]> {
	const text = await readFile(TASKS_FILE, 'utf8').catch(() => '')
	const byId = new Map<string, TaskRecord>()
	for (const line of text.split('\n')) {
		if (line.trim() === '') continue
		try {
			const json = JSON.parse(line)
			const deleted = DeletedSchema.safeParse(json)
			if (deleted.success) byId.delete(deleted.data.taskId)
			else {
				const record = TaskRecordSchema.parse(json)
				byId.set(record.taskId, record)
			}
		} catch {} // a line cut short, or from another version
	}
	return [...byId.values()]
}

/** What the thread's own tools do; session.ts implements them. Each returns the text the model sees. */
export type ThreadHandlers = {
	start: (args: { name: string; brief: string }) => Promise<string>
	message: (args: { name: string; text: string }) => Promise<string>
	list: () => Promise<string>
	stop: (args: { name: string }) => Promise<string>
	/** Starts an MCP server's sign-in (OAuth) and opens its page in the browser. */
	signIn: (args: { server: string }) => Promise<string>
}

const asText = (text: string) => ({ content: [{ type: 'text' as const, text }] })

/** The thread's own tools: tasks, and signing in to MCP servers. */
export function makeThreadTools({ handlers }: { handlers: ThreadHandlers }) {
	return [
		tool(
			'start_task',
			'Start a named task: a separate Claude session that does real work on its own (research, writing, coding, files, ' +
				"operating apps or the browser, anything that takes more than a few seconds) while you stay free for the user. It can't see this " +
				'conversation, so the brief must hold everything it needs. Its result reaches the user when it finishes.',
			{
				name: z
					.string()
					.min(1)
					.max(40)
					.describe('Short, unique name the user can refer to, 2-4 words, e.g. "Chrome extension icon"'),
				brief: z
					.string()
					.min(1)
					.describe(
						"Self-contained instructions: the goal, the user's words, every detail, path and preference it needs",
					),
			},
			async ({ name, brief }) => asText(await handlers.start({ name, brief })),
		),
		tool(
			'message_task',
			"Send a follow-up to a task, running or finished: a change, more detail, or the next step. Use it whenever the user refers to a task's work instead of starting a new one.",
			{
				name: z.string().describe("The task's name (as list_tasks shows it)"),
				text: z.string().min(1).describe('The message, self-contained'),
			},
			async ({ name, text }) => asText(await handlers.message({ name, text })),
		),
		tool('list_tasks', "List this conversation's tasks: name, status and latest result.", {}, async () =>
			asText(await handlers.list()),
		),
		tool('stop_task', 'Stop a running task.', { name: z.string().describe("The task's name") }, async ({ name }) =>
			asText(await handlers.stop({ name })),
		),
		tool(
			'sign_in_to_server',
			"Sign the user in to an MCP server or connector that needs it (its tools fail with an authorization error, or the user asks): opens the server's sign-in page in their browser, and it connects once they finish there.",
			{ server: z.string().describe("The MCP server's name, as its tools show it (mcp__<server>__…)") },
			async ({ server }) => asText(await handlers.signIn({ server })),
		),
	]
}

export const THREAD_TASK_PROMPT = `
# Tasks
You are the user's one long-running conversation, and you stay free for them. For anything that takes more than a few seconds or several steps (research, writing, coding, file work, operating apps or the browser), call start_task with a short unique name and a self-contained brief: the task can't see this conversation, so include the user's words, every detail, path and preference it needs. Then reply in one short sentence ("On it, I'll tell you when it's done."). Answer quick questions and one-step actions yourself.
When the user refers to a task, running or finished ("tell the icon task to…", "make it blue instead"), use message_task rather than starting a new one; list_tasks shows them, stop_task stops one. Task results reach the user directly and come back to you as notes: don't repeat them unless asked.

# Skills and sign-ins
The user's Claude Code skills are available through the Skill tool. When they name one ("use my release skill", "run the morning brief") or a request fits one, use it, or start a task whose brief says to use that skill.
If an MCP server or connector needs the user to sign in, call sign_in_to_server and tell them to finish in the browser.
`

export function taskPrompt({ name }: { name: string }) {
	return `
# You are a task
You are Bol's task "${name}", working on your own in the background on the request that follows. The user isn't watching: make sensible choices rather than asking, and only ask if you truly can't go on. When you're done, your final message is read aloud to the user and shown in Bol's voice bar: one or two short spoken sentences with the outcome and anything the user must do next. No headings, bullet lists, bold labels or step-by-step recaps of what you changed; plain sentences only. Follow-up messages with changes may arrive later.
`
}
