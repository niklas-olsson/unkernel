// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Worker mode's shared-memory transport (2026-11-14): console input, evdev
// input, frames, shm reads and vsock packets for the guest through
// SharedArrayBuffers instead of messages, where
// SharedArrayBuffer exists and can be posted (Node; browsers only when the
// page is cross-origin isolated). The console size goes along with the
// console input; everything else (sync, stop, disk operations, the display
// size, sound) stays a message. Universal.
//
// Why: the worker handles messages only while the kernel is suspended, which
// while the guest is busy is its 20 ms yield. But the kernel calls the WASI
// clock (clock_time_get, monotonic) at the end of every 200k-instruction
// slice, before it reads wasm_host_irqs (traps.c, do_user_interrupt), and on
// every guest clock_gettime: measured every 0.6 ms (p90; 1.3 ms without the
// JIT, 2 ms at most) while a guest loop runs. That import is where the worker
// looks at the shared control block (one plain read when nothing is new),
// drains the input rings into the console and the InputHost (which set the
// IRQ bits in kernel memory themselves, read by the kernel right after) and
// copies a frame that was asked for. The kernel's own memory stays unshared
// (the module imports an unshared memory, kwemu's JIT modules import it the
// same way, and the host's read-modify-write of wasm_host_irqs would race
// the kernel's clearing of bits).
//
// Control block (Int32, one SharedArrayBuffer made by the owner, sent in the
// boot spec):
//   BELL        the owner adds 1 after every write below
//   IDLE        0 the kernel runs; 1 it waits idle (poll_oneoff); 2 idle and
//               the owner posted a "kick" message (only one per idle wait).
//               Writer and reader each store their side, then load the
//               other's (sequentially consistent), so a write is never missed:
//               the worker sets IDLE before it checks BELL, the owner bumps
//               BELL before it checks IDLE.
//   FRAME_WANT  1: the owner wants a frame once the picture may have changed
//   FRAME_NOW   id of the latest readFrame() (answered by "frame-ready")
//   CON_SIZE    the console size, rows << 16 | cols (0: none yet); applied
//               before the console bytes of the same drain, as the kernel
//               itself takes both in one console poll
//   CON_HEAD/CON_TAIL, EV_HEAD/EV_TAIL  single-producer rings (the owner
//               writes data and HEAD, the worker TAIL): console bytes, and
//               evdev calls as (op, a, b) Float64 triples (EVDEV_OP; moveTo
//               takes fractions). Nothing is merged or reordered; what does
//               not fit waits on the owner's side, in order, and is retried.
//   SHM_HEAD/SHM_TAIL  a third such ring: ShmFile.read() calls as (seq, id,
//               offset, length) Float64 quadruples, which the worker copies
//               at once (ShmDevice.read) and answers with a "shm-read"
//               message (bytes transferred), posted from inside the import:
//               a read waits for the next clock read (or a kick), not for
//               the kernel's yield. A full ring: the read goes as a message.
//               Kept in order with the "shm" messages: the worker drains
//               this ring before it runs one, and the owner sends reads as
//               messages while one of its writes is on its way.
//   VS_HEAD/VS_TAIL  a fourth one, of bytes: vsock packets for the guest
//               (VsockHost's, header and payload) as records, a u32 length
//               (little-endian) then the packet, which the worker queues in
//               the VsockDevice at once (2026-11-22). As messages they waited
//               for the kernel's yield, up to 20 ms while the guest is busy:
//               a Wayland app's frame callback took 12 ms of a 75 ms frame on
//               average (foot under `yes` output). A packet that does not fit
//               waits on the owner's side with those after it, retried like
//               the input.
//   VS_ACK      While the kernel waits idle a burst goes as one "vsock"
//               message instead (buffers transferred): the worker's event
//               loop is free then and a "kick" would be posted anyway, and
//               the ring costs two copies of every byte (a cold 26 MB read
//               from a 9p mount: 125 ms through the ring, 103 ms so,
//               2026-11-24). Only with the ring and the owner's queue empty,
//               and the worker counts the messages it has delivered here:
//               until it has them all the next bursts go as messages too,
//               so the stream keeps its order.
//
// Frames (one SharedArrayBuffer per display size, made by the worker, sent
// as "frame-buffer" before the "display" message of that mode): three slots
// of packed XRGB8888 rows, a triple buffer. The worker writes its back slot
// and swaps it with the middle one (STATE: middle index | FRESH); the owner
// swaps a fresh middle slot with its front one and converts the front slot,
// which the worker never touches, so no frame is torn by the copy and nobody
// waits. A frame is copied only when asked for (FRAME_WANT, FRAME_NOW) and
// only if the kernel ran since the last one (or the mode changed): at the
// next clock read when the kernel runs; at once on a "kick" if it is idle.

