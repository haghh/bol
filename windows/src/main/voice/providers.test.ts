import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isAbortError, toVoiceError, VoiceError } from './errors'
import { createSpeaker } from './speaker'
import { createDeepgramStt, createOpenAiStt } from './stt'
import { createElevenLabsTts, createOpenAiTts, type AudioPlayer, type SynthTts } from './tts'

type Call = { url: string; init: RequestInit }
function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
	const calls: Call[] = []
	const fn = (async (url: string | URL | Request, init?: RequestInit) => {
		const call = { url: String(url), init: init ?? {} }
		calls.push(call)
		return respond(call)
	}) as typeof fetch
	return { fn, calls }
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const clip = { pcm16: Int16Array.from([0, 4000, -4000, 2000]), sampleRate: 16_000 }
const silentPlayer: AudioPlayer = { play: async () => {} }

test('OpenAI STT: sends the key and the audio, returns the text', async () => {
	const { fn, calls } = fakeFetch(() => json({ text: ' open notepad ' }))
	const stt = createOpenAiStt({ getKey: async () => 'sk-test', fetchFn: fn })
	assert.equal(await stt.transcribe(clip, { language: 'en' }), 'open notepad')
	assert.equal(calls[0]?.url, 'https://api.openai.com/v1/audio/transcriptions')
	assert.equal((calls[0]?.init.headers as Record<string, string>).Authorization, 'Bearer sk-test')
	const form = calls[0]?.init.body as FormData
	assert.equal(form.get('language'), 'en')
	assert.ok(form.get('file') instanceof Blob)
})

test('Deepgram STT: parses the transcript; detects language when none is set', async () => {
	const { fn, calls } = fakeFetch(() => json({ results: { channels: [{ alternatives: [{ transcript: 'hello world' }] }] } }))
	const stt = createDeepgramStt({ getKey: async () => 'dg-key', fetchFn: fn })
	assert.equal(await stt.transcribe(clip, {}), 'hello world')
	assert.match(calls[0]?.url ?? '', /detect_language=true/)
	assert.equal((calls[0]?.init.headers as Record<string, string>).Authorization, 'Token dg-key')
	await stt.transcribe(clip, { language: 'es' })
	assert.match(calls[1]?.url ?? '', /language=es/)
})

test('providers: missing key, bad key, quota, server, no network', async () => {
	const noKey = createOpenAiStt({ getKey: async () => null, fetchFn: fakeFetch(() => json({})).fn })
	await assert.rejects(noKey.transcribe(clip, {}), (e: VoiceError) => e.kind === 'no-key' && /OpenAI API key/.test(e.message))

	const status = (code: number) => createDeepgramStt({ getKey: async () => 'k', fetchFn: fakeFetch(() => json({ err_msg: 'secret detail' }, code)).fn })
	await assert.rejects(status(401).transcribe(clip, {}), (e: VoiceError) => e.kind === 'bad-key' && !/secret detail/.test(e.message))
	await assert.rejects(status(429).transcribe(clip, {}), (e: VoiceError) => e.kind === 'quota')
	await assert.rejects(status(503).transcribe(clip, {}), (e: VoiceError) => e.kind === 'network')

	const offline = createOpenAiStt({
		getKey: async () => 'k',
		fetchFn: (async () => {
			throw new TypeError('fetch failed')
		}) as typeof fetch,
	})
	await assert.rejects(offline.transcribe(clip, {}).catch((e) => Promise.reject(toVoiceError({ error: e, provider: 'OpenAI' }))), (e: VoiceError) => e.kind === 'network' && /No network/.test(e.message))
})

test('an abort from the caller stays an abort', async () => {
	const controller = new AbortController()
	const fetchFn = ((_url: string, init?: RequestInit) =>
		new Promise((_resolve, reject) => {
			const abort = () => reject(new DOMException('Aborted', 'AbortError')) // like real fetch: also when already aborted
			if (init?.signal?.aborted === true) abort()
			else init?.signal?.addEventListener('abort', abort)
		})) as unknown as typeof fetch
	const stt = createOpenAiStt({ getKey: async () => 'k', fetchFn })
	const pending = stt.transcribe(clip, { signal: controller.signal })
	controller.abort()
	await assert.rejects(pending, (e: unknown) => isAbortError(e))
})

