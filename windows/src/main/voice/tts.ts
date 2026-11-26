// Text-to-speech providers. Each one only has to turn text into a WAV (`synthesize`); `speak`, which the
// contract in shared/voice.ts asks for, is synthesize + play. Keeping the two apart lets the speaker
// synthesise sentence 2 while sentence 1 is playing.

import { randomUUID } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TextToSpeech, TtsProviderId } from '../../shared/voice'
import { ensurePiper, PIPER_DEFAULT_VOICE, piperVoicesDir } from './assets'
import { listFiles, type Notice } from './download'
import { noKeyError, VoiceError } from './errors'
import { callApi, type FetchFn } from './http'
import { runPowerShell, runProcess } from './process'
import { pcmBytesToWav } from './wav'

export type AudioPlayer = {
	/** Plays a WAV; resolves when it ends or `signal` aborts. */
	play: (args: { wav: Uint8Array; signal?: AbortSignal; onLevel?: (level: number) => void }) => Promise<void>
}

export interface SynthTts extends TextToSpeech {
	synthesize(text: string, options: { voice: string | null; signal?: AbortSignal }): Promise<Uint8Array>
}

type GetKey = () => Promise<string | null>
type Voice = { id: string; name: string }

function makeTts({
	id,
	player,
	listVoices,
	synthesize,
}: {
	id: TtsProviderId
	player: AudioPlayer
	listVoices: () => Promise<Voice[]>
	synthesize: SynthTts['synthesize']
}): SynthTts {
	return {
		id,
		listVoices,
		synthesize,
		async speak(text, { voice, signal, onLevel }) {
			const wav = await synthesize(text, { voice, signal })
			if (signal?.aborted === true) return
			await player.play({ wav, signal, onLevel })
		},
	}
}

const SAPI_PRELUDE = '$ErrorActionPreference = "Stop"; [Console]::OutputEncoding = [Text.Encoding]::UTF8; Add-Type -AssemblyName System.Speech;'

export function createWindowsTts({ player }: { player: AudioPlayer }): SynthTts {
	return makeTts({
		id: 'windows',
		player,
		async listVoices() {
			const res = await runPowerShell({
				script: `${SAPI_PRELUDE} $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name }`,
				timeoutMs: 20_000,
			})
			if (res.code !== 0) throw new VoiceError({ kind: 'failed', message: "Couldn't list the Windows voices." })
			return res.stdout
				.toString('utf8')
				.split(/\r?\n/)
				.map((n) => n.trim())
				.filter((n) => n !== '')
				.map((name) => ({ id: name, name }))
		},
		async synthesize(text, { voice, signal }) {
			const base = join(tmpdir(), `bol-tts-${randomUUID()}`)
			await writeFile(`${base}.txt`, text, 'utf8')
			try {
				// An unknown voice name (say, left over from another provider) falls back to the default voice.
				const res = await runPowerShell({
					script: `${SAPI_PRELUDE} $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; try { if ($env:BOL_VOICE) { $s.SelectVoice($env:BOL_VOICE) } } catch {}; $s.SetOutputToWaveFile($env:BOL_OUT); $s.Speak([IO.File]::ReadAllText($env:BOL_TEXT, [Text.Encoding]::UTF8)); $s.Dispose()`,
					env: { BOL_VOICE: voice ?? '', BOL_OUT: `${base}.wav`, BOL_TEXT: `${base}.txt` },
					signal,
					timeoutMs: 60_000,
				})
				if (res.code !== 0) throw new VoiceError({ kind: 'failed', message: "Windows couldn't speak that. Is a voice installed?" })
				return new Uint8Array(await readFile(`${base}.wav`))
			} finally {
				await Promise.all([rm(`${base}.txt`, { force: true }), rm(`${base}.wav`, { force: true })])
			}
		},
	})
}

