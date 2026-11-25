// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The Web Audio sink (js/web/audio.ts) without a browser: the worklet's
// source in a stand-in AudioWorkletGlobalScope, and createAudioOut() on
// stand-ins for AudioContext, document and navigator.
//
//   node --test test/audio.test.ts
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { SOUND_FORMAT_S16_LE, SOUND_FORMAT_U8, type SoundEvent, type SoundFormat } from "../js/core/sound.ts";
import { AUDIO_WORKLET, createAudioOut, type AudioOut, type AudioOutOptions } from "../js/web/audio.ts";

const RATE = 48000;
const QUANTUM = 128;

type Msg = { t: string; d?: Float32Array; ch?: number; rate?: number; keep?: boolean };

interface Processor {
	port: { onmessage: ((e: { data: Msg }) => void) | null; postMessage: (m: unknown) => void };
	q: unknown[];
	sec: number;
	avg: number;
	playing: boolean;
	underruns: number;
	dropped: number;
	process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

function worklet(sampleRate = RATE): { p: Processor; send: (m: Msg) => void; render: (quanta?: number, right?: boolean) => Float32Array; reports: unknown[] } {
	const reports: unknown[] = [];
	let Cls: (new () => Processor) | undefined;
	class Base {
		port = { onmessage: null, postMessage: (m: unknown) => { reports.push(m); } };
	}
	new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", AUDIO_WORKLET)(
		Base, (_: string, c: new () => Processor) => { Cls = c; }, sampleRate);
	const p = new Cls!();
	return {
		p, reports,
		send: (m) => p.port.onmessage!({ data: m }),
		render(quanta = 1, right = false) {
			const all = new Float32Array(quanta * QUANTUM);
			for (let i = 0; i < quanta; i++) {
				const L = new Float32Array(QUANTUM), R = new Float32Array(QUANTUM);
				p.process([], [[L, R]]);
				all.set(right ? R : L, i * QUANTUM);
			}
			return all;
		},
	};
}

const mono = (seconds: number, value: number, rate = RATE): Float32Array => new Float32Array(Math.round(seconds * rate)).fill(value);
const pcm = (seconds: number, value: number, keep = false, rate = RATE): Msg => ({ t: "pcm", d: mono(seconds, value, rate), ch: 1, rate, keep });
const quantaOf = (seconds: number): number => Math.ceil(seconds * RATE / QUANTUM);

