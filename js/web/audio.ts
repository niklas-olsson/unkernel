// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The guest's sound in a browser: a SoundSink (core/sound.ts) that plays
// the PCM with Web Audio. createKernel({ sound: createAudioOut() })
//
// - The kernel hands over PCM from a timer every 2-10 ms, inline from inside
//   a synchronous import, while the main thread is busy running the guest
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
// - Browsers usually let a page start sound only once the user has clicked,
//   tapped or pressed a key on it. The AudioContext is created at the first
//   playback after such a gesture (navigator.userActivation) or where the
//   browser says it needs none (Firefox's autoplay policy; Chrome, which may
//   allow a site it knows, does not say), else at the next gesture
//   (GESTURES: the events that count as activation in Chrome, Firefox and
//   Safari, including iOS, which needs touchend or click). Created earlier
//   it is mostly refused, with a warning in the console. Safari may also
//   refuse one created outside a gesture's handler; like a context that iOS
//   interrupts (a call, the background), it starts at the next gesture.
// - What is played before the output first runs is held, the latest HOLD_S
//   of it from its first sound on. Then a clip that has ended plays whole
//   (at its own pace, not steered), and a stream that still plays joins
//   live. A stream that has played zeros for QUIET_S counts as ended: a
//   sound server in the guest plays them while no client does. Such zeros
//   are not held and do not disturb the clip; other live sound cuts it off
//   if more than MAX_S of it is left. The guest sees no delay for held
//   audio. The same list holds the chunks of the moment the context takes
//   to start and the worklet to load. Once the output has run, what plays
//   while it is interrupted is dropped.
// - SoundSink.onRing is not used: a worklet does not run while its context
//   is suspended, so nothing would drain the ring, which holds 1.4 s.
import { pcmToFloat32, type SoundChunk, type SoundEvent, type SoundSink, type SoundState } from "../core/sound.ts";

/** Queue the worklet fills before it starts playing, and steers towards. */
const TARGET_S = 0.06;
/** Most queued before the oldest chunks are dropped. */
const MAX_S = 0.3;
/** Most held before the context runs (AudioOutOptions.holdSeconds). */
const HOLD_S = 10;
/** Zeros for this long are a pause: what came before them has ended. */
const QUIET_S = 0.5;
/** How long a context asked to run may take before the page counts as waiting for a gesture, in ms. */
const START_MS = 1000;
const GESTURES = ["keydown", "mousedown", "pointerup", "touchend", "click"] as const;

/**
 * Runs in the AudioWorkletGlobalScope (sampleRate, AudioWorkletProcessor and
 * registerProcessor are its globals). Messages in: {t: "pcm", d: Float32Array
 * interleaved, ch, rate, keep} (keep: held audio, queued whole), {t: "start"},
 * {t: "end"} (play out what is queued without waiting for TARGET). Out, every
 * ~100 ms: {sec, underruns, dropped}. Exported for test/audio.test.ts.
 * @internal
 */
