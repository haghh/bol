import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// Bol keeps everything under ~/.bol: point home at a scratch folder before anything reads it.
process.env.HOME = await mkdtemp(join(tmpdir(), 'bol-test-'))
process.env.USERPROFILE = process.env.HOME

const { MockLanguageModelV4 } = await import('ai/test')
const { createApiEngine, dropOldImages } = await import('./engine')
const { onEvent } = await import('../brain/protocol')
const { parseSettings } = await import('../../shared/settings')

const usage = {
	inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
}
const toolCall = (toolName: string, input: unknown) => ({
	content: [{ type: 'tool-call' as const, toolCallId: `call-${toolName}`, toolName, input: JSON.stringify(input) }],
	finishReason: { unified: 'tool-calls' as const, raw: 'tool_use' },
	usage,
	warnings: [],
})
const answer = (text: string) => ({
	content: [{ type: 'text' as const, text }],
	finishReason: { unified: 'stop' as const, raw: 'end_turn' },
	usage,
	warnings: [],
})

function collect() {
	const events: any[] = []
	const off = onEvent((e) => events.push(e))
	const idle = new Promise<void>((resolve) => {
		const stop = onEvent((e) => {
			if (e.type === 'idle') {
				stop()
				resolve()
			}
		})
	})
	return { events, idle, off }
}

test('runs a tool, then answers, with the same events as the Claude Code engine', async () => {
	const model = new MockLanguageModelV4({
		doGenerate: [toolCall('run_command', { command: 'echo hello-from-shell' }), answer('Done, it said hello.')],
	})
	const engine = createApiEngine({ settings: parseSettings({ backend: 'anthropic', screen: 'off' }), languageModel: model })
	const { events, idle, off } = collect()
	await engine.start()
	await engine.send({ type: 'say', text: 'say hello in the shell', seq: 1 })
	await idle
	off()
	engine.close()

	const tool = events.find((e) => e.type === 'tool')
	assert.equal(tool?.name, 'run_command')
	const result = events.find((e) => e.type === 'result')
	assert.deepEqual(result, { type: 'result', text: 'Done, it said hello.', isError: false })
	// The tool's output went back to the model on the second call.
	const second = JSON.stringify(model.doGenerateCalls[1]?.prompt)
	assert.match(second, /hello-from-shell/)
})

test('refuses a hard-blocked command without running it', async () => {
	const model = new MockLanguageModelV4({
		doGenerate: [toolCall('run_command', { command: 'rm -rf ~' }), answer('That was blocked.')],
	})
	const engine = createApiEngine({ settings: parseSettings({ backend: 'openai', screen: 'off' }), languageModel: model })
	const { events, idle, off } = collect()
	await engine.start()
	await engine.send({ type: 'say', text: 'wipe my home folder', seq: 2 })
	await idle
	off()
	engine.close()

	assert.ok(events.some((e) => e.type === 'blocked' && e.tool === 'run_command'))
	assert.match(JSON.stringify(model.doGenerateCalls[1]?.prompt), /Blocked by Bol's safety list/)
})

test('says what to do when there is no API key', async () => {
	delete process.env.GOOGLE_GENERATIVE_AI_API_KEY
	const engine = createApiEngine({ settings: parseSettings({ backend: 'gemini', screen: 'off' }) })
	const { events, idle, off } = collect()
	await engine.start()
	await engine.send({ type: 'say', text: 'hi', seq: 3 })
	await idle
	off()
	engine.close()
	const result = events.find((e) => e.type === 'result')
	assert.equal(result?.isError, true)
	assert.match(result?.text, /no Google Gemini API key/)
})

test('drops screenshots from earlier turns', () => {
	const messages = dropOldImages({
		messages: [
			{
				role: 'tool',
				content: [
					{
						type: 'tool-result',
						toolCallId: 'a',
						toolName: 'screenshot',
						output: {
							type: 'content',
							value: [
								{ type: 'text', text: 'Screenshot' },
								{ type: 'file', mediaType: 'image/jpeg', data: { type: 'data', data: 'AAAA' } },
							],
						},
					},
				],
			} as any,
		],
	})
	assert.doesNotMatch(JSON.stringify(messages), /AAAA/)
	assert.match(JSON.stringify(messages), /no longer attached/)
})

test("passes Bol's own control tools through, with their results", async () => {
	const model = new MockLanguageModelV4({
		doGenerate: [toolCall('screenshot', {}), answer('I can see the screen.')],
	})
	const engine = createApiEngine({ settings: parseSettings({ backend: 'anthropic' }), languageModel: model })
	const { events, idle, off } = collect()
	await engine.start()
	await engine.send({ type: 'say', text: 'what is on my screen', seq: 4 })
	await idle
	off()
	engine.close()
	const tools = (model.doGenerateCalls[0]?.tools ?? []).map((t: any) => t.name)
	for (const name of ['run_command', 'read_file', 'write_file', 'move_to_recycle_bin', 'look_at_screen', 'left_click', 'computer_batch'])
		assert.ok(tools.includes(name), name)
	assert.equal(events.find((e) => e.type === 'tool')?.name, 'mcp__bol__screenshot')
	// No executor is registered in tests, so the tool reports that rather than throwing.
	assert.match(JSON.stringify(model.doGenerateCalls[1]?.prompt), /not available in this build/)
})
