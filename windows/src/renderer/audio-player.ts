// Plays a WAV the main process sends (a spoken reply) and reports its loudness for the bar's meter.

export type Player = {
	/** Resolves when the audio ends or is stopped. Rejects if it can't be decoded or played. */
	play: (args: { wav: Uint8Array }) => Promise<void>
	stop: () => void
}

export function createPlayer({ onLevel }: { onLevel: (level: number) => void }): Player {
	let ctx: AudioContext | null = null
	let current: { source: AudioBufferSourceNode; finish: () => void } | null = null

	function stop() {
		const c = current
		current = null
		if (c == null) return
		c.source.onended = null
		try {
			c.source.stop()
		} catch {
			// already stopped
		}
		c.finish()
	}

	return {
		stop,
		async play({ wav }) {
			stop()
			ctx ??= new AudioContext()
			if (ctx.state === 'suspended') await ctx.resume()
			// decodeAudioData takes ownership of the buffer, so give it a copy.
			const buffer = await ctx.decodeAudioData(wav.slice().buffer)
			const source = ctx.createBufferSource()
			source.buffer = buffer
			const analyser = ctx.createAnalyser()
			analyser.fftSize = 512
			source.connect(analyser)
			analyser.connect(ctx.destination)
			const samples = new Uint8Array(analyser.fftSize)
			await new Promise<void>((resolve) => {
				const meter = setInterval(() => {
					analyser.getByteTimeDomainData(samples)
					let sum = 0
					for (const s of samples) sum += ((s - 128) / 128) ** 2
					onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 4))
				}, 50)
				const finish = () => {
					clearInterval(meter)
					onLevel(0)
					resolve()
				}
				current = { source, finish }
				source.onended = () => {
					current = null
					finish()
				}
				source.start()
			})
		},
	}
}
