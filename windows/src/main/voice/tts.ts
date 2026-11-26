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
