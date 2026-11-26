// The user's own MCP servers, from ~/.bol/mcp.json.
//
// The file uses the format Claude Code, Claude Desktop and Cursor share, so configs can be pasted
// in as they are:
//
//   { "mcpServers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
//                                 "env": { "GITHUB_TOKEN": "…" } },
//                     "linear": { "type": "http", "url": "https://mcp.linear.app/mcp" } } }
//
// Each server is checked on its own, so one bad entry doesn't take the others down. `"disabled": true`
// keeps an entry without loading it. Servers added with `claude mcp add` load as well, through
// Claude Code's own settings.

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { z } from 'zod'
import { BOL_DIR, MCP_FILE, RESERVED_MCP_NAMES } from './constants'
import { log } from './protocol'

const common = {
	timeout: z.number().optional(),
	alwaysLoad: z.boolean().optional(),
	disabled: z.boolean().optional(),
}

const Stdio = z.object({
	type: z.literal('stdio').optional(),
	command: z.string().min(1, 'needs a command'),
	args: z.array(z.string()).optional(),
	env: z.record(z.string(), z.string()).optional(),
	...common,
})

const Remote = z.object({
	// "streamable-http" is what some clients call http; a url with no type is http too.
	type: z.enum(['http', 'sse', 'streamable-http']).optional(),
	url: z.url('needs a valid url'),
	headers: z.record(z.string(), z.string()).optional(),
	...common,
})

const NAME = /^[A-Za-z0-9_-]{1,64}$/

export type CustomServers = {
	servers: Record<string, McpServerConfig>
	/** Entries that couldn't be used, with why: shown in Settings. */
	problems: { name: string; error: string }[]
}

function toConfig(entry: z.infer<typeof Stdio> | z.infer<typeof Remote>): McpServerConfig {
	if ('command' in entry) {
		const { disabled: _, type: __, ...rest } = entry
		return { type: 'stdio', ...rest }
	}
	const { disabled: _, type, ...rest } = entry
	return type === 'sse' ? { type: 'sse', ...rest } : { type: 'http', ...rest }
}

export async function loadCustomServers(): Promise<CustomServers> {
	const result: CustomServers = { servers: {}, problems: [] }
	let raw: string
	try {
		raw = await readFile(MCP_FILE, 'utf8')
	} catch {
		return result // no file: no custom servers
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (e) {
		result.problems.push({ name: 'mcp.json', error: `isn't valid JSON: ${(e as Error).message}` })
		return result
	}
	const entries = (parsed as { mcpServers?: unknown })?.mcpServers
	if (entries == null || typeof entries !== 'object' || Array.isArray(entries)) {
		result.problems.push({ name: 'mcp.json', error: 'needs a top-level "mcpServers" object' })
		return result
	}
	for (const [name, value] of Object.entries(entries)) {
		if (!NAME.test(name)) {
			result.problems.push({ name, error: 'names can only use letters, digits, - and _' })
			continue
		}
		if (RESERVED_MCP_NAMES.includes(name)) {
			result.problems.push({ name, error: 'this name is used by Bol itself; pick another' })
			continue
		}
		const isRemote = typeof value === 'object' && value != null && 'url' in value
		const entry = (isRemote ? Remote : Stdio).safeParse(value)
		if (!entry.success) {
			result.problems.push({ name, error: entry.error.issues.map((i) => i.message).join('; ') })
			continue
		}
		if (entry.data.disabled === true) continue
		result.servers[name] = toConfig(entry.data)
	}
	return result
}

/** Calls `onChange` (debounced) whenever mcp.json is written, created or deleted. */
export function watchCustomServers({ onChange }: { onChange: () => void }): () => void {
	let timer: ReturnType<typeof setTimeout> | null = null
	try {
		// The directory, not the file: editors replace files on save, which ends a watch on the file.
		const watcher = watch(BOL_DIR, (_event, file) => {
			if (file != null && file !== basename(MCP_FILE)) return
			if (timer != null) clearTimeout(timer)
			timer = setTimeout(onChange, 300)
		})
		return () => watcher.close()
	} catch (e) {
		log({ msg: `can't watch ${MCP_FILE}: ${e}` })
		return () => {}
	}
}
