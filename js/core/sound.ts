// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The host side of kwsnd (sound/drivers/kwsnd.c): optional sound output.
//
// The kernel asks wasm_driver_sound_init() once at boot; < 0 means no audio
// and no sound card. Otherwise it registers ALSA card 0 with one playback
// PCM (hw:0,0, /dev/snd/pcmC0D0p) and, if the kernel has OSS emulation,
// /dev/dsp; the return value is the host's preferred rate (0 = none), which
// the card's long name shows. Nothing runs until a program opens the PCM.
//
// Then wasm_driver_sound_event() reports each state change: open, prepare
// (rate, channels, ALSA format: 1 = U8, 2 = S16_LE), start, stop (with 1
// when the stream drained) and close. While the stream runs, a kernel timer
// on the host's monotonic clock (WASI clock_time_get) fires every 2 to 10
// ms and hands the frames the elapsed time is worth to
// wasm_driver_sound_write(addr, bytes), which copies them out of kernel
// memory during the call. The return value is how many frames the sink
// still has queued; the kernel adds it to the delay that programs see.
// Frames the program had not written by then are not sent (the kernel
// reports an underrun to the program and the sink plays silence), so the
// sink gets real samples only, in playback order, at the guest's clock.
// A sink that plays on another clock (an audio device) must absorb the
// drift between the two (e.g. js/web/audio.ts adjusts its resampling
// ratio to keep its queue level). No import suspends.

const ENODEV = 19;

/** ALSA formats the kernel offers (SNDRV_PCM_FORMAT_*). */
export const SOUND_FORMAT_U8 = 1;
export const SOUND_FORMAT_S16_LE = 2;

/** The format of a playback stream. */
export interface SoundFormat {
	/** Frames per second. */
	rate: number;
	/** 1 or 2 (interleaved: left, right). */
	channels: number;
	/** SOUND_FORMAT_U8 (unsigned 8 bit) or SOUND_FORMAT_S16_LE (signed 16 bit). */
	format: number;
	/** Bytes per frame (channels * sample size). */
	frameBytes: number;
}

/** What a guest program is doing with the sound device. */
export interface SoundState {
	/** Some program has the PCM open. */
	open: boolean;
	/** The stream is running: chunks are coming. */
	playing: boolean;
	/** The format once the program set it (prepare), else null. */
	format: SoundFormat | null;
}

/** PCM the guest played, in the stream's format. */
export interface SoundChunk {
	format: SoundFormat;
	/** A copy, owned by the receiver. */
	data: Uint8Array;
	/** data.length / format.frameBytes. */
	frames: number;
}

export interface SoundSink {
	/**
	 * The host's preferred rate (e.g. an AudioContext's), shown in the card's
	 * long name; programs still choose any rate from 8000 to 48000 Hz.
	 */
	rate?: number;
	/**
	 * PCM played by the guest, in order. Return the frames (at the chunk's
	 * rate) still queued for output after it, if known: programs see it as
	 * part of their delay (snd_pcm_delay).
	 */
	onChunk?: (chunk: SoundChunk) => number | void;
	/**
	 * Worker mode with shared memory: receives the shared PCM ring buffer once the
	 * kernel starts (sound-ring.ts). When set and shared memory is active, PCM
	 * chunks remain in the ring for the consumer's SoundRingReader (exactly
	 * one) rather than being drained into onChunk; otherwise (inline or
	 * shared: false) onChunk receives chunks as usual, and a sink without it
	 * gets no PCM. The ring also holds a record per state change, in order
	 * with the PCM (a reader that was not reading meets the old stream's
	 * records first), and the reader reports the frames it has queued with
	 * setQueuedFrames(), which the guest sees as the stream's delay.
	 */
	onRing?: (ring: SharedArrayBuffer) => void;
	/** The state changed (open, format, start, stop, close). */
	onState?: (state: SoundState, event: SoundEvent) => void;
}

/** A state change, as wasm_driver_sound_event() reports it. */
export type SoundEvent = "open" | "prepare" | "start" | "stop" | "drain" | "close";

/** The sound option: false (no device), true (a device whose output is dropped), or a sink. */
export type SoundOption = boolean | SoundSink;

export interface SoundStats {
	/** Opens of the PCM. */
	opens: number;
	/** Stream starts (one per start after prepare, including restarts after an underrun). */
	starts: number;
	/** Stops that were not the end of a drain: underruns, drops (snd_pcm_drop, close while running). */
	stops: number;
	chunks: number;
	frames: number;
	/**
	 * The longest a player that started with the first chunk of a stream
	 * would have waited for data, in ms: the largest shortfall of frames
	 * received against frames due by the host clock since the stream
	 * started. A sink needs at least this much queued to play without gaps.
	 */
	maxLagMs: number;
}

