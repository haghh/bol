// One place that calls a provider's HTTP API and turns every failure into a VoiceError.

import { httpError, isAbortError, VoiceError } from './errors'

export type FetchFn = typeof fetch

export async function callApi({
	provider,
	fetchFn,
	url,
	init,
	signal,
	timeoutMs = 30_000,
}: {
	provider: string
	fetchFn: FetchFn
	url: string
	init: RequestInit
	signal?: AbortSignal
	timeoutMs?: number
}): Promise<Response> {
	const timeout = AbortSignal.timeout(timeoutMs)
	let res: Response
	try {
		res = await fetchFn(url, { ...init, signal: signal == null ? timeout : AbortSignal.any([signal, timeout]) })
	} catch (e) {
		// A stop from the caller stays an abort (callers treat it as "done"); a timeout is a network problem.
		if (signal?.aborted === true) throw e
		if (isAbortError(e)) throw new VoiceError({ kind: 'network', message: `${provider} took too long to answer.` })
		throw e
	}
	if (!res.ok) {
		await res.body?.cancel().catch(() => {}) // the body can carry anything; we only use the status
		throw httpError({ provider, status: res.status })
	}
	return res
}
