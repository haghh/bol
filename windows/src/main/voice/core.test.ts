import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSecretStore, type SecretCrypto } from '../secrets'
import { parseHotkey } from './hotkey'
import { cleanForSpeech, cleanTranscript, splitForSpeech } from './text'
import { clipToWav, isSilent, pcmBytesToWav, prepareClip, readWavHeader } from './wav'

test('parseHotkey: Alt+Space and friends', () => {
	assert.deepEqual(parseHotkey({ accelerator: 'Alt+Space' }), { vk: 0x20, isAlt: true, isCtrl: false, isShift: false, isWin: false })
	assert.deepEqual(parseHotkey({ accelerator: 'CommandOrControl+Shift+K' }), { vk: 0x4b, isAlt: false, isCtrl: true, isShift: true, isWin: false })
	assert.equal(parseHotkey({ accelerator: 'Super+F9' })?.vk, 0x78)
	assert.equal(parseHotkey({ accelerator: 'F8' })?.vk, 0x77) // a function key may stand alone
})

test('parseHotkey: rejects what could swallow typing or can not be hooked', () => {
	assert.equal(parseHotkey({ accelerator: 'Space' }), null) // no modifier
	assert.equal(parseHotkey({ accelerator: 'Alt' }), null) // no key
	assert.equal(parseHotkey({ accelerator: 'Alt+A+B' }), null) // two keys
	assert.equal(parseHotkey({ accelerator: 'Alt+Banana' }), null)
	assert.equal(parseHotkey({ accelerator: '' }), null)
})