describe("worklet", () => {
	test("starts once 60 ms are queued", () => {
		const w = worklet();
		w.send(pcm(0.05, 0.5));
		assert.equal(w.render()[0], 0);
		w.send(pcm(0.02, 0.5));
		assert.equal(w.render()[0], 0.5);
	});

	test("a short stream that ended plays out without an underrun", () => {
		const w = worklet();
		w.send(pcm(0.02, 0.5));
		w.send({ t: "end" });
		const out = w.render(quantaOf(0.1));
		const played = out.filter((v) => v !== 0).length;
		assert.ok(Math.abs(played - 0.02 * RATE) <= 20, `${played} frames`);
		assert.equal(w.p.underruns, 0);
	});

	test("running dry while the stream plays is an underrun", () => {
		const w = worklet();
		w.send(pcm(0.07, 0.5));
		w.render(quantaOf(0.1));
		assert.equal(w.p.underruns, 1);
	});

	test("live chunks over 300 ms drop the oldest", () => {
		const w = worklet();
		for (let i = 0; i < 29; i++) w.send(pcm(0.01, 0.5));
		assert.equal(w.p.dropped, 0);
		w.send(pcm(0.015, 0.5));
		assert.ok(w.p.sec <= 0.061, `${w.p.sec}`);
		assert.ok(w.p.dropped > 0);
	});

	test("held audio is kept whole, at its own pace", () => {
		const w = worklet();
		for (let i = 0; i < 200; i++) w.send(pcm(0.01, 0.5, true));
		w.send({ t: "end" });
		assert.ok(Math.abs(w.p.sec - 2) < 1e-6);
		const played = w.render(quantaOf(2.2)).filter((v) => v !== 0).length;
		assert.ok(Math.abs(played - 2 * RATE) <= 2, `${played} frames`);
		assert.equal(w.p.dropped, 0);
		assert.equal(w.p.underruns, 0);
	});

	test("a live chunk cuts held audio off, then starts as any stream", () => {
		const w = worklet();
		for (let i = 0; i < 200; i++) w.send(pcm(0.01, 0.5, true));
		w.render(10);
		w.send(pcm(0.01, 0.25));
		assert.ok(Math.abs(w.p.sec - 0.01) < 1e-6, `${w.p.sec}`);
		assert.equal(w.render()[0], 0);
		w.send(pcm(0.06, 0.25));
		assert.equal(w.render()[0], 0.25);
	});

	test("the end of held audio, up to 300 ms, plays before a live chunk", () => {
		const w = worklet();
		for (let i = 0; i < 20; i++) w.send(pcm(0.01, 0.5, true));
		w.send(pcm(0.01, 0.25));
		assert.equal(w.p.dropped, 0);
		assert.equal(w.render()[0], 0.5);
	});

	test("stereo, and mono on both channels", () => {
		const w = worklet();
		w.send({ t: "pcm", d: Float32Array.from({ length: 9600 }, (_, i) => (i % 2 ? 0.25 : 0.5)), ch: 2, rate: RATE });
		assert.equal(w.render()[0], 0.5);
		assert.equal(w.render(1, true)[0], 0.25);
		const m = worklet();
		m.send(pcm(0.1, 0.5));
		assert.equal(m.render(1, true)[0], 0.5);
	});

	test("resamples to the context's rate and reports every 100 ms", () => {
		const w = worklet();
		w.send(pcm(0.2, 0.5, true, 24000));
		w.send({ t: "end" });
		const played = w.render(quantaOf(0.4)).filter((v) => v !== 0).length;
		assert.ok(Math.abs(played - 0.2 * RATE) <= 4, `${played} frames`);
		assert.equal(w.reports.length, 3);
	});

	test("steers a live queue towards its target by at most 1%", () => {
		const w = worklet();
		for (let i = 0; i < 25; i++) w.send(pcm(0.01, 0.5));
		w.p.avg = 0.25;
		const before = w.p.sec;
		w.render(38); // 101 ms
		const ratio = (before - w.p.sec) / (38 * QUANTUM / RATE);
		assert.ok(ratio > 1.005 && ratio < 1.0101, `${ratio}`);
	});
});

const FMT: SoundFormat = { rate: RATE, channels: 1, format: SOUND_FORMAT_S16_LE, frameBytes: 2 };

/** Everything the stand-in Web Audio was asked to do. */
class Env {
	contexts: FakeContext[] = [];
	posted: Msg[] = [];
	transferred = 0;
	/** Listeners on the document now. */
	listeners = 0;
	doc = new (class extends EventTarget {
		override addEventListener(...a: Parameters<EventTarget["addEventListener"]>): void { env.listeners++; super.addEventListener(...a); }
		override removeEventListener(...a: Parameters<EventTarget["removeEventListener"]>): void { env.listeners--; super.removeEventListener(...a); }
	})();
	activation: { hasBeenActive: boolean } | undefined = { hasBeenActive: false };
	autoplayPolicy: string | undefined;
	secure = true;
	noWebAudio = false;
	throwOnCreate = false;
	workletFails = false;
	/** Whether a resume() starts the context. */
	allowResume = true;
	loadWorklet: (() => void) | null = null;

	/** A click the browser counts as activation. */
	click(type = "click"): void {
		if (this.activation) this.activation.hasBeenActive = true;
		this.doc.dispatchEvent(new Event(type));
	}
	get pcm(): Msg[] { return this.posted.filter((m) => m.t === "pcm"); }
	get last(): FakeContext { return this.contexts[this.contexts.length - 1]!; }
}

let env: Env;

