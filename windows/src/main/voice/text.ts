// Turns a reply written for the eye into text that sounds right aloud, and cuts it into sentences so the
// first one can start playing while the rest are still being synthesised.

const MAX_SPOKEN_CHARS = 1500
const MAX_CHUNK_CHARS = 280

export function cleanForSpeech({ text }: { text: string }): string {
	let t = text
		.replace(/```[\s\S]*?```/g, ' (code omitted) ')
		.replace(/`([^`]*)`/g, '$1')
		.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/https?:\/\/\S+/g, ' link ')
		.replace(/^\s{0,3}#{1,6}\s+/gm, '')
		.replace(/^\s*[-*+]\s+/gm, '')
		.replace(/^\s*\d+\.\s+/gm, '')
		.replace(/^\s*>\s?/gm, '')
		.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2')
		.replace(/[*_~|]/g, ' ')
		.replace(/\s*\n+\s*/g, '. ')
		.replace(/\.(\s*\.)+/g, '.')
		.replace(/\s+/g, ' ')
		.trim()
	if (t.length > MAX_SPOKEN_CHARS) {
		const cut = t.slice(0, MAX_SPOKEN_CHARS)
		const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '))
		t = (end > MAX_SPOKEN_CHARS / 2 ? cut.slice(0, end + 1) : cut).trim()
	}
	return t
}

/** Sentences, merged up to a comfortable size; a sentence that is itself too long is cut at commas or spaces. */
export function splitForSpeech({ text }: { text: string }): string[] {
	const sentences = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [text]
	const chunks: string[] = []
	let current = ''
	const push = (s: string) => {
		if (s.trim() !== '') chunks.push(s.trim())
	}
	for (const raw of sentences) {
		let sentence = raw.trim()
		while (sentence.length > MAX_CHUNK_CHARS) {
			const window = sentence.slice(0, MAX_CHUNK_CHARS)
			const at = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(' '))
			const cut = at > 40 ? at + 1 : MAX_CHUNK_CHARS
			push(current)
			current = ''
			push(sentence.slice(0, cut))
			sentence = sentence.slice(cut).trim()
		}
		if (current !== '' && current.length + sentence.length + 1 > MAX_CHUNK_CHARS) {
			push(current)
			current = ''
		}
		current = current === '' ? sentence : `${current} ${sentence}`
	}
	push(current)
	return chunks
}

/** whisper.cpp prints annotations like [BLANK_AUDIO] or (music) for non-speech; they aren't what was said. */
export function cleanTranscript({ text }: { text: string }): string {
	return text
		.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}
