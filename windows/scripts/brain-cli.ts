// Step 1 of the build order: the brain on Windows, text in and text out, no Electron.
//
//   npm run brain            (type a request, press Enter; Ctrl+C to quit)
//   npm run brain -- --log   (also print the brain's log lines)
//
// Commands: /new starts a new conversation, /stop interrupts, /mcp shows MCP status.
// Computer control works here too, through the same PowerShell layer the app uses.

import { createInterface } from 'node:readline'
import { createClaudeCodeEngine } from '../src/main/brain/index'
import { setControlExecutor } from '../src/main/brain/control'
import { onEvent } from '../src/main/brain/protocol'
import { createWindowsControl } from '../src/main/native/windows-control'
import { loadSettings } from '../src/main/settings-store'

const isLogging = process.argv.includes('--log')
const settings = await loadSettings()
const engine = createClaudeCodeEngine({ settings })
const control = process.platform === 'win32' ? createWindowsControl() : null
setControlExecutor(control?.executor ?? null)

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' })
let seq = 0

onEvent((event) => {
	const tag = 'job' in event && event.job != null ? `[${event.job}] ` : ''
	switch (event.type) {
		case 'ready':
			console.log(dim(`Bol is ready (${event.backend}). Type a request.`))
			rl.prompt()
			break
		case 'log':
			if (isLogging) console.log(dim(`log: ${event.msg}`))
			break
		case 'tool':
			console.log(dim(`${tag}· ${event.name.replace(/^mcp__bol__/, '')}${event.summary === '' ? '' : `: ${event.summary}`}`))
			break
		case 'screen':
			console.log(dim(`${tag}· looking at the screen: ${event.reason}`))
			break
		case 'blocked':
			console.log(`${tag}✋ blocked ${event.tool}: ${event.reason}`)
			break
		case 'result':
			if (event.isInterrupted) console.log(dim('(stopped)'))
			else console.log(`${tag}${event.isError ? '⚠ ' : ''}Bol: ${event.text}`)
			if (event.job == null) rl.prompt()
			break
		case 'task':
			console.log(dim(`task "${event.name}" ${event.status}`))
			break
		case 'mcpStatus':
			for (const s of event.servers) console.log(dim(`mcp ${s.name}: ${s.status}${s.error == null ? '' : ` (${s.error})`}`))
			for (const p of event.problems) console.log(dim(`mcp.json ${p.name}: ${p.error}`))
			break
		default:
			break
	}
})

rl.on('line', (line) => {
	const text = line.trim()
	if (text === '') return rl.prompt()
	if (text === '/new') void engine.send({ type: 'reset' }).then(() => rl.prompt())
	else if (text === '/stop') void engine.send({ type: 'interrupt' })
	else if (text === '/mcp') void engine.send({ type: 'mcpStatus' })
	else void engine.send({ type: 'say', text, seq: ++seq })
})
rl.on('close', () => {
	engine.close()
	control?.close()
	process.exit(0)
})

try {
	await engine.start()
} catch (e) {
	console.error(e instanceof Error ? e.message : e)
	process.exit(1)
}
