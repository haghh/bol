// Safety without prompts. Bol runs every tool call without asking, so instead of prompts it has:
// - a short hard-block list, refused outright whatever the model says (checkCommand below);
// - a copy of any existing file before the Write/Edit tools change it, unless Bol created it in this session;
// - deletes that go to the Recycle Bin (the move_to_recycle_bin tool, plus SAFETY_PROMPT);
// - an action log, ~/.bol/actions.jsonl, with a timestamp for every tool call;
// - an optional "ask first" mode (Settings → askFirst, off by default) that routes each call to the voice bar.

import { tool, type HookCallbackMatcher, type HookEvent, type HookJSONOutput } from '@anthropic-ai/claude-agent-sdk'
import { appendFile, copyFile, mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, normalize, resolve } from 'node:path'
import { z } from 'zod'
import { ACTIONS_FILE, BACKUPS_DIR } from './constants'
import { emit, log } from './protocol'
import { powershell } from './utils'

// ---------------------------------------------------------------------------------------------------------
// Hard-block list

type Rule = { pattern: RegExp; reason: string }

const RULES: Rule[] = [
	{ pattern: /\bformat(\.com)?\s+[a-z]:/i, reason: 'formats a drive' },
	{ pattern: /\b(Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition)\b/i, reason: 'formats or wipes a disk' },
	{ pattern: /\bdiskpart\b/i, reason: 'runs diskpart' },
	{ pattern: /\bcipher(\.exe)?\s+\/w/i, reason: 'wipes free space' },
	{ pattern: /\bvssadmin(\.exe)?\s+delete\b/i, reason: 'deletes shadow copies' },
	{ pattern: /\bwmic(\.exe)?\s+shadowcopy\s+delete\b/i, reason: 'deletes shadow copies' },
	{ pattern: /\bwbadmin(\.exe)?\s+delete\b/i, reason: 'deletes backups' },
	{ pattern: /\bbcdedit(\.exe)?\s+\/delete\b/i, reason: 'edits the boot configuration' },
	{ pattern: /\bClear-RecycleBin\b/i, reason: 'empties the Recycle Bin' },
	{ pattern: /\$Recycle\.Bin/i, reason: 'touches the Recycle Bin directly' },
	// A registry hive, or a key directly under one (HKLM\SOFTWARE, HKCU\Software…).
	{
		pattern:
			/\breg(\.exe)?\s+delete\s+"?(HKLM|HKCU|HKCR|HKU|HKCC|HKEY_[A-Z_]+)(\\[^\\\s"]+)?\\?"?(\s|$)/i,
		reason: 'deletes a whole registry hive or top-level key',
	},
	{
		pattern: /\bRemove-Item\b[^|;\n]*\b(HKLM|HKCU|HKCR|HKU|HKCC):\\?[^\\\s]*\\?(\s|$)/i,
		reason: 'deletes a whole registry hive or top-level key',
	},
]

/** Commands that delete recursively; their targets are checked against PROTECTED roots. */
const RECURSIVE_DELETE = [
	/\brm\s+(-[a-z]*r[a-z]*|--recursive)\b/i,
	/\bRemove-Item\b[^|;\n]*-Recurse\b/i,
	/\b(rd|rmdir)\s+\/s\b/i,
	/\b(del|erase)\s+(\/[a-z]\s+)*\/s\b/i,
	/\bfind\b[^|;\n]*-delete\b/i,
]

function protectedRoots(): string[] {
	const home = homedir()
	const roots = [
		home,
		...['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos', 'OneDrive', 'AppData'].map((d) =>
			join(home, d),
		),
	]
	if (process.platform === 'win32') {
		const sys = process.env.SystemDrive ?? 'C:'
		roots.push(
			join(sys, '\\'),
			process.env.SystemRoot ?? join(sys, '\\Windows'),
			process.env.ProgramFiles ?? join(sys, '\\Program Files'),
			process.env['ProgramFiles(x86)'] ?? join(sys, '\\Program Files (x86)'),
			process.env.ProgramData ?? join(sys, '\\ProgramData'),
			join(sys, '\\Users'),
		)
	} else roots.push('/', '/home', '/Users', '/etc', '/usr')
	return roots.map(canonical)
}

