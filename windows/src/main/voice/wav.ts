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
