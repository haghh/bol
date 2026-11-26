// The API-key engines' tool set, kept minimal on purpose: a shell, reading and writing files, Bol's own
// tools (the Recycle Bin, look_at_screen and computer control, shared with the Claude Code engine), and
// the user's MCP servers from ~/.bol/mcp.json. Every call goes through the same safety checks as Claude
// Code's tools (safety.ts) and shows up in the voice bar and the action log.

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp'
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio'
import { tool, type Tool, type ToolSet } from 'ai'
import { spawn } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, resolve } from 'node:path'
import { z } from 'zod'
import type { BrainEvent } from '../../shared/events'
import { log } from '../brain/protocol'
import { guardToolCall, recordToolCall } from '../brain/safety'
import { bolToolDefinitions } from '../brain/screen'

/** What a tool returns: text, and any images (base64 JPEG/PNG) for the model to look at. */
export type ToolOutput = { text: string; images: { data: string; mediaType: string }[]; isError: boolean }

const MAX_OUTPUT_CHARS = 30_000

function clip(text: string): string {
	if (text.length <= MAX_OUTPUT_CHARS) return text
	const half = MAX_OUTPUT_CHARS / 2
	return `${text.slice(0, half)}\n… [${text.length - MAX_OUTPUT_CHARS} characters cut] …\n${text.slice(-half)}`
}

/** How a ToolOutput reaches the model: text plus images, which every provider here can read. */
function toModelOutput({ output }: { output: ToolOutput }) {
	if (output.images.length === 0) return { type: 'text' as const, value: output.text }
	return {
		type: 'content' as const,
		value: [
			{ type: 'text' as const, text: output.text },
			...output.images.map((image) => ({
				type: 'file' as const,
				mediaType: image.mediaType,
				data: { type: 'data' as const, data: image.data },
			})),
		],
	}
}

// ---------------------------------------------------------------------------------------------------------
// Shell and files

/** Runs a command in PowerShell (Windows) or bash (elsewhere, for development). */
function runCommand({
	command,
	cwd,
	timeoutMs,
	signal,
}: {
	command: string
	cwd: string
	timeoutMs: number
	signal?: AbortSignal
}): Promise<ToolOutput> {
	const [file, args] =
		process.platform === 'win32'
			? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command]]
			: ['bash', ['-c', command]]
	return new Promise((done) => {
		const p = spawn(file as string, args as string[], { cwd, windowsHide: true, signal })
		let out = ''
		let isTimedOut = false
		const timer = setTimeout(() => {
			isTimedOut = true
			p.kill()
		}, timeoutMs)
		p.stdout.setEncoding('utf8').on('data', (d: string) => (out += d))
		p.stderr.setEncoding('utf8').on('data', (d: string) => (out += d))
		p.on('error', (e) => {
			clearTimeout(timer)
			done({ text: `Couldn't run it: ${e.message}`, images: [], isError: true })
		})
		p.on('close', (code) => {
			clearTimeout(timer)
			const tail = isTimedOut ? `\n(Stopped after ${Math.round(timeoutMs / 1000)}s.)` : code === 0 ? '' : `\n(Exit code ${code}.)`
			done({ text: clip(out.trim() === '' ? '(no output)' : out.trim()) + tail, images: [], isError: isTimedOut || code !== 0 })
		})
	})
}

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }

function expandPath({ path, cwd }: { path: string; cwd: string }): string {
	return resolve(cwd, path.replace(/^~(?=$|[\\/])/, homedir()))
}