/** What a machine snapshot keeps of kwsnd (SoundHost.saveState()). */
export interface SoundSnapshot {
	state: SoundState;
}

const EV_NAMES: readonly SoundEvent[] = ["close", "open", "prepare", "start", "stop"];

export interface SoundHostOptions {
	/** Offer a sound device, and where its output goes. Default false: no sound card. */
	enabled?: SoundOption;
	/** The kernel's memory, read at call time. */
	memory: () => WebAssembly.Memory;
	log?: (msg: string) => void;
}

export class SoundHost {
	readonly enabled: boolean;
	/** Did the kernel ask (wasm_driver_sound_init)? False for a kernel without kwsnd. */
	probed = false;
	state: SoundState = { open: false, playing: false, format: null };
	stats: SoundStats = { opens: 0, starts: 0, stops: 0, chunks: 0, frames: 0, maxLagMs: 0 };
	#sink: SoundSink;
	#memory: () => WebAssembly.Memory;
	#log: (msg: string) => void;
	/** Host time of the current stream's start, and frames received since. */
	#t0 = 0;
	#received = 0;

	constructor(opts: SoundHostOptions) {
		this.enabled = !!opts.enabled;
		this.#sink = typeof opts.enabled === "object" ? opts.enabled : {};
		this.#memory = opts.memory;
		this.#log = opts.log ?? (() => {});
	}

	/** A program is playing (the stream runs). */
	get playing(): boolean {
		return this.state.playing;
	}

	#event(ev: SoundEvent, format: SoundFormat | null): void {
		const s = this.state;
		if (ev === "open") this.stats.opens++;
		if (ev === "start") {
			this.stats.starts++;
			this.#t0 = performance.now();
			this.#received = 0;
		}
		if (ev === "stop") this.stats.stops++;
		this.state = {
			open: ev !== "close",
			playing: ev === "start",
			format: ev === "prepare" ? format : ev === "open" || ev === "close" ? null : s.format,
		};
		try { this.#sink.onState?.(this.state, ev); } catch (e) { this.#log(`[sound] onState failed: ${e}`); }
	}

	/** The state a snapshot keeps. */
	saveState(): SoundSnapshot {
		const s = this.state;
		return { state: { open: s.open, playing: s.playing, format: s.format && { ...s.format } } };
	}