class FakeSource {
	buffer: { duration: number } | null = null;
	startedAt: number | null = null;
	stopped = false;
	onended: (() => void) | null = null;
	connect(): void {}
	start(t = 0): void { this.startedAt = t; }
	stop(): void { this.stopped = true; }
}

class FakeContext extends EventTarget {
	state: string = "suspended";
	sampleRate = RATE;
	baseLatency = 0.01;
	currentTime = 0;
	destination = {};
	gains: { gain: { value: number } }[] = [];
	sources: FakeSource[] = [];
	stateListeners = 0;
	override addEventListener(...a: Parameters<EventTarget["addEventListener"]>): void { this.stateListeners++; super.addEventListener(...a); }
	override removeEventListener(...a: Parameters<EventTarget["removeEventListener"]>): void { this.stateListeners--; super.removeEventListener(...a); }
	audioWorklet: { addModule: () => Promise<void> } | undefined;
	constructor() {
		super();
		if (env.throwOnCreate) throw new Error("no device");
		env.contexts.push(this);
		this.audioWorklet = {
			addModule: () => env.workletFails ? Promise.reject(new Error("CSP")) : new Promise((r) => { env.loadWorklet = () => r(); }),
		};
	}
	createGain() {
		const g = { gain: { value: 1 }, connect() {} };
		this.gains.push(g);
		return g;
	}
	createBuffer(_ch: number, frames: number, rate: number) {
		return { duration: frames / rate, copyToChannel() {} };
	}
	createBufferSource(): FakeSource {
		const s = new FakeSource();
		this.sources.push(s);
		return s;
	}
	setState(s: string): void {
		this.state = s;
		this.dispatchEvent(new Event("statechange"));
	}
	resume(): Promise<void> {
		if (env.allowResume) queueMicrotask(() => { if (this.state === "suspended") this.setState("running"); });
		return Promise.resolve();
	}
	close(): Promise<void> {
		this.state = "closed";
		return Promise.resolve();
	}
}

