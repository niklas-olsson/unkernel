// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The guest's sound on the page (kwsnd; on unless ?sound=0): a SoundSink
// for the SDK (js/core/sound.ts) that plays the PCM with Web Audio.
//
// - The kernel hands over PCM from a timer every 2-10 ms, from inside a
//   synchronous import, while the main thread is busy running the guest
//   (it only gets back to its event loop at the kernel's 20 ms yields and
//   when idle). So the chunks are posted at once to an AudioWorklet, whose
//   thread plays them from its own queue whatever the main thread does: a
//   MessagePort message is delivered to the audio thread without waiting
//   for the main thread's task to end. Scheduled AudioBufferSourceNodes
//   would depend on ctx.currentTime and graph changes made from that busy
//   thread, and create a node per chunk; they are only the fallback where
//   there is no AudioWorklet (it needs a secure context, so a LAN http://
//   page uses them).
// - The worklet keeps about TARGET_S queued: it starts (and restarts after
//   running dry) only once that much is there, resamples linearly from the
//   stream's rate to the context's, and steers its ratio by up to 1% from
//   the smoothed queue level, which absorbs the drift between the guest's
//   clock (the host's performance.now(), which paces the kernel) and the
//   audio device's clock. More than MAX_S queued (which kwsnd itself
//   avoids: after a stall it skips the missed time) drops the oldest
//   chunks down to TARGET_S, so latency does not stay high.
// - The AudioContext is created on first playback (the first prepare or
//   start), not at boot. Created without a user gesture it usually starts
//   suspended (autoplay policy); chunks are then dropped, and the next
//   gesture (keydown, mousedown, pointerup, touchend or click: the events
//   that count as activation in Chrome, Firefox and Safari, including iOS,
//   which needs touchend or click) resumes it. The same applies after iOS
//   interrupts the context (a call, the page in the background).
import { pcmToFloat32, type SoundChunk, type SoundEvent, type SoundSink, type SoundState } from "./sdk.ts";

/** Queue the worklet fills before it starts playing, and steers towards. */
const TARGET_S = 0.06;
/** Most queued before the oldest chunks are dropped. */
const MAX_S = 0.3;
const GESTURES = ["keydown", "mousedown", "pointerup", "touchend", "click"] as const;

// Runs in the AudioWorkletGlobalScope (sampleRate, AudioWorkletProcessor and
// registerProcessor are its globals). Messages in: {t: "pcm", d: Float32Array
// interleaved, ch, rate}, {t: "start"}, {t: "end"} (play out what is queued
// without waiting for TARGET), {t: "flush"}. Out, every ~100 ms: {sec,
// underruns, dropped}.
const WORKLET = `
const TARGET = ${TARGET_S}, MAX = ${MAX_S};
class KwPcm extends AudioWorkletProcessor {
	constructor() {
		super();
		this.q = []; this.off = 0; this.sec = 0; this.avg = TARGET;
		this.playing = false; this.ending = false;
		this.underruns = 0; this.dropped = 0; this.report = 0;
		this.port.onmessage = (e) => {
			const m = e.data;
			if (m.t === "pcm") {
				const frames = m.d.length / m.ch;
				this.q.push({ d: m.d, ch: m.ch, rate: m.rate, frames });
				this.sec += frames / m.rate;
				this.ending = false;
				if (this.sec > MAX) while (this.sec > TARGET && this.q.length > 1) {
					const c = this.q.shift();
					this.sec -= (c.frames - this.off) / c.rate;
					this.off = 0;
					this.dropped++;
				}
			} else if (m.t === "start") this.ending = false;
			else if (m.t === "end") this.ending = true;
			else if (m.t === "flush") { this.q = []; this.off = 0; this.sec = 0; this.playing = false; }
		};
	}
	process(inputs, outputs) {
		const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length;
		let i = 0;
		if (!this.playing && this.q.length && (this.sec >= TARGET || this.ending)) this.playing = true;
		if (this.playing) {
			this.avg += (this.sec - this.avg) * (n / sampleRate);
			const steer = 1 + Math.max(-0.01, Math.min(0.01, (this.avg - TARGET) * 0.1));
			for (; i < n; i++) {
				const c = this.q[0];
				if (!c) {
					this.playing = false;
					if (!this.ending) this.underruns++;
					break;
				}
				const f = Math.floor(this.off), t = this.off - f;
				const nx = f + 1 < c.frames ? c : this.q[1], g = f + 1 < c.frames ? f + 1 : 0;
				const l0 = c.d[f * c.ch], r0 = c.d[f * c.ch + c.ch - 1];
				const l1 = nx ? nx.d[g * nx.ch] : l0, r1 = nx ? nx.d[g * nx.ch + nx.ch - 1] : r0;
				L[i] = l0 + (l1 - l0) * t;
				R[i] = r0 + (r1 - r0) * t;
				const step = c.rate / sampleRate * steer;
				this.off += step;
				this.sec -= step / c.rate;
				while (this.q.length && this.off >= this.q[0].frames) {
					this.off -= this.q[0].frames;
					this.q.shift();
				}
			}
			if (!this.q.length) this.sec = 0;
		}
		for (; i < n; i++) L[i] = R[i] = 0;
		if ((this.report += n) >= sampleRate / 10) {
			this.report = 0;
			this.port.postMessage({ sec: this.sec, underruns: this.underruns, dropped: this.dropped });
		}
		return true;
	}
}
registerProcessor("kw-pcm", KwPcm);
`;