test('OpenAI TTS: asks for WAV, falls back to the default voice for unknown names', async () => {
	const { fn, calls } = fakeFetch(() => new Response(new Uint8Array([1, 2, 3])))
	const tts = createOpenAiTts({ player: silentPlayer, getKey: async () => 'k', fetchFn: fn })
	assert.deepEqual([...(await tts.synthesize('hi', { voice: 'Microsoft David Desktop' }))], [1, 2, 3])
	const body = JSON.parse(String(calls[0]?.init.body)) as { voice: string; response_format: string; input: string }
	assert.equal(body.voice, 'coral')
	assert.equal(body.response_format, 'wav')
	await tts.synthesize('hi', { voice: 'onyx' })
	assert.equal((JSON.parse(String(calls[1]?.init.body)) as { voice: string }).voice, 'onyx')
})

test('ElevenLabs TTS: wraps PCM in a WAV, lists voices, validates the voice id', async () => {
	const { fn, calls } = fakeFetch((call) => (call.url.endsWith('/v1/voices') ? json({ voices: [{ voice_id: 'abc', name: 'Ann' }, { name: 'broken' }] }) : new Response(new Uint8Array(10))))
	const played: Uint8Array[] = []
	const tts = createElevenLabsTts({ player: { play: async ({ wav }) => void played.push(wav) }, getKey: async () => 'xi', fetchFn: fn })
	assert.deepEqual(await tts.listVoices(), [{ id: 'abc', name: 'Ann' }])
	await tts.speak('hello', { voice: 'not-an-id' })
	assert.match(calls[1]?.url ?? '', /text-to-speech\/21m00Tcm4TlvDq8ikWAM\?output_format=pcm_24000/)
	assert.equal(played[0]?.byteLength, 54)
	assert.equal((calls[1]?.init.headers as Record<string, string>)['xi-api-key'], 'xi')
})

function fakeTts({ synth }: { synth: (text: string, signal?: AbortSignal) => Promise<Uint8Array> }): SynthTts {
	return { id: 'windows', listVoices: async () => [], synthesize: (text, { signal }) => synth(text, signal), speak: async () => {} }
}

test('speaker: speaks sentences in order, prefetching the next while one plays', async () => {
	const log: string[] = []
	const tts = fakeTts({
		synth: async (text) => {
			log.push(`synth ${text.slice(0, 5)}`)
			return new Uint8Array([text.length])
		},
	})
	const player: AudioPlayer = { play: async ({ wav }) => void log.push(`play ${wav[0]}`) }
	const speaking: boolean[] = []
	const longSentence = (n: string) => `${n} ${'word '.repeat(40)}end.`
	const speaker = createSpeaker({ getProvider: () => tts, getVoice: () => null, player, onSpeaking: (s) => speaking.push(s), onError: () => assert.fail('no error expected') })
	await speaker.speak({ text: `${longSentence('One')} ${longSentence('Two')}` })
	assert.deepEqual(speaking, [true, false])
	assert.equal(log.filter((l) => l.startsWith('play')).length, 2)
	assert.ok(log.indexOf('synth Two w') < log.indexOf(log.filter((l) => l.startsWith('play'))[1] ?? ''), log.join(' | '))
})

test('speaker: stop() cuts it off without an error; a failure is reported once', async () => {
	let playStarted: () => void = () => {}
	const started = new Promise<void>((r) => (playStarted = r))
	const player: AudioPlayer = {
		play: ({ signal }) =>
			new Promise<void>((resolve) => {
				playStarted()
				signal?.addEventListener('abort', () => resolve())
			}),
	}
	const errors: VoiceError[] = []
	const speaking: boolean[] = []
	const speaker = createSpeaker({ getProvider: () => fakeTts({ synth: async () => new Uint8Array(1) }), getVoice: () => null, player, onSpeaking: (s) => speaking.push(s), onError: (e) => errors.push(e) })
	const done = speaker.speak({ text: 'First. Second.' })
	await started
	speaker.stop()
	await done
	assert.deepEqual(speaking, [true, false])
	assert.equal(errors.length, 0)

	const failing = createSpeaker({
		getProvider: () => fakeTts({ synth: async () => Promise.reject(new VoiceError({ kind: 'bad-key', message: 'OpenAI rejected the API key.' })) }),
		getVoice: () => null,
		player: silentPlayer,
		onSpeaking: () => {},
		onError: (e) => errors.push(e),
	})
	await failing.speak({ text: 'Hello there.' })
	assert.deepEqual(errors.map((e) => e.message), ['OpenAI rejected the API key.'])
})

test('speaker: text with nothing to say makes no sound and no state change', async () => {
	const speaking: boolean[] = []
	const speaker = createSpeaker({ getProvider: () => fakeTts({ synth: async () => assert.fail('should not synth') }), getVoice: () => null, player: silentPlayer, onSpeaking: (s) => speaking.push(s), onError: () => {} })
	await speaker.speak({ text: '   ' })
	assert.deepEqual(speaking, [])
})