class FakeNode {
	port = { onmessage: null, postMessage: (m: Msg, transfer?: unknown[]) => { env.posted.push(m); env.transferred += transfer?.length ?? 0; } };
	connect(): void {}
	disconnect(): void {}
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

const saved = new Map<string, PropertyDescriptor | undefined>();
function define(name: string, get: () => unknown): void {
	if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	Object.defineProperty(globalThis, name, { configurable: true, get });
}

let out: AudioOut;
let logs: string[];
let changes: string[];
const make = (o: AudioOutOptions = {}): AudioOut => (out = createAudioOut({ log: (m) => logs.push(m), onChange: (s) => changes.push(s), ...o }));

const ev = (event: SoundEvent, playing = event === "start"): void =>
	out.onState!({ open: event !== "close", playing, format: FMT }, event);
/** A chunk of `seconds` of one S16 sample value. */
const chunk = (seconds: number, value = 8192, format = FMT): number => {
	const frames = Math.round(seconds * format.rate);
	const data = format.format === SOUND_FORMAT_U8 ? new Uint8Array(frames).fill(value) : new Uint8Array(new Int16Array(frames).fill(value).buffer);
	return out.onChunk!({ format, data, frames }) as number;
};
const start = (): void => { ev("open"); ev("prepare"); ev("start"); };
const ready = async (): Promise<void> => {
	await tick();
	env.loadWorklet?.();
	await tick();
};

describe("createAudioOut", { concurrency: 1 }, () => {
	beforeEach(() => {
		env = new Env();
		logs = [];
		changes = [];
		define("document", () => env.doc);
		define("navigator", () => ({
			userActivation: env.activation,
			...(env.autoplayPolicy !== undefined && { getAutoplayPolicy: () => env.autoplayPolicy }),
		}));
		define("AudioContext", () => (env.noWebAudio ? undefined : FakeContext));
		define("AudioWorkletNode", () => FakeNode);
		define("isSecureContext", () => env.secure);
	});
	afterEach(async () => {
		await out.close();
		for (const [name, d] of saved) {
			if (d) Object.defineProperty(globalThis, name, d);
			else delete (globalThis as Record<string, unknown>)[name];
		}
		saved.clear();
	});

	test("creates no context before a gesture, then plays an ended clip whole", async () => {
		make();
		start();
		for (let i = 0; i < 200; i++) assert.equal(chunk(0.01), 0, "held audio is no delay");
		ev("drain");
		ev("close");
		assert.equal(env.contexts.length, 0);
		assert.equal(out.state, "waiting");
		assert.ok(Math.abs(out.stats().heldS - 2) < 1e-6);
		env.click();
		await ready();
		assert.equal(env.contexts.length, 1);
		assert.equal(env.pcm.length, 200);
		assert.ok(env.pcm.every((m) => m.keep));
		assert.equal(env.posted.at(-1)!.t, "end");
		assert.equal(out.state, "running");
		assert.equal(out.stats().heldS, 0);
		assert.deepEqual(changes, ["waiting", "running"]);
		assert.equal(env.transferred, 200);
		assert.ok(env.last.sources.some((s) => s.startedAt === 0), "the iOS unlock");
		assert.equal(env.listeners, 0);
	});

	for (const type of ["keydown", "mousedown", "pointerup", "touchend", "click"]) {
		test(`${type} starts it`, async () => {
			make();
			start();
			chunk(0.01);
			env.click(type);
			await ready();
			assert.equal(out.state, "running");
		});
	}

	test("a clip followed by zeros of a stream left open plays whole, and they do not cut it off", async () => {
		make();
		start();
		for (let i = 0; i < 100; i++) chunk(0.01);
		for (let i = 0; i < 1500; i++) chunk(0.01, 0);
		assert.ok(out.stats().heldS < 1.6, `${out.stats().heldS}`);
		env.click();
		await ready();
		const n = env.pcm.length;
		assert.ok(n >= 100 && env.pcm.every((m) => m.keep));
		assert.equal(env.pcm.filter((m) => m.d![0] !== 0).length, 100);
		chunk(0.01, 0);
		assert.equal(env.pcm.length, n);
		assert.equal(chunk(0.01), 0.01 * RATE, "sound cuts it off");
		assert.equal(env.pcm.length, n + 1);
	});

	test("held: the window that slides past the sound leaves no zeros", () => {
		make({ holdSeconds: 0.2 });
		start();
		chunk(0.01);
		for (let i = 0; i < 40; i++) chunk(0.01, 0);
		assert.equal(out.stats().heldS, 0);
	});

	test("a live stream whose page was activated elsewhere starts at its next chunk", async () => {
		make();
		start();
		chunk(0.01);
		env.activation!.hasBeenActive = true;
		chunk(0.01);
		await ready();
		assert.equal(out.state, "running");
	});

	test("the end of a live stream is passed on", async () => {
		env.activation!.hasBeenActive = true;
		make();
		start();
		await ready();
		chunk(0.02);
		ev("drain");
		assert.equal(env.posted.at(-1)!.t, "end");
	});

	test("holdSeconds: 0 keeps the chunks of the moment the worklet loads", async () => {
		env.activation!.hasBeenActive = true;
		make({ holdSeconds: 0 });
		start();
		for (let i = 0; i < 5; i++) chunk(0.01);
		await ready();
		assert.equal(env.pcm.length, 5);
	});

	test("holdSeconds: NaN is the default", () => {
		make({ holdSeconds: NaN });
		start();
		for (let i = 0; i < 1200; i++) chunk(0.01);
		assert.ok(out.stats().heldS <= 10.001);
	});

	test("gestures in a row do not put off \"waiting\"", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		env.activation!.hasBeenActive = true;
		env.allowResume = false;
		make();
		start();
		chunk(0.01);
		for (let i = 0; i < 3; i++) {
			t.mock.timers.tick(400);
			env.click();
		}
		assert.equal(out.state, "waiting");
	});

	test("onChange is not called from inside the kernel's call", async () => {
		make();
		start();
		chunk(0.01);
		assert.deepEqual(changes, []);
		await tick();
		assert.deepEqual(changes, ["waiting"]);
	});

	test("a stream that still plays joins live", async () => {
		make();
		start();
		for (let i = 0; i < 200; i++) chunk(0.01);
		env.click();
		await ready();
		assert.ok(env.pcm.length <= 6, `${env.pcm.length} chunks`);
		assert.ok(env.pcm.every((m) => !m.keep));
		assert.ok(!env.posted.some((m) => m.t === "end"));
		assert.ok(chunk(0.01) > 0);
	});

	test("an event that is no activation starts nothing", async () => {
		make();
		start();
		chunk(0.01);
		env.doc.dispatchEvent(new Event("keydown"));
		await ready();
		assert.equal(env.contexts.length, 0);
		env.click();
		await ready();
		assert.equal(out.state, "running");
	});

	test("without navigator.userActivation the gesture itself starts it", async () => {
		env.activation = undefined;
		make();
		start();
		chunk(0.01);
		assert.equal(env.contexts.length, 0);
		env.click();
		await ready();
		assert.equal(out.state, "running");
	});

	test("starts at once after a gesture or where autoplay is allowed, keeping the first chunks", async () => {
		env.activation!.hasBeenActive = true;
		make();
		start();
		assert.equal(env.contexts.length, 1);
		for (let i = 0; i < 5; i++) chunk(0.01);
		assert.equal(out.state, "idle", "not waiting for a gesture while the context starts");
		await ready();
		assert.equal(env.pcm.length, 5);
		assert.equal(out.state, "running");
		await out.close();

		env = new Env();
		env.autoplayPolicy = "allowed";
		make();
		start();
		assert.equal(env.contexts.length, 1);
	});

	test("a context the browser keeps suspended waits for the next gesture", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		env.activation!.hasBeenActive = true;
		env.allowResume = false;
		make();
		start();
		chunk(0.01);
		t.mock.timers.tick(1500);
		assert.equal(out.state, "waiting");
		env.allowResume = true;
		env.click();
		await ready();
		assert.equal(out.state, "running");
	});

