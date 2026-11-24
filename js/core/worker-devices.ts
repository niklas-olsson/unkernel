// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Worker mode, the owner's side of the display, the evdev devices and the
// sound card (WorkerKernel, worker-host.ts). The devices live in the worker
// (worker-serve.ts); memory is not shared, so everything crosses as
// messages (worker-protocol.ts), which the worker handles only when the
// kernel yields (idle, or every 20 ms while user code runs).
//
// - Evdev (RemoteEvdev): the same methods as InputHost. Each call is
//   forwarded in order to the worker's InputHost, which applies the
//   queueing rules (presses only while open, releases of keys the guest saw,
//   releases at close). The return values come from a mirror here of the
//   open mask ("input-state") and of the keys and buttons held, so callers
//   can route keys between the guest and a terminal synchronously. Calls are
//   batched: one message per microtask, but a batch of nothing but motion
//   and wheel waits MOTION_BATCH_MS for more (a key or button press sends
//   it at once). Nothing is merged or reordered: the guest gets every call
//   as inline (merging moves was tried and lost intermediate positions).
// - Frames (FrameClient): a "latest frame" model. The owner gives credits
//   ("frame-want", at most FRAME_CREDITS outstanding), each with a returned
//   frame buffer to reuse; the worker answers one credit once the picture
//   may have changed (the kernel ran since the last frame), with the raw
//   XRGB8888 rows transferred. RGBA conversion happens here, once per
//   frame() call, into the caller's buffer: the worker thread only copies.
// - With the shared transport (worker-shared.ts) evdev calls go straight
//   into a shared ring (no batching: there is no message to save), frame
//   requests into the control block, and frames come back through a shared
//   triple buffer that frame() reads at any time; readFrame() is answered
//   by a "frame-ready" message. Without a frame buffer from the worker,
//   frames fall back to the credits above.
// - Sound (SoundBridge): with the shared transport the PCM comes through
//   the sound ring (sound-ring.ts), drained here into the sink's onChunk()
//   on a "sound-wake" message, or handed to the sink's onRing() to read
//   itself; the sink's answer (frames queued at the sink) goes back through
//   the ring. Without it, chunks come as messages with a sequence number,
//   and the answer goes back throttled to one per SOUND_REPORT_MS, with
//   the time it was measured; the worker's answer to the kernel is that
//   report, less what played since, plus the frames sent after it
//   (worker-serve.ts).

import { xrgbToRgba, type DisplayFrame, type DisplayMode } from "./display.ts";
import { INPUT_KEYBOARD, INPUT_MOUSE, INPUT_TABLET, type Evdev, type InputState } from "./input.ts";
import type { SoundChunk, SoundEvent, SoundFormat, SoundSink, SoundState } from "./sound.ts";
import { SoundRingReader } from "./sound-ring.ts";
import { EVDEV_OP, type ToWorker } from "./worker-protocol.ts";
import type { SharedOwner } from "./worker-shared.ts";

/** How long a batch of nothing but pointer motion and wheel clicks waits for more before it is sent. */
const MOTION_BATCH_MS = 8;
/** Frame credits outstanding at most: two lets the worker send a frame at every yield without waiting for this thread. */
const FRAME_CREDITS = 2;
/** At most one sink report per this many ms. */
const SOUND_REPORT_MS = 15;

/** performance.now() on a clock both threads share (ms). */
export const sharedNow = (): number => performance.timeOrigin + performance.now();

/** InputHost's surface, forwarded to the worker (see the top of this file). */
export class RemoteEvdev implements Evdev {
	mask = 0;
	#post: (msg: ToWorker) => void;
	#ops: number[] = [];
	#urgent = false;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#micro = false;
	#keys = new Set<number>();
	#buttons = new Set<number>();
	#tabletButtons = new Set<number>();
	#shared: SharedOwner | undefined;

	constructor(post: (msg: ToWorker) => void, shared?: SharedOwner) {
		this.#post = post;
		this.#shared = shared;
	}

