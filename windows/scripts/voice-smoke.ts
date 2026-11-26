// Smoke test for the local voice engines on a real Windows PC: downloads whisper.cpp and Piper into a
// scratch folder (first run only), speaks a sentence with Windows voices and with Piper, and checks Whisper
// hears it back. Run: npm run voice:smoke   (needs Windows and a network for the first run)

import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AudioClip } from '../src/shared/voice'
import { createWhisperLocalStt } from '../src/main/voice/stt'
import { createPiperTts, createWindowsTts } from '../src/main/voice/tts'
import { readWavHeader } from '../src/main/voice/wav'

const root = process.env.BOL_VOICE_ROOT ?? join(homedir(), '.bol', 'voice')
await mkdir(root, { recursive: true })
const notice = (text: string) => console.log(`  ${text}`)
const player = { play: async () => {} }
const phrase = 'Open notepad and write hello world.'

function toClip({ wav }: { wav: Uint8Array }): AudioClip {
	const header = readWavHeader({ wav })
	if (header == null) throw new Error('not a WAV')
	const samples = new Int16Array(wav.buffer.slice(wav.byteOffset + header.dataOffset, wav.byteOffset + wav.byteLength))
	// Naive resample to 16 kHz by picking samples; good enough for a smoke test.
	const ratio = header.sampleRate / 16_000
	const out = new Int16Array(Math.floor(samples.length / ratio))
	for (let i = 0; i < out.length; i++) out[i] = samples[Math.floor(i * ratio)] ?? 0
	return { pcm16: out, sampleRate: 16_000 }
}

const stt = createWhisperLocalStt({ root, getModel: () => 'base', notice })

for (const [name, tts] of [
	['Windows voices', createWindowsTts({ player })],
	['Piper', createPiperTts({ player, root, notice })],
] as const) {
	console.log(`\n${name}`)
	const voices = await tts.listVoices()
	console.log(`  voices: ${voices.map((v) => v.name).slice(0, 5).join(', ')}${voices.length > 5 ? ', …' : ''}`)
	const started = Date.now()
	const wav = await tts.synthesize(phrase, { voice: null })
	console.log(`  synthesised ${wav.byteLength} bytes in ${Date.now() - started} ms`)
	const heard = await stt.transcribe(toClip({ wav }), {})
	console.log(`  Whisper heard: "${heard}"`)
	if (!/notepad/i.test(heard) || !/hello/i.test(heard)) throw new Error(`${name}: round trip failed`)
}
console.log('\nOK')