test('cleanForSpeech drops markdown, code and links', () => {
	const text = '# Done\n\nI ran **three** steps:\n- opened `notepad`\n- see [the docs](https://example.com/x)\n\n```ts\nconst a = 1\n```\nVisit https://example.com now.'
	const spoken = cleanForSpeech({ text })
	assert.ok(!/[`*#\[\]]|https?:/.test(spoken), spoken)
	assert.match(spoken, /I ran three steps/)
	assert.match(spoken, /opened notepad/)
	assert.match(spoken, /the docs/)
	assert.match(spoken, /code omitted/)
	assert.equal(cleanForSpeech({ text: '   ' }), '')
})

test('cleanForSpeech caps very long replies at a sentence', () => {
	const spoken = cleanForSpeech({ text: 'This is a sentence. '.repeat(200) })
	assert.ok(spoken.length <= 1500)
	assert.ok(spoken.endsWith('.'))
})

test('splitForSpeech keeps sentences whole and chunks bounded', () => {
	assert.deepEqual(splitForSpeech({ text: 'Hello there. How are you?' }), ['Hello there. How are you?'])
	const long = 'word '.repeat(200).trim() + '.'
	const chunks = splitForSpeech({ text: long })
	assert.ok(chunks.length > 1)
	assert.ok(chunks.every((c) => c.length <= 280))
	assert.equal(chunks.join(' ').replace(/\s+/g, ' '), long)
	const many = splitForSpeech({ text: Array.from({ length: 30 }, (_, i) => `Sentence number ${i}.`).join(' ') })
	assert.ok(many.every((c) => c.length <= 280))
	assert.ok(many.length >= 2)
})

test('cleanTranscript removes whisper.cpp annotations', () => {
	assert.equal(cleanTranscript({ text: ' [BLANK_AUDIO]\n' }), '')
	assert.equal(cleanTranscript({ text: ' open notepad (music)\n' }), 'open notepad')
})

test('WAV encoding and header', () => {
	const clip = { pcm16: Int16Array.from([0, 1000, -1000, 32767]), sampleRate: 16_000 }
	const wav = clipToWav({ clip })
	assert.equal(wav.byteLength, 44 + 8)
	assert.deepEqual(readWavHeader({ wav }), { sampleRate: 16_000, dataOffset: 44 })
	assert.equal(new DataView(wav.buffer).getInt16(44 + 6, true), 32767)
	assert.equal(readWavHeader({ wav: new Uint8Array(10) }), null)
	assert.equal(readWavHeader({ wav: pcmBytesToWav({ bytes: new Uint8Array(4), sampleRate: 24_000 }) })?.sampleRate, 24_000)
})

test('isSilent', () => {
	assert.equal(isSilent({ clip: { pcm16: new Int16Array(16_000), sampleRate: 16_000 } }), true)
	assert.equal(isSilent({ clip: { pcm16: Int16Array.from([0, 5000, -4000]), sampleRate: 16_000 } }), false)
})

test('prepareClip trims the silence around speech and raises a quiet voice', () => {
	const rate = 16_000
	// 1 s of near-silence, 0.5 s of a quiet tone, 1 s of near-silence.
	const pcm16 = new Int16Array(rate * 2.5)
	for (let i = 0; i < pcm16.length; i++) pcm16[i] = i % 7 === 0 ? 20 : 0
	for (let i = rate; i < rate * 1.5; i++) pcm16[i] = Math.round(2000 * Math.sin(i / 5))
	const out = prepareClip({ clip: { pcm16, sampleRate: rate } })
	const seconds = out.pcm16.length / rate
	assert.ok(seconds > 0.9 && seconds < 1.1, `kept ${seconds}s`) // the speech plus 0.25 s each side
	const peak = Math.max(...out.pcm16.map(Math.abs))
	assert.ok(peak > 14_000 && peak <= 32_767, `peak ${peak}`)
	// A loud clip is left at its level.
	const loud = Int16Array.from({ length: rate }, (_, i) => Math.round(30_000 * Math.sin(i / 5)))
	assert.deepEqual(prepareClip({ clip: { pcm16: loud, sampleRate: rate } }).pcm16, loud)
})

// A reversible fake of the OS store, so the test can prove the file holds ciphertext.
const fakeCrypto: SecretCrypto & { isOn: boolean } = {
	isOn: true,
	isAvailable() {
		return this.isOn
	},
	encrypt: (text) => Buffer.from(text.split('').reverse().join('') + '#enc'),
	decrypt: (data) => data.toString().replace(/#enc$/, '').split('').reverse().join(''),
}

test('secret store: round trip, ciphertext on disk, removal', async () => {
	const file = join(await mkdtemp(join(tmpdir(), 'bol-secrets-')), 'secrets.json')
	const store = createSecretStore({ file, crypto: fakeCrypto })
	assert.equal(await store.get({ name: 'openai' }), null)
	await store.set({ name: 'openai', value: '  sk-test-123  ' })
	assert.equal(await store.get({ name: 'openai' }), 'sk-test-123')
	assert.ok(!(await readFile(file, 'utf8')).includes('sk-test-123'))
	assert.deepEqual(await store.has({ names: ['openai', 'deepgram'] }), { openai: true, deepgram: false })
	await store.set({ name: 'openai', value: null })
	assert.equal(await store.get({ name: 'openai' }), null)
})

test('secret store: refuses to save in plain text, and rejects junk keys', async () => {
	const file = join(await mkdtemp(join(tmpdir(), 'bol-secrets-')), 'secrets.json')
	const store = createSecretStore({ file, crypto: { ...fakeCrypto, isAvailable: () => false } })
	await assert.rejects(store.set({ name: 'openai', value: 'sk-abc' }), /Secure storage/)
	const ok = createSecretStore({ file, crypto: fakeCrypto })
	await assert.rejects(ok.set({ name: 'openai', value: 'two words' }), /API key/)
	assert.equal(await ok.get({ name: 'openai' }), null)
})

test('secret store: two quick saves both land', async () => {
	const file = join(await mkdtemp(join(tmpdir(), 'bol-secrets-')), 'secrets.json')
	const store = createSecretStore({ file, crypto: fakeCrypto })
	await Promise.all([store.set({ name: 'openai', value: 'a1' }), store.set({ name: 'deepgram', value: 'b2' })])
	assert.equal(await store.get({ name: 'openai' }), 'a1')
	assert.equal(await store.get({ name: 'deepgram' }), 'b2')
})
