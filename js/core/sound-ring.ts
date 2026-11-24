// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Shared-memory SPSC sound PCM ring between the kernel worker (SoundRingWriter)
// and exactly one SoundRingReader: the owner's (SoundBridge, feeding
// sink.onChunk) or the one a sink.onRing consumer makes, e.g. in an
// AudioWorklet. Two readers on one ring corrupt it.
//
// Layout: SOUND_RING_HEADER_BYTES of Int32 control words followed by a
// power-of-two byte buffer. Every chunk record begins at a 16-byte-aligned
// offset inside the buffer with a 4-word header [seq, rate, channels_format,
// byteLen] followed by `byteLen` payload bytes (wrapped at capacity and padded
// to 16 bytes). Since capacity is a multiple of 16 >= 1024, the 4-word header
// never straddles the end of the buffer.
//
// State changes travel in the ring too, as records without payload (byteLen
// 0, the event in channels_format, a running number in seq), so a reader
// meets them in order with the PCM: the chunks after a "prepare" record
// belong to the new stream. SOUND_RING_EVENT_RESERVE bytes are kept free of
// PCM for them. A full ring drops the newest PCM (counted in DROPPED).
//
// The delay the kernel reports is QUEUED_FRAMES (what the reader's sink has
// queued, stored by the reader: setQueuedFrames) plus the frames still in
// the ring (the writer's count less READ_FRAMES).

import { SOUND_FORMAT_U8, type SoundEvent, type SoundFormat } from "./sound.ts";

export const SOUND_RING_HEAD = 0;
export const SOUND_RING_TAIL = 1;
export const SOUND_RING_QUEUED_FRAMES = 2;
export const SOUND_RING_DROPPED = 3;
export const SOUND_RING_READ_FRAMES = 4;

export const SOUND_RING_HEADER_BYTES = 64;
export const SOUND_RING_DEFAULT_BYTES = 1 << 18; // 256 KiB (~1.36 s @ 48 kHz S16_LE stereo)

/** Room no PCM record may take, so that state records still fit in a full ring. */
export const SOUND_RING_EVENT_RESERVE = 256;

const EVENT_FLAG = 1 << 16;
const EVENTS: readonly SoundEvent[] = ["open", "prepare", "start", "stop", "drain", "close"];
const NO_FORMAT: SoundFormat = { rate: 0, channels: 0, format: 0, frameBytes: 0 };
const NO_DATA = new Uint8Array(0);

export interface SoundRingRecord {
	/** PCM: the chunk's number. A state record: the state change's number. */
	seq: number;
	format: SoundFormat;
	data: Uint8Array;
	/** Set on a state record (no PCM): the stream's state changed here. */
	event?: SoundEvent;
}

/** Allocate a SharedArrayBuffer backing a SoundRing (power-of-two data capacity). */
export function createSoundRing(capacityBytes: number = SOUND_RING_DEFAULT_BYTES): SharedArrayBuffer {
	if (!Number.isInteger(capacityBytes) || capacityBytes < 1024 || (capacityBytes & (capacityBytes - 1)) !== 0) {
		throw new RangeError(`sound ring capacity must be a power of two >= 1024, got ${capacityBytes}`);
	}
	return new SharedArrayBuffer(SOUND_RING_HEADER_BYTES + capacityBytes);
}

function ringViews(buffer: SharedArrayBuffer): { ctrl: Int32Array; hdr: Int32Array; data: Uint8Array; capacity: number; mask: number } {
	const capacity = buffer.byteLength - SOUND_RING_HEADER_BYTES;
	if (capacity < 1024 || (capacity & (capacity - 1)) !== 0) {
		throw new RangeError(`invalid sound ring byteLength ${buffer.byteLength}`);
	}
	return {
		ctrl: new Int32Array(buffer, 0, SOUND_RING_HEADER_BYTES >> 2),
		hdr: new Int32Array(buffer),
		data: new Uint8Array(buffer, SOUND_RING_HEADER_BYTES, capacity),
		capacity,
		mask: capacity - 1,
	};
}

function decodeFormat(rate: number, packed: number): SoundFormat {
	const channels = (packed >> 8) & 0xff;
	const format = packed & 0xff;
	const sampleBytes = format === SOUND_FORMAT_U8 ? 1 : 2;
	return { rate, channels, format, frameBytes: sampleBytes * channels };
}