	test("what plays in an interruption is dropped, and the stream resumes", async () => {
		env.activation!.hasBeenActive = true;
		make();
		start();
		chunk(0.01);
		await ready();
		const n = env.pcm.length;
		env.last.setState("interrupted");
		chunk(0.01);
		assert.equal(out.state, "waiting");
		assert.equal(env.pcm.length, n);
		env.last.state = "suspended";
		env.click();
		await ready();
		assert.equal(out.state, "running");
		assert.equal(env.pcm.length, n);
		chunk(0.01);
		assert.equal(env.pcm.length, n + 1);
	});

	test("holds only the latest, and no silence before the first sound", () => {
		make({ holdSeconds: 1 });
		start();
		for (let i = 0; i < 50; i++) chunk(0.01, 0);
		assert.equal(out.state, "idle");
		assert.equal(out.stats().heldS, 0);
		for (let i = 0; i < 150; i++) chunk(0.01);
		assert.ok(Math.abs(out.stats().heldS - 1) < 0.011);
		assert.ok(out.stats().dropped >= 49);
		assert.equal(out.state, "waiting");
	});

	test("U8 silence is silence", () => {
		make();
		start();
		const u8: SoundFormat = { rate: 8000, channels: 1, format: SOUND_FORMAT_U8, frameBytes: 1 };
		chunk(0.01, 128, u8);
		assert.equal(out.stats().heldS, 0);
		chunk(0.01, 200, u8);
		assert.ok(out.stats().heldS > 0);
	});

	test("holdSeconds: 0 holds nothing, but waits while a stream plays", () => {
		make({ holdSeconds: 0 });
		start();
		chunk(0.01);
		assert.equal(out.stats().heldS, 0);
		assert.equal(out.state, "waiting");
		ev("stop");
		ev("close");
		assert.equal(out.state, "idle");
	});

