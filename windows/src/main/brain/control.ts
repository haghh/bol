// Computer control: screenshots, pointer, keyboard, clipboard and apps, as in-process MCP tools.
//
// Claude Code has its own computer use, but only wires it up in interactive sessions, never through
// the SDK. These tools follow its names and parameters, without its per-app permission step: the
// user has given Bol the run of this PC. On macOS the Swift app performed each action; here a
// ControlExecutor in the main process does (see ../native/windows-control.ts). This file only
// describes the tools and relays them.

import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

const CONTROL_TIMEOUT_MS = 120_000

/** One action, as the tools below describe it: `name` plus that action's parameters (camelCase). */
export type ControlAction = { name: string } & Record<string, unknown>
/** `images` are base64 JPEGs to attach to the tool result (screenshots, zooms). */
export type ControlResult = { text: string; isError: boolean; images: string[] }
export type ControlExecutor = (action: ControlAction) => Promise<ControlResult>

let executor: ControlExecutor | null = null

/** The shell registers what actually moves the mouse; until then every control tool reports it's unavailable. */
export function setControlExecutor(fn: ControlExecutor | null) {
	executor = fn
}

/** Performs one action and returns its result as tool content (text plus any screenshots). */
export async function control({ action }: { action: ControlAction }) {
	const run = executor
	const result: ControlResult =
		run == null
			? { text: 'Computer control is not available in this build.', isError: true, images: [] }
			: await Promise.race([
					run(action).catch(
						(e): ControlResult => ({ text: `Failed: ${e instanceof Error ? e.message : e}`, isError: true, images: [] }),
					),
					new Promise<ControlResult>((resolve) =>
						setTimeout(
							() => resolve({ text: 'The PC did not respond in time.', isError: true, images: [] }),
							CONTROL_TIMEOUT_MS,
						),
					),
				])
	const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [
		{ type: 'text', text: result.text },
	]
	for (const data of result.images) content.push({ type: 'image', data, mimeType: 'image/jpeg' })
	return { content, isError: result.isError }
}

const coordinate = z.tuple([z.number(), z.number()]).describe('[x, y] in pixels of the latest screenshot')
const modifiers = z.string().optional().describe('Modifier keys to hold during the click, e.g. "shift" or "ctrl+shift"')
const keys = z.string().describe('A key or combination, e.g. "enter", "escape", "ctrl+a", "alt+tab", "win+r"')

const clickShape = { coordinate, text: modifiers }

function clickTool({ name, description }: { name: string; description: string }) {
	return tool(name, description, clickShape, ({ coordinate, text }) =>
		control({ action: { name, coordinate, text } }),
	)
}

/** One step of computer_batch: the same actions and parameters as the single tools. */
const batchStep = z.object({
	action: z.enum([
		'screenshot',
		'zoom',
		'left_click',
		'right_click',
		'middle_click',
		'double_click',
		'triple_click',
		'left_click_drag',
		'left_mouse_down',
		'left_mouse_up',
		'mouse_move',
		'scroll',
		'type',
		'key',
		'hold_key',
		'cursor_position',
		'open_application',
		'read_clipboard',
		'write_clipboard',
		'wait',
	]),
	coordinate: coordinate.optional(),
	start_coordinate: coordinate.optional(),
	region: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
	text: z.string().optional(),
	repeat: z.number().int().optional(),
	scroll_direction: z.enum(['up', 'down', 'left', 'right']).optional(),
	scroll_amount: z.number().int().optional(),
	duration: z.number().optional(),
	app: z.string().optional(),
})

function toAction({ action, start_coordinate, scroll_direction, scroll_amount, ...rest }: z.infer<typeof batchStep>) {
	return {
		name: action,
		startCoordinate: start_coordinate,
		scrollDirection: scroll_direction,
		scrollAmount: scroll_amount,
		...rest,
	}
}