import { xrgbToRgba, type DisplayFrame, type DisplayMode } from "./display.ts";
import type { InputHost } from "./input.ts";
import type { Kernel } from "./kernel.ts";
import { EVDEV_OP, type FromWorker, type ToWorker } from "./worker-protocol.ts";

/** Which way the owner and the kernel talk: on one thread, or worker mode by messages or with shared memory. */
export type KernelTransport = "inline" | "messages" | "shared";

const BELL = 0, IDLE = 1, FRAME_WANT = 2, FRAME_NOW = 3, CON_HEAD = 4, CON_TAIL = 5, EV_HEAD = 6, EV_TAIL = 7, CON_SIZE = 8, SHM_HEAD = 9, SHM_TAIL = 10, VS_HEAD = 11, VS_TAIL = 12, VS_ACK = 13;
const CTL_BYTES = 64;
/** Console ring, bytes (a power of two). */
const CON_CAP = 1 << 16;
/** Evdev ring, calls (a power of two); InputHost holds 4096 events. */
const EV_CAP = 1 << 12;
/** Shm read ring, reads (a power of two). */
const SHM_CAP = 1 << 8;
const SHM_AT = CTL_BYTES + CON_CAP + EV_CAP * 24;
/** Vsock ring, bytes (a power of two; a packet is at most 64 KiB and 44 bytes, VsockHost.maxPayload). */
const VS_CAP = 1 << 19;
const VS_AT = SHM_AT + SHM_CAP * 32;
const CTL_SIZE = VS_AT + VS_CAP;
/** How soon the owner retries input that did not fit in a ring. */
const RETRY_MS = 2;

/** Frame buffer header: STATE, then w, h, seq, spare per slot; the pixels start at FRAME_DATA. */
const F_STATE = 0, F_SLOT = 4, FRESH = 4;
const FRAME_DATA = 64;

/**
 * Can this thread use the shared transport: SharedArrayBuffer exists, the
 * context is not a non-isolated browser page, and one survives a post.
 */
