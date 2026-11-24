// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Unit tests for the CowDisk overlay logic (core/block.ts) with a fake store,
// the kwsparse format, FileDisk, Kernel.requestSync() and the disk side of
// machine snapshots (write generations, sealing, snapshotDiskMismatch), and
// HttpBase's read-ahead against a local Range server.
//
//   node --test test/block.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { CowDisk, HttpBase, SparseBase, ZeroBase, type BlockDevice, type DiskBase, type DiskSnapshotState, type OverlayStore, type StoreIndex } from "../js/core/block.ts";
import { snapshotDiskMismatch } from "../js/core/snapshot.ts";
import { decodeKwsparse, encodeKwsparse, readKwsparse } from "../js/core/kwsparse.ts";
import { IRQ_SYNC, Kernel } from "../js/core/kernel.ts";
import { FileDisk, createImageFromKwsparse } from "../js/node/disk.ts";

const B = 4096;

function deferred<T = void>() {
	let resolve!: (v: T) => void, reject!: (e: unknown) => void;
	const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
	return { promise, resolve, reject };
}

/**
 * The IdbStore interface in memory. Saves and reads can be held (hold* =
 * true) until the test releases them, and saves can be made to fail. Values
 * are copied when a save commits, the latest point a real store could read
 * them, so a buffer modified during a save would show up.
 */
class FakeStore implements OverlayStore {
	blocks: Map<number, Uint8Array>;
	holdSaves = false;
	holdReads = false;
	failNext = 0;
	saves: Array<() => void> = [];
	reads: Array<() => void> = [];
	log: Array<[string, ...number[][]]> = [];
	/** meta: the write generation (save()'s meta.gen) and the store's id. */
	gen = 0;
	uid = "fake-uid";

	constructor(blocks = new Map<number, Uint8Array>()) {
		this.blocks = blocks;
	}

	async open(): Promise<StoreIndex> {
		return { keys: new Set(this.blocks.keys()), initialized: true, gen: this.gen, uid: this.uid };
	}

	getBlocks(list: number[]): Promise<Map<number, Uint8Array>> {
		this.log.push(["get", list.slice()]);
		const run = () => new Map(list.filter((b) => this.blocks.has(b)).map((b) => [b, this.blocks.get(b)!.slice()]));
		if (!this.holdReads) return Promise.resolve(run());
		const d = deferred<Map<number, Uint8Array>>();
		this.reads.push(() => d.resolve(run()));
		return d.promise;
	}

	save(puts: Array<[number, Uint8Array]>, dels: number[], meta?: { gen: number }): Promise<void> {
		this.log.push(["save", puts.map(([b]) => b), dels.slice()]);
		const commit = () => {
			if (this.failNext) {
				this.failNext--;
				throw Object.assign(new Error("simulated failure"), { name: "QuotaExceededError" });
			}
			for (const [b, v] of puts) this.blocks.set(b, v.slice());
			for (const b of dels) this.blocks.delete(b);
			if (meta) this.gen = meta.gen;
		};
		if (!this.holdSaves) return Promise.resolve().then(commit);
		const d = deferred();
		this.saves.push(() => { try { commit(); d.resolve(); } catch (e) { d.reject(e); } });
		return d.promise;
	}

	async clear(): Promise<void> {
		this.blocks.clear();
	}

	releaseSave(): void { this.saves.shift()!(); }
	releaseRead(): void { this.reads.shift()!(); }
}

const fill = (v: number, n = B) => new Uint8Array(n).fill(v);
const tick = () => new Promise((r) => setTimeout(r, 0));

async function rd(d: CowDisk, off: number, len: number): Promise<Uint8Array> {
	const v = new Uint8Array(len);
	await d.read(off, [v]);
	return v;
}
const wr = (d: CowDisk, off: number, data: Uint8Array) => d.write(off, [data]);

async function openDisk(stored: Record<number, Uint8Array> = {}, base: DiskBase = new ZeroBase(64 * B)) {
	const store = new FakeStore(new Map(Object.entries(stored).map(([b, v]) => [Number(b), v])));
	const d = await new CowDisk(base, { store, log: () => {} }).open();
	return { d, store };
}

test("a failed save puts the blocks back into the dirty set and fails the flush", async () => {
	const { d, store } = await openDisk();
	await wr(d, 2 * B, fill(7));
	store.failNext = 1;
	await assert.rejects(d.flush() as Promise<unknown>, /simulated/);
	assert.ok(d.dirty.has(2), "re-dirtied");
	assert.deepEqual(await rd(d, 2 * B, B), fill(7));
	assert.equal(store.blocks.size, 0);
	await d.flush();
	assert.deepEqual(store.blocks.get(2), fill(7));
	assert.equal(d.dirty.size, 0);
	assert.equal(d.mem.size, 0, "saved blocks leave memory");
	assert.deepEqual(await rd(d, 2 * B, B), fill(7), "read back from the store");
});