	get keyboardOpen(): boolean { return !!(this.mask & (1 << INPUT_KEYBOARD)); }
	get mouseOpen(): boolean { return !!(this.mask & (1 << INPUT_MOUSE)); }
	get tabletOpen(): boolean { return !!(this.mask & (1 << INPUT_TABLET)); }
	get state(): InputState {
		return { keyboard: this.keyboardOpen, mouse: this.mouseOpen, tablet: this.tabletOpen };
	}

	/** @internal The worker reported the open mask: keys on a device that closed were released there. */
	setMask(mask: number): void {
		const closed = this.mask & ~mask;
		this.mask = mask >>> 0;
		if (closed & (1 << INPUT_KEYBOARD)) this.#keys.clear();
		if (closed & (1 << INPUT_MOUSE)) this.#buttons.clear();
		if (closed & (1 << INPUT_TABLET)) this.#tabletButtons.clear();
	}

	#held(set: Set<number>, open: boolean, op: number, code: number, down: boolean): boolean {
		if (down) {
			if (!open) return false;
			if (!set.has(code)) {
				set.add(code);
				this.#queue(op, code, 1);
			}
			return true;
		}
		if (!set.delete(code)) return false;
		this.#queue(op, code, 0);
		return true;
	}

	key(code: number, down: boolean): boolean {
		return this.#held(this.#keys, this.keyboardOpen, EVDEV_OP.key, code, down);
	}

	button(code: number, down: boolean): boolean {
		return this.#held(this.#buttons, this.mouseOpen, EVDEV_OP.button, code, down);
	}

	tabletButton(code: number, down: boolean): boolean {
		return this.#held(this.#tabletButtons, this.tabletOpen, EVDEV_OP.tabletButton, code, down);
	}

	move(dx: number, dy: number): boolean {
		if (!this.mouseOpen) return false;
		this.#queue(EVDEV_OP.move, dx, dy, true);
		return true;
	}

	wheel(clicks: number): boolean {
		if (!this.mouseOpen) return false;
		if (Math.round(clicks)) this.#queue(EVDEV_OP.wheel, clicks, 0, true);
		return true;
	}

	moveTo(x: number, y: number): boolean {
		if (!this.tabletOpen) return false;
		this.#queue(EVDEV_OP.moveTo, x, y, true);
		return true;
	}

	tabletWheel(clicks: number): boolean {
		if (!this.tabletOpen) return false;
		if (Math.round(clicks)) this.#queue(EVDEV_OP.tabletWheel, clicks, 0, true);
		return true;
	}

	releaseAll(): void {
		for (const c of [...this.#keys]) this.key(c, false);
		for (const b of [...this.#buttons]) this.button(b, false);
		for (const b of [...this.#tabletButtons]) this.tabletButton(b, false);
	}

	#queue(op: number, a: number, b: number, motion = false): void {
		if (this.#shared) return this.#shared.evdev(op, a, b);
		this.#ops.push(op, a, b);
		if (!motion) this.#urgent = true;
		if (this.#urgent) {
			if (!this.#micro) {
				this.#micro = true;
				queueMicrotask(() => this.flush());
			}
		} else this.#timer ??= setTimeout(() => this.flush(), MOTION_BATCH_MS);
	}

	/** @internal Send what is queued now. */
	flush(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#micro = false;
		this.#urgent = false;
		if (!this.#ops.length) return;
		const ops = this.#ops;
		this.#ops = [];
		this.#post({ t: "evdev", ops });
	}

	/** @internal The kernel exited: drop what is queued. */
	close(): void {
		clearTimeout(this.#timer);
		this.#ops = [];
	}
}

interface RawFrame {
	mode: DisplayMode;
	data: Uint8Array;
}

/** The frame credits, the latest frame and the buffers to return (see the top of this file). */
export class FrameClient {
	/** The mode while a program has the display open, as the worker last reported it. */
	mode: DisplayMode | null = null;
	#seq = 0;
	#post: (msg: ToWorker, transfer?: ArrayBuffer[]) => void;
	#shared: SharedOwner | undefined;
	#latest: RawFrame | null = null;
	#spare: ArrayBuffer[] = [];
	#outstanding = 0;
	#nextId = 1;
	#waiters = new Map<number, (ok: boolean) => void>();
	#closed = false;

	constructor(post: (msg: ToWorker, transfer?: ArrayBuffer[]) => void, shared?: SharedOwner) {
		this.#post = post;
		this.#shared = shared;
	}

	/** Frames come through the shared triple buffer (else by messages). */
	get #viaShared(): boolean {
		return !!this.#shared?.frames.ready;
	}

	/** Counts frames with new pixels (received, or published in the shared buffer). */
	get seq(): number {
		return this.#viaShared ? this.#shared!.frames.seq : this.#seq;
	}

	#want(now: boolean): number {
		const id = this.#nextId++;
		const buf = this.#spare.pop();
		this.#outstanding++;
		this.#post(buf ? { t: "frame-want", id, buf, now } : { t: "frame-want", id, now }, buf ? [buf] : []);
		return id;
	}

	/** Ask for the next frame, unless enough are asked for already or nothing has the display. */
	request(): void {
		if (this.#closed || !this.mode) return;
		if (this.#viaShared) return this.#shared!.wantFrame();
		if (this.#outstanding >= FRAME_CREDITS) return;
		this.#want(false);
	}

	/** The latest frame as RGBA (null while detached or before the first arrives); asks for the next. */
	frame(out?: Uint8ClampedArray): DisplayFrame | null {
		this.request();
		if (this.#viaShared) return this.mode ? this.#shared!.frames.frame(out) : null;
		const f = this.#latest;
		if (!f || !this.mode) return null;
		return { width: f.mode.width, height: f.mode.height, data: xrgbToRgba(f.data, f.mode.width, f.mode.height, out) };
	}

	/** A fresh frame: a round trip to the worker, answered at its next chance even if unchanged. */
	read(out?: Uint8ClampedArray): Promise<DisplayFrame | null> {
		if (this.#closed) return Promise.resolve(this.frame(out));
		if (this.#viaShared) {
			const id = this.#nextId++;
			return new Promise((resolve) => {
				this.#waiters.set(id, () => resolve(this.mode && this.#viaShared ? this.#shared!.frames.frame(out) : null));
				this.#shared!.wantFrameNow(id);
			});
		}
		return new Promise((resolve) => {
			this.#waiters.set(this.#want(true), () => resolve(this.#latest && this.mode ? this.frame(out) : null));
		});
	}

	/** @internal A "frame-buffer" message: the shared buffer for the next mode (null: frames by messages). */
	adoptBuffer(buffer: SharedArrayBuffer | null, cap: number): void {
		this.#shared?.frames.adopt(buffer, cap);
	}

	/** @internal A "frame-ready" message: readFrame() requests up to `id` are answered (the mode came in "display" before it). */
	ready(id: number): void {
		for (const [w, resolve] of this.#waiters) {
			if (w > id) continue;
			this.#waiters.delete(w);
			resolve(true);
		}
	}

	/** @internal A "display" message. */
	setMode(mode: DisplayMode | null): void {
		this.mode = mode;
		if (!mode) this.#drop();
	}

	#drop(): void {
		if (this.#latest) {
			this.#keep(this.#latest.data.buffer as ArrayBuffer);
			this.#latest = null;
		}
	}

	#keep(buf: ArrayBuffer): void {
		if (this.#spare.length < FRAME_CREDITS) this.#spare.push(buf);
	}

	/** @internal A "frame" message. */
	receive(id: number, mode: DisplayMode | null, data: Uint8Array | null): void {
		this.#outstanding = Math.max(0, this.#outstanding - 1);
		if (data && mode) {
			this.#drop();
			this.#latest = { mode, data };
			this.#seq++;
		} else if (!mode) this.#drop();
		const w = this.#waiters.get(id);
		this.#waiters.delete(id);
		w?.(true);
	}

	/** @internal The kernel exited: answer what waits with what is here. */
	close(): void {
		this.#closed = true;
		for (const w of this.#waiters.values()) w(false);
		this.#waiters.clear();
	}
}

/**
 * Feeds the owner's SoundSink from sound messages or the shared sound ring.
 * With a ring read here, a state change is delivered where its record sits
 * in the ring, between the chunks around it, not when its message arrives.
 */
export class SoundBridge {
	state: SoundState = { open: false, playing: false, format: null };
	#sink: SoundSink;
	#post: (msg: ToWorker) => void;
	#log: (msg: string) => void;
	#lastReport = -Infinity;
	#reader: SoundRingReader | undefined;
	#ring: SharedArrayBuffer | undefined;
	#ringDelivered = false;
	/** Ring read here: state messages whose record the drain has not reached, oldest first. */
	#states: Array<{ n: number; state: SoundState; event: SoundEvent }> = [];
	/** The number of the latest state message. */
	#arrived = 0;
	#dropped = 0;

	constructor(sink: SoundSink, post: (msg: ToWorker) => void, log: (msg: string) => void, ring?: SharedArrayBuffer) {
		this.#sink = sink;
		this.#post = post;
		this.#log = log;
		if (ring && sink.onRing) this.#ring = ring;
		else if (ring && sink.onChunk) this.#reader = new SoundRingReader(ring);
		if (ring) this.#dropped = new SoundRingReader(ring).droppedBytes();
	}

	get playing(): boolean {
		return this.state.playing;
	}

	/** @internal Hand the shared sound ring to sink.onRing once the worker starts. */
	startRing(): void {
		if (!this.#ring || this.#ringDelivered) return;
		this.#ringDelivered = true;
		try { this.#sink.onRing?.(this.#ring); } catch (e) { this.#log(`[sound] onRing failed: ${e}`); }
	}

	/** @internal Drain the shared sound ring into sink.onChunk, and the state changes in its order. */
	onWake(): void {
		const reader = this.#reader;
		if (!reader) return;
		for (;;) {
			const n = reader.nextEvent();
			if (n >= 0) {
				// Its message has not arrived (messages are slower than the ring): it drains again.
				if (n > this.#arrived) break;
				this.#deliverStates(n);
				reader.readNext();
				continue;
			}
			const rec = reader.readNext();
			if (!rec) {
				// Empty: a message still waiting had no room for its record.
				this.#deliverStates(this.#arrived);
				break;
			}
			const chunk: SoundChunk = { format: rec.format, data: rec.data, frames: Math.floor(rec.data.length / rec.format.frameBytes) };
			let queued: number | void = 0;
			try { queued = this.#sink.onChunk?.(chunk); } catch (e) { this.#log(`[sound] onChunk failed: ${e}`); }
			reader.setQueuedFrames(queued || 0);
		}
		this.#reportDrops(reader.droppedBytes());
	}

	#deliverStates(upTo: number): void {
		while (this.#states.length && this.#states[0]!.n <= upTo) {
			const s = this.#states.shift()!;
			this.#deliver(s.state, s.event);
		}
	}

	#deliver(state: SoundState, event: SoundEvent): void {
		this.state = state;
		if (event === "start") this.#lastReport = -Infinity;
		try { this.#sink.onState?.(state, event); } catch (e) { this.#log(`[sound] onState failed: ${e}`); }
	}

	#reportDrops(dropped: number): void {
		if (dropped === this.#dropped) return;
		this.#log(`[sound] the sound ring was full: ${(dropped - this.#dropped) >>> 0} bytes of PCM dropped`);
		this.#dropped = dropped;
	}

	/** @internal A "sound-state" message (`n`: its number, as on its record in the ring). */
	onState(state: SoundState, event: SoundEvent, n: number): void {
		this.startRing();
		if (this.#reader) {
			this.#states.push({ n, state, event });
			this.#arrived = n;
			this.onWake();
			return;
		}
		if (this.#ring) this.#reportDrops(new SoundRingReader(this.#ring).droppedBytes());
		this.#deliver(state, event);
	}

	/** @internal A "sound-chunk" message. */
	onChunk(seq: number, format: SoundFormat, data: Uint8Array): void {
		const chunk: SoundChunk = { format, data, frames: Math.floor(data.length / format.frameBytes) };
		let queued: number | void = 0;
		try { queued = this.#sink.onChunk?.(chunk); } catch (e) { this.#log(`[sound] onChunk failed: ${e}`); }
		const now = sharedNow();
		if (now - this.#lastReport < SOUND_REPORT_MS) return;
		this.#lastReport = now;
		this.#post({ t: "sound-queued", seq, frames: Math.max(0, Math.round(queued || 0)), at: now });
	}
}