/** Lower-case, backslashes, no trailing separator: Windows paths compare case-insensitively. */
function canonical(path: string): string {
	return normalize(path).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/** Turns what a shell token might mean into an absolute path: Git Bash's /c/…, ~, %USERPROFILE%, $HOME. */
export function expandTarget({ token, cwd }: { token: string; cwd: string }): string | null {
	let t = token.replace(/^["']|["']$/g, '')
	if (t === '' || t.startsWith('-')) return null
	// A bare "/s" or "/c" is a cmd flag; "/c/Users/…" is Git Bash's spelling of C:\Users\….
	if (/^\/[a-z]\/./i.test(t)) t = `${t[1]}:${t.slice(2)}`
	else if (/^\/[a-z]\/?$/i.test(t)) return t.endsWith('/') ? `${t[1]}:\\` : null
	if (t === '/' && process.platform === 'win32') return `${process.env.SystemDrive ?? 'C:'}\\`
	t = t
		.replace(/^~(?=$|[\\/])/, homedir())
		.replace(/%USERPROFILE%|\$HOME\b|\$env:USERPROFILE\b|\$\{HOME\}/gi, homedir())
		.replace(/%SystemDrive%|\$env:SystemDrive\b/gi, process.env.SystemDrive ?? 'C:')
	t = t.replace(/[\\/]\*(\.\*)?$/, '') // "dir/*" deletes everything in dir
	if (/^[a-z]:$/i.test(t)) t += '\\'
	if (/^[a-z]:/i.test(t) || isAbsolute(t)) return t
	if (t.startsWith('/') || t.startsWith('$') || t.startsWith('%')) return null // a flag like /s or an unknown variable
	return resolve(cwd, t)
}

/** Why `command` is refused, or null if it may run. */
export function checkCommand({ command, cwd }: { command: string; cwd: string }): string | null {
	for (const rule of RULES) if (rule.pattern.test(command)) return rule.reason
	if (!RECURSIVE_DELETE.some((p) => p.test(command))) return null
	const roots = new Set(protectedRoots())
	const tokens = command.match(/"[^"]*"|'[^']*'|[^\s;|&]+/g) ?? []
	for (const token of tokens) {
		const target = expandTarget({ token, cwd })
		if (target == null) continue
		if (roots.has(canonical(target))) return `recursively deletes ${target}`
	}
	return null
}

// ---------------------------------------------------------------------------------------------------------
// Backups before overwriting

/** Files Bol wrote from nothing in this run: changing them again needs no copy. */
const createdByBol = new Set<string>()
/** Files already copied in this run: one copy per file is enough. */
const backedUp = new Set<string>()

async function backupBeforeWrite({ filePath }: { filePath: string }) {
	const key = canonical(filePath)
	if (createdByBol.has(key) || backedUp.has(key)) return
	const info = await stat(filePath).catch(() => null)
	if (info == null) {
		createdByBol.add(key) // it doesn't exist yet: this write creates it
		return
	}
	if (!info.isFile()) return
	const day = new Date().toISOString().slice(0, 10)
	const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '')
	const flat = filePath.replace(/[:\\/]+/g, '_').replace(/^_+/, '')
	const dest = join(BACKUPS_DIR, day, `${stamp}_${flat}`)
	await mkdir(join(BACKUPS_DIR, day), { recursive: true })
	await copyFile(filePath, dest)
	backedUp.add(key)
	log({ msg: `backed up ${filePath} -> ${dest}` })
}

// ---------------------------------------------------------------------------------------------------------
// Ask first

export type Approver = (request: { id: string; tool: string; summary: string; job: string | null }) => Promise<boolean>
let approver: Approver | null = null
/** The shell sets this; while askFirst is on, each tool call waits for its answer. */
export function setApprover(fn: Approver | null) {
	approver = fn
}

// ---------------------------------------------------------------------------------------------------------
// Hooks

const deny = (reason: string): HookJSONOutput => ({
	hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
})

/** Tools whose calls never need logging or approval: Bol's own read-only bookkeeping. */
const QUIET_TOOLS = new Set(['mcp__bol__list_tasks', 'mcp__bol__cursor_position', 'mcp__bol__wait'])

async function logAction(entry: Record<string, unknown>) {
	await appendFile(ACTIONS_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', {
		mode: 0o600,
	}).catch((e) => log({ msg: `action log: ${e}` }))
}

function truncateInput(input: unknown): unknown {
	const text = JSON.stringify(input) ?? ''
	return text.length <= 2000 ? input : text.slice(0, 2000) + '…'
}

/** Names of tools that write a file given by `file_path` (Claude Code's, and the API engines' write_file). */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'write_file'])

/**
 * Checks one tool call before it runs, for any engine: the hard-block list, a backup before a write, and
 * ask-first. Returns why it's refused (the text the model sees), or null to let it run.
 */