test("a full write during a pending read-modify-write fetch wins over the stale fetch", async () => {
	const { d, store } = await openDisk({ 5: fill(1) });
	store.holdReads = true;
	const p1 = wr(d, 5 * B, fill(2, 512)); // partial: needs block 5 from the store
	assert.ok(p1 instanceof Promise);
	const p2 = wr(d, 5 * B, fill(3)); // full write while the fetch is pending
	assert.ok(p2 instanceof Promise, "waits for the earlier write to the block");
	await tick();
	store.releaseRead();
	await Promise.all([p1, p2]);
	assert.deepEqual(await rd(d, 5 * B, B), fill(3));
	await d.flush();
	assert.deepEqual(store.blocks.get(5), fill(3));
});

test("partial write of a stored block that is not in memory (read-modify-write)", async () => {
	const { d, store } = await openDisk({ 9: fill(0xaa) });
	await wr(d, 9 * B + 100, fill(0x55, 200));
	const want = fill(0xaa);
	want.fill(0x55, 100, 300);
	assert.deepEqual(await rd(d, 9 * B, B), want);
	await d.flush();
	assert.deepEqual(store.blocks.get(9), want);
	// A partial write over the zero base needs no store read.
	const reads = store.log.filter((l) => l[0] === "get").length;
	await wr(d, 20 * B + 10, fill(9, 10));
	assert.equal(store.log.filter((l) => l[0] === "get").length, reads);
	const z = new Uint8Array(B);
	z.fill(9, 10, 20);
	assert.deepEqual(await rd(d, 20 * B, B), z);
});

test("reads combine memory, the store (one batched request) and the base", async () => {
	const base = new SparseBase(64 * B, new Map([[3, fill(0x33)], [4, fill(0x44)]]));
	const { d, store } = await openDisk({ 1: fill(0x11), 2: fill(0x22) }, base);
	await wr(d, 0, fill(0x10));
	const out = await rd(d, 0, 5 * B);
	for (const [i, v] of [0x10, 0x11, 0x22, 0x33, 0x44].entries()) assert.deepEqual(out.subarray(i * B, (i + 1) * B), fill(v));
	assert.deepEqual(store.log.filter((l) => l[0] === "get"), [["get", [1, 2]]]);
	// Unaligned read across blocks.
	assert.deepEqual(await rd(d, 2 * B + 4000, 200), Uint8Array.from({ length: 200 }, (_, i) => (i < 96 ? 0x22 : 0x33)));
});

test("readahead: a block-by-block scan of stored blocks takes a few store reads", async () => {
	const stored: Record<number, Uint8Array> = {};
	for (let b = 100; b < 356; b++) stored[b] = fill(b & 0xff);
	const { d, store } = await openDisk(stored, new ZeroBase(1024 * B));
	for (let b = 100; b < 356; b++) assert.deepEqual(await rd(d, b * B, B), fill(b & 0xff), `block ${b}`);
	const gets = store.log.filter((l) => l[0] === "get").length;
	assert.ok(gets <= 8, `${gets} store reads for 256 sequential blocks`);
	assert.equal(d.ahead.size, 0, "consumed by the reads");
	assert.equal(d.mem.size, 0, "readahead does not fill the write overlay");
});

test("readahead: a write drops a block fetched ahead (fetched, and in flight)", async () => {
	const stored: Record<number, Uint8Array> = {};
	for (let b = 0; b < 16; b++) stored[b] = fill(b + 1);
	const { d } = await openDisk(stored);
	await rd(d, 0, B); // fetches 1..8 ahead
	assert.ok(d.ahead.has(3));
	await wr(d, 3 * B, fill(0xee));
	await d.flush(); // block 3 leaves memory; the store has the new record
	assert.equal(d.mem.has(3), false);
	assert.deepEqual(await rd(d, 3 * B, B), fill(0xee));
	await wr(d, 4 * B + 8, fill(0xdd, 8)); // a partial write uses the fetched block
	const want = fill(5);
	want.fill(0xdd, 8, 16);
	assert.deepEqual(await rd(d, 4 * B, B), want);


	const { d: d2, store: s2 } = await openDisk(stored);
	s2.holdReads = true;
	const r = rd(d2, 9 * B, B); // fetches 10.. ahead, held
	await tick();
	assert.ok(d2.aheadPending.has(11));
	await wr(d2, 11 * B, fill(0xcc));
	await d2.flush();
	s2.releaseRead();
	assert.deepEqual(await r, fill(10));
	assert.equal(d2.ahead.has(11), false, "the stale fetch of block 11 is not kept");
	assert.ok(d2.ahead.has(12));
	s2.holdReads = false;
	assert.deepEqual(await rd(d2, 11 * B, B), fill(0xcc));
	assert.deepEqual(await rd(d2, 12 * B, B), fill(13));
});

