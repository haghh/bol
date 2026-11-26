// WAV helpers. Every provider hands audio to the bar as a WAV, so the bar can decode it without caring
// where it came from.

import type { AudioClip } from '../../shared/voice'

/** Wraps little-endian 16-bit mono PCM bytes in a WAV header. */
export function pcmBytesToWav({ bytes, sampleRate }: { bytes: Uint8Array; sampleRate: number }): Uint8Array {
	const header = new ArrayBuffer(44)
	const v = new DataView(header)
	const text = (offset: number, s: string) => [...s].forEach((c, i) => v.setUint8(offset + i, c.charCodeAt(0)))
	text(0, 'RIFF')
	v.setUint32(4, 36 + bytes.byteLength, true)
	text(8, 'WAVE')
	text(12, 'fmt ')
	v.setUint32(16, 16, true) // fmt chunk size
	v.setUint16(20, 1, true) // PCM
	v.setUint16(22, 1, true) // mono
	v.setUint32(24, sampleRate, true)
	v.setUint32(28, sampleRate * 2, true) // byte rate
	v.setUint16(32, 2, true) // block align
	v.setUint16(34, 16, true) // bits per sample
	text(36, 'data')
	v.setUint32(40, bytes.byteLength, true)
	const wav = new Uint8Array(44 + bytes.byteLength)
	wav.set(new Uint8Array(header), 0)
	wav.set(bytes, 44)
	return wav
}

export function clipToWav({ clip }: { clip: AudioClip }): Uint8Array {
	const bytes = new Uint8Array(clip.pcm16.length * 2)
	const v = new DataView(bytes.buffer)
	clip.pcm16.forEach((s, i) => v.setInt16(i * 2, s, true))
	return pcmBytesToWav({ bytes, sampleRate: clip.sampleRate })
}

export function clipSeconds({ clip }: { clip: AudioClip }): number {
	return clip.pcm16.length / clip.sampleRate
}

/** True when nothing audible was recorded (mic muted, wrong device): saves a pointless provider call. */
export function isSilent({ clip }: { clip: AudioClip }): boolean {
	let peak = 0
	for (const s of clip.pcm16) peak = Math.max(peak, Math.abs(s))
	return peak < 200 // of 32768: about -44 dBFS
}

/** The sample rate of a PCM WAV and where its data starts, or null if it isn't one we understand. */
export function readWavHeader({ wav }: { wav: Uint8Array }): { sampleRate: number; dataOffset: number } | null {
	if (wav.byteLength < 44) return null
	const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
	const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3))
	if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
	return { sampleRate: v.getUint32(24, true), dataOffset: 44 }
}

const FRAME_MS = 20
const PAD_MS = 250
const TARGET_PEAK = 0.9 * 32767
const MAX_GAIN = 8

/**
 * Tidies a clip before it is transcribed: cuts the silence before and after the speech (keeping a short pad),
 * because Whisper tends to invent words like "Thank you." in long quiet stretches, and raises a quiet recording
 * to a steady level (at most 8x, so background hiss isn't blown up).
 */
export function prepareClip({ clip }: { clip: AudioClip }): AudioClip {
	const { pcm16, sampleRate } = clip
	const frame = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000))
	const frameCount = Math.ceil(pcm16.length / frame)
	const levels = new Float64Array(frameCount)
	let loudest = 0
	for (let f = 0; f < frameCount; f++) {
		let sum = 0
		const end = Math.min(pcm16.length, (f + 1) * frame)
		for (let i = f * frame; i < end; i++) sum += (pcm16[i] ?? 0) ** 2
		levels[f] = Math.sqrt(sum / Math.max(1, end - f * frame))
		loudest = Math.max(loudest, levels[f] ?? 0)
	}
	// Speech is anything within about 26 dB of the loudest frame, and above the mic's floor.
	const threshold = Math.max(150, loudest * 0.05)
	let first = 0
	while (first < frameCount && (levels[first] ?? 0) < threshold) first++
	let last = frameCount - 1
	while (last > first && (levels[last] ?? 0) < threshold) last--
	if (first >= frameCount) return clip
	const pad = Math.round((sampleRate * PAD_MS) / 1000)
	const start = Math.max(0, first * frame - pad)
	const end = Math.min(pcm16.length, (last + 1) * frame + pad)
	const trimmed = pcm16.subarray(start, end)

	let peak = 0
	for (const s of trimmed) peak = Math.max(peak, Math.abs(s))
	const gain = peak === 0 ? 1 : Math.min(MAX_GAIN, TARGET_PEAK / peak)
	if (gain <= 1) return { pcm16: trimmed.slice(), sampleRate }
	const out = new Int16Array(trimmed.length)
	for (let i = 0; i < trimmed.length; i++) out[i] = Math.round((trimmed[i] ?? 0) * gain)
	return { pcm16: out, sampleRate }
}
