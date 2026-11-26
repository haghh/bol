// The language models behind the API-key engines, through the Vercel AI SDK.

import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'
import { KEY_ENV, type KeyProvider } from './secrets'

/** Used when Settings.model is null. Top models, as the original insists on; change them in settings.json. */
export const DEFAULT_MODELS: Record<KeyProvider, string> = {
	anthropic: 'claude-opus-5-5',
	openai: 'gpt-5.6',
	gemini: 'gemini-pro-latest',
}

export const PROVIDER_NAMES: Record<KeyProvider, string> = {
	anthropic: 'Anthropic',
	openai: 'OpenAI',
	gemini: 'Google Gemini',
}

export function makeModel({
	provider,
	model,
	apiKey,
}: {
	provider: KeyProvider
	model: string | null
	apiKey: string
}): LanguageModel {
	const id = model ?? DEFAULT_MODELS[provider]
	switch (provider) {
		case 'anthropic':
			return createAnthropic({ apiKey })(id)
		case 'openai':
			return createOpenAI({ apiKey })(id)
		case 'gemini':
			return createGoogleGenerativeAI({ apiKey })(id)
	}
}

export function missingKeyMessage({ provider }: { provider: KeyProvider }): string {
	return `There's no ${PROVIDER_NAMES[provider]} API key yet. Run npm run set-key -- ${provider} in Bol's folder, or set ${KEY_ENV[provider]}.`
}
