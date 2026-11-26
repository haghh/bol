// look_at_screen and Bol's own MCP server (control tools, the Recycle Bin tool, and the thread's task tools).

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { control, controlTools } from './control'
import { recycleTool } from './safety'

const makeLookAtScreen = ({ onScreen }: { onScreen: (event: { reason: string }) => void }) =>
	tool(
		'look_at_screen',
		'See what the user is looking at on their PC right now: returns a screenshot plus the frontmost app, window title and browser URL when known. ' +
			"Use it when the request refers to something on screen or needs visual context. Prefer scope 'window' (the frontmost window); use 'screen' for the whole display.",
		{
			reason: z.string().describe('A few words on why you need to look, shown to the user'),
			scope: z.enum(['window', 'screen']).optional().describe('Default: window'),
		},
		async ({ reason, scope }) => {
			onScreen({ reason })
			// The executor captures the frontmost window (hiding Bol's own bar first) and describes it.
			return control({ action: { name: 'look_at_screen', scope: scope ?? 'window' } })
		},
	)

/** Bol's own tool definitions, minus the thread's task tools. The API-key engines use these directly. */
export function bolToolDefinitions({
	onScreen,
	isScreenEnabled,
}: {
	onScreen: (event: { reason: string }) => void
	isScreenEnabled: boolean
}) {
	return [recycleTool, ...(isScreenEnabled ? [makeLookAtScreen({ onScreen }), ...controlTools] : [])]
}

/** Bol's own tools. An SDK MCP server serves one query at a time, so each conversation makes its own. */
export function makeBolTools({
	onScreen,
	extraTools,
	isScreenEnabled,
}: {
	onScreen: (event: { reason: string }) => void
	/** The thread's task tools. */
	extraTools: ReturnType<typeof tool<any>>[]
	isScreenEnabled: boolean
}) {
	return createSdkMcpServer({
		name: 'bol',
		version: '1.0.0',
		tools: [...bolToolDefinitions({ onScreen, isScreenEnabled }), ...extraTools],
	})
}