async function readFileTool({
	path,
	offset,
	limit,
}: {
	path: string
	offset?: number
	limit?: number
}): Promise<ToolOutput> {
	const info = await stat(path).catch(() => null)
	if (info == null) return { text: `No such file: ${path}`, images: [], isError: true }
	if (info.isDirectory()) return { text: `${path} is a folder. List it with run_command.`, images: [], isError: true }
	const mediaType = IMAGE_TYPES[extname(path).toLowerCase()]
	if (mediaType != null) {
		if (info.size > 5_000_000) return { text: 'That image is over 5 MB.', images: [], isError: true }
		return { text: `Image ${path}`, images: [{ data: (await readFile(path)).toString('base64'), mediaType }], isError: false }
	}
	const lines = (await readFile(path, 'utf8')).split(/\r?\n/)
	const start = Math.max(0, (offset ?? 1) - 1)
	const slice = lines.slice(start, start + (limit ?? 2000))
	const numbered = slice.map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`).join('\n')
	const more = start + slice.length < lines.length ? `\n(${lines.length - start - slice.length} more lines; use offset.)` : ''
	return { text: clip(numbered) + more, images: [], isError: false }
}

// ---------------------------------------------------------------------------------------------------------
// The tool set

export type ToolContext = {
	cwd: string
	job: string | null
	isAskFirst: () => boolean
	emit: (event: BrainEvent) => void
	summarize: (args: { name: string; input: unknown }) => string
}

/**
 * Wraps a tool's work in Bol's safety checks: refused calls never run, every call is shown in the bar and
 * logged. `name` is what the voice bar and action log see (mcp__bol__… for Bol's own, as with Claude Code).
 */
function guarded<INPUT extends Record<string, unknown>>({
	name,
	description,
	inputSchema,
	run,
	context,
}: {
	name: string
	description: string
	inputSchema: z.ZodType<INPUT>
	run: (input: INPUT, signal?: AbortSignal) => Promise<ToolOutput>
	context: ToolContext
}): Tool<INPUT, ToolOutput> {
	return tool({
		description,
		inputSchema,
		execute: async (input: INPUT, options: { toolCallId: string; abortSignal?: AbortSignal }) => {
			context.emit({ type: 'tool', name, summary: context.summarize({ name, input }) })
			const refusal = await guardToolCall({
				id: options.toolCallId,
				name,
				input,
				job: context.job,
				cwd: context.cwd,
				isAskFirst: context.isAskFirst(),
				summary: context.summarize({ name, input }),
			})
			if (refusal != null) return { text: refusal, images: [], isError: true }
			const output = await run(input, options.abortSignal).catch(
				(e): ToolOutput => ({ text: `Failed: ${e instanceof Error ? e.message : e}`, images: [], isError: true }),
			)
			await recordToolCall({ name, input, job: context.job, isError: output.isError })
			return output
		},
		toModelOutput,
	}) as Tool<INPUT, ToolOutput>
}

/** Turns one of Bol's Agent-SDK tool definitions (control.ts, screen.ts, safety.ts) into an AI SDK tool. */
function fromSdkDefinition({
	definition,
	context,
}: {
	definition: ReturnType<typeof bolToolDefinitions>[number]
	context: ToolContext
}) {
	const def = definition as unknown as {
		name: string
		description: string
		inputSchema: z.ZodRawShape
		handler: (args: any, extra: unknown) => Promise<{ content: any[]; isError?: boolean }>
	}
	return guarded({
		name: `mcp__bol__${def.name}`,
		description: def.description,
		inputSchema: z.object(def.inputSchema),
		context,
		run: async (input) => {
			const result = await def.handler(input, {})
			return {
				text: result.content.filter((c) => c.type === 'text').map((c) => c.text as string).join('\n'),
				images: result.content
					.filter((c) => c.type === 'image')
					.map((c) => ({ data: c.data as string, mediaType: c.mimeType as string })),
				isError: result.isError === true,
			}
		},
	})
}

export function makeTools({ context, isScreenEnabled }: { context: ToolContext; isScreenEnabled: boolean }): ToolSet {
	const tools: ToolSet = {
		run_command: guarded({
			name: 'run_command',
			description:
				process.platform === 'win32'
					? 'Run a PowerShell command on the PC and get its output. Use it for anything the shell can do: files and folders, apps, settings, ' +
						'COM automation, the registry, services, network. Start-Process opens apps, files and URLs. Runs in the workspace folder by default.'
					: 'Run a bash command and get its output.',
			inputSchema: z.object({
				command: z.string().min(1),
				timeout_seconds: z.number().int().min(1).max(600).optional().describe('Default 120'),
			}),
			context,
			run: (input, signal) =>
				runCommand({ command: input.command, cwd: context.cwd, timeoutMs: (input.timeout_seconds ?? 120) * 1000, signal }),
		}),
		read_file: guarded({
			name: 'read_file',
			description:
				'Read a text file (with line numbers) or look at an image file (png, jpg, gif, webp). Paths can be absolute or relative to the workspace.',
			inputSchema: z.object({
				file_path: z.string().min(1),
				offset: z.number().int().min(1).optional().describe('First line to read (1-based)'),
				limit: z.number().int().min(1).optional().describe('How many lines (default 2000)'),
			}),
			context,
			run: (input) =>
				readFileTool({ path: expandPath({ path: input.file_path, cwd: context.cwd }), offset: input.offset, limit: input.limit }),
		}),
		write_file: guarded({
			name: 'write_file',
			description:
				'Create or replace a text file with the given content. Bol keeps a copy of a file it is about to overwrite. To change part of a big file, read it first and write it back whole.',
			inputSchema: z.object({ file_path: z.string().min(1), content: z.string() }),
			context,
			run: async (input) => {
				const path = expandPath({ path: input.file_path, cwd: context.cwd })
				await mkdir(dirname(path), { recursive: true })
				await writeFile(path, input.content)
				return { text: `Wrote ${input.content.length} characters to ${path}.`, images: [], isError: false }
			},
		}),
	}
	for (const definition of bolToolDefinitions({
		onScreen: ({ reason }) => context.emit({ type: 'screen', reason }),
		isScreenEnabled,
	}))
		tools[definition.name] = fromSdkDefinition({ definition, context })
	return tools
}

// ---------------------------------------------------------------------------------------------------------
// The user's MCP servers

export type McpConnection = { tools: ToolSet; close: () => Promise<void>; problems: { name: string; error: string }[] }

/** Connects to each server from mcp.json and exposes its tools as mcp__<server>__<tool>, behind the same checks. */
export async function connectMcpServers({
	servers,
	context,
}: {
	servers: Record<string, McpServerConfig>
	context: ToolContext
}): Promise<McpConnection> {
	const clients: MCPClient[] = []
	const tools: ToolSet = {}
	const problems: { name: string; error: string }[] = []
	await Promise.all(
		Object.entries(servers).map(async ([server, config]) => {
			try {
				const client = await createMCPClient({
					transport:
						config.type === 'http' || config.type === 'sse'
							? { type: config.type, url: config.url, headers: config.headers }
							: 'command' in config
								? new Experimental_StdioMCPTransport({
										command: config.command,
										args: config.args,
										env: { ...(process.env as Record<string, string>), ...config.env },
										// npx and other .cmd shims need a shell on Windows.
										shell: process.platform === 'win32',
									})
								: (() => {
										throw new Error(`unsupported server type ${config.type}`)
									})(),
				})
				clients.push(client)
				const serverTools = await client.tools()
				for (const [toolName, t] of Object.entries(serverTools)) {
					const name = `mcp__${server}__${toolName}`
					const original = t as Tool<any, any>
					tools[name] = {
						...original,
						execute: async (input: any, options: any) => {
							context.emit({ type: 'tool', name, summary: '' })
							const refusal = await guardToolCall({
								id: options.toolCallId,
								name,
								input: input ?? {},
								job: context.job,
								cwd: context.cwd,
								isAskFirst: context.isAskFirst(),
								summary: '',
							})
							if (refusal != null) return { content: [{ type: 'text', text: refusal }], isError: true }
							let isError = false
							try {
								const result = await original.execute!(input, options)
								isError = (result as { isError?: boolean })?.isError === true
								return result
							} catch (e) {
								isError = true
								throw e
							} finally {
								await recordToolCall({ name, input, job: context.job, isError })
							}
						},
					} as Tool<any, any>
				}
				log({ msg: `mcp ${server}: ${Object.keys(serverTools).length} tool(s)` })
			} catch (e) {
				const error = e instanceof Error ? e.message : String(e)
				log({ msg: `mcp ${server} failed: ${error}` })
				problems.push({ name: server, error })
			}
		}),
	)
	return { tools, problems, close: async () => void (await Promise.all(clients.map((c) => c.close().catch(() => {})))) }
}
