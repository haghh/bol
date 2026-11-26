// Speech-to-text providers. All run in the main process (keys stay out of the renderer): the bar records,
// sends the clip over IPC, and gets text back.

import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AudioClip, SpeechToText } from '../../shared/voice'
import { ensureWhisper, type WhisperModel } from './assets'
import type { Notice } from './download'
import { noKeyError, VoiceError } from './errors'
import { callApi, type FetchFn } from './http'
import { runProcess } from './process'
import { cleanTranscript } from './text'
import { clipToWav } from './wav'

type GetKey = () => Promise<string | null>

/** Written like a previous transcript: Whisper copies its spelling, names and punctuation. */
const WHISPER_PROMPT =
	'Hey Bol, open Chrome and check my Gmail. Play something on Spotify. Open VS Code, PowerShell and File Explorer. ' +
	'Reply on WhatsApp, Discord, Outlook or Teams. Make an Excel sheet, a Word doc, a PDF. Ask Claude. Search YouTube.'

export function createWhisperLocalStt({
	root,
	getModel,
	notice,
	fetchFn,
}: {
	root: string
	getModel: () => WhisperModel
	notice?: Notice
	fetchFn?: FetchFn
}): SpeechToText {
	return {
		id: 'whisper-local',
		async transcribe(clip: AudioClip, { language, signal }) {
			const { exe, modelPath } = await ensureWhisper({ root, model: getModel(), notice, fetchFn })
			const wavPath = join(tmpdir(), `bol-stt-${randomUUID()}.wav`)
			await writeFile(wavPath, clipToWav({ clip }))
			try {
				const threads = String(Math.min(8, Math.max(1, cpus().length - 1)))
				const args = ['-m', modelPath, '-f', wavPath, '-nt', '-np', '-t', threads, '-l', language ?? 'auto', '-bs', '5', '--suppress-nst']
				// The prompt teaches Whisper the words a PC assistant hears (it otherwise writes "bowl" and "V S code").
				// It's English, so it's left out when another language is set, where it would pull the transcript to English.
				if (language == null || language === 'en') args.push('--prompt', WHISPER_PROMPT)
				const res = await runProcess({ file: exe, args, signal, timeoutMs: 120_000 })
				if (res.code !== 0) throw new VoiceError({ kind: 'failed', message: "Whisper couldn't transcribe that." })
				return cleanTranscript({ text: res.stdout.toString('utf8') })
			} finally {
				await rm(wavPath, { force: true })
			}
		},
	}
}

export function createOpenAiStt({ getKey, fetchFn = fetch }: { getKey: GetKey; fetchFn?: FetchFn }): SpeechToText {
	return {
		id: 'openai',
		async transcribe(clip, { language, signal }) {
			const key = await getKey()
			if (key == null) throw noKeyError({ provider: 'OpenAI' })
			const form = new FormData()
			form.append('file', new Blob([clipToWav({ clip }) as BlobPart], { type: 'audio/wav' }), 'speech.wav')
			form.append('model', 'gpt-4o-mini-transcribe')
			form.append('response_format', 'json')
			if (language != null) form.append('language', language)
			const res = await callApi({
				provider: 'OpenAI',
				fetchFn,
				url: 'https://api.openai.com/v1/audio/transcriptions',
				init: { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form },
				signal,
			})
			const json = (await res.json()) as { text?: unknown }
			return typeof json.text === 'string' ? json.text.trim() : ''
		},
	}
}

export function createDeepgramStt({ getKey, fetchFn = fetch }: { getKey: GetKey; fetchFn?: FetchFn }): SpeechToText {
	return {
		id: 'deepgram',
		async transcribe(clip, { language, signal }) {
			const key = await getKey()
			if (key == null) throw noKeyError({ provider: 'Deepgram' })
			const query = new URLSearchParams({ model: 'nova-3', smart_format: 'true' })
			if (language != null) query.set('language', language)
			else query.set('detect_language', 'true')
			const res = await callApi({
				provider: 'Deepgram',
				fetchFn,
				url: `https://api.deepgram.com/v1/listen?${query}`,
				init: { method: 'POST', headers: { Authorization: `Token ${key}`, 'Content-Type': 'audio/wav' }, body: clipToWav({ clip }) as BodyInit },
				signal,
			})
			const json = (await res.json()) as { results?: { channels?: { alternatives?: { transcript?: unknown }[] }[] } }
			const transcript = json.results?.channels?.[0]?.alternatives?.[0]?.transcript
			return typeof transcript === 'string' ? transcript.trim() : ''
		},
	}
}
