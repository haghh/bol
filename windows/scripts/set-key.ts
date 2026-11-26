// Saves an API key for the API-key backends, encrypted for your Windows account (see src/main/api/secrets.ts).
//
//   npm run set-key -- anthropic      (then paste the key; it isn't echoed)
//   npm run set-key -- openai --clear

import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { KEY_ENV, setApiKey, type KeyProvider } from '../src/main/api/secrets'

const provider = process.argv[2] as KeyProvider | undefined
if (provider == null || !(provider in KEY_ENV)) {
	console.error('Usage: npm run set-key -- <anthropic|openai|gemini> [--clear]')
	process.exit(1)
}

if (process.argv.includes('--clear')) {
	await setApiKey({ provider, key: null })
	console.log(`Removed the ${provider} key.`)
	process.exit(0)
}

// A muted output stream, so the key doesn't appear on screen while it's typed or pasted.
let isMuted = false
const output = new Writable({
	write(chunk, _encoding, done) {
		if (!isMuted) process.stdout.write(chunk)
		done()
	},
})
const rl = createInterface({ input: process.stdin, output, terminal: true })
process.stdout.write(`Paste your ${provider} API key and press Enter: `)
isMuted = true
rl.question('', async (key) => {
	isMuted = false
	rl.close()
	process.stdout.write('\n')
	if (key.trim() === '') {
		console.error('No key entered; nothing changed.')
		process.exit(1)
	}
	await setApiKey({ provider, key })
	console.log(`Saved. Set "backend": "${provider}" in %USERPROFILE%\\.bol\\settings.json to use it.`)
})
