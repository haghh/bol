// Voice errors with a short message fit for the voice bar. Anything a provider can throw ends up as one of
// these (see toVoiceError), so nothing raw (stack traces, JSON bodies, keys) ever reaches the user.

export type VoiceErrorKind = 'no-key' | 'bad-key' | 'network' | 'quota' | 'setup' | 'failed'

export class VoiceError extends Error {
	readonly kind: VoiceErrorKind
	constructor({ kind, message }: { kind: VoiceErrorKind; message: string }) {
		super(message)
		this.name = 'VoiceError'
		this.kind = kind
	}
}

export function isAbortError(e: unknown): boolean {
	return e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')
}

export function noKeyError({ provider }: { provider: string }): VoiceError {
	return new VoiceError({ kind: 'no-key', message: `Add your ${provider} API key in voice settings.` })
}

/** Maps an HTTP failure to a message. 401/403 are a bad key; 402/429 are quota or rate limits. */
export function httpError({ provider, status }: { provider: string; status: number }): VoiceError {
	if (status === 401 || status === 403) return new VoiceError({ kind: 'bad-key', message: `${provider} rejected the API key.` })
	if (status === 402 || status === 429) return new VoiceError({ kind: 'quota', message: `${provider} quota or rate limit reached.` })
	if (status >= 500) return new VoiceError({ kind: 'network', message: `${provider} is having problems (${status}). Try again.` })
	return new VoiceError({ kind: 'failed', message: `${provider} couldn't handle that (error ${status}).` })
}

/** Any thrown value to a VoiceError. Never returns raw text from the outside world. */
export function toVoiceError({ error, provider }: { error: unknown; provider: string }): VoiceError {
	if (error instanceof VoiceError) return error
	const code = (error as { code?: string; cause?: { code?: string } } | null)?.code ?? (error as { cause?: { code?: string } } | null)?.cause?.code
	if (error instanceof TypeError || ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(code ?? '')) {
		return new VoiceError({ kind: 'network', message: `No network connection. Can't reach ${provider}.` })
	}
	if (error instanceof Error && error.name === 'TimeoutError') {
		return new VoiceError({ kind: 'network', message: `${provider} took too long to answer.` })
	}
	return new VoiceError({ kind: 'failed', message: `${provider} voice failed. Check the log.` })
}