export const AUDIO_WORKLET = `
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
				this.q.push({ d: m.d, ch: m.ch, rate: m.rate, frames, keep: m.keep });
				this.sec += frames / m.rate;
				this.ending = false;
				if (!m.keep && this.sec > MAX) {
					const cut = this.q[0].keep;
					if (cut) this.playing = false;
					while (this.q.length > 1 && (cut ? this.q[0].keep : this.sec > TARGET)) {
						const c = this.q.shift();
						this.sec -= (c.frames - this.off) / c.rate;
						this.off = 0;
						this.dropped++;
					}
				}
			} else if (m.t === "start") this.ending = false;
			else if (m.t === "end") this.ending = true;
		};
	}
	process(inputs, outputs) {
		const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length;
		let i = 0;
		if (!this.playing && this.q.length && (this.sec >= TARGET || this.ending)) this.playing = true;
		if (this.playing) {
			if (this.q.length && this.q[0].keep) this.avg = TARGET;
			else this.avg += (this.sec - this.avg) * (n / sampleRate);
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

/**
 * What an AudioOut does:
 * - "idle": nothing to hear so far, or nothing plays while the browser has
 *   the output suspended;
 * - "waiting": the guest plays, or played something that is held, and it
 *   starts at the user's next click, tap or key press on the page;
 * - "running": the output is on, and the guest has played something;
 * - "unavailable": this browser gives no Web Audio;
 * - "closed": after close().
 */
export type AudioOutState = "idle" | "waiting" | "running" | "unavailable" | "closed";

export interface AudioOutOptions {
	log?: (msg: string) => void;
	/**
	 * How much of what the guest plays before the output first runs is kept,
	 * in seconds (the latest; default 10, 0 for none).
	 */
	holdSeconds?: number;
	/** Start muted. Default false. */
	muted?: boolean;
	/** `state` changed (called from a microtask; not for the first state, "idle"). */
	onChange?: (state: AudioOutState) => void;
}

export interface AudioOutStats {
	/** "worklet", "buffers" (the fallback), or null before there is an AudioContext. */
	mode: "worklet" | "buffers" | null;
	/** The AudioContext's state, or null before there is one. */
	state: string | null;
	sampleRate: number;
	/** Chunks dropped because too much was held or queued. */
	dropped: number;
	/** Times the output ran dry while a stream played. */
	underruns: number;
	/** Seconds queued in the output, as last reported. */
	queuedS: number;
	/** Seconds held until the output runs. */
	heldS: number;
}

/**
 * The sink of one kernel at a time. Nothing closes it when the kernel ends:
 * pass it to the next one, or close() it.
 */
export interface AudioOut extends SoundSink {
	readonly state: AudioOutState;
	/** Silences the output; the guest's stream goes on. */
	muted: boolean;
	/**
	 * Start or resume the output: call it from a click or key handler (a
	 * play button). Not needed for gestures that reach the document, which
	 * start it by themselves while something plays. Without a gesture so far
	 * it does nothing but wait for one.
	 */
	resume(): void;
	stats(): AudioOutStats;
	/** Stop for good: releases the AudioContext, the listeners and what is held. */
	close(): Promise<void>;
}

/** One chunk as interleaved floats. */
interface Pcm {
	d: Float32Array<ArrayBuffer>;
	ch: number;
	rate: number;
	silent: boolean;
}

const secondsOf = (p: Pcm): number => p.d.length / p.ch / p.rate;

function isSilent(d: Float32Array): boolean {
	for (let i = 0; i < d.length; i++) if (d[i] !== 0) return false;
	return true;
}

const audioContextClass = (): typeof AudioContext | undefined =>
	globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

type Nav = Partial<Navigator> & { getAutoplayPolicy?: (type: "audiocontext") => string };
const nav = (): Nav | undefined => globalThis.navigator as Nav | undefined;

/** The page may try to start sound now: it has had a gesture, or the browser needs none (only Firefox says). */
function mayStart(): boolean {
	const n = nav();
	if (n?.userActivation?.hasBeenActive) return true;
	try { return n?.getAutoplayPolicy?.("audiocontext") === "allowed"; } catch { return false; }
}

/** A SoundSink that plays the guest's PCM through Web Audio (see the top of this file). */
export function createAudioOut(opts: AudioOutOptions = {}): AudioOut {
	const log = opts.log ?? (() => {});
	const holdS = opts.holdSeconds !== undefined && opts.holdSeconds >= 0 ? opts.holdSeconds : HOLD_S;
	let state: AudioOutState = "idle", told: AudioOutState = "idle";
	let saidWaiting = false;
	let muted = opts.muted ?? false;
	let failed = false, closed = false;
	let ctx: AudioContext | null = null;
	let gain: GainNode | null = null;
	let node: AudioWorkletNode | null = null;
	let mode: AudioOutStats["mode"] = null;
	/** The guest has opened a stream to play; it has played more than silence; a stream runs now. */
	let wanted = false, heard = false, streaming = false;
	/** How long the guest has played zeros, in seconds. */
	let quietS = 0;
	/** The output has run. */
	let ran = false;
	/** The context was asked to run; until it does, or START_MS passed, `state` stays. */
	let starting: ReturnType<typeof setTimeout> | null = null;
	/** Chunks that wait for the output to run (or the worklet to load), and their length in seconds. */
	let held: Pcm[] = [];
	let heldS = 0;
	/** Held audio was queued and no live chunk since; when it has played (performance.now()). */
	let kept = false, keptUntil = 0;
	let queuedS = 0, underruns = 0, dropped = 0, workletDropped = 0;
	/** The fallback: when the next chunk starts, and the sources of held audio that may still play. */
	let nextTime = 0;
	const heldSources = new Set<AudioBufferSourceNode>();
	let armed = false;

	const running = (): boolean => ctx?.state === "running";
	/** The stream plays, and not zeros only. */
	const live = (): boolean => streaming && quietS < QUIET_S;
	const ready = (): boolean => running() && (mode === "buffers" || node !== null);

	const currentState = (): AudioOutState => {
		if (closed) return "closed";
		if (failed) return "unavailable";
		if (running()) return heard ? "running" : "idle";
		if (starting !== null) return state;
		return held.length || (streaming && heard) ? "waiting" : "idle";
	};
	const onGesture = (): void => resume();
	const arm = (on: boolean): void => {
		if (on === armed || typeof document === "undefined") return;
		armed = on;
		for (const ev of GESTURES) {
			if (on) document.addEventListener(ev, onGesture, { capture: true, passive: true });
			else document.removeEventListener(ev, onGesture, { capture: true });
		}
	};
	const update = (): void => {
		arm(!closed && !failed && !running() && (wanted || ctx !== null));
		const next = currentState();
		if (next === state) return;
		state = next;
		if (state === "running") {
			saidWaiting = false;
			log(`[audio] playing (${ctx!.sampleRate} Hz, ${mode})`);
		}
		if (state === "waiting" && !saidWaiting) {
			saidWaiting = true;
			log("[audio] sound starts at the next tap, click or key press");
		}
		// Not from here: inline this may be inside the kernel's call.
		queueMicrotask(() => {
			if (told === state) return;
			told = state;
			try { opts.onChange?.(state); } catch (e) { log(`[audio] onChange failed: ${e}`); }
		});
	};
	const stopStarting = (): void => {
		if (starting !== null) clearTimeout(starting);
		starting = null;
	};
	const dropHeld = (): void => {
		held = [];
		heldS = 0;
	};
	const fail = (why: string): void => {
		failed = true;
		stopStarting();
		dropHeld();
		log(`[audio] ${why}: no sound`);
		update();
	};

	/** Keep a chunk until the output runs. */
	const hold = (p: Pcm): void => {
		if (p.silent && (!held.length || quietS > QUIET_S)) return;
		const before = ran ? 0 : holdS;
		// A context about to run (the worklet loads) holds as much as the queue takes.
		const limit = running() || starting !== null ? Math.max(before, MAX_S) : before;
		held.push(p);
		heldS += secondsOf(p);
		while (held.length && (heldS > limit || held[0]!.silent)) {
			heldS -= secondsOf(held.shift()!);
			dropped++;
		}
		if (!held.length) heldS = 0;
	};

	/** Play one chunk; returns the frames (at its rate) queued after it. `keep`: held audio, not live. */
	const play = (p: Pcm, keep: boolean): number => {
		const { d, ch, rate } = p;
		const seconds = secondsOf(p);
		ran = true;
		if (mode === "worklet") {
			node!.port.postMessage({ t: "pcm", d, ch, rate, keep }, [d.buffer]);
			queuedS += seconds;
			// What the worklet drops.
			if (!keep && queuedS > MAX_S) queuedS = kept ? seconds : TARGET_S;
			kept = keep;
			return Math.round(queuedS * rate);
		}
		// Fallback: one AudioBufferSourceNode per chunk, back to back.
		const c = ctx!;
		const now = c.currentTime;
		if (!keep && kept && nextTime - now > MAX_S) {
			for (const s of heldSources) s.stop();
			nextTime = now;
		}
		kept = keep;
		if (nextTime < now + 0.005) {
			if (nextTime && !keep) underruns++;
			nextTime = now + TARGET_S;
		}
		if (!keep && nextTime - now > MAX_S) {
			dropped++;
			return Math.round((nextTime - now) * rate);
		}
		const frames = d.length / ch;
		const buf = c.createBuffer(ch, frames, rate);
		for (let k = 0; k < ch; k++) {
			const plane = new Float32Array(frames);
			for (let i = 0; i < frames; i++) plane[i] = d[i * ch + k]!;
			buf.copyToChannel(plane, k);
		}
		const src = c.createBufferSource();
		src.buffer = buf;
		src.connect(gain!);
		src.start(nextTime);
		if (keep) {
			heldSources.add(src);
			src.onended = () => { heldSources.delete(src); };
		}
		nextTime += seconds;
		queuedS = nextTime - now;
		return Math.round(queuedS * rate);
	};

	/** The output runs: play what was held (see the top of this file). */
	const flush = (): void => {
		if (!held.length || !ready()) return;
		const keep = !live();
		// The fallback does not steer: what it starts with stays its latency.
		if (!keep && (heldS > MAX_S || mode === "buffers")) {
			while (held.length > 1 && heldS > TARGET_S) {
				heldS -= secondsOf(held.shift()!);
				dropped++;
			}
			if (mode === "buffers") nextTime = Math.max(nextTime, ctx!.currentTime + Math.max(0.01, TARGET_S - heldS));
		}
		const list = held;
		if (keep) keptUntil = performance.now() + heldS * 1000;
		dropHeld();
		for (const p of list) play(p, keep);
		if (keep) node?.port.postMessage({ t: "end" });
	};

	const onContextState = (): void => {
		if (closed) return;
		if (running()) {
			stopStarting();
			ran = true;
		}
		flush();
		update();
	};

	const create = (): void => {
		const AC = audioContextClass();
		if (!AC) return fail("no Web Audio in this browser");
		let c: AudioContext;
		try {
			c = new AC({ latencyHint: "interactive" });
		} catch (e) {
			return fail(`cannot create an AudioContext (${e})`);
		}
		ctx = c;
		c.addEventListener("statechange", onContextState);
		gain = c.createGain();
		gain.gain.value = muted ? 0 : 1;
		gain.connect(c.destination);
		mode = c.audioWorklet && globalThis.isSecureContext ? "worklet" : "buffers";
		log(`[audio] AudioContext ${c.sampleRate} Hz, ${mode === "worklet" ? "AudioWorklet" : "scheduled buffers (no AudioWorklet here)"}, ` +
			`base latency ${((c.baseLatency ?? 0) * 1000).toFixed(0)} ms`);
		if (mode !== "worklet") return;
		const url = URL.createObjectURL(new Blob([AUDIO_WORKLET], { type: "text/javascript" }));
		c.audioWorklet.addModule(url).then(() => {
			if (closed) return;
			const n = new AudioWorkletNode(c, "kw-pcm", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
			n.port.onmessage = (e: MessageEvent<{ sec: number; underruns: number; dropped: number }>) => {
				queuedS = e.data.sec;
				underruns = e.data.underruns;
				workletDropped = e.data.dropped;
			};
			n.connect(gain!);
			node = n;
		}).catch((e: unknown) => {
			if (closed) return;
			log(`[audio] AudioWorklet failed (${e}); using scheduled buffers`);
			mode = "buffers";
		}).finally(() => {
			URL.revokeObjectURL(url);
			onContextState();
		});
	};

	/** Create the context, or resume it. */
	const start = (): void => {
		if (!ctx) create();
		const c = ctx;
		if (!c || c.state === "running" || c.state === "closed") return;
		starting ??= setTimeout(() => {
			starting = null;
			update();
		}, START_MS);
		void c.resume().catch(() => {});
		// The classic iOS unlock: start something from inside the gesture.
		try {
			const src = c.createBufferSource();
			src.buffer = c.createBuffer(1, 1, c.sampleRate);
			src.connect(c.destination);
			src.start();
		} catch {}
	};
	const resume = (): void => {
		if (closed || failed) return;
		wanted = true;
		// An event that is no activation (Escape, a scripted click) would get the context refused.
		if (!nav()?.userActivation || mayStart()) start();
		update();
	};
	/** The guest plays: start the output if the page may, else at the next gesture. */
	const want = (): void => {
		wanted = true;
		if (ctx) return;
		if (!audioContextClass()) fail("no Web Audio in this browser");
		else if (mayStart()) start();
	};

	return {
		// Most devices run at 48 kHz; the context does not exist yet to ask.
		rate: 48000,
		onState(s: SoundState, ev: SoundEvent): void {
			streaming = s.playing;
			if (closed || failed) return;
			if (ev === "prepare" || ev === "start") want();
			if (ev === "start" && ctx && nextTime < ctx.currentTime) nextTime = 0;
			if (ev === "start") node?.port.postMessage({ t: "start" });
			if (ev === "drain" || ev === "stop") node?.port.postMessage({ t: "end" });
			if (ev === "close" && (underruns || dropped || workletDropped)) {
				log(`[audio] stream closed: ${underruns} underruns, ${dropped + workletDropped} chunks dropped so far`);
			}
			update();
		},
		onChunk(chunk: SoundChunk): number {
			if (closed || failed || !chunk.frames) return 0;
			const d = pcmToFloat32(chunk.data, chunk.format) as Float32Array<ArrayBuffer>;
			const p: Pcm = { d, ch: chunk.format.channels, rate: chunk.format.rate, silent: isSilent(d) };
			quietS = p.silent ? quietS + secondsOf(p) : 0;
			heard ||= !p.silent;
			want();
			let queued = 0;
			if (ready()) {
				flush();
				// Zeros would cut off the clip that plays.
				if (!(kept && p.silent && performance.now() < keptUntil)) queued = play(p, false);
			} else if (!failed) hold(p);
			update();
			return queued;
		},
		get state() { return state; },
		get muted() { return muted; },
		set muted(on: boolean) {
			muted = on;
			if (gain) gain.gain.value = on ? 0 : 1;
		},
		resume,
		stats: () => ({
			mode, state: ctx?.state ?? null, sampleRate: ctx?.sampleRate ?? 0,
			dropped: dropped + workletDropped, underruns, queuedS, heldS,
		}),
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			stopStarting();
			dropHeld();
			heldSources.clear();
			node?.disconnect();
			ctx?.removeEventListener("statechange", onContextState);
			update();
			if (ctx && ctx.state !== "closed") await ctx.close().catch(() => {});
		},
	};
}