export const OPENAI_VOICES = ['coral', 'alloy', 'ash', 'ballad', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse']

export function createOpenAiTts({ player, getKey, fetchFn = fetch }: { player: AudioPlayer; getKey: GetKey; fetchFn?: FetchFn }): SynthTts {
	return makeTts({
		id: 'openai',
		player,
		listVoices: async () => OPENAI_VOICES.map((v) => ({ id: v, name: v })),
		async synthesize(text, { voice, signal }) {
			const key = await getKey()
			if (key == null) throw noKeyError({ provider: 'OpenAI' })
			const res = await callApi({
				provider: 'OpenAI',
				fetchFn,
				url: 'https://api.openai.com/v1/audio/speech',
				init: {
					method: 'POST',
					headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
					body: JSON.stringify({
						model: 'gpt-4o-mini-tts',
						input: text,
						voice: voice != null && OPENAI_VOICES.includes(voice) ? voice : OPENAI_VOICES[0],
						response_format: 'wav',
					}),
				},
				signal,
			})
			return new Uint8Array(await res.arrayBuffer())
		},
	})
}

/** "Rachel", one of ElevenLabs' stock voices, for when nothing is chosen. */
export const ELEVENLABS_DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM'
const ELEVENLABS_PCM_RATE = 24_000

export function createElevenLabsTts({ player, getKey, fetchFn = fetch }: { player: AudioPlayer; getKey: GetKey; fetchFn?: FetchFn }): SynthTts {
	return makeTts({
		id: 'elevenlabs',
		player,
		async listVoices() {
			const key = await getKey()
			if (key == null) throw noKeyError({ provider: 'ElevenLabs' })
			const res = await callApi({ provider: 'ElevenLabs', fetchFn, url: 'https://api.elevenlabs.io/v1/voices', init: { headers: { 'xi-api-key': key } } })
			const json = (await res.json()) as { voices?: { voice_id?: unknown; name?: unknown }[] }
			return (json.voices ?? []).flatMap((v) => (typeof v.voice_id === 'string' ? [{ id: v.voice_id, name: typeof v.name === 'string' ? v.name : v.voice_id }] : []))
		},
		async synthesize(text, { voice, signal }) {
			const key = await getKey()
			if (key == null) throw noKeyError({ provider: 'ElevenLabs' })
			// Voice ids are 20 letters and digits; anything else (a name from another provider) means "default".
			const id = voice != null && /^[A-Za-z0-9]{20}$/.test(voice) ? voice : ELEVENLABS_DEFAULT_VOICE
			const res = await callApi({
				provider: 'ElevenLabs',
				fetchFn,
				url: `https://api.elevenlabs.io/v1/text-to-speech/${id}?output_format=pcm_${ELEVENLABS_PCM_RATE}`,
				init: {
					method: 'POST',
					headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
					body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5' }),
				},
				signal,
			})
			return pcmBytesToWav({ bytes: new Uint8Array(await res.arrayBuffer()), sampleRate: ELEVENLABS_PCM_RATE })
		},
	})
}

export function createPiperTts({ player, root, notice, fetchFn }: { player: AudioPlayer; root: string; notice?: Notice; fetchFn?: FetchFn }): SynthTts {
	const installed = async () => (await listFiles({ dir: piperVoicesDir({ root }), extension: '.onnx' })).map((f) => f.replace(/\.onnx$/i, ''))
	return makeTts({
		id: 'piper',
		player,
		async listVoices() {
			const names = new Set([PIPER_DEFAULT_VOICE, ...(await installed())])
			return [...names].map((name) => ({ id: name, name }))
		},
		async synthesize(text, { voice, signal }) {
			const have = await installed()
			const name = voice != null && (have.includes(voice) || voice === PIPER_DEFAULT_VOICE) ? voice : PIPER_DEFAULT_VOICE
			const { exe, dir, modelPath } = await ensurePiper({ root, voice: name, notice, fetchFn })
			const out = join(tmpdir(), `bol-piper-${randomUUID()}.wav`)
			try {
				const res = await runProcess({ file: exe, args: ['--model', modelPath, '--output_file', out, '--quiet'], input: text, cwd: dir, signal, timeoutMs: 60_000 })
				if (res.code !== 0) throw new VoiceError({ kind: 'failed', message: "Piper couldn't speak that." })
				return new Uint8Array(await readFile(out))
			} finally {
				await rm(out, { force: true })
			}
		},
	})
}

/** A natural Chirp 3 HD voice, for when nothing is chosen (1M free characters a month). */
export const GOOGLE_DEFAULT_VOICE = 'en-US-Chirp3-HD-Kore'
const GOOGLE_PCM_RATE = 24_000
const GOOGLE_API = 'https://texttospeech.googleapis.com/v1'
/** Voice families worth offering, most natural first. Studio, Polyglot and the rest are left out. */
const GOOGLE_FAMILIES = [
	{ tag: 'Chirp3-HD', label: 'Chirp 3 HD' },
	{ tag: 'Neural2', label: 'Neural2' },
	{ tag: 'Wavenet', label: 'WaveNet' },
	{ tag: 'Standard', label: 'Standard' },
]

/** Google voice names start with their language: "en-US-Chirp3-HD-Kore" is en-US. */
function googleLanguage({ voice }: { voice: string }): string {
	return voice.split('-').slice(0, 2).join('-')
}

export function createGoogleTts({
	player,
	getKey,
	getLanguage,
	fetchFn = fetch,
}: {
	player: AudioPlayer
	getKey: GetKey
	/** The spoken language setting ("en"), so the voice list isn't hundreds long; null means English. */
	getLanguage: () => string | null
	fetchFn?: FetchFn
}): SynthTts {
	// The key goes in a header, not the URL, so it can't end up in a log line.
	const headers = (key: string) => ({ 'X-Goog-Api-Key': key, 'Content-Type': 'application/json' })
	return makeTts({
		id: 'google',
		player,
		async listVoices() {
			const key = await getKey()
			if (key == null) throw noKeyError({ provider: 'Google Cloud' })
			const language = getLanguage() ?? 'en'
			const res = await callApi({ provider: 'Google Cloud', fetchFn, url: `${GOOGLE_API}/voices?languageCode=${encodeURIComponent(language)}`, init: { headers: headers(key) } })
			const json = (await res.json()) as { voices?: { name?: unknown; ssmlGender?: unknown }[] }
			const voices = (json.voices ?? []).flatMap((v) => {
				if (typeof v.name !== 'string') return []
				const name = v.name
				const rank = GOOGLE_FAMILIES.findIndex((f) => name.includes(`-${f.tag}-`))
				if (rank < 0) return []
				const gender = typeof v.ssmlGender === 'string' && v.ssmlGender !== 'SSML_VOICE_GENDER_UNSPECIFIED' ? `, ${v.ssmlGender.toLowerCase()}` : ''
				const short = name.slice(name.indexOf(`-${GOOGLE_FAMILIES[rank]?.tag}-`) + (GOOGLE_FAMILIES[rank]?.tag.length ?? 0) + 2)
				return [{ id: name, name: `${short} (${GOOGLE_FAMILIES[rank]?.label}, ${googleLanguage({ voice: name })}${gender})`, rank }]
			})
			voices.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))
			return voices.map(({ id, name }) => ({ id, name }))
		},
		async synthesize(text, { voice, signal }) {
			const key = await getKey()
			if (key == null) throw noKeyError({ provider: 'Google Cloud' })
			// Anything that isn't a Google voice name (one left over from another provider) means the default.
			const name = voice != null && /^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9-]+$/.test(voice) ? voice : GOOGLE_DEFAULT_VOICE
			const res = await callApi({
				provider: 'Google Cloud',
				fetchFn,
				url: `${GOOGLE_API}/text:synthesize`,
				init: {
					method: 'POST',
					headers: headers(key),
					body: JSON.stringify({
						input: { text },
						voice: { languageCode: googleLanguage({ voice: name }), name },
						audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: GOOGLE_PCM_RATE },
					}),
				},
				signal,
			})
			const json = (await res.json()) as { audioContent?: unknown }
			if (typeof json.audioContent !== 'string') throw new VoiceError({ kind: 'failed', message: 'Google Cloud sent back no audio.' })
			const audio = new Uint8Array(Buffer.from(json.audioContent, 'base64'))
			// LINEAR16 comes with a WAV header; wrap it ourselves if one ever doesn't.
			const isWav = audio.byteLength >= 4 && String.fromCharCode(...audio.subarray(0, 4)) === 'RIFF'
			return isWav ? audio : pcmBytesToWav({ bytes: audio, sampleRate: GOOGLE_PCM_RATE })
		},
	})
}