	test("the delay never counts more than the queue keeps", async () => {
		env.activation!.hasBeenActive = true;
		make();
		start();
		await ready();
		let q = 0;
		for (let i = 0; i < 100; i++) q = chunk(0.01, i === 0 ? 8192 : 4096);
		assert.ok(q <= 0.3 * RATE, `${q}`);
	});

	test("muted", async () => {
		env.activation!.hasBeenActive = true;
		make({ muted: true });
		start();
		assert.equal(env.last.gains[0]!.gain.value, 0);
		out.muted = false;
		assert.equal(env.last.gains[0]!.gain.value, 1);
		assert.equal(out.muted, false);
	});

	test("resume() before anything plays, from a gesture", async () => {
		make();
		out.resume();
		assert.equal(env.contexts.length, 0, "no gesture yet");
		env.activation!.hasBeenActive = true;
		out.resume();
		await ready();
		assert.equal(env.contexts.length, 1);
		assert.equal(out.state, "idle");
		start();
		chunk(0.01);
		assert.equal(out.state, "running");
	});

	test("no Web Audio: unavailable, said once", () => {
		env.noWebAudio = true;
		env.activation!.hasBeenActive = true;
		make();
		start();
		for (let i = 0; i < 5; i++) assert.equal(chunk(0.01), 0);
		assert.equal(out.state, "unavailable");
		assert.equal(logs.length, 1);
	});

	test("a context that cannot be created: unavailable, tried once", () => {
		env.throwOnCreate = true;
		env.activation!.hasBeenActive = true;
		make();
		start();
		for (let i = 0; i < 5; i++) chunk(0.01);
		assert.equal(out.state, "unavailable");
		assert.equal(logs.length, 1);
	});

	test("close() releases the context and the listeners", async () => {
		make();
		start();
		chunk(0.01);
		await out.close();
		assert.equal(out.state, "closed");
		assert.equal(env.listeners, 0);
		env.click();
		assert.equal(env.contexts.length, 0);
		assert.equal(chunk(0.01), 0);

		make();
		start();
		assert.equal(env.contexts.length, 1);
		await out.close();
		assert.equal(env.last.state, "closed");
		assert.equal(env.last.stateListeners, 0);
		env.loadWorklet!();
		await tick();
		assert.equal(env.posted.length, 0);
	});

	test("scheduled buffers: a held clip is queued back to back, a live chunk cuts it off", async () => {
		env.secure = false;
		make();
		start();
		for (let i = 0; i < 100; i++) chunk(0.01);
		ev("drain");
		env.click();
		await tick();
		assert.equal(out.stats().mode, "buffers");
		const clip = env.last.sources.filter((s) => s.startedAt !== null && s.startedAt > 0);
		assert.equal(clip.length, 100);
		assert.ok(Math.abs(clip[99]!.startedAt! - clip[0]!.startedAt! - 0.99) < 1e-6);
		ev("start");
		const q = chunk(0.01);
		assert.ok(clip.every((s) => s.stopped));
		assert.ok(q > 0 && q <= 0.1 * RATE, `${q}`);
	});

	test("scheduled buffers: joining a live stream adds no lasting latency", async () => {
		env.secure = false;
		make();
		start();
		for (let i = 0; i < 29; i++) chunk(0.01);
		env.click();
		await tick();
		assert.ok(chunk(0.01) <= 0.081 * RATE);
	});

	test("close() ends the start timer", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
		env.activation!.hasBeenActive = true;
		env.allowResume = false;
		const clear = t.mock.method(globalThis, "clearTimeout");
		make();
		start();
		await out.close();
		assert.equal(clear.mock.callCount(), 1);
	});

	test("a worklet that does not load falls back to scheduled buffers, with what was held", async () => {
		env.workletFails = true;
		env.activation!.hasBeenActive = true;
		make();
		start();
		for (let i = 0; i < 3; i++) chunk(0.01);
		await tick();
		await tick();
		assert.equal(out.stats().mode, "buffers");
		assert.equal(env.last.sources.filter((s) => s.startedAt !== null && s.startedAt > 0).length, 3);
	});
});