test("discard deletes the records on a zero base", async () => {
	const { d, store } = await openDisk({ 1: fill(1), 2: fill(2), 3: fill(3), 4: fill(4) });
	await d.discard(1 * B, 2 * B); // blocks 1, 2
	await d.writeZeroes(3 * B + 100, B - 100); // tail of block 3: partial, stays a record
	assert.deepEqual(await rd(d, B, 2 * B), new Uint8Array(2 * B));
	await d.flush();
	assert.deepEqual([...store.blocks.keys()].sort(), [3, 4]);
	assert.deepEqual([...d.stored].sort(), [3, 4]);
	assert.equal(d.mem.size, 0);
	assert.deepEqual(await rd(d, B, 2 * B), new Uint8Array(2 * B));
	const b3 = fill(3);
	b3.fill(0, 100);
	assert.deepEqual(store.blocks.get(3), b3);
	// Discarding a block that was never written stores nothing.
	await d.discard(30 * B, 4 * B);
	assert.equal(d.dirty.size, 0);
});

test("discard over a non-zero base stores an empty (zeros) record", async () => {
	const base = new SparseBase(16 * B, new Map([[1, fill(9)]]));
	const { d, store } = await openDisk({}, base);
	await d.discard(B, B);
	await d.flush();
	assert.equal(store.blocks.get(1)!.length, 0);
	assert.deepEqual(await rd(d, B, B), new Uint8Array(B));
});

test("discard of a block whose save is in flight still deletes it", async () => {
	const { d, store } = await openDisk();
	await wr(d, 6 * B, fill(6));
	store.holdSaves = true;
	const f1 = d.flush();
	await tick();
	await d.discard(6 * B, B);
	const f2 = d.flush();
	store.releaseSave();
	await f1;
	await tick();
	store.releaseSave();
	await f2;
	assert.equal(store.blocks.has(6), false);
	assert.deepEqual(await rd(d, 6 * B, B), new Uint8Array(B));
});

test("flushes are chained: an empty flush waits for the save in flight", async () => {
	const { d, store } = await openDisk();
	await wr(d, 0, fill(1));
	store.holdSaves = true;
	let f1done = false, f2done = false;
	const f1 = (d.flush() as Promise<unknown>).then(() => { f1done = true; });
	await tick();
	const f2 = d.flush();
	assert.ok(f2 instanceof Promise, "not synchronous while a save is pending");
	void (f2 as Promise<unknown>).then(() => { f2done = true; });
	await tick();
	assert.equal(f2done, false);
	store.releaseSave();
	await f1;
	await f2;
	assert.ok(f1done && f2done);
});

test("a block written during its save keeps the newer data (frozen buffers)", async () => {
	const { d, store } = await openDisk();
	await wr(d, 0, fill(1));
	store.holdSaves = true;
	const f1 = d.flush();
	await tick();
	await wr(d, 10, fill(2, 10)); // partial write into the block being saved
	store.releaseSave();
	await f1;
	assert.deepEqual(store.blocks.get(0), fill(1), "the save got the old content");
	assert.ok(d.mem.has(0) && d.dirty.has(0), "the newer content stays in memory, dirty");
	const want = fill(1);
	want.fill(2, 10, 20);
	assert.deepEqual(await rd(d, 0, B), want);
	store.holdSaves = false;
	await d.flush();
	assert.deepEqual(store.blocks.get(0), want);
	assert.equal(d.mem.size, 0);
});

test("whenFlushed resolves only for a flush issued after the mark", async () => {
	const { d, store } = await openDisk();
	await wr(d, 0, fill(1));
	store.holdSaves = true;
	const f1 = d.flush();
	const mark = d.flushSeq;
	let synced = false;
	d.whenFlushed(mark).then(() => { synced = true; });
	await tick();
	store.releaseSave();
	await f1;
	await tick();
	assert.equal(synced, false, "the flush in flight at the mark does not count");
	const f2 = d.flush();
	await f2;
	await tick();
	assert.equal(synced, true);
});

test("without a store the overlay stays in memory", async () => {
	const d = new CowDisk(new ZeroBase(8 * B));
	await wr(d, B, fill(4));
	assert.equal(d.flush(), undefined);
	assert.deepEqual(await rd(d, B, B), fill(4));
	await d.discard(B, B);
	assert.equal(d.mem.size, 0);
	assert.equal(d.persistent, false);
});