export interface AudioOutOptions {
	log?: (msg: string) => void;
}

export interface AudioOutStats {
	/** "worklet", "buffers" (the fallback), or null before the first playback. */
	mode: "worklet" | "buffers" | null;
	/** The AudioContext's state, or null before the first playback. */
	state: string | null;
	sampleRate: number;
	/** Chunks dropped because the context was not running (autoplay) or the queue was full. */
	dropped: number;
	/** Times the output ran dry while a stream played. */
	underruns: number;
	/** Seconds queued in the output, as last reported. */
	queuedS: number;
}

export interface AudioOut extends SoundSink {
	stats(): AudioOutStats;
}

/** A SoundSink that plays the guest's PCM through Web Audio (see the top of this file). */
export function createAudioOut(opts: AudioOutOptions = {}): AudioOut {
	const log = opts.log ?? (() => {});
	let ctx: AudioContext | null = null;
	let node: AudioWorkletNode | null = null;
	let mode: AudioOutStats["mode"] = null;
	/** Chunks posted before the worklet module loaded, and their length in seconds. */
	let pending: { d: Float32Array; ch: number; rate: number }[] = [];
	let pendingS = 0;
	let queuedS = 0, underruns = 0, dropped = 0, workletDropped = 0;
	let nextTime = 0;
	let armed = false;

	const unlock = (): void => {
		if (!ctx || ctx.state === "running" || ctx.state === "closed") return;
		void ctx.resume().catch(() => {});
		// The classic iOS unlock: start something from inside the gesture.
		try {
			const src = ctx.createBufferSource();
			src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
			src.connect(ctx.destination);
			src.start();
		} catch {}
	};
	const arm = (on: boolean): void => {
		if (on === armed) return;
		armed = on;
		for (const ev of GESTURES) {
			if (on) document.addEventListener(ev, unlock, { capture: true, passive: true });
			else document.removeEventListener(ev, unlock, { capture: true });
		}
	};
	const onStateChange = (): void => {
		if (!ctx) return;
		const running = ctx.state === "running";
		arm(!running && ctx.state !== "closed");
		log(running ? `[audio] playing (${ctx.sampleRate} Hz, ${mode})`
			: `[audio] ${ctx.state}: sound starts at the next tap, click or key press`);
		if (running) nextTime = 0;
	};

	const ensureContext = (): void => {
		if (ctx) return;
		const AC = globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
		if (!AC) {
			log("[audio] no Web Audio in this browser: no sound");
			mode = "buffers";
			return;
		}
		try {
			ctx = new AC({ latencyHint: "interactive" });
		} catch (e) {
			log(`[audio] cannot create an AudioContext: ${e}`);
			return;
		}
		const c = ctx;
		c.addEventListener("statechange", onStateChange);
		mode = c.audioWorklet && globalThis.isSecureContext ? "worklet" : "buffers";
		log(`[audio] AudioContext ${c.sampleRate} Hz, ${mode === "worklet" ? "AudioWorklet" : "scheduled buffers (no AudioWorklet here)"}, ` +
			`base latency ${((c.baseLatency ?? 0) * 1000).toFixed(0)} ms`);
		if (mode === "worklet") {
			const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
			c.audioWorklet.addModule(url).then(() => {
				node = new AudioWorkletNode(c, "kw-pcm", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
				node.port.onmessage = (e: MessageEvent<{ sec: number; underruns: number; dropped: number }>) => {
					queuedS = e.data.sec;
					underruns = e.data.underruns;
					workletDropped = e.data.dropped;
				};
				node.connect(c.destination);
				for (const p of pending) node.port.postMessage({ t: "pcm", ...p }, [p.d.buffer]);
				pending = [];
				pendingS = 0;
			}).catch((e: unknown) => {
				log(`[audio] AudioWorklet failed (${e}); using scheduled buffers`);
				mode = "buffers";
				pending = [];
			}).finally(() => URL.revokeObjectURL(url));
		}
		onStateChange();
	};

	/** Play one chunk; returns the frames (at its rate) queued after it. */
	const play = (chunk: SoundChunk): number => {
		const c = ctx;
		const { rate, channels: ch } = chunk.format;
		if (!c || c.state !== "running") {
			dropped++;
			return 0;
		}
		const d = pcmToFloat32(chunk.data, chunk.format);
		if (mode === "worklet") {
			if (node) {
				node.port.postMessage({ t: "pcm", d, ch, rate }, [d.buffer]);
				queuedS += chunk.frames / rate;
			} else if (pendingS < MAX_S) {
				pending.push({ d, ch, rate });
				pendingS += chunk.frames / rate;
			} else dropped++;
			return Math.round((queuedS + pendingS) * rate);
		}
		// Fallback: one AudioBufferSourceNode per chunk, back to back.
		const now = c.currentTime;
		if (nextTime < now + 0.005) {
			if (nextTime) underruns++;
			nextTime = now + TARGET_S;
		}
		if (nextTime - now > MAX_S) {
			dropped++;
			return Math.round((nextTime - now) * rate);
		}
		const buf = c.createBuffer(ch, chunk.frames, rate);
		for (let k = 0; k < ch; k++) {
			const plane = new Float32Array(chunk.frames);
			for (let i = 0; i < chunk.frames; i++) plane[i] = d[i * ch + k]!;
			buf.copyToChannel(plane, k);
		}
		const src = c.createBufferSource();
		src.buffer = buf;
		src.connect(c.destination);
		src.start(nextTime);
		nextTime += chunk.frames / rate;
		return Math.round((nextTime - now) * rate);
	};

	return {
		// Most devices run at 48 kHz; the context does not exist yet to ask.
		rate: 48000,
		onState(state: SoundState, ev: SoundEvent): void {
			if (ev === "prepare" || ev === "start") ensureContext();
			if (ev === "start") node?.port.postMessage({ t: "start" });
			if (ev === "drain" || ev === "stop") node?.port.postMessage({ t: "end" });
			if (ev === "close" && state.open === false && (underruns || dropped)) {
				log(`[audio] stream closed: ${underruns} underruns, ${dropped + workletDropped} chunks dropped so far`);
			}
		},
		onChunk(chunk: SoundChunk): number {
			ensureContext();
			return play(chunk);
		},
		stats: () => ({
			mode, state: ctx?.state ?? null, sampleRate: ctx?.sampleRate ?? 0,
			dropped: dropped + workletDropped, underruns, queuedS,
		}),
	};
}