	/**
	 * A restored snapshot: the kernel does not call init again and the
	 * stream goes on where it was, so take the saved state and replay it to
	 * the sink (open, prepare, start) as the guest's calls did. The kernel's
	 * timer keeps handing over frames on the guest's clock, which a restore
	 * continues.
	 */
	restoreState(s: SoundSnapshot): void {
		this.probed = true;
		this.state = { open: false, playing: false, format: null };
		this.#t0 = performance.now();
		this.#received = 0;
		const notify = (state: SoundState, ev: SoundEvent) => {
			this.state = state;
			try { this.#sink.onState?.(state, ev); } catch (e) { this.#log(`[sound] onState failed: ${e}`); }
		};
		const { open, playing, format } = s.state;
		if (!open) return;
		notify({ open: true, playing: false, format: null }, "open");
		if (format) notify({ open: true, playing: false, format: { ...format } }, "prepare");
		if (format && playing) notify({ open: true, playing: true, format: { ...format } }, "start");
	}

	imports(): Record<string, unknown> {
		return {
			wasm_driver_sound_init: (): bigint => {
				this.probed = true;
				if (!this.enabled) return -BigInt(ENODEV);
				const r = Math.round(this.#sink.rate ?? 0);
				return BigInt(r > 0 && r < 1e6 ? r : 0);
			},
			wasm_driver_sound_event: (event: number, rate: number, channels: number, format: number): void => {
				let ev = EV_NAMES[event];
				if (!ev) return;
				let f: SoundFormat | null = null;
				if (ev === "prepare") {
					const size = format === SOUND_FORMAT_U8 ? 1 : format === SOUND_FORMAT_S16_LE ? 2 : 0;
					if (!size || channels < 1 || channels > 2 || !rate) {
						this.#log(`[sound] unexpected format: rate ${rate}, ${channels} channels, format ${format}`);
						return;
					}
					f = { rate, channels, format, frameBytes: size * channels };
				}
				if (ev === "stop" && rate === 1) ev = "drain";
				this.#event(ev, f);
			},
			wasm_driver_sound_write: (buf: bigint, bytes: bigint): bigint => {
				const f = this.state.format;
				const n = Number(bytes);
				if (!f || n <= 0) return 0n;
				const addr = Number(buf);
				const mem = this.#memory().buffer;
				if (addr + n > mem.byteLength) return 0n;
				const frames = Math.floor(n / f.frameBytes);
				const now = performance.now();
				const lag = ((now - this.#t0) * f.rate / 1000 - this.#received) * 1000 / f.rate;
				if (lag > this.stats.maxLagMs) this.stats.maxLagMs = lag;
				this.#received += frames;
				this.stats.chunks++;
				this.stats.frames += frames;
				const onChunk = this.#sink.onChunk;
				if (!onChunk) return 0n;
				const data = new Uint8Array(mem, addr, frames * f.frameBytes).slice();
				let queued: number | void = 0;
				try { queued = onChunk({ format: f, data, frames }); } catch (e) { this.#log(`[sound] onChunk failed: ${e}`); }
				return BigInt(Math.max(0, Math.round(queued || 0)));
			},
		};
	}
}

/** Samples of a chunk as floats in [-1, 1), interleaved like the input. */
export function pcmToFloat32(data: Uint8Array, format: SoundFormat, out?: Float32Array): Float32Array {
	const n = format.format === SOUND_FORMAT_U8 ? data.length : data.length >> 1;
	const f = out && out.length === n ? out : new Float32Array(n);
	if (format.format === SOUND_FORMAT_U8) {
		for (let i = 0; i < n; i++) f[i] = (data[i]! - 128) / 128;
	} else {
		const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
		for (let i = 0; i < n; i++) f[i] = dv.getInt16(i * 2, true) / 32768;
	}
	return f;
}

/**
 * A canonical 44-byte WAV (RIFF, PCM) header for `dataBytes` bytes of
 * samples in `format`.
 */
export function wavHeader(format: SoundFormat, dataBytes: number): Uint8Array {
	const h = new Uint8Array(44);
	const dv = new DataView(h.buffer);
	const ascii = (o: number, s: string) => { for (let i = 0; i < 4; i++) h[o + i] = s.charCodeAt(i); };
	ascii(0, "RIFF");
	dv.setUint32(4, 36 + dataBytes, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	dv.setUint32(16, 16, true);
	dv.setUint16(20, 1, true); // PCM
	dv.setUint16(22, format.channels, true);
	dv.setUint32(24, format.rate, true);
	dv.setUint32(28, format.rate * format.frameBytes, true);
	dv.setUint16(32, format.frameBytes, true);
	dv.setUint16(34, (format.frameBytes / format.channels) * 8, true);
	ascii(36, "data");
	dv.setUint32(40, dataBytes, true);
	return h;
}

/**
 * Convert PCM to another format: channels (mono to stereo duplicates,
 * stereo to mono averages), sample type, and rate (linear interpolation;
 * fine for checking and for occasional format changes, not for music).
 */
export function convertPcm(data: Uint8Array, from: SoundFormat, to: SoundFormat): Uint8Array {
	if (from.rate === to.rate && from.channels === to.channels && from.format === to.format) return data;
	const src = pcmToFloat32(data, from);
	const inFrames = Math.floor(src.length / from.channels);
	const outFrames = Math.floor(inFrames * to.rate / from.rate);
	const out = new Uint8Array(outFrames * to.frameBytes);
	const dv = new DataView(out.buffer);
	const sample = (frame: number, ch: number): number => {
		const c = Math.min(ch, from.channels - 1);
		if (to.channels === 1 && from.channels === 2) return (src[frame * 2]! + src[frame * 2 + 1]!) / 2;
		return src[frame * from.channels + c]!;
	};
	for (let i = 0; i < outFrames; i++) {
		const x = i * from.rate / to.rate;
		const i0 = Math.floor(x), i1 = Math.min(i0 + 1, inFrames - 1), t = x - i0;
		for (let ch = 0; ch < to.channels; ch++) {
			const v = Math.max(-1, Math.min(1, sample(i0, ch) * (1 - t) + sample(i1, ch) * t));
			const o = i * to.frameBytes + ch * (to.frameBytes / to.channels);
			if (to.format === SOUND_FORMAT_U8) out[o] = Math.round(v * 127 + 128);
			else dv.setInt16(o, Math.round(v * 32767), true);
		}
	}
	return out;
}