export const controlTools = [
	tool(
		'screenshot',
		'Take a screenshot of the display showing the frontmost window. Everything on screen is visible. ' +
			'Click, scroll and drag coordinates are pixels in the most recent screenshot, so take one before pointing at anything and again after the screen changes.',
		{},
		() => control({ action: { name: 'screenshot' } }),
	),
	tool(
		'zoom',
		'Look closer at part of the latest screenshot, at higher resolution: small text, icons, fine detail. ' +
			'Read-only. Coordinates for later clicks still refer to the full screenshot, never to the zoomed image.',
		{
			region: z
				.tuple([z.number(), z.number(), z.number(), z.number()])
				.describe('[x0, y0, x1, y1] in pixels of the latest screenshot'),
		},
		({ region }) => control({ action: { name: 'zoom', region } }),
	),
	clickTool({ name: 'left_click', description: 'Left-click at a point on the screen.' }),
	clickTool({ name: 'right_click', description: 'Right-click at a point, which usually opens a context menu.' }),
	clickTool({ name: 'middle_click', description: 'Middle-click (the scroll-wheel button) at a point.' }),
	clickTool({ name: 'double_click', description: 'Double-click at a point. Selects a word in most text fields.' }),
	clickTool({ name: 'triple_click', description: 'Triple-click at a point. Selects a line in most text fields.' }),
	tool(
		'left_click_drag',
		'Press the left button, move to the target and release: dragging files, sliders, selections, window edges.',
		{
			coordinate: coordinate.describe('Where to release, [x, y] in pixels of the latest screenshot'),
			start_coordinate: coordinate
				.optional()
				.describe('Where to press, [x, y]; defaults to where the pointer is now'),
		},
		({ coordinate, start_coordinate }) =>
			control({ action: { name: 'left_click_drag', coordinate, startCoordinate: start_coordinate } }),
	),
	tool(
		'left_mouse_down',
		'Press the left button where the pointer is and keep it held. Position the pointer with mouse_move first, and release with left_mouse_up.',
		{},
		() => control({ action: { name: 'left_mouse_down' } }),
	),
	tool('left_mouse_up', 'Release the left button where the pointer is. Safe to call when it is not held.', {}, () =>
		control({ action: { name: 'left_mouse_up' } }),
	),
	tool(
		'mouse_move',
		'Move the pointer without clicking, for example to reveal hover states.',
		{ coordinate },
		({ coordinate }) => control({ action: { name: 'mouse_move', coordinate } }),
	),
	tool(
		'scroll',
		'Scroll at a point on the screen.',
		{
			coordinate,
			scroll_direction: z.enum(['up', 'down', 'left', 'right']),
			scroll_amount: z
				.number()
				.int()
				.describe('How far, in wheel notches (3 is a small scroll, 10 about a page)'),
		},
		({ coordinate, scroll_direction, scroll_amount }) =>
			control({
				action: { name: 'scroll', coordinate, scrollDirection: scroll_direction, scrollAmount: scroll_amount },
			}),
	),
	tool(
		'type',
		'Type text into whatever has keyboard focus, as if on the keyboard. Newlines press Enter. For shortcuts use key.',
		{ text: z.string() },
		({ text }) => control({ action: { name: 'type', text } }),
	),
	tool(
		'key',
		'Press a key or key combination, including system shortcuts such as alt+tab, win+d or alt+f4.',
		{ text: keys, repeat: z.number().int().optional().describe('How many times to press it (default 1)') },
		({ text, repeat }) => control({ action: { name: 'key', text, repeat } }),
	),
	tool(
		'hold_key',
		'Press and hold a key or combination for a duration, then release it.',
		{ text: keys, duration: z.number().describe('Seconds to hold (up to 30)') },
		({ text, duration }) => control({ action: { name: 'hold_key', text, duration } }),
	),
	tool('cursor_position', 'Where the pointer is now, in pixels of the latest screenshot.', {}, () =>
		control({ action: { name: 'cursor_position' } }),
	),
	tool(
		'open_application',
		'Open an app, or bring it to the front if it is already running.',
		{ app: z.string().describe('The app name, e.g. "Notepad", "Excel" or "Spotify", or a path to its .exe') },
		({ app }) => control({ action: { name: 'open_application', app } }),
	),
	tool(
		'switch_display',
		'Choose which monitor screenshots capture, when the app you need is on another one. ' +
			'The screenshot tool names the monitor it captured and lists the others. Pass "auto" to follow the frontmost window again.',
		{ display: z.string().describe('A monitor name from a screenshot result, or "auto"') },
		({ display }) => control({ action: { name: 'switch_display', display } }),
	),
	tool('read_clipboard', 'Read the clipboard as text.', {}, () => control({ action: { name: 'read_clipboard' } })),
	tool('write_clipboard', 'Put text on the clipboard.', { text: z.string() }, ({ text }) =>
		control({ action: { name: 'write_clipboard', text } }),
	),
	tool(
		'wait',
		'Wait, for example while something loads.',
		{ duration: z.number().describe('Seconds (up to 30)') },
		({ duration }) => control({ action: { name: 'wait', duration } }),
	),
	tool(
		'computer_batch',
		'Run several actions in one call, in order, stopping at the first that fails. Every separate tool call costs seconds, ' +
			'so batch whenever you can predict the steps: click a field, type into it, press Return, take a screenshot.',
		{ actions: z.array(batchStep).min(1) },
		({ actions }) => control({ action: { name: 'computer_batch', actions: actions.map(toAction) } }),
	),
]