test("export: the disk content as kwsparse", async () => {
	const { d, store } = await openDisk({ 1: fill(1), 2: fill(2) });
	await wr(d, 3 * B, fill(3));
	await d.discard(2 * B, B);
	const { parts, blocks } = await d.exportParts();
	assert.equal(blocks, 2);
	const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
	const img = decodeKwsparse(bytes);
	assert.deepEqual(img.indices, [1, 3]);
	assert.deepEqual(img.block(0), fill(1));
	assert.deepEqual(img.block(1), fill(3));
	assert.equal(store.blocks.size, 2, "export does not save");
});

test("kwsparse round trip (zero blocks dropped, gzip, validation)", async () => {
	const rnd = (seed: number) => Uint8Array.from({ length: B }, (_, i) => (i * 31 + seed * 7) & 255);
	const blocks: Array<[number, Uint8Array]> = [[7, rnd(7)], [0, rnd(0)], [1000, rnd(3)], [5, new Uint8Array(B)]];
	const raw = encodeKwsparse({ size: 4096 * B, blocks });
	assert.equal(new TextDecoder().decode(raw.subarray(0, 8)), "KWSPARS1");
	const img = decodeKwsparse(raw);
	assert.equal(img.size, 4096 * B);
	assert.equal(img.blockSize, B);
	assert.deepEqual(img.indices, [0, 7, 1000]);
	assert.deepEqual(img.block(2), rnd(3));
	const img2 = await readKwsparse(gzipSync(raw));
	assert.deepEqual(img2.indices, img.indices);
	assert.deepEqual(img2.data, img.data);
	const bad = raw.slice();
	bad[0] = 0;
	assert.throws(() => decodeKwsparse(bad), /magic/);
	assert.throws(() => decodeKwsparse(raw.subarray(0, raw.length - 1)), /expected/);
	assert.throws(() => encodeKwsparse({ size: 2 * B, blocks: [[5, rnd(1)]] }), /bad block index/);
	const base = SparseBase.fromKwsparse(img);
	assert.deepEqual(base.read(7 * B, B), rnd(7));
	assert.deepEqual(base.read(6 * B, B), new Uint8Array(B));
});

function fakeKernel(disks: ConstructorParameters<typeof Kernel>[0]["disks"]) {
	// An empty module: the constructor reads its imports (which drivers the kernel has).
	const module = new WebAssembly.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
	const k = new Kernel({ module, disks, write: () => {}, log: () => {} });
	k.memory = new WebAssembly.Memory({ initial: 1 });
	k.irqAddr = 64;
	return k;
}
const irqBits = (k: Kernel) => k.dv().getUint32(k.irqAddr!, true);

test("requestSync: true after a later flush of every persistent disk", async () => {
	const { d } = await openDisk();
	const mem = new CowDisk(new ZeroBase(8 * B)); // not persistent: ignored
	const k = fakeKernel([d, mem]);
	await wr(d, 0, fill(1));
	const p = k.requestSync({ timeout: 2000 });
	assert.equal(irqBits(k) & (1 << IRQ_SYNC), 1 << IRQ_SYNC);
	// The kernel takes the request: clears the bit and syncs.
	k.dv().setUint32(k.irqAddr!, irqBits(k) & ~(1 << IRQ_SYNC), true);
	await d.flush();
	assert.equal(await p, true);
});

test("requestSync: false on a timeout, and the bit is cleared", async () => {
	const { d } = await openDisk();
	const k = fakeKernel([d]);
	const t0 = performance.now();
	assert.equal(await k.requestSync({ timeout: 50 }), false);
	assert.ok(performance.now() - t0 >= 45);
	assert.equal(irqBits(k) & (1 << IRQ_SYNC), 0);
	assert.equal(await fakeKernel([]).requestSync(), true, "no persistent disk: nothing to wait for");
});

