// Where the local engines come from. Pinned URLs and checksums; see download.ts.
// To update one: change the URL and SHA-256 here (and the README), nothing else.

import { join } from 'node:path'
import { downloadVerified, extractZip, fileExists, once, type Notice } from './download'
import type { FetchFn } from './http'

export const WHISPER_TAG = 'b5454'
const WHISPER_ZIP = {
	url: `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_TAG}/whisper-bin-x64.zip`,
	sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb',
}

export const WHISPER_MODELS = {
	tiny: { size: '75 MB', sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21' },
	base: { size: '142 MB', sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe' },
	small: { size: '466 MB', sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b' },
} as const
export type WhisperModel = keyof typeof WHISPER_MODELS

const PIPER_ZIP = {
	url: 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip',
	sha256: 'f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea',
}

export const PIPER_DEFAULT_VOICE = 'en_US-lessac-medium'
const PIPER_VOICES: Record<string, { path: string; onnxSha256: string; jsonSha256: string }> = {
	[PIPER_DEFAULT_VOICE]: {
		path: 'en/en_US/lessac/medium',
		onnxSha256: '5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f',
		jsonSha256: 'efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0',
	},
}

export type Engine = { exe: string; dir: string }

export async function ensureWhisper({
	root,
	model,
	notice,
	fetchFn,
}: {
	root: string
	model: WhisperModel
	notice?: Notice
	fetchFn?: FetchFn
}): Promise<{ exe: string; modelPath: string }> {
	const dir = join(root, 'whisper', WHISPER_TAG)
	const exe = join(dir, 'Release', 'whisper-cli.exe')
	const modelPath = join(root, 'whisper', 'models', `ggml-${model}.bin`)
	await once({
		key: `whisper-exe-${root}`,
		task: async () => {
			if (await fileExists({ path: exe })) return
			const zip = join(root, 'downloads', `whisper-${WHISPER_TAG}.zip`)
			await downloadVerified({ ...WHISPER_ZIP, dest: zip, label: 'the Whisper engine', notice, fetchFn })
			notice?.('Unpacking the Whisper engine…')
			await extractZip({ zip, to: dir })
		},
	})
	await once({
		key: `whisper-model-${root}-${model}`,
		task: async () => {
			if (await fileExists({ path: modelPath })) return
			await downloadVerified({
				url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`,
				sha256: WHISPER_MODELS[model].sha256,
				dest: modelPath,
				label: `the Whisper ${model} model (${WHISPER_MODELS[model].size})`,
				notice,
				fetchFn,
			})
		},
	})
	return { exe, modelPath }
}

export function piperVoicesDir({ root }: { root: string }): string {
	return join(root, 'piper', 'voices')
}

export async function ensurePiper({
	root,
	voice,
	notice,
	fetchFn,
}: {
	root: string
	voice: string
	notice?: Notice
	fetchFn?: FetchFn
}): Promise<{ exe: string; dir: string; modelPath: string }> {
	const dir = join(root, 'piper', 'engine')
	const exeDir = join(dir, 'piper')
	const exe = join(exeDir, 'piper.exe')
	await once({
		key: `piper-exe-${root}`,
		task: async () => {
			if (await fileExists({ path: exe })) return
			const zip = join(root, 'downloads', 'piper-2023.11.14-2.zip')
			await downloadVerified({ ...PIPER_ZIP, dest: zip, label: 'the Piper engine', notice, fetchFn })
			notice?.('Unpacking the Piper engine…')
			await extractZip({ zip, to: dir })
		},
	})
	const modelPath = join(piperVoicesDir({ root }), `${voice}.onnx`)
	const known = PIPER_VOICES[voice]
	await once({
		key: `piper-voice-${root}-${voice}`,
		task: async () => {
			if (await fileExists({ path: modelPath })) return
			// A voice the user dropped in by hand is used as is; only known voices are fetched.
			if (known == null) return
			const base = `https://huggingface.co/rhasspy/piper-voices/resolve/main/${known.path}/${voice}`
			await downloadVerified({ url: `${base}.onnx.json`, sha256: known.jsonSha256, dest: `${modelPath}.json`, label: 'the Piper voice settings', notice, fetchFn })
			await downloadVerified({ url: `${base}.onnx`, sha256: known.onnxSha256, dest: modelPath, label: 'the Piper voice (60 MB)', notice, fetchFn })
		},
	})
	return { exe, dir: exeDir, modelPath }
}