export function sharedMemoryAvailable(): boolean {
	if (typeof SharedArrayBuffer !== "function" || typeof Atomics !== "object") return false;
	if ((globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === false) return false;
	if (typeof MessageChannel !== "function") return true;
	const ch = new MessageChannel();
	try {
		ch.port1.postMessage(new SharedArrayBuffer(8));
		return true;
	} catch {
		return false;
	} finally {
		ch.port1.close();
		ch.port2.close();
	}
}

/** A fresh control block, for the boot spec. */
export function newSharedControl(): SharedArrayBuffer {
	return new SharedArrayBuffer(CTL_SIZE);
}

/** The owner's side: writes input into the rings, asks for frames, reads them. */
export class SharedOwner {
	#ctl: Int32Array;
	#con: Uint8Array;
	#ev: Float64Array;
	#shm: Float64Array;
	#vs: Uint8Array;
	#post: (msg: ToWorker, transfer?: ArrayBuffer[]) => void;
	/** "vsock" messages sent (VS_ACK: those the worker delivered). */
	#vsSent = 0;
	#shmReads = new Map<number, { resolve: (data: Uint8Array) => void; reject: (e: Error) => void }>();
	#shmSeq = 0;
	#conPending: Uint8Array[] = [];
	#evPending: number[] = [];
	#vsPending: Uint8Array[] = [];
	#retry: ReturnType<typeof setTimeout> | undefined;
	#closed = false;
	readonly frames = new SharedFrames();

	constructor(buffer: SharedArrayBuffer, post: (msg: ToWorker, transfer?: ArrayBuffer[]) => void) {
		this.#ctl = new Int32Array(buffer, 0, CTL_BYTES / 4);
		this.#con = new Uint8Array(buffer, CTL_BYTES, CON_CAP);
		this.#ev = new Float64Array(buffer, CTL_BYTES + CON_CAP, EV_CAP * 3);
		this.#shm = new Float64Array(buffer, SHM_AT, SHM_CAP * 4);
		this.#vs = new Uint8Array(buffer, VS_AT, VS_CAP);
		this.#post = post;
	}

	/**
	 * Copy bytes out of shm export `id` in the worker at the kernel's next
	 * clock read; the "shm-read" answer goes to shmAnswer(). Null when the
	 * ring is full or closed (send a message instead).
	 */
	shmRead(id: number, offset: number, length: number): Promise<Uint8Array> | null {
		if (this.#closed) return null;
		const c = this.#ctl;
		const head = Atomics.load(c, SHM_HEAD);
		if (((head - Atomics.load(c, SHM_TAIL)) | 0) >= SHM_CAP) return null;
		const seq = this.#shmSeq = (this.#shmSeq % 0x7fffffff) + 1;
		const at = (head & (SHM_CAP - 1)) * 4;
		this.#shm[at] = seq;
		this.#shm[at + 1] = id;
		this.#shm[at + 2] = offset;
		this.#shm[at + 3] = length;
		Atomics.store(c, SHM_HEAD, (head + 1) | 0);
		const p = new Promise<Uint8Array>((resolve, reject) => this.#shmReads.set(seq, { resolve, reject }));
		this.#ring();
		return p;
	}

	/** A "shm-read" message: the bytes, or the error. */
	shmAnswer(seq: number, data: Uint8Array | null, error: Error | null): void {
		const r = this.#shmReads.get(seq);
		if (!r) return;
		this.#shmReads.delete(seq);
		if (data) r.resolve(data);
		else r.reject(error ?? new Error("shm read failed"));
	}

	/** Console input, in order. */
	writeConsole(bytes: Uint8Array): void {
		if (this.#closed || !bytes.length) return;
		this.#conPending.push(bytes);
		this.#pump();
	}

	/** One evdev call (EVDEV_OP), in order. */
	evdev(op: number, a: number, b: number): void {
		if (this.#closed) return;
		this.#evPending.push(op, a, b);
		this.#pump();
	}

	/** Vsock packets for the guest (VsockHost's), in order; their buffers may be transferred, so the caller gives them up. */
	vsock(packets: Uint8Array[]): void {
		if (this.#closed || !packets.length) return;
		// As a message while the kernel waits idle, or while one is on its way (VS_ACK, at the top of this file).
		const c = this.#ctl;
		if (!this.#vsPending.length && Atomics.load(c, VS_HEAD) === Atomics.load(c, VS_TAIL) && (this.#vsSent !== Atomics.load(c, VS_ACK) || Atomics.load(c, IDLE) !== 0)) {
			this.#vsSent = (this.#vsSent + 1) | 0;
			this.#post({ t: "vsock", packets }, packets.map((p) => p.buffer as ArrayBuffer));
			return;
		}
		for (const p of packets) this.#vsPending.push(p);
		this.#pump();
	}

	/** The console size (cols x rows), for the guest's tty. */
	resize(cols: number, rows: number): void {
		if (this.#closed || !cols || !rows) return;
		Atomics.store(this.#ctl, CON_SIZE, (Math.min(rows, 0xffff) << 16) | Math.min(cols, 0xffff));
		this.#ring();
	}

	/** Ask for a frame once the picture may have changed. */
	wantFrame(): void {
		if (this.#closed || Atomics.load(this.#ctl, FRAME_WANT)) return;
		Atomics.store(this.#ctl, FRAME_WANT, 1);
		this.#ring();
	}

	/** Ask for the current frame now; "frame-ready" with this id (or a later one) answers. */
	wantFrameNow(id: number): void {
		if (this.#closed) return;
		Atomics.store(this.#ctl, FRAME_NOW, id);
		this.#ring();
	}

	/** The kernel exited: drop what waits; shm reads on their way fail with `error()`. */
	close(error?: () => Error): void {
		this.#closed = true;
		clearTimeout(this.#retry);
		this.#conPending = [];
		this.#evPending = [];
		this.#vsPending = [];
		for (const r of this.#shmReads.values()) r.reject(error?.() ?? new Error("the kernel exited"));
		this.#shmReads.clear();
	}

	/** Move what waits into the rings, as far as it fits; retry the rest soon. */
	#pump(): void {
		const c = this.#ctl;
		let wrote = false;
		// Console bytes.
		if (this.#conPending.length) {
			let head = Atomics.load(c, CON_HEAD);
			const tail = Atomics.load(c, CON_TAIL);
			let free = CON_CAP - ((head - tail) | 0);
			while (this.#conPending.length && free > 0) {
				const chunk = this.#conPending[0]!;
				const n = Math.min(free, chunk.length);
				const at = head & (CON_CAP - 1);
				const first = Math.min(n, CON_CAP - at);
				this.#con.set(chunk.subarray(0, first), at);
				if (n > first) this.#con.set(chunk.subarray(first, n), 0);
				head = (head + n) | 0;
				free -= n;
				if (n === chunk.length) this.#conPending.shift();
				else this.#conPending[0] = chunk.subarray(n);
				wrote = true;
			}
			Atomics.store(c, CON_HEAD, head);
		}
		// Evdev calls.
		if (this.#evPending.length) {
			let head = Atomics.load(c, EV_HEAD);
			const tail = Atomics.load(c, EV_TAIL);
			const free = EV_CAP - ((head - tail) | 0);
			const n = Math.min(free, this.#evPending.length / 3);
			const q = this.#evPending;
			for (let i = 0; i < n; i++) {
				const at = ((head + i) & (EV_CAP - 1)) * 3;
				this.#ev[at] = q[i * 3]!;
				this.#ev[at + 1] = q[i * 3 + 1]!;
				this.#ev[at + 2] = q[i * 3 + 2]!;
			}
			if (n) {
				head = (head + n) | 0;
				Atomics.store(c, EV_HEAD, head);
				q.splice(0, n * 3);
				wrote = true;
			}
		}
		// Vsock packets: whole records only.
		if (this.#vsPending.length) {
			let head = Atomics.load(c, VS_HEAD);
			let free = VS_CAP - ((head - Atomics.load(c, VS_TAIL)) | 0);
			const q = this.#vsPending, ring = this.#vs;
			let n = 0;
			for (; n < q.length && 4 + q[n]!.length <= free; n++) {
				const p = q[n]!, len = p.length;
				for (let i = 0; i < 4; i++) ring[(head + i) & (VS_CAP - 1)] = (len >>> (i * 8)) & 255;
				const at = (head + 4) & (VS_CAP - 1), first = Math.min(len, VS_CAP - at);
				ring.set(p.subarray(0, first), at);
				if (len > first) ring.set(p.subarray(first), 0);
				head = (head + 4 + len) | 0;
				free -= 4 + len;
			}
			if (n) {
				q.splice(0, n);
				Atomics.store(c, VS_HEAD, head);
				wrote = true;
			}
		}
		if (wrote) this.#ring();
		if ((this.#conPending.length || this.#evPending.length || this.#vsPending.length) && this.#retry === undefined)
			this.#retry = setTimeout(() => {
				this.#retry = undefined;
				if (!this.#closed) this.#pump();
			}, RETRY_MS);
	}

	/** Tell the worker: BELL, then a "kick" message if the kernel waits idle (its event loop is free then). */
	#ring(): void {
		Atomics.add(this.#ctl, BELL, 1);
		if (Atomics.compareExchange(this.#ctl, IDLE, 1, 2) === 1) this.#post({ t: "kick" });
	}
}

/** The owner's end of the frame triple buffer (see the top of this file). */
export class SharedFrames {
	#i32: Int32Array | null = null;
	#buf: SharedArrayBuffer | null = null;
	#cap = 0;
	#front = 0;
	#pinned = false;
	/** Whether the worker gave a frame buffer for the current mode (false: frames go by messages). */
	ready = false;

	/** A "frame-buffer" message: the buffer for the next mode, or null (frames by messages). */
	adopt(buffer: SharedArrayBuffer | null, cap: number): void {
		this.ready = !!buffer;
		this.#buf = buffer;
		this.#i32 = buffer ? new Int32Array(buffer, 0, FRAME_DATA / 4) : null;
		this.#cap = cap;
		this.#front = 0;
		this.#pinned = false;
	}

	/**
	 * Take the freshest frame into the front slot, at most once per task:
	 * frameSeq, frame() and the next frameSeq in one task agree on the frame.
	 */
	#acquire(): void {
		const h = this.#i32;
		if (!h || this.#pinned) return;
		this.#pinned = true;
		queueMicrotask(() => (this.#pinned = false));
		if (Atomics.load(h, F_STATE) & FRESH) this.#front = Atomics.exchange(h, F_STATE, this.#front) & 3;
	}

	/** The front frame's sequence number (counts frames with new pixels). */
	get seq(): number {
		this.#acquire();
		return this.#i32 ? Atomics.load(this.#i32, F_SLOT + this.#front * 4 + 2) : 0;
	}

	/** The front frame as RGBA, or null before the first. */
	frame(out?: Uint8ClampedArray): DisplayFrame | null {
		this.#acquire();
		const h = this.#i32;
		if (!h) return null;
		const s = F_SLOT + this.#front * 4;
		const width = h[s]!, height = h[s + 1]!;
		if (!width || !height) return null;
		const src = new Uint8Array(this.#buf!, FRAME_DATA + this.#front * this.#cap, width * height * 4);
		return { width, height, data: xrgbToRgba(src, width, height, out) };
	}
}

/** What the worker's side drives (worker-serve.ts gives it the instance's parts). */
export interface SharedServerTarget {
	kernel: Kernel;
	/** Console input for the guest. */
	write(bytes: Uint8Array): void;
	/** The console size. */
	resize(cols: number, rows: number): void;
	/** The InputHost when the display is on. */
	evdev: InputHost | undefined;
	/** A shm read from the ring: copy and post the "shm-read" answer. */
	shmRead?(seq: number, id: number, offset: number, length: number): void;
	/** A vsock packet for the guest (VsockDevice.deliver); absent: the kernel has no vsock (packets are dropped). */
	vsock?(pkt: Uint8Array): void;
}

/** Apply one evdev call (EVDEV_OP) to an InputHost; worker-serve.ts uses it for "evdev" messages too. */
export function applyEvdev(ev: InputHost, op: number, a: number, b: number): void {
	switch (op) {
	case EVDEV_OP.key: ev.key(a, !!b); break;
	case EVDEV_OP.button: ev.button(a, !!b); break;
	case EVDEV_OP.move: ev.move(a, b); break;
	case EVDEV_OP.wheel: ev.wheel(a); break;
	case EVDEV_OP.moveTo: ev.moveTo(a, b); break;
	case EVDEV_OP.tabletButton: ev.tabletButton(a, !!b); break;
	case EVDEV_OP.tabletWheel: ev.tabletWheel(a); break;
	case EVDEV_OP.releaseAll: ev.releaseAll(); break;
	}
}

/**
 * The worker's side: Kernel.poller. poll() runs in every monotonic
 * clock_time_get, idle() when poll_oneoff is about to wait, awake() when the
 * wait ends; kicked() on a "kick" message.
 */
export class SharedServer {
	#ctl: Int32Array;
	#con: Uint8Array;
	#ev: Float64Array;
	#shm: Float64Array;
	#vs: Uint8Array;
	#post: (msg: FromWorker, transfer?: ArrayBuffer[]) => void;
	#log: (msg: string) => void;
	#t: SharedServerTarget | null = null;
	#seen = 0;
	#nowAnswered = 0;
	#size = 0;
	/** A frame was asked for but the picture had not changed: look again at every poll. */
	#wantPending = false;
	/** Idles, yields and switches, and the display's attach count, at the last frame (the kernel ran since if they moved). */
	#sentRan = -1;
	#sentGen = -1;
	// The frame buffer.
	#fbuf: SharedArrayBuffer | null = null;
	#fi32: Int32Array | null = null;
	#fcap = 0;
	#back = 2;
	#published = 0;
	/** The display could not get a frame buffer: frames go by messages ("frame-want"). */
	framesByMessage = false;

	constructor(buffer: SharedArrayBuffer, post: (msg: FromWorker, transfer?: ArrayBuffer[]) => void, log: (msg: string) => void) {
		this.#ctl = new Int32Array(buffer, 0, CTL_BYTES / 4);
		this.#con = new Uint8Array(buffer, CTL_BYTES, CON_CAP);
		this.#ev = new Float64Array(buffer, CTL_BYTES + CON_CAP, EV_CAP * 3);
		this.#shm = new Float64Array(buffer, SHM_AT, SHM_CAP * 4);
		this.#vs = new Uint8Array(buffer, VS_AT, VS_CAP);
		this.#post = post;
		this.#log = log;
	}

	/** Start serving (the kernel runs): becomes kernel.poller. */
	attach(t: SharedServerTarget): void {
		this.#t = t;
		t.kernel.poller = this;
		// Already waiting idle: say so (before drain() reads BELL), so that the owner kicks.
		if (t.kernel.idleWake) Atomics.store(this.#ctl, IDLE, 1);
		this.drain(false);
	}

	detach(): void {
		if (this.#t?.kernel.poller === this) this.#t.kernel.poller = null;
		this.#t = null;
		Atomics.store(this.#ctl, IDLE, 0);
	}

	/**
	 * Hot: every monotonic clock read. A plain read of BELL (about 1 ns;
	 * Atomics.load costs about 7 ns here, measured on Node 24): a racy read
	 * is at worst stale, which a later poll corrects, or wrong, which costs a
	 * drain() that finds nothing; drain() reads everything with Atomics.
	 */
	poll(): void {
		if (this.#ctl[BELL] !== this.#seen || this.#wantPending) this.drain(true);
	}

	/** poll_oneoff is about to wait: true if input arrived meanwhile (it was drained; do not wait). */
	idle(): boolean {
		Atomics.store(this.#ctl, IDLE, 1);
		if (Atomics.load(this.#ctl, BELL) === this.#seen) return false;
		Atomics.store(this.#ctl, IDLE, 0);
		this.drain(true);
		return true;
	}

	/** The idle wait ended. */
	awake(): void {
		Atomics.store(this.#ctl, IDLE, 0);
	}

	/** A "vsock" message was delivered (or dropped): the owner may use the ring again. */
	vsockAck(): void {
		Atomics.add(this.#ctl, VS_ACK, 1);
	}

	/** A "kick" message: the owner wrote while the kernel waited idle. */
	kicked(): void {
		const k = this.#t?.kernel;
		// Still idle: accept the next kick (stored before BELL is read, see the top of this file).
		if (k?.idleWake) Atomics.compareExchange(this.#ctl, IDLE, 2, 1);
		this.drain(false);
	}

	/** Take everything the owner wrote; `running`: called from the kernel (it ran since any earlier drain). */
	drain(running: boolean): void {
		const t = this.#t;
		if (!t) return;
		const c = this.#ctl;
		this.#seen = Atomics.load(c, BELL);
		const size = Atomics.load(c, CON_SIZE);
		if (size !== this.#size) {
			this.#size = size;
			t.resize(size & 0xffff, size >>> 16);
		}
		// Console bytes.
		const ch = Atomics.load(c, CON_HEAD);
		let ct = Atomics.load(c, CON_TAIL);
		const cn = (ch - ct) | 0;
		if (cn > 0) {
			const out = new Uint8Array(cn);
			const at = ct & (CON_CAP - 1);
			const first = Math.min(cn, CON_CAP - at);
			out.set(this.#con.subarray(at, at + first));
			if (cn > first) out.set(this.#con.subarray(0, cn - first), first);
			ct = (ct + cn) | 0;
			Atomics.store(c, CON_TAIL, ct);
			t.write(out);
		}
		// Evdev calls.
		const eh = Atomics.load(c, EV_HEAD);
		let et = Atomics.load(c, EV_TAIL);
		if (eh !== et) {
			const ev = t.evdev;
			for (; et !== eh; et = (et + 1) | 0) {
				const at = (et & (EV_CAP - 1)) * 3;
				if (ev) applyEvdev(ev, this.#ev[at]!, this.#ev[at + 1]!, this.#ev[at + 2]!);
			}
			Atomics.store(c, EV_TAIL, et);
		}
		this.drainShm();
		// Vsock packets.
		const vh = Atomics.load(c, VS_HEAD);
		let vt = Atomics.load(c, VS_TAIL);
		if (vh !== vt) {
			const ring = this.#vs;
			while (vt !== vh) {
				let len = 0;
				for (let i = 0; i < 4; i++) len |= ring[(vt + i) & (VS_CAP - 1)]! << (i * 8);
				const at = (vt + 4) & (VS_CAP - 1), first = Math.min(len, VS_CAP - at);
				const pkt = new Uint8Array(len);
				pkt.set(ring.subarray(at, at + first));
				if (len > first) pkt.set(ring.subarray(0, len - first), first);
				vt = (vt + 4 + len) | 0;
				t.vsock?.(pkt);
			}
			Atomics.store(c, VS_TAIL, vt);
		}
		this.#serveFrames(t.kernel, running);
	}

	/** Serve the shm reads in the ring (also before a "shm" message runs, to keep the owner's order). */
	drainShm(): void {
		const t = this.#t;
		if (!t) return;
		const c = this.#ctl;
		const head = Atomics.load(c, SHM_HEAD);
		let tail = Atomics.load(c, SHM_TAIL);
		for (; tail !== head; tail = (tail + 1) | 0) {
			const at = (tail & (SHM_CAP - 1)) * 4;
			const s = this.#shm;
			const seq = s[at]!, id = s[at + 1]!, offset = s[at + 2]!, length = s[at + 3]!;
			// Taken before the answer goes out, so that the owner may reuse the entry.
			Atomics.store(c, SHM_TAIL, (tail + 1) | 0);
			if (t.shmRead) t.shmRead(seq, id, offset, length);
			else this.#post({ t: "shm-read", seq, ok: false, code: "ENODEV", message: "read: the kernel has no kwshm" });
		}
	}

	#serveFrames(k: Kernel, running: boolean): void {
		const c = this.#ctl;
		const want = Atomics.load(c, FRAME_WANT) !== 0;
		const nowId = Atomics.load(c, FRAME_NOW);
		const now = nowId !== this.#nowAnswered;
		this.#wantPending = false;
		if (!want && !now) return;
		const d = k.display;
		const mode = d.mode;
		if (mode && this.#fi32 && !this.framesByMessage) {
			const ran = k.stats.idles + k.stats.yields + k.stats.switches;
			const gen = d.stats.attaches + d.stats.detaches;
			if (running || ran !== this.#sentRan || gen !== this.#sentGen) {
				Atomics.store(c, FRAME_WANT, 0);
				this.#publish(mode, d.pixels());
				this.#sentRan = ran;
				this.#sentGen = gen;
			} else if (want) this.#wantPending = true;
		} else if (want && !mode) Atomics.store(c, FRAME_WANT, 0);
		if (now) {
			this.#nowAnswered = nowId;
			this.#post({ t: "frame-ready", id: nowId, mode });
		}
	}

	#publish(mode: DisplayMode, px: Uint8Array | null): void {
		const h = this.#fi32!;
		if (!px) return;
		const row = mode.width * 4, n = row * mode.height;
		if (n > this.#fcap) return;
		const dst = new Uint8Array(this.#fbuf!, FRAME_DATA + this.#back * this.#fcap, n);
		if (mode.stride === row) dst.set(px.subarray(0, n));
		else for (let y = 0; y < mode.height; y++) dst.set(px.subarray(y * mode.stride, y * mode.stride + row), y * row);
		const s = F_SLOT + this.#back * 4;
		h[s] = mode.width;
		h[s + 1] = mode.height;
		Atomics.store(h, s + 2, ++this.#published);
		this.#back = Atomics.exchange(h, F_STATE, this.#back | FRESH) & 3;
	}

	/**
	 * The display attached or changed its mode (DisplayHost onChange, inside
	 * the attach import): make sure the frame buffer fits it, and if a new
	 * one is needed post it ("frame-buffer") before the caller posts the mode.
	 */
	onMode(mode: DisplayMode | null): void {
		if (!mode || this.framesByMessage) return;
		const need = mode.width * mode.height * 4;
		if (this.#fbuf && need <= this.#fcap) return;
		let buf: SharedArrayBuffer;
		try {
			buf = new SharedArrayBuffer(FRAME_DATA + 3 * need);
		} catch (e) {
			this.#log(`[host] no shared frame buffer for ${mode.width}x${mode.height} (${(e as Error)?.message ?? e}); frames go by messages`);
			this.framesByMessage = true;
			this.#fbuf = null;
			this.#fi32 = null;
			this.#post({ t: "frame-buffer", buffer: null, cap: 0 });
			return;
		}
		this.#fbuf = buf;
		this.#fi32 = new Int32Array(buf, 0, FRAME_DATA / 4);
		this.#fcap = need;
		this.#back = 2;
		// The front slot is 0 and the middle one 1, not fresh; slot seqs continue from the last buffer's.
		Atomics.store(this.#fi32, F_STATE, 1);
		for (let i = 0; i < 3; i++) this.#fi32[F_SLOT + i * 4 + 2] = this.#published;
		this.#sentRan = -1;
		this.#post({ t: "frame-buffer", buffer: buf, cap: need });
	}
}