export async function guardToolCall({
	id,
	name,
	input,
	job,
	cwd,
	isAskFirst,
	summary,
}: {
	id: string
	name: string
	input: Record<string, unknown>
	job: string | null
	cwd: string
	isAskFirst: boolean
	summary: string
}): Promise<string | null> {
	for (const field of ['command', 'script']) {
		const value = input[field]
		if (typeof value !== 'string') continue
		const reason = checkCommand({ command: value, cwd })
		if (reason != null) {
			log({ msg: `blocked ${name}: ${reason}: ${value.slice(0, 200)}` })
			emit({ type: 'blocked', tool: name, reason, ...(job == null ? {} : { job }) })
			await logAction({ job, tool: name, input: truncateInput(input), blocked: reason })
			return `Blocked by Bol's safety list: this command ${reason}. Tell the user it's blocked for safety.`
		}
	}
	if (WRITE_TOOLS.has(name) && typeof input.file_path === 'string') {
		const filePath = resolve(cwd, input.file_path)
		await backupBeforeWrite({ filePath }).catch((e) => log({ msg: `backup of ${filePath} failed: ${e}` }))
	}
	if (isAskFirst && approver != null && !QUIET_TOOLS.has(name)) {
		const isAllowed = await approver({ id, tool: name, summary, job })
		if (!isAllowed) return 'The user declined this action. Ask what they want instead.'
	}
	return null
}

/** Adds a finished tool call to the action log. */
export async function recordToolCall({
	name,
	input,
	job,
	isError,
}: {
	name: string
	input: unknown
	job: string | null
	isError: boolean
}) {
	if (QUIET_TOOLS.has(name)) return
	await logAction({ job, tool: name, input: truncateInput(input), ...(isError ? { isError: true } : {}) })
}

/** The SDK hooks that enforce all of the above, for one Claude Code conversation. */
export function makeSafetyHooks({
	job,
	cwd,
	isAskFirst,
	summarize,
}: {
	job: string | null
	cwd: string
	isAskFirst: () => boolean
	summarize: (args: { name: string; input: unknown }) => string
}): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
	return {
		PreToolUse: [
			{
				onFailure: 'block',
				hooks: [
					async (input) => {
						if (input.hook_event_name !== 'PreToolUse') return {}
						const args = (input.tool_input ?? {}) as Record<string, unknown>
						const reason = await guardToolCall({
							id: input.tool_use_id,
							name: input.tool_name,
							input: args,
							job,
							cwd,
							isAskFirst: isAskFirst(),
							summary: summarize({ name: input.tool_name, input: args }),
						})
						return reason == null ? {} : deny(reason)
					},
				],
			},
		],
		PostToolUse: [
			{
				hooks: [
					async (input) => {
						if (input.hook_event_name !== 'PostToolUse') return {}
						await recordToolCall({ name: input.tool_name, input: input.tool_input, job, isError: false })
						return {}
					},
				],
			},
		],
		PostToolUseFailure: [
			{
				hooks: [
					async (input) => {
						if (input.hook_event_name !== 'PostToolUseFailure') return {}
						await recordToolCall({ name: input.tool_name, input: input.tool_input, job, isError: true })
						return {}
					},
				],
			},
		],
	}
}

// ---------------------------------------------------------------------------------------------------------
// Recycle Bin

/** Sends files or folders to the Recycle Bin through the Windows shell, so they can be restored. */
export async function moveToRecycleBin({ paths }: { paths: string[] }): Promise<{ moved: string[]; failed: string[] }> {
	const moved: string[] = []
	const failed: string[] = []
	for (const path of paths) {
		const full = resolve(path)
		if (protectedRoots().includes(canonical(full))) {
			failed.push(`${full} (protected folder)`)
			continue
		}
		// Microsoft.VisualBasic's FileSystem is the documented way to recycle from .NET (no dialogs, undoable).
		const literal = full.replace(/'/g, "''")
		const script = `
Add-Type -AssemblyName Microsoft.VisualBasic
$p = '${literal}'
if (Test-Path -LiteralPath $p -PathType Container) {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
} elseif (Test-Path -LiteralPath $p) {
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
} else { throw "not found" }`
		try {
			await powershell({ script })
			moved.push(full)
		} catch (e) {
			failed.push(`${full} (${e instanceof Error ? e.message.split('\n')[0] : e})`)
		}
	}
	await logAction({ tool: 'move_to_recycle_bin', input: { paths }, moved, failed })
	return { moved, failed }
}

export const recycleTool = tool(
	'move_to_recycle_bin',
	'Delete files or folders by moving them to the Windows Recycle Bin, where the user can restore them. ' +
		'Always use this instead of rm, del, rd or Remove-Item.',
	{ paths: z.array(z.string().min(1)).min(1).describe('Absolute Windows paths, e.g. C:\\Users\\me\\old.txt') },
	async ({ paths }) => {
		const { moved, failed } = await moveToRecycleBin({ paths })
		const lines = [
			...(moved.length > 0 ? [`Moved to the Recycle Bin: ${moved.map((p) => basename(p)).join(', ')}`] : []),
			...(failed.length > 0 ? [`Failed: ${failed.join('; ')}`] : []),
		]
		return { content: [{ type: 'text', text: lines.join('\n') }], isError: moved.length === 0 }
	},
)