test("FileDisk: sizes of 4 GiB and more, flush counting; createImageFromKwsparse", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kwblk-test-"));
	try {
		const size = 4 * 1024 * 1024 * 1024 + 8192; // above 2^32: `& ~511` would give 8192
		const blocks: Array<[number, Uint8Array]> = [[0, fill(1)], [size / B - 1, fill(2)]];
		const tpl = gzipSync(encodeKwsparse({ size, blocks }));
		const file = path.join(dir, "data.img");
		assert.deepEqual(await createImageFromKwsparse(file, tpl), { size, blocks: 2 });
		await assert.rejects(createImageFromKwsparse(file, tpl), /EEXIST/, "never replaces an existing image");
		assert.ok(fs.statSync(file).blocks * 512 < 1048576, "written sparse");
		const d = new FileDisk(file);
		try {
			assert.equal(d.size, size);
			assert.equal(d.persistent, true);
			const v = new Uint8Array(B);
			d.read(size - B, [v]);
			assert.deepEqual(v, fill(2));
			d.write(B, [fill(3)]);
			const mark = d.flushSeq;
			const synced = d.whenFlushed(mark);
			d.flush();
			await synced;
			assert.equal(d.flushSeq, mark + 1);
		} finally {
			d.close();
		}
		assert.equal(new FileDisk(file, { readOnly: true }).persistent, false);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Machine snapshots: the disk side.

test("snapshots: a CowDisk's write generation starts with the first write after open and after each seal, and is saved with the blocks", async () => {
	const store = new FakeStore();
	store.gen = 4;
	const d = await new CowDisk(new ZeroBase(64 * B), { store, log: () => {} }).open();
	assert.equal(d.snapshotState().gen, 4, "the stored generation");
	assert.match(d.snapshotState().identity, /uid=fake-uid/);
	await wr(d, 0, fill(1));
	await wr(d, B, fill(2));
	assert.equal(d.snapshotState().gen, 5, "one new generation per session, not per write");
	assert.equal(store.gen, 4, "not saved before a flush");
	await d.flush();
	assert.equal(store.gen, 5, "saved in the same transaction as the blocks");
	const { state, done } = d.snapshotSeal();
	await done;
	assert.equal(state.gen, 5);
	await wr(d, 0, fill(3));
	assert.equal(d.snapshotState().gen, 6, "the first write after a seal");
	await d.flush();
	assert.equal(store.gen, 6);

	// A new session over the same store: the saved generation, until it writes.
	const d2 = await new CowDisk(new ZeroBase(64 * B), { store, log: () => {} }).open();
	assert.equal(snapshotDiskMismatch([d.snapshotState()], [d2]), null);
	await wr(d2, 0, fill(4));
	assert.match(snapshotDiskMismatch([d.snapshotState()], [d2]) ?? "", /written after the snapshot \(generation 7, the snapshot has 6\)/);
});

test("snapshots: a seal saves exactly the blocks written before it, even while the guest writes on", async () => {
	const { d, store } = await openDisk();
	await wr(d, 1 * B, fill(0xa1));
	store.holdSaves = true;
	const { state, done } = d.snapshotSeal();
	assert.equal(state.gen, 1);
	// The guest runs on while the seal's save is held.
	await wr(d, 1 * B, fill(0xb1));
	await wr(d, 2 * B, fill(0xb2));
	const fl = d.flush(); // chained after the seal's save
	await tick();
	assert.equal(store.saves.length, 1, "the flush waits for the seal");
	store.releaseSave();
	await done;
	assert.deepEqual(store.blocks.get(1), fill(0xa1), "the seal's content, not the later write");
	assert.equal(store.blocks.has(2), false);
	assert.equal(store.gen, 1);
	await tick();
	store.releaseSave();
	await fl;
	assert.deepEqual(store.blocks.get(1), fill(0xb1));
	assert.deepEqual(store.blocks.get(2), fill(0xb2));
	assert.equal(store.gen, 2);
	assert.deepEqual(await rd(d, 1 * B, B), fill(0xb1));
});

test("snapshots: a failed seal fails, and its blocks are saved by the next flush", async () => {
	const { d, store } = await openDisk();
	await wr(d, 3 * B, fill(9));
	store.failNext = 1;
	await assert.rejects(d.snapshotSeal().done, /simulated failure/);
	await d.flush();
	assert.deepEqual(store.blocks.get(3), fill(9));
});

test("snapshots: a CowDisk without a store can be in one only while unwritten, over a base with an identity", async () => {
	const base = Object.assign(new ZeroBase(8 * B), { identity: "img v1" });
	const d = new CowDisk(base);
	assert.deepEqual(d.snapshotState(), { name: "img v1", identity: "base img v1", gen: 0 });
	assert.equal(snapshotDiskMismatch([d.snapshotState()], [new CowDisk(base)]), null);
	await wr(d, 0, fill(1));
	assert.throws(() => d.snapshotState(), /keeps its writes in memory only/);
	assert.throws(() => d.snapshotSeal(), /keeps its writes in memory only/);
	assert.throws(() => new CowDisk(new ZeroBase(8 * B)).snapshotState(), /no identity/);
});

test("snapshots: snapshotDiskMismatch names the disk that is missing, extra, another one, or written since", () => {
	const disk = (identity: string, gen: number): BlockDevice => ({
		size: B, read: () => {}, write: () => {},
		snapshotState: (): DiskSnapshotState => ({ name: identity, identity, gen }),
	});
	const saved = [disk("a", 1).snapshotState!(), disk("b", 2).snapshotState!()];
	assert.equal(snapshotDiskMismatch(saved, [disk("a", 1), disk("b", 2)]), null);
	assert.match(snapshotDiskMismatch(saved, [disk("a", 1)])!, /^disk wdb \(b\) is missing/);
	assert.match(snapshotDiskMismatch(saved, [disk("a", 1), disk("b", 2), disk("c", 0)])!, /^disk wdc was not in the snapshot/);
	assert.match(snapshotDiskMismatch(saved, [disk("a", 1), disk("x", 2)])!, /^disk wdb \(x\) is not the disk of the snapshot \(b\)$/);
	const stamped = (stamp: string): BlockDevice => ({ ...disk("a", 1), snapshotState: () => ({ name: "a", identity: "a", gen: 1, stamp }) });
	assert.match(snapshotDiskMismatch([stamped("t1").snapshotState!()], [stamped("t2")])!, /^disk wda \(a\) was changed by another program/);
	assert.match(snapshotDiskMismatch(saved, [disk("a", 2), disk("b", 2)])!, /^disk wda \(a\) was written after the snapshot/);
	assert.match(snapshotDiskMismatch(saved, [{ size: B, read: () => {}, write: () => {} }, disk("b", 2)])!, /^disk wda cannot be checked/);
});

test("snapshots: FileDisk keeps its write generation in a sidecar file once a snapshot included it", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kwblk-snap-"));
	try {
		const file = path.join(dir, "disk.img");
		fs.writeFileSync(file, new Uint8Array(16 * B));
		const d = new FileDisk(file);
		d.write(0, [fill(1)]);
		assert.equal(d.gen, 1);
		assert.equal(fs.existsSync(`${file}.kwsnap`), false, "no sidecar before a snapshot");
		const s1 = d.snapshotSeal().state;
		const side = () => JSON.parse(fs.readFileSync(`${file}.kwsnap`, "utf8")) as { uid: string; gen: number };
		assert.deepEqual(side(), { uid: d.uid, gen: 1 });
		d.write(B, [fill(2)]);
		assert.equal(side().gen, 2, "stored before the data, on the first write after the seal");
		d.write(2 * B, [fill(3)]);
		assert.equal(side().gen, 2);
		d.close();

		const d2 = new FileDisk(file);
		assert.equal(d2.gen, 2);
		assert.match(snapshotDiskMismatch([s1], [d2])!, /written after the snapshot \(generation 2, the snapshot has 1\)/);
		const s2 = d2.snapshotSeal().state;
		d2.close();
		const d3 = new FileDisk(file);
		assert.equal(snapshotDiskMismatch([s2], [d3]), null, "unchanged since the seal");
		d3.close();

		// Another program writes the image: the identity (size, mtime) changes.
		const fd = fs.openSync(file, "r+");
		fs.writeSync(fd, fill(7), 0, B, 5 * B);
		fs.futimesSync(fd, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
		fs.closeSync(fd);
		const d4 = new FileDisk(file);
		assert.match(snapshotDiskMismatch([s2], [d4])!, /was changed by another program after the snapshot/);
		d4.close();

		const ro = new FileDisk(file, { readOnly: true });
		const r1 = ro.snapshotSeal().state;
		ro.close();
		const ro2 = new FileDisk(file, { readOnly: true });
		assert.equal(snapshotDiskMismatch([r1], [ro2]), null);
		ro2.close();
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// HttpBase read-ahead (HttpBaseOptions.readAhead), against a local server
// that answers single Range requests from a pattern image and records them.
const KiB = 1024, CS = 256 * KiB;

async function rangeServer(size: number, { fail, hold }: { fail?: (start: number, end: number) => boolean; hold?: (start: number, end: number) => Promise<void> | undefined } = {}) {
	const img = new Uint8Array(size);
	for (let i = 0; i < size; i++) img[i] = (i * 7 + (i >> 12)) & 255;
	const ranges: Array<[number, number]> = [];
	const server = http.createServer(async (req, res) => {
		const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
		if (!m) { res.writeHead(200, { "content-length": size, etag: '"img"' }); res.end(img); return; }
		const start = Number(m[1]), end = Math.min(size - 1, Number(m[2]));
		ranges.push([start, end + 1]);
		if (fail?.(start, end + 1)) { res.writeHead(500); res.end(); return; }
		res.writeHead(206, { "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1, etag: '"img"' });
		const wait = hold?.(start, end + 1);
		if (wait) {
			res.write(img.subarray(start, start + CS));
			await wait;
			res.end(img.subarray(start + CS, end + 1));
		} else res.end(img.subarray(start, end + 1));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/img`;
	return { img, ranges, url, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

/** Until no fetch is in flight (a read-ahead may still run after the reads). */
async function settled(b: HttpBase) {
	while (b.pending.size) await Promise.allSettled([...b.pending.values()]);
}

/** Read [from, to) in `step` pieces, one after the other, checking the bytes. */
async function readSeq(b: HttpBase, img: Uint8Array, from: number, to: number, step = 128 * KiB) {
	for (let off = from; off < to; off += step) {
		const got = await b.read(off, Math.min(step, to - off));
		assert.deepEqual(got, img.subarray(off, Math.min(off + step, to)), `bytes at ${off}`);
	}
}

test("HttpBase read-ahead: a sequential reader gets growing windows ahead of it, and the bytes are right", async () => {
	const s = await rangeServer(16 * 1024 * KiB);
	try {
		const b = await HttpBase.open(s.url, { prefetch: false, strict: true });
		await readSeq(b, s.img, CS, 12 * 1024 * KiB);
		await settled(b);
		// 11.75 MiB: 47 chunks. Without read-ahead every chunk is a request of its own.
		assert.ok(b.stats.aheadRequests >= 3, `read-ahead requests: ${b.stats.aheadRequests}`);
		assert.ok(b.stats.lazyRequests <= 3, `lazy requests: ${b.stats.lazyRequests}`);
		const sizes = s.ranges.slice(1).map(([a, e]) => (e - a) / CS);
		assert.equal(Math.max(...sizes), 16, `request sizes in chunks: ${sizes}`);
		// Never more than the window past what was read.
		assert.ok(Math.max(...s.ranges.map(([, e]) => e)) <= 16 * 1024 * KiB);
		assert.equal(b.stats.bytes, s.ranges.reduce((n, [a, e]) => n + e - a, 0));
	} finally {
		await s.close();
	}
});

test("HttpBase read-ahead: scattered reads fetch only their own chunks; readAhead: false turns it off", async () => {
	const s = await rangeServer(16 * 1024 * KiB);
	try {
		const b = await HttpBase.open(s.url, { prefetch: false });
		for (const c of [9, 3, 30, 17, 50]) assert.deepEqual(await b.read(c * CS + 100, 4096), s.img.subarray(c * CS + 100, c * CS + 4196));
		assert.equal(b.stats.aheadRequests, 0);
		assert.equal(b.stats.lazyRequests, 5);
		const off = await HttpBase.open(s.url, { prefetch: false, readAhead: false });
		await readSeq(off, s.img, 0, 2 * 1024 * KiB);
		await settled(off);
		assert.equal(off.stats.aheadRequests, 0);
		assert.equal(off.stats.lazyRequests, 7);   // chunk 0 came with open()
	} finally {
		await s.close();
	}
});

test("HttpBase read-ahead: a failed read-ahead leaves its chunks to lazy reads, which still fail loudly", async () => {
	let failAll = false;
	const s = await rangeServer(8 * 1024 * KiB, { fail: (a, e) => failAll || e - a > 2 * CS });   // every read-ahead (4+ chunks) fails
	try {
		const logs: string[] = [];
		const b = await HttpBase.open(s.url, { prefetch: false, log: (m) => logs.push(m) });
		await readSeq(b, s.img, 0, 4 * 1024 * KiB);
		await settled(b);
		assert.ok(b.stats.aheadRequests >= 1);
		assert.ok(logs.some((m) => /read-ahead .* failed/.test(m)), logs.join("\n"));
		failAll = true;
		await assert.rejects(async () => b.read(30 * CS, 4096), /HTTP 500/);
	} finally {
		await s.close();
	}
});

test("HttpBase read-ahead: chunks arrive streamed, so a read waits only for its own bytes", async () => {
	const gate = deferred();
	const s = await rangeServer(8 * 1024 * KiB, { hold: (a, e) => (e - a > CS ? gate.promise : undefined) });
	try {
		const b = await HttpBase.open(s.url, { prefetch: false });
		await b.read(4 * CS, 4096);   // chunk 4: lazy (chunk 3 is not here)
		await b.read(5 * CS, 4096);   // chunk 5: lazy, after chunk 4: read-ahead of chunks 6-9, held after chunk 6
		// Wait for streamed bytes before checking what the server received.
		const r6 = await Promise.race([Promise.resolve(b.read(6 * CS, 4096)), new Promise((r) => setTimeout(() => r("timeout"), 2000))]);
		assert.deepEqual(r6, s.img.subarray(6 * CS, 6 * CS + 4096));
		assert.deepEqual(s.ranges.at(-1), [6 * CS, 10 * CS]);
		const r7 = b.read(7 * CS, 4096);
		assert.ok(r7 instanceof Promise);
		gate.resolve();
		assert.deepEqual(await r7, s.img.subarray(7 * CS, 7 * CS + 4096));
		await settled(b);
	} finally {
		gate.resolve();
		await s.close();
	}
});

// The distro header's background field and HttpBase's background tier
// (HttpBaseOptions.background).
test("readDistroHeader: a 136-byte header adds background; the 128-byte one has none", async () => {
	const { readDistroHeader } = await import("../js/core/block.ts");
	const head = (len: number, size: number, prefetch: number, background?: number) => {
		const b = new Uint8Array(256), dv = new DataView(b.buffer);
		b.set(new TextEncoder().encode("KWDISTRO"));
		dv.setUint32(8, 1, true);
		dv.setUint32(12, len, true);
		dv.setBigUint64(16, BigInt(size), true);
		dv.setBigUint64(24, BigInt(prefetch), true);
		b.set(new TextEncoder().encode("debian"), 32);
		b.set(new TextEncoder().encode("debian-13-x"), 64);
		if (background !== undefined) dv.setBigUint64(128, BigInt(background), true);
		return b;
	};
	const MiB = 1024 * KiB;
	assert.deepEqual(readDistroHeader(head(128, 72 * MiB, 3 * MiB, 20 * MiB), 72 * MiB),
		{ size: 72 * MiB, prefetch: 3 * MiB, background: 0, distro: "debian", image: "debian-13-x" });
	assert.equal(readDistroHeader(head(136, 72 * MiB, 3 * MiB, 20 * MiB), 72 * MiB)?.background, 20 * MiB);
	assert.equal(readDistroHeader(head(136, 72 * MiB, 3 * MiB, 99 * MiB))?.background, 72 * MiB);   // capped at the size
	assert.equal(readDistroHeader(head(136, 72 * MiB, 3 * MiB, 2 * MiB))?.background, 0);   // not past the prefetch: none
	assert.equal(readDistroHeader(head(136, 72 * MiB, 3 * MiB, 20 * MiB).subarray(0, 128))?.background, 0);
});

test("HttpBase background: once the image was read and the boot is quiet, [prefetch, background) comes in sequential pieces; reads in it need no request", async () => {
	const MiB = 1024 * KiB;
	const s = await rangeServer(8 * MiB);
	try {
		const b = await HttpBase.open(s.url, { prefetch: MiB, background: 6 * MiB, maxRequest: 2 * MiB, readAhead: false });
		assert.equal(b.stats.background, 6 * MiB);
		// Not before the first read (an image opened while its kernel loads), however long that takes.
		await new Promise((r) => setTimeout(r, 1600));
		assert.equal(b.stats.backgroundState as string, "waiting");
		assert.deepEqual(s.ranges, [[0, CS], [CS, MiB]]);
		await b.read(4096, 4096);
		const t0 = Date.now();
		while (b.stats.backgroundState !== "done") {
			assert.ok(!["failed", "skipped"].includes(b.stats.backgroundState), b.stats.backgroundState);
			assert.ok(Date.now() - t0 < 10000, `background: ${b.stats.backgroundState}`);
			await new Promise((r) => setTimeout(r, 50));
		}
		assert.deepEqual(s.ranges, [[0, CS], [CS, MiB], [MiB, 3 * MiB], [3 * MiB, 5 * MiB], [5 * MiB, 6 * MiB]]);
		assert.equal(b.stats.backgroundBytes, 5 * MiB);
		const n = s.ranges.length;
		for (const off of [MiB, 3 * MiB - 100, 6 * MiB - 4096]) {
			const got = b.read(off, 4096);
			assert.ok(!(got instanceof Promise), `read at ${off} is cached`);
			assert.deepEqual(got, s.img.subarray(off, off + 4096));
		}
		assert.equal(s.ranges.length, n);
		// background: false, or prefetch: false without a background option: none.
		for (const opts of [{ prefetch: MiB, background: false as const }, { prefetch: false as const }]) {
			const off = await HttpBase.open(s.url, { ...opts, readAhead: false });
			assert.equal(off.stats.backgroundState, "none");
		}
	} finally {
		await s.close();
	}
});

test("HttpBase background: it waits while reads keep the image busy, and skips chunks a read fetched", async () => {
	const MiB = 1024 * KiB;
	const s = await rangeServer(8 * MiB);
	try {
		const b = await HttpBase.open(s.url, { prefetch: false, background: 4 * MiB, maxRequest: 4 * MiB, readAhead: false });
		// A read every 300 ms for 1.5 s: the tier must not start meanwhile.
		for (let i = 0; i < 5; i++) {
			await b.read((i + 1) * CS, 4096);
			await new Promise((r) => setTimeout(r, 300));
			assert.equal(b.stats.backgroundState, "waiting");
		}
		const t0 = Date.now();
		while (b.stats.backgroundState !== "done") {
			assert.ok(Date.now() - t0 < 10000, `background: ${b.stats.backgroundState}`);
			await new Promise((r) => setTimeout(r, 50));
		}
		// Chunks 1-5 came lazily: the tier asks only for chunks 6-15.
		assert.deepEqual(s.ranges.at(-1), [6 * CS, 4 * MiB]);
		assert.deepEqual(b.read(4 * MiB - 4096, 4096), s.img.subarray(4 * MiB - 4096, 4 * MiB));
	} finally {
		await s.close();
	}
});