/** Single-producer writer in the kernel worker thread. */
export class SoundRingWriter {
	readonly buffer: SharedArrayBuffer;
	readonly #ctrl: Int32Array;
	readonly #hdr: Int32Array;
	readonly #data: Uint8Array;
	readonly #capacity: number;
	readonly #mask: number;
	/** Frames written (wraps like READ_FRAMES). */
	#written = 0;

	constructor(buffer: SharedArrayBuffer) {
		this.buffer = buffer;
		const v = ringViews(buffer);
		this.#ctrl = v.ctrl;
		this.#hdr = v.hdr;
		this.#data = v.data;
		this.#capacity = v.capacity;
		this.#mask = v.mask;
		this.#written = Atomics.load(this.#ctrl, SOUND_RING_READ_FRAMES);
	}

	/**
	 * Append a state record (number `n`, see the top). Returns false if even
	 * the reserve is full; a reader that also gets the states as messages
	 * (SoundBridge) notices the gap in the numbers.
	 */
	writeEvent(n: number, event: SoundEvent): boolean {
		const head = Atomics.load(this.#ctrl, SOUND_RING_HEAD);
		const used = (head - Atomics.load(this.#ctrl, SOUND_RING_TAIL)) | 0;
		if (this.#capacity - used < 16) return false;
		const wi = (SOUND_RING_HEADER_BYTES + (head & this.#mask)) >> 2;
		this.#hdr[wi] = n & 0x7fffffff;
		this.#hdr[wi + 1] = 0;
		this.#hdr[wi + 2] = EVENT_FLAG | EVENTS.indexOf(event);
		this.#hdr[wi + 3] = 0;
		Atomics.store(this.#ctrl, SOUND_RING_HEAD, (head + 16) | 0);
		return true;
	}

	/**
	 * Append one PCM chunk record. Returns true if the reader appears asleep on
	 * an empty ring (Dekker check: Atomics.store(HEAD) then Atomics.load(TAIL)),
	 * so the caller should send a coalesced "sound-wake" if draining via callbacks.
	 */
	write(seq: number, format: SoundFormat, bytes: Uint8Array): boolean {
		const n = bytes.byteLength;
		const recBytes = 16 + ((n + 15) & ~15);
		if (n <= 0 || recBytes > this.#capacity) return false;
		const head = Atomics.load(this.#ctrl, SOUND_RING_HEAD);
		const tail0 = Atomics.load(this.#ctrl, SOUND_RING_TAIL);
		const used = (head - tail0) | 0;
		if (this.#capacity - used < recBytes + SOUND_RING_EVENT_RESERVE) {
			Atomics.add(this.#ctrl, SOUND_RING_DROPPED, n);
			return false;
		}
		this.#written = (this.#written + Math.floor(n / format.frameBytes)) | 0;
		const pos = head & this.#mask;
		const wi = (SOUND_RING_HEADER_BYTES + pos) >> 2;
		this.#hdr[wi] = seq | 0;
		this.#hdr[wi + 1] = format.rate | 0;
		this.#hdr[wi + 2] = ((format.channels & 0xff) << 8) | (format.format & 0xff);
		this.#hdr[wi + 3] = n | 0;
		const dataOff = (pos + 16) & this.#mask;
		const first = Math.min(n, this.#capacity - dataOff);
		this.#data.set(bytes.subarray(0, first), dataOff);
		if (first < n) this.#data.set(bytes.subarray(first), 0);
		const nextHead = (head + recBytes) | 0;
		Atomics.store(this.#ctrl, SOUND_RING_HEAD, nextHead);
		const tail1 = Atomics.load(this.#ctrl, SOUND_RING_TAIL);
		return ((nextHead - tail1) | 0) === recBytes;
	}

	/** Frames not played yet: those the reader's sink reported, plus those still in the ring. */
	queuedFrames(): number {
		const unread = (this.#written - Atomics.load(this.#ctrl, SOUND_RING_READ_FRAMES)) | 0;
		return Atomics.load(this.#ctrl, SOUND_RING_QUEUED_FRAMES) + Math.max(0, unread);
	}

	/** A new stream: forget what the sink reported for the last one. */
	resetQueued(): void {
		Atomics.store(this.#ctrl, SOUND_RING_QUEUED_FRAMES, 0);
	}

	/** Bytes dropped because the ring was full. */
	droppedBytes(): number {
		return Atomics.load(this.#ctrl, SOUND_RING_DROPPED);
	}
}

/** Single-consumer reader on the owner thread or inside an AudioWorkletProcessor. */
export class SoundRingReader {
	readonly buffer: SharedArrayBuffer;
	readonly #ctrl: Int32Array;
	readonly #hdr: Int32Array;
	readonly #data: Uint8Array;
	readonly #capacity: number;
	readonly #mask: number;

	constructor(buffer: SharedArrayBuffer) {
		this.buffer = buffer;
		const v = ringViews(buffer);
		this.#ctrl = v.ctrl;
		this.#hdr = v.hdr;
		this.#data = v.data;
		this.#capacity = v.capacity;
		this.#mask = v.mask;
	}

	/** Bytes (including 16-byte record headers + padding) currently readable. */
	availableBytes(): number {
		const head = Atomics.load(this.#ctrl, SOUND_RING_HEAD);
		const tail = Atomics.load(this.#ctrl, SOUND_RING_TAIL);
		return (head - tail) | 0;
	}

	/**
	 * Frames the sink still has queued after the records read so far. The
	 * kernel reports it (plus what is in the ring) as the stream's delay, so
	 * a reader that never calls this leaves the sink's latency out of it.
	 */
	setQueuedFrames(frames: number): void {
		Atomics.store(this.#ctrl, SOUND_RING_QUEUED_FRAMES, Math.max(0, Math.round(frames || 0)));
	}

	/** Bytes dropped by the producer because the ring overflowed. */
	droppedBytes(): number {
		return Atomics.load(this.#ctrl, SOUND_RING_DROPPED);
	}

	/** The number of the state record that is next in the ring, or -1 (PCM next, or empty). */
	nextEvent(): number {
		const head = Atomics.load(this.#ctrl, SOUND_RING_HEAD);
		const tail = Atomics.load(this.#ctrl, SOUND_RING_TAIL);
		if (head === tail) return -1;
		const wi = (SOUND_RING_HEADER_BYTES + (tail & this.#mask)) >> 2;
		return this.#hdr[wi + 2]! & EVENT_FLAG ? this.#hdr[wi]! & 0x7fffffff : -1;
	}

	/**
	 * Read one record (PCM into `scratch` if provided and large enough), or
	 * null if empty. A state record has `event` set and no data.
	 */
	readNext(scratch?: Uint8Array): SoundRingRecord | null {
		const head = Atomics.load(this.#ctrl, SOUND_RING_HEAD);
		const tail = Atomics.load(this.#ctrl, SOUND_RING_TAIL);
		if (head === tail) return null;
		const pos = tail & this.#mask;
		const wi = (SOUND_RING_HEADER_BYTES + pos) >> 2;
		const seq = this.#hdr[wi]!;
		const packed = this.#hdr[wi + 2]!;
		if (packed & EVENT_FLAG) {
			Atomics.store(this.#ctrl, SOUND_RING_TAIL, (tail + 16) | 0);
			return { seq: seq & 0x7fffffff, format: NO_FORMAT, data: NO_DATA, event: EVENTS[packed & 0xff] ?? "stop" };
		}
		const format = decodeFormat(this.#hdr[wi + 1]!, packed);
		const n = this.#hdr[wi + 3]!;
		const out = scratch && scratch.byteLength >= n ? scratch.subarray(0, n) : new Uint8Array(n);
		const dataOff = (pos + 16) & this.#mask;
		const first = Math.min(n, this.#capacity - dataOff);
		out.set(this.#data.subarray(dataOff, dataOff + first), 0);
		if (first < n) out.set(this.#data.subarray(0, n - first), first);
		Atomics.add(this.#ctrl, SOUND_RING_READ_FRAMES, format.frameBytes ? Math.floor(n / format.frameBytes) : 0);
		Atomics.store(this.#ctrl, SOUND_RING_TAIL, (tail + 16 + ((n + 15) & ~15)) | 0);
		return { seq, format, data: out };
	}
}
