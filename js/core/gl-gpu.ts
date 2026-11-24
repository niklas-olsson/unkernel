// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// virtio-gpu 3D: the guest's stock virtio_gpu DRM driver and Mesa's
// virtio_gpu (virgl) driver render through the same virglrenderer module
// and WebGL2 context as guest GL's vtest link (gl.ts), with
// createKernel({ gl, gpu }). Two halves:
//
//   VirglGpuBackend  the device side (a GpuBackend of virtio-gpu.ts), where
//                    the kernel runs (this thread inline, the kernel's
//                    worker in worker mode): it keeps what needs the guest's
//                    memory (each resource's backing pages and the layout
//                    of 3D resources) and hands the renderer commands and
//                    transfer data, packed;
//   GpuRenderer      the renderer side, on the thread with the WebGL2
//                    context (the page's): runs the commands in the module
//                    (gl/wasm/kw_virgl.c, kw_vgpu_*), answers fences,
//                    presents the scanout.
//
// Between them a GpuLink: direct calls inline (inlineGpuLink), messages in
// worker mode (worker-serve.ts and worker-host.ts post "gpu" and
// "gpu-reply").
//
// Memory: the guest's pages are in the kernel's memory, the renderer has
// its own; nothing is shadowed. TRANSFER_TO_HOST_3D gathers exactly the
// bytes the transfer reads (each block row of the box, layer after layer;
// a buffer's range) into one packed buffer and rewrites the command to
// read it from offset 0 with the packed strides; TRANSFER_FROM_HOST_3D gets
// the same packing back and scatters it. Inline, the gather writes straight
// into the module's heap (one copy) and a readback is copied out once and
// scattered; in worker mode the packed buffer is a transferred ArrayBuffer
// (two copies each way: pages to it, it to the heap). RESOURCE_ATTACH_BACKING
// never reaches the renderer, so no resource has an iovec there, and the
// capsets the guest gets have no transfers in the command stream
// (kw_virgl.c).
//
// Answers: commands that answer only "OK" and carry no fence (resource and
// context commands, SET_SCANOUT, RESOURCE_FLUSH) are answered by the
// device at once and posted to the renderer, which runs them in order
// (errors there are logged). Fenced commands and readbacks wait for the
// renderer's answer, which for a fenced one is the fence signal
// (GpuRenderer, fences below). Capsets: their ids, versions and sizes are
// constants of virglrenderer (VIRGL_CAPSETS), so GET_CAPSET_INFO, which the
// driver asks at probe, is answered without the renderer; their contents
// come from its WebGL2 context once it is up (GpuInit), cached on the
// device side.
//
// Loading: the renderer (the module and its WebGL2 context) may be loaded
// on the first command that needs it (gl.ts, GlLoader; the default): the
// device side starts it (GpuLink.start) on GET_CAPSET or the first 3D
// command (context, 3D resource, submit), and nothing before that (a 2D
// client's SET_SCANOUT 0 or RESOURCE_FLUSH never loads it). Commands wait
// meanwhile: GET_CAPSET for the capsets, a 3D transfer for the format
// table, and every command sent after a waiting one goes after it, so the
// renderer sees them in order. If it cannot load, everything 3D is
// answered ERR_UNSPEC (the driver then caches a zeroed capset; gl.md, The
// DRM path, for what Mesa makes of that).

import { FORMATS, GPU_CMD, GPU_RESP, VIRTIO_GPU_F_VIRGL, type GpuBackend, type GpuBackendContext } from "./virtio-gpu.ts";
import type { VirtqBuffer } from "./virtio.ts";
import type { DisplayFrame } from "./display.ts";

const HDR = 24;
const FLAG_FENCE = 1;
/** PIPE_BUFFER, gallium's target of buffers. */
const TARGET_BUFFER = 0;

/**
 * The capsets the device offers (num_capsets, GET_CAPSET_INFO), known
 * without the renderer: virglrenderer's virgl_renderer_get_cap_set() gives
 * constants (VREND_CAPSET_VIRGL_MAX_VERSION, VREND_CAPSET_VIRGL2_MAX_VERSION,
 * sizeof(struct virgl_caps_v1), sizeof(struct virgl_caps_v2)) and may be
 * called before the renderer exists. gl/wasm/kw_virgl.h has the same
 * numbers (KW_VGPU_CAPSET*), which kw_virgl.c checks at compile time
 * against virglrenderer's, and GpuRenderer checks the loaded module's
 * capsets against these (a module from another virglrenderer then gives no
 * 3D, with a log line, rather than capsets of the wrong size).
 */
export const VIRGL_CAPSETS: ReadonlyArray<{ readonly id: number; readonly version: number; readonly size: number }> = Object.freeze([
	Object.freeze({ id: 1, version: 1, size: 308 }), // VIRTGPU_DRM_CAPSET_VIRGL: struct virgl_caps_v1
	Object.freeze({ id: 2, version: 2, size: 1408 }), // VIRTGPU_DRM_CAPSET_VIRGL2: struct virgl_caps_v2
]);

/** What the renderer offers, from its WebGL2 context: the device side caches it. */
export interface GpuInit {
	/** Capsets by index (capset IDs 1, VIRGL, and 2, VIRGL2, as far as the renderer has them). */
	capsets: Array<{ id: number; version: number; data: Uint8Array }>;
	/** kw_vgpu_format() of each virgl format, by number: block width | height << 8 | bytes << 16. */
	formats: Uint32Array;
}

/** A command for the renderer: a copy (rewritten for packed transfers), header first. */
export interface GpuRequest {
	cmd: Uint8Array;
	/** TRANSFER_TO_HOST_3D: the packed bytes. */
	data?: Uint8Array;
	/** TRANSFER_FROM_HOST_3D: how many packed bytes to read back. */
	readLen?: number;
}

/** The renderer's answer: 0 (OK) or a virtio-gpu response type, and a readback's packed bytes. */
export interface GpuReply {
	code: number;
	data?: Uint8Array;
}

/** How the device side reaches the renderer. */
export interface GpuLink {
	/** The renderer's capsets and formats once it is up (after start()); rejects if there is none. */
	readonly init: Promise<GpuInit>;
	/** Load the renderer now if it is not loaded or loading (the guest's first 3D use). */
	start(): void;
	/** Run a command and answer (in order with posts). */
	call(req: GpuRequest): GpuReply | Promise<GpuReply>;
	/** Run a command; no answer. */
	post(req: GpuRequest): void;
	/** The device reset: the renderer drops the guest's contexts and resources. */
	reset(): void;
	/** A buffer for a TRANSFER_TO_HOST_3D's packed bytes, used by the next call() (inline: the module's heap). */
	buffer?(n: number): Uint8Array;
}

/** A 3D resource as the device side keeps it. */
interface Resource3d {
	target: number;
	format: number;
	width: number;
	height: number;
	/** The guest pages behind it (ATTACH_BACKING), with each entry's start offset. */
	backing: VirtqBuffer[] | null;
	starts: number[];
}

/** A transfer's rows: where each packed row comes from in the backing. */
interface Packing {
	/** Bytes per packed row; rows `rows` per layer, `layers` layers. */
	row: number;
	rows: number;
	layers: number;
	srcStride: number;
	srcLayer: number;
	offset: number;
	/** Total packed bytes. */
	len: number;
}

const minify = (v: number, level: number) => Math.max(1, v >>> level);

/** A response of `size` bytes with only the type set. */
function resp(type: number, size = HDR): Uint8Array {
	const b = new Uint8Array(size);
	new DataView(b.buffer).setUint32(0, type, true);
	return b;
}

/** A command with a header (type, context) and, if given, the resource id (RESOURCE_UNREF) after it; CTX_CREATE's debug name empty. */
function hdr(type: number, ctx: number, id?: number): Uint8Array {
	const b = new Uint8Array(HDR + (type === GPU_CMD.CTX_CREATE ? 72 : 8));
	const dv = new DataView(b.buffer);
	dv.setUint32(0, type, true);
	dv.setUint32(16, ctx, true);
	if (id !== undefined) dv.setUint32(HDR, id, true);
	return b;
}

/** The resource a command names, or 0. */
function resourceOf(dv: DataView): number {
	switch (dv.getUint32(0, true)) {
		case GPU_CMD.TRANSFER_TO_HOST_3D:
		case GPU_CMD.TRANSFER_FROM_HOST_3D:
			return dv.byteLength >= HDR + 36 ? dv.getUint32(HDR + 32, true) : 0;
		case GPU_CMD.SET_SCANOUT:
			return dv.byteLength >= HDR + 24 ? dv.getUint32(HDR + 20, true) : 0;
		case GPU_CMD.RESOURCE_FLUSH:
			return dv.byteLength >= HDR + 20 ? dv.getUint32(HDR + 16, true) : 0;
		case GPU_CMD.RESOURCE_CREATE_3D:
		case GPU_CMD.RESOURCE_UNREF:
		case GPU_CMD.CTX_ATTACH_RESOURCE:
		case GPU_CMD.CTX_DETACH_RESOURCE:
			return dv.byteLength >= HDR + 4 ? dv.getUint32(HDR, true) : 0;
		default:
			return 0;
	}
}

/**
 * The device side of virtio-gpu 3D: a GpuBackend over a GpuLink. Offers
 * VIRTIO_GPU_F_VIRGL and the capsets of VIRGL_CAPSETS (their contents
 * answered once the renderer is up, which the first GET_CAPSET starts).
 * Not CONTEXT_INIT, which only Venus and ring-indexed fences need: without
 * it the driver makes a file's context at its first 3D use and attaches
 * every resource the file opens to it, a PRIME import made before the first
 * 3D ioctl included (with CONTEXT_INIT such an import is left out of the
 * context the file makes later).
 */
export class VirglGpuBackend implements GpuBackend {
	readonly features = VIRTIO_GPU_F_VIRGL;
	readonly capsetCount = VIRGL_CAPSETS.length;
	#link: GpuLink;
	#log: (msg: string) => void;
	#init: GpuInit | null = null;
	#failed = false;
	/** link.start() was called: the guest has used 3D. */
	#started = false;
	/** The last command sent to the renderer that had to wait for its init: later sends go after it. */
	#tail: Promise<unknown> | null = null;
	#resources = new Map<number, Resource3d>();
	/** Contexts made in the renderer. */
	#contexts = new Set<number>();
	/**
	 * Contexts the guest made before the renderer was loaded, with their
	 * CTX_CREATE: the driver makes a DRM file's context at its first dumb
	 * buffer too, so a 2D client makes one and attaches only 2D resources
	 * to it, which needs no renderer. Made there when it loads (#start).
	 */
	#pending = new Map<number, Uint8Array>();
	/** Contexts that submitted commands: they hold objects in the renderer (blocker()). */
	#submitted = new Set<number>();

	constructor(link: GpuLink, log: (msg: string) => void = () => {}) {
		this.#link = link;
		this.#log = log;
		link.init.then((i) => (this.#init = i), (e: unknown) => {
			this.#failed = true;
			log(`[virtio-gpu] no 3D renderer: ${(e as Error)?.message ?? e}; capsets and 3D commands fail, so the guest's Mesa gets no virgl screen (it falls back to software rendering)`);
		});
	}

	resource(id: number): { width: number; height: number } | null {
		const r = this.#resources.get(id);
		return r && r.target !== TARGET_BUFFER ? { width: r.width, height: r.height } : null;
	}

	reset(): void {
		this.#resources.clear();
		this.#contexts.clear();
		this.#pending.clear();
		this.#submitted.clear();
		this.#tail = null;
		this.#link.reset();
	}

	/**
	 * What a snapshot would lose: any 3D resource, or a context that
	 * submitted commands (its objects: shaders, states, sub contexts). A
	 * context that never submitted and, as no resource exists, has none
	 * attached (a compositor or relay that opened the render node and
	 * imported buffers that are gone) is only its id in the renderer; the
	 * guest's kernel keeps it across a restore, and the first command that
	 * names it there makes it again (#adopt), as it was.
	 */
	blocker(): string {
		if (this.#resources.size) return "virtio-gpu resources";
		if (this.#submitted.size) return "virtio-gpu contexts";
		return "";
	}

	/**
	 * A command that needs the renderer names a context it has not made:
	 * make it there first. Either its CTX_CREATE was held (#pending), or it
	 * is from before a restore (blocker() let only empty ones through),
	 * made as the guest made it then (without CONTEXT_INIT: no flags; the
	 * debug name is lost).
	 */
	#adopt(ctx: number): void {
		if (!ctx || this.#contexts.has(ctx)) return;
		this.#contexts.add(ctx);
		let b = this.#pending.get(ctx);
		if (b) this.#pending.delete(ctx);
		else {
			this.#log(`[virtio-gpu] context ${ctx} is from before a restore: made again in the renderer`);
			b = hdr(GPU_CMD.CTX_CREATE, ctx);
		}
		this.#start();
		void this.#send({ cmd: b }, false);
	}

	/**
	 * The guest uses 3D: load the renderer (once), and make the contexts
	 * held before it first, so that from here on every context the guest
	 * holds is in the renderer (a lost renderer's renewal sees a new
	 * program's CTX_CREATE before its resources, as the driver sends them).
	 */
	#start(): void {
		if (this.#started) return;
		this.#started = true;
		this.#link.start();
		for (const id of [...this.#pending.keys()]) this.#adopt(id);
	}

	command(cmd: Uint8Array, ctx: GpuBackendContext): Uint8Array | null | Promise<Uint8Array | null> {
		const dv = new DataView(cmd.buffer, cmd.byteOffset, cmd.byteLength);
		const type = dv.getUint32(0, true);
		const fenced = (dv.getUint32(4, true) & FLAG_FENCE) !== 0;
		const need = (n: number) => {
			if (cmd.length < HDR + n) throw new Error(`virtio-gpu command 0x${type.toString(16)}: ${cmd.length} bytes`);
		};
		switch (type) {
			case GPU_CMD.GET_CAPSET_INFO: {
				need(4);
				// Constants (VIRGL_CAPSETS): the driver asks at probe, long before any 3D use.
				const c = VIRGL_CAPSETS[dv.getUint32(HDR, true)];
				const out = resp(GPU_RESP.OK_CAPSET_INFO, HDR + 16);
				const o = new DataView(out.buffer);
				// An index past them: id 0, which the driver skips.
				if (c) {
					o.setUint32(HDR, c.id, true);
					o.setUint32(HDR + 4, c.version, true);
					o.setUint32(HDR + 8, c.size, true);
				}
				return out;
			}
			case GPU_CMD.GET_CAPSET:
				need(8);
				this.#start();
				return this.#withInit((init) => {
					const c = init.capsets.find((x) => x.id === dv.getUint32(HDR, true));
					if (!c) return resp(GPU_RESP.ERR_INVALID_PARAMETER);
					const out = resp(GPU_RESP.OK_CAPSET, HDR + c.data.length);
					out.set(c.data, HDR);
					return out;
				});
			case GPU_CMD.RESOURCE_CREATE_3D: {
				need(44);
				const id = dv.getUint32(HDR, true);
				if (!id || this.#resources.has(id)) return resp(GPU_RESP.ERR_INVALID_RESOURCE_ID);
				this.#resources.set(id, {
					target: dv.getUint32(HDR + 4, true), format: dv.getUint32(HDR + 8, true),
					width: dv.getUint32(HDR + 16, true), height: dv.getUint32(HDR + 20, true), backing: null, starts: [],
				});
				this.#start();
				return this.#send({ cmd }, fenced);
			}
			case GPU_CMD.RESOURCE_UNREF: {
				need(8);
				if (!this.#resources.delete(dv.getUint32(HDR, true))) return resp(GPU_RESP.ERR_INVALID_RESOURCE_ID);
				return this.#send({ cmd }, fenced);
			}
			case GPU_CMD.RESOURCE_ATTACH_BACKING: {
				need(8);
				const res = this.#resources.get(dv.getUint32(HDR, true));
				if (!res) return resp(GPU_RESP.ERR_INVALID_RESOURCE_ID);
				const n = dv.getUint32(HDR + 4, true);
				need(8 + 16 * n);
				const size = ctx.memory().buffer.byteLength;
				const backing: VirtqBuffer[] = [], starts: number[] = [];
				let total = 0;
				for (let i = 0; i < n; i++) {
					const at = HDR + 8 + 16 * i;
					const addr = Number(dv.getBigUint64(at, true)), len = dv.getUint32(at + 8, true);
					if (addr + len > size) return resp(GPU_RESP.ERR_INVALID_PARAMETER);
					backing.push({ addr, len });
					starts.push(total);
					total += len;
				}
				res.backing = backing;
				res.starts = starts;
				return resp(GPU_RESP.OK_NODATA);
			}
			case GPU_CMD.RESOURCE_DETACH_BACKING: {
				need(8);
				const res = this.#resources.get(dv.getUint32(HDR, true));
				if (!res) return resp(GPU_RESP.ERR_INVALID_RESOURCE_ID);
				res.backing = null;
				res.starts = [];
				return resp(GPU_RESP.OK_NODATA);
			}
			case GPU_CMD.TRANSFER_TO_HOST_3D:
			case GPU_CMD.TRANSFER_FROM_HOST_3D: {
				need(48);
				const res = this.#resources.get(dv.getUint32(HDR + 32, true));
				if (!res) return resp(GPU_RESP.ERR_INVALID_RESOURCE_ID);
				this.#adopt(dv.getUint32(16, true));
				const toHost = type === GPU_CMD.TRANSFER_TO_HOST_3D;
				// The packing needs the renderer's format table: wait for it, and keep later sends behind.
				const run = () => this.#transferNow(cmd, dv, res, ctx, toHost, fenced);
				return this.#tail || (!this.#init && !this.#failed) ? this.#after(run) : run();
			}
			case GPU_CMD.CTX_CREATE: {
				need(8);
				const id = dv.getUint32(16, true);
				// Before the renderer is loaded, held (#pending; a 2D client's never needs it).
				if (!this.#started && !this.#contexts.has(id)) {
					this.#pending.set(id, cmd.slice());
					return resp(GPU_RESP.OK_NODATA);
				}
				this.#contexts.add(id);
				return this.#send({ cmd }, fenced);
			}
			case GPU_CMD.CTX_DESTROY: {
				const id = dv.getUint32(16, true);
				this.#submitted.delete(id);
				// Not made in the renderer (held, or from before a restore and not used since): nothing to tell it.
				if (this.#pending.delete(id) || !this.#contexts.delete(id)) return resp(GPU_RESP.OK_NODATA);
				return this.#send({ cmd }, fenced);
			}
			case GPU_CMD.CTX_ATTACH_RESOURCE:
			case GPU_CMD.CTX_DETACH_RESOURCE:
				// A 2D resource (a dumb buffer): the renderer has none of that id, nothing to attach.
				if (!this.#resources.has(dv.getUint32(HDR, true))) return resp(GPU_RESP.OK_NODATA);
				this.#adopt(dv.getUint32(16, true));
				return this.#send({ cmd }, fenced);
			case GPU_CMD.SUBMIT_3D:
				this.#submitted.add(dv.getUint32(16, true));
				this.#adopt(dv.getUint32(16, true));
				this.#start();
				return this.#send({ cmd }, fenced);
			case GPU_CMD.SET_SCANOUT:
			case GPU_CMD.RESOURCE_FLUSH:
				// Before any 3D use the renderer has no scanout (a 2D client turning
				// its scanout off): nothing to tell, and no reason to load it.
				if (!this.#started) return resp(GPU_RESP.OK_NODATA);
				return this.#send({ cmd }, fenced);
			default:
				// Blobs, UUIDs, 2D commands on a 3D resource: not offered.
				this.#log(`[virtio-gpu] command 0x${type.toString(16)} is not supported with the 3D renderer`);
				return resp(type === GPU_CMD.TRANSFER_TO_HOST_2D ? GPU_RESP.ERR_INVALID_RESOURCE_ID : GPU_RESP.ERR_UNSPEC);
		}
	}

	/** Answer from the renderer's init, now if it is there. */
	#withInit(f: (init: GpuInit) => Uint8Array): Uint8Array | Promise<Uint8Array> {
		if (this.#init) return f(this.#init);
		if (this.#failed) return resp(GPU_RESP.ERR_UNSPEC);
		return this.#link.init.then(f, () => resp(GPU_RESP.ERR_UNSPEC));
	}

	/**
	 * Run `f` (which sends to the renderer) once the renderer's init has come
	 * and after every send that waited before it; sends that come meanwhile
	 * queue behind it (#send), so the renderer gets them in order.
	 */
	#after<T>(f: () => T | Promise<T>): Promise<T> {
		const before = this.#tail ?? this.#link.init.catch(() => {});
		const p = before.then(() => f());
		const tail = p.catch(() => {});
		this.#tail = tail;
		void tail.then(() => {
			if (this.#tail === tail) this.#tail = null;
		});
		return p;
	}

	/** A command for the renderer: fenced ones wait for its answer, the others are answered OK now. */
	#send(req: GpuRequest, fenced: boolean): Uint8Array | Promise<Uint8Array> {
		return this.#tail ? this.#after(() => this.#sendNow(req, fenced)) : this.#sendNow(req, fenced);
	}

	#sendNow(req: GpuRequest, fenced: boolean): Uint8Array | Promise<Uint8Array> {
		if (this.#failed) return resp(GPU_RESP.ERR_UNSPEC);
		if (!fenced) {
			this.#link.post(req);
			return resp(GPU_RESP.OK_NODATA);
		}
		const r = this.#link.call(req);
		return r instanceof Promise ? r.then((x) => resp(x.code || GPU_RESP.OK_NODATA)) : resp(r.code || GPU_RESP.OK_NODATA);
	}

	/** Where a transfer's packed rows come from (null: a format the renderer cannot pack, or no such resource). */
	#packing(res: Resource3d, dv: DataView): Packing | null {
		const w = dv.getUint32(HDR + 12, true), h = dv.getUint32(HDR + 16, true), d = Math.max(1, dv.getUint32(HDR + 20, true));
		const offset = Number(dv.getBigUint64(HDR + 24, true));
		const level = dv.getUint32(HDR + 36, true), stride = dv.getUint32(HDR + 40, true), layerStride = dv.getUint32(HDR + 44, true);
		if (res.target === TARGET_BUFFER) return { row: w, rows: 1, layers: 1, srcStride: 0, srcLayer: 0, offset, len: w };
		const f = this.#init?.formats[res.format] ?? 0;
		const bw = f & 0xff, bh = (f >> 8) & 0xff, bs = f >>> 16;
		if (!bw || !bh || !bs) return null;
		const nbx = Math.ceil(Math.max(1, w) / bw), nby = Math.ceil(Math.max(1, h) / bh);
		// vrend's defaults for a stride of 0 (check_iov_bounds): the level's.
		const srcStride = stride || Math.ceil(minify(res.width, level) / bw) * bs;
		const srcLayer = layerStride || Math.ceil(minify(res.height, level) / bh) * srcStride;
		const row = nbx * bs;
		return { row, rows: nby, layers: d, srcStride, srcLayer, offset, len: row * nby * d };
	}

	#transferNow(cmd: Uint8Array, dv: DataView, res: Resource3d, ctx: GpuBackendContext, toHost: boolean, fenced: boolean): Uint8Array | Promise<Uint8Array> {
		if (this.#failed) return resp(GPU_RESP.ERR_UNSPEC);
		const p = this.#packing(res, dv);
		if (!p) {
			this.#log(`[virtio-gpu] transfer of a resource in format ${res.format}: no layout for it`);
			return resp(GPU_RESP.ERR_INVALID_PARAMETER);
		}
		// The command as the renderer runs it: the packed buffer from offset 0.
		const out = cmd.slice();
		const o = new DataView(out.buffer);
		o.setBigUint64(HDR + 24, 0n, true);
		o.setUint32(HDR + 40, res.target === TARGET_BUFFER ? 0 : p.row, true);
		o.setUint32(HDR + 44, res.target === TARGET_BUFFER ? 0 : p.row * p.rows, true);
		const mem = new Uint8Array(ctx.memory().buffer);
		if (toHost) {
			const data = this.#link.buffer?.(p.len) ?? new Uint8Array(p.len);
			this.#rows(res, p, (src, at, n) => gather(res, mem, src, data, at, n));
			const req = { cmd: out, data };
			if (!fenced) {
				this.#link.post(req);
				return resp(GPU_RESP.OK_NODATA);
			}
			const r = this.#link.call(req);
			return r instanceof Promise ? r.then((x) => resp(x.code || GPU_RESP.OK_NODATA)) : resp(r.code || GPU_RESP.OK_NODATA);
		}
		const done = (x: GpuReply) => {
			if (!x.code && x.data) {
				// The guest's memory now: the kernel may have reused nothing of the
				// backing while the transfer was in flight (its fence holds the object).
				const m = new Uint8Array(ctx.memory().buffer);
				const data = x.data;
				this.#rows(res, p, (dst, at, n) => scatter(res, m, dst, data, at, n));
			}
			return resp(x.code || GPU_RESP.OK_NODATA);
		};
		const r = this.#link.call({ cmd: out, readLen: p.len });
		return r instanceof Promise ? r.then(done) : done(r);
	}

	/** Each packed row: its offset in the backing, its offset in the packed buffer, its length. */
	#rows(res: Resource3d, p: Packing, f: (backingOff: number, packedOff: number, n: number) => void): void {
		if (!res.backing?.length) return;
		let at = 0;
		for (let l = 0; l < p.layers; l++)
			for (let r = 0; r < p.rows; r++, at += p.row) f(p.offset + l * p.srcLayer + r * p.srcStride, at, p.row);
	}
}

/** The backing entry index that holds byte `off` (the last that starts at or before it). */
function entryAt(starts: number[], off: number): number {
	let lo = 0, hi = starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (starts[mid]! <= off) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/** Copy `n` bytes at offset `off` of the backing into `dst` at `at` (zeros past the backing). */
function gather(res: Resource3d, mem: Uint8Array, off: number, dst: Uint8Array, at: number, n: number): void {
	const back = res.backing!, starts = res.starts;
	for (let i = entryAt(starts, off); n > 0 && i < back.length; i++) {
		const b = back[i]!, skip = off - starts[i]!;
		if (skip >= b.len) continue;
		const k = Math.min(n, b.len - skip);
		dst.set(mem.subarray(b.addr + skip, b.addr + skip + k), at);
		at += k;
		off += k;
		n -= k;
	}
	if (n > 0) dst.fill(0, at, at + n);
}

/** Copy `n` bytes of `src` at `at` into the backing at offset `off` (what falls past the backing is dropped). */
function scatter(res: Resource3d, mem: Uint8Array, off: number, src: Uint8Array, at: number, n: number): void {
	const back = res.backing!, starts = res.starts;
	for (let i = entryAt(starts, off); n > 0 && i < back.length; i++) {
		const b = back[i]!, skip = off - starts[i]!;
		if (skip >= b.len) continue;
		const k = Math.min(n, b.len - skip);
		mem.set(src.subarray(at, at + k), b.addr + skip);
		at += k;
		off += k;
		n -= k;
	}
}

// ---------------------------------------------------------------- renderer side

/** The module's virtio-gpu helpers (gl/wasm/post.js, Module.virgl.gpu). */
export interface VirglGpuApi {
	buffer(n: number): Uint8Array;
	command(cmd: Uint8Array, data?: Uint8Array): number;
	capset(id: number): { version: number; data: Uint8Array } | null;
	format(f: number): number;
	fence(): number;
	fencesDone(): number;
	/** Host GL errors of guests' commands so far (GpuRendererStats.glErrors). Absent in a module from before it. */
	glErrors?(): number;
	info(res: number): { texture: WebGLTexture | null; width: number; height: number; format: number; yTop: boolean; alpha?: boolean } | null;
	/** Absent in a module from before window images (GpuRenderer.image() then gives null). */
	blit?(res: number, x: number, y: number, w: number, h: number, flags?: number): number;
	present(res: number, x: number, y: number, w: number, h: number): number;
	read(res: number, x: number, y: number, w: number, h: number, bpp?: number): Uint8Array | null;
}

/** What GpuRenderer runs on: the module's helpers and its WebGL2 context (an OffscreenCanvas). */
export interface GpuRendererCore {
	gpu: VirglGpuApi;
	gl: WebGL2RenderingContext;
}

/** A resource's texture in the renderer's WebGL2 context (GpuRenderer.texture()). */
export interface GpuTexture {
	/** The context that owns it (the renderer's; share nothing with another context). */
	gl: WebGL2RenderingContext;
	/** The texture, or null for a resource without one (a buffer). */
	texture: WebGLTexture | null;
	width: number;
	height: number;
	/** The virgl format (virgl_formats; 1 B8G8R8A8, 2 B8G8R8X8, 67 R8G8B8A8, 134 R8G8B8X8 ...). */
	format: number;
	/**
	 * VIRGL_RESOURCE_Y_0_TOP: the texture's row k holds the picture's row
	 * height - 1 - k (rows counted from the top, as the guest lays them
	 * out); without it row k holds row k, so drawn into a framebuffer as GL
	 * counts rows (from the bottom) it is upside down.
	 */
	yTop: boolean;
	/** The format has alpha (B8G8R8A8, R8G8B8A8 ...; not B8G8R8X8, R8G8B8X8). */
	alpha: boolean;
}

/** Command names for messages (GpuRendererStats.lastError). */
const CMD_NAMES = new Map<number, string>(Object.entries(GPU_CMD).map(([k, v]) => [v, k]));

/** kw_vgpu_blit()'s flags (gl/wasm/kw_virgl.h). */
const BLIT_OPAQUE = 1, BLIT_FLIP_Y = 2;

/** What GpuRenderer.image() takes of a resource, and how. */
export interface GpuImageOptions {
	/** The rectangle of the picture (rows from the top): default all of it; clamped to the resource. */
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	/**
	 * Alpha 1 everywhere. Default: when the resource's format has none
	 * (GpuTexture.alpha). Pass what the client declared: true for an X
	 * fourcc (XR24, XB24: the fourth byte is undefined), false for an A one
	 * (AR24, AB24: premultiplied alpha, kept).
	 */
	opaque?: boolean;
	/**
	 * Upside down: the image's row 0 is the picture's last row. For a
	 * buffer whose client set y_invert (zwp_linux_buffer_params_v1 flag 1:
	 * its row 0 is the bottom), so that the image's row 0 is the top.
	 */
	flipY?: boolean;
}

export interface GpuRendererStats {
	/** Commands run. */
	commands: number;
	/** Fenced commands, and how they were answered: at once, or after waiting for the GPU (parks). */
	fenced: number;
	parks: number;
	parkedMs: number;
	/** Frames presented (RESOURCE_FLUSH of the scanout), and readbacks (TRANSFER_FROM_HOST_3D). */
	presents: number;
	reads: number;
	/** Window images made (image()). */
	images: number;
	/** Commands the renderer refused or could not run (logged, at most one line a second). */
	errors: number;
	/**
	 * WebGL errors raised by guests' commands: each one a call WebGL dropped
	 * (it refuses calls GLES leaves undefined), with the guest's context
	 * going on; the renderer logs them ("[gl] virgl: ... GL error 0x502 ...").
	 */
	glErrors: number;
	/**
	 * The latest of the commands that failed, for a device without DevTools: the command, its
	 * context and resource, the answer and why ("" while none failed), e.g.
	 * "SUBMIT_3D ctx 1: 0x1200, the renderer refused it (...)".
	 */
	lastError: string;
	/**
	 * The WebGL2 context is lost and no new renderer has been made since: every
	 * 3D command fails until the guest's next new GL context makes one
	 * (GpuRendererOptions.renew).
	 */
	contextLost: boolean;
	/** WebGL2 contexts lost so far, and new renderers made after a loss. */
	losses: number;
	renewals: number;
}

export interface GpuRendererOptions {
	/**
	 * Answer every fenced command once its GPU work is done, as QEMU does
	 * (glmark2 and the like then wait for each frame). Default false: at
	 * once, except that after a frame was presented a fenced command waits
	 * until that frame is done (the guest runs at most about a frame ahead
	 * of the GPU).
	 */
	strictWaits?: boolean;
	log?: (msg: string) => void;
	/**
	 * A renderer to go on with after the WebGL2 context was lost: a new
	 * module instance on a new WebGL2 context (gl.ts, GlLoader.get()),
	 * asked when the guest makes its next new GL context. Without it a
	 * loss is final: every 3D command fails from then on.
	 */
	renew?: () => Promise<GpuRendererCore>;
}

/** After a renewal failed, the next new GL context tries again only this much later (ms). */
const RENEW_RETRY_MS = 1000;

/** The current scanout and its latest frame (GpuRenderer.scanout). */
export interface GpuScanout {
	resource: number;
	x: number;
	y: number;
	width: number;
	height: number;
	/** Frames presented on it so far. */
	seq: number;
}

/**
 * The renderer side of virtio-gpu 3D, on the thread with the WebGL2
 * context. Runs commands in the order they come; answers fenced ones as
 * GpuRendererOptions.strictWaits says (gl.md, The DRM path: why answering
 * ahead of the GPU cannot make the guest read data before it is valid);
 * presents the scanout: a RESOURCE_FLUSH of the scanout's resource blits
 * it into the context's drawing buffer (sized to the scanout) and takes it
 * as an ImageBitmap (transferToImageBitmap: no readback), which
 * drawFrame() draws into the page's canvas. frame() reads the scanout back
 * on demand (screenshots). image() takes any resource's picture the same
 * way, for a compositor on the page (window images).
 *
 * A lost WebGL2 context takes every guest object of the renderer with it
 * (#loseContext). With `renew`, the guest's next new GL context gets a new
 * renderer; contexts and resources the guest still holds from the lost one
 * are stale: commands naming them fail, or are dropped where nothing is
 * left to do (destroy, unref, detach), so the programs that had them must
 * be restarted. Contexts that never submitted (a Wayland relay's) hold no
 * objects and are made again in the new renderer.
 */
export class GpuRenderer {
	/** The capsets and the format table once the renderer is up (after start()); rejects if it cannot be. */
	readonly init: Promise<GpuInit>;
	stats: GpuRendererStats = { commands: 0, fenced: 0, parks: 0, parkedMs: 0, presents: 0, reads: 0, images: 0, errors: 0, glErrors: 0, lastError: "", contextLost: false, losses: 0, renewals: 0 };
	/** A new frame was presented, or the scanout changed. */
	onFrame: (() => void) | undefined;
	#load: () => Promise<GpuRendererCore>;
	#renew: (() => Promise<GpuRendererCore>) | undefined;
	#started = false;
	#failed = false;
	/** The WebGL2 context was lost (webglcontextlost, or isContextLost()) and no new renderer is up yet. */
	#lost = false;
	/** The capsets the guest got (from the first renderer): a new renderer's are compared with them. */
	#capsets: GpuInit["capsets"] = [];
	/** The current core's lost listener. */
	#listening: AbortController | null = null;
	/** Ids the guest still holds from a lost renderer: commands naming them fail, or are dropped. */
	#staleContexts = new Set<number>();
	#staleResources = new Set<number>();
	/** Contexts of a lost renderer that never submitted: made again in the next one. */
	#idle = new Set<number>();
	/** Contexts that submitted commands (they hold objects in the renderer). */
	#submitted = new Set<number>();
	/** The current core's glErrors() as of the last submit. */
	#glErrorsSeen = 0;
	#renewFailedAt = -Infinity;
	/** Error lines: when the last was logged, and how many were left out since. */
	#errorLogAt = -Infinity;
	#errorsUnlogged = 0;
	#settle!: { resolve: (c: GpuRendererCore) => void; reject: (e: unknown) => void };
	#core: GpuRendererCore | null = null;
	#queue: Array<{ req: GpuRequest; done?: (r: GpuReply | Promise<GpuReply>) => void }> | null = [];
	#strict: boolean;
	#log: (msg: string) => void;
	#contexts = new Set<number>();
	#resources = new Set<number>();
	#scanout: GpuScanout | null = null;
	#bitmap: ImageBitmap | null = null;
	#drawn = -1;
	/** The fence after the last presented frame: fenced answers wait for it (not strict). */
	#hold = 0;
	/** Fences known done although WebGL may not say so yet: those before a readback. */
	#floor = 0;
	#waits: Array<{ need: number; since: number; resolve: () => void }> = [];
	#polling = false;
	#rounds = 0;
	#wake: MessagePort | null = null;

	/**
	 * `load` gives the module's helpers and its WebGL2 context: called once,
	 * on start() (the device side's first 3D use, or at once for a renderer
	 * loaded before boot), or on the first command.
	 */
	constructor(load: () => Promise<GpuRendererCore>, opts: GpuRendererOptions = {}) {
		this.#load = load;
		this.#renew = opts.renew;
		this.#strict = !!opts.strictWaits;
		this.#log = opts.log ?? (() => {});
		const core = new Promise<GpuRendererCore>((resolve, reject) => (this.#settle = { resolve, reject }));
		this.init = core.then((c) => {
			const capsets: GpuInit["capsets"] = [];
			for (const { id, version, size } of VIRGL_CAPSETS) {
				const cs = c.gpu.capset(id);
				// The device offered these before the module was loaded (GET_CAPSET_INFO): the driver
				// caches that size, so a capset of another size or version cannot be given.
				if (!cs || cs.version !== version || cs.data.length !== size)
					throw new Error(`the renderer's capset ${id} is ${cs ? `version ${cs.version}, ${cs.data.length} bytes` : "missing"}, not version ${version}, ${size} bytes as offered ` +
						"(VIRGL_CAPSETS in js/core/gl-gpu.ts and KW_VGPU_CAPSET* in gl/wasm/kw_virgl.h must match the module's virglrenderer)");
				capsets.push({ id, version, data: cs.data });
			}
			const formats = new Uint32Array(512);
			for (let f = 0; f < formats.length; f++) formats[f] = c.gpu.format(f);
			this.#capsets = capsets;
			this.#attach(c);
			const q = this.#queue ?? [];
			this.#queue = null;
			for (const { req, done } of q) {
				const r = this.#run(req);
				done?.(r);
			}
			return { capsets, formats };
		});
		this.init.catch((e: unknown) => {
			this.#failed = true;
			const q = this.#queue ?? [];
			this.#queue = null;
			for (const { done } of q) done?.({ code: GPU_RESP.ERR_UNSPEC });
			this.stats.lastError = `no renderer, every 3D command fails: ${(e as Error)?.message ?? e}`;
			this.#log(`[gl] virtio-gpu: no renderer: ${(e as Error)?.message ?? e}`);
		});
	}

	/** Load the renderer now, if that has not started (the guest's first 3D use). */
	start(): void {
		if (this.#started) return;
		this.#started = true;
		let p: Promise<GpuRendererCore>;
		try {
			p = this.#load();
		} catch (e) {
			p = Promise.reject(e);
		}
		p.then(this.#settle.resolve, this.#settle.reject);
	}

	/** start() was called: the renderer is loaded, loading, or failed. */
	get started(): boolean {
		return this.#started;
	}

	/** Run a command and answer (after the commands before it). */
	call(req: GpuRequest): GpuReply | Promise<GpuReply> {
		this.start();
		this.#maybeRenew(req);
		if (this.#queue) {
			const q = this.#queue;
			return new Promise((resolve) => q.push({ req, done: (r) => void Promise.resolve(r).then(resolve) }));
		}
		if (!this.#core) return { code: GPU_RESP.ERR_UNSPEC };
		return this.#run(req);
	}

	/** Run a command, no answer. */
	post(req: GpuRequest): void {
		this.start();
		this.#maybeRenew(req);
		if (this.#queue) this.#queue.push({ req });
		else if (this.#core) void this.#run(req);
	}

	/** The module's heap for a transfer's packed bytes (inline), valid until the next command. */
	buffer(n: number): Uint8Array {
		return this.#core ? this.#core.gpu.buffer(n) : new Uint8Array(n);
	}

	/** The device reset: destroy the guest's contexts and resources. */
	reset(): void {
		const c = this.#core;
		if (this.#queue) this.#queue.length = 0;
		this.#setScanout(null);
		for (const w of this.#waits) w.resolve();
		this.#waits = [];
		this.#hold = 0;
		this.#staleContexts.clear();
		this.#staleResources.clear();
		this.#idle.clear();
		this.#submitted.clear();
		// Nothing to destroy in a lost context (its objects are gone; no GL call on it).
		if (c && !this.#lost) {
			for (const id of this.#resources) c.gpu.command(hdr(GPU_CMD.RESOURCE_UNREF, 0, id));
			for (const ctx of this.#contexts) c.gpu.command(hdr(GPU_CMD.CTX_DESTROY, ctx));
		}
		this.#resources.clear();
		this.#contexts.clear();
	}

	/** The scanout (a 3D resource on it) and how many frames it got, or null. */
	get scanout(): GpuScanout | null {
		return this.#scanout && { ...this.#scanout };
	}

	/**
	 * Draw the scanout's latest frame into a 2D context at (0, 0), its size
	 * (the canvas should be the scanout's size). True if it drew a frame it
	 * had not drawn before, false if there is nothing new, null if no 3D
	 * resource is on the scanout (show frame() or the display instead).
	 * The frame stays until the next one, so `force` draws it again.
	 */
	drawFrame(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, force = false): boolean | null {
		const s = this.#scanout;
		if (!s) return null;
		if (!this.#bitmap || (!force && this.#drawn === s.seq)) return false;
		ctx.drawImage(this.#bitmap, 0, 0);
		this.#drawn = s.seq;
		return true;
	}

	/** The scanout as RGBA, read back from the GPU (for screenshots, not every frame), or null. */
	frame(out?: Uint8ClampedArray): DisplayFrame | null {
		const s = this.#scanout, c = this.#core;
		if (!s || !c) return null;
		const info = c.gpu.info(s.resource);
		const order = info && FORMATS[info.format];
		if (!order) return null;
		const px = c.gpu.read(s.resource, s.x, s.y, s.width, s.height, 4);
		if (!px) return null;
		const n = s.width * s.height;
		const data = out && out.length === n * 4 ? out : new Uint8ClampedArray(n * 4);
		for (let i = 0, o = 0; i < n * 4; i += 4, o += 4) {
			data[o] = px[i + order[2]]!;
			data[o + 1] = px[i + order[1]]!;
			data[o + 2] = px[i + order[0]]!;
			data[o + 3] = 255;
		}
		return { width: s.width, height: s.height, data };
	}

	/**
	 * A resource's GL texture in the renderer's context, for host code that
	 * composes guest buffers (a client's dmabuf: DRM_IOCTL_VIRTGPU_RESOURCE_INFO
	 * gives its resource id): null if there is no such resource. Use it on
	 * this thread, in `gl`, and do not change its parameters or delete it.
	 */
	texture(resource: number): GpuTexture | null {
		const c = this.#lost ? null : this.#core;
		const i = c?.gpu.info(resource);
		return c && i ? { gl: c.gl, ...i, alpha: i.alpha ?? false } : null;
	}

	/**
	 * A resource's picture as an ImageBitmap, for a compositor on the page
	 * (a guest client's dmabuf: DRM_IOCTL_VIRTGPU_RESOURCE_INFO gives the
	 * resource id; textures do not cross WebGL contexts, images do). Row 0
	 * is the picture's top row as the guest lays it out (VIRGL_RESOURCE_Y_0_TOP
	 * resources included), unless `flipY`; colour and alpha as the client
	 * rendered them, premultiplied (Wayland's ARGB, and what a 2D canvas's
	 * drawImage() takes from an ImageBitmap), or opaque (`opaque`, by default
	 * for a format without alpha). No readback: the module blits the texture
	 * into the renderer's drawing buffer (vrend's state handled as for the
	 * scanout) and takes it with transferToImageBitmap(), so the image holds
	 * what the guest's commands before this call drew, now; later rendering
	 * does not change it. The image is the caller's: close() it when drawn.
	 *
	 * Null for an unknown id, a resource without a texture (a buffer), an
	 * empty rectangle, or no renderer; a promise while the renderer is
	 * still loading (it waits for it; the guest made no 3D resource before
	 * the renderer could run its commands, so nothing waits otherwise). It
	 * never loads the renderer: before the guest's first 3D use there is no
	 * resource. The drawing buffer is resized to the image (the scanout's
	 * next present resizes it back; its frame is already an ImageBitmap).
	 */
	image(resource: number, opts: GpuImageOptions = {}): ImageBitmap | null | Promise<ImageBitmap | null> {
		if (this.#core) return this.#image(this.#core, resource, opts);
		if (!this.#started || this.#failed) return null;
		return this.init.then(() => this.#image(this.#core!, resource, opts), () => null);
	}

	#image(c: GpuRendererCore, resource: number, opts: GpuImageOptions): ImageBitmap | null {
		if (this.#lost) return null;
		const i = c.gpu.info(resource);
		const canvas = c.gl.canvas as OffscreenCanvas;
		if (!i?.texture || !c.gpu.blit || typeof canvas.transferToImageBitmap !== "function") return null;
		const x = Math.max(0, Math.floor(opts.x ?? 0)), y = Math.max(0, Math.floor(opts.y ?? 0));
		const w = Math.min(Math.floor(opts.width ?? i.width), i.width - x), h = Math.min(Math.floor(opts.height ?? i.height), i.height - y);
		if (!(w > 0 && h > 0)) return null;
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
		}
		if (c.gl.drawingBufferWidth !== w || c.gl.drawingBufferHeight !== h) {
			this.#log(`[gl] virtio-gpu: no ${w}x${h} drawing buffer for resource ${resource} (got ${c.gl.drawingBufferWidth}x${c.gl.drawingBufferHeight})`);
			return null;
		}
		const flags = ((opts.opaque ?? !i.alpha) ? BLIT_OPAQUE : 0) | (opts.flipY ? BLIT_FLIP_Y : 0);
		if (c.gpu.blit(resource, x, y, w, h, flags) < 0) return null;
		this.stats.images++;
		return canvas.transferToImageBitmap();
	}

	#run(req: GpuRequest): GpuReply | Promise<GpuReply> {
		const c = this.#core!;
		const dv = new DataView(req.cmd.buffer, req.cmd.byteOffset, req.cmd.byteLength);
		const type = dv.getUint32(0, true);
		const fenced = (dv.getUint32(4, true) & FLAG_FENCE) !== 0;
		this.stats.commands++;
		if (!this.#lost && c.gl.isContextLost()) this.#loseContext();
		if (this.#lost || this.#staleContexts.size || this.#staleResources.size || this.#idle.size) {
			const r = this.#stale(dv, type);
			// Answered at once: no GPU work to wait for, and no call into a lost renderer.
			if (r) return r;
		}
		let code = 0, data: Uint8Array | undefined;
		switch (type) {
			case GPU_CMD.SET_SCANOUT: {
				const id = dv.getUint32(HDR + 20, true);
				const w = dv.getUint32(HDR + 8, true), h = dv.getUint32(HDR + 12, true);
				this.#setScanout(id && w && h ? { resource: id, x: dv.getUint32(HDR, true), y: dv.getUint32(HDR + 4, true), width: w, height: h } : null);
				break;
			}
			case GPU_CMD.RESOURCE_FLUSH:
				if (this.#scanout?.resource === dv.getUint32(HDR + 16, true)) this.#present();
				break;
			case GPU_CMD.TRANSFER_FROM_HOST_3D: {
				const n = req.readLen ?? 0;
				code = c.gpu.command(req.cmd, c.gpu.buffer(n));
				// A copy: the heap is reused, and the answer may wait.
				if (!code) data = c.gpu.buffer(n).slice();
				this.stats.reads++;
				break;
			}
			default:
				// A submit that fails may have made objects before the command that failed.
				if (type === GPU_CMD.SUBMIT_3D) this.#submitted.add(dv.getUint32(16, true));
				code = c.gpu.command(req.cmd, req.data);
				if (type === GPU_CMD.SUBMIT_3D && c.gpu.glErrors) {
					const n = c.gpu.glErrors();
					this.stats.glErrors += (n - this.#glErrorsSeen) >>> 0;
					this.#glErrorsSeen = n;
				}
				if (!code) {
					if (type === GPU_CMD.RESOURCE_CREATE_3D) this.#resources.add(dv.getUint32(HDR, true));
					else if (type === GPU_CMD.RESOURCE_UNREF) {
						this.#resources.delete(dv.getUint32(HDR, true));
						if (this.#scanout?.resource === dv.getUint32(HDR, true)) this.#setScanout(null);
					} else if (type === GPU_CMD.CTX_CREATE) this.#contexts.add(dv.getUint32(16, true));
					else if (type === GPU_CMD.CTX_DESTROY) {
						this.#contexts.delete(dv.getUint32(16, true));
						this.#submitted.delete(dv.getUint32(16, true));
					}
				}
		}
		if (code) return this.#refused(dv, code, "the renderer refused it (the [gl] virgl: lines before this one have its reason)", true);
		if (!fenced) return { code, data };
		return this.#fence(type, { code, data });
	}

	/**
	 * A fenced command ran: answer it (the fence signal) now or once the GPU
	 * work it should wait for is done. The guest shares no memory with the
	 * GPU: what it reads comes in a TRANSFER_FROM_HOST_3D answer, read with
	 * glReadPixels or getBufferSubData after everything before it, and what
	 * it writes goes in with TRANSFER_TO_HOST_3D, ordered after everything
	 * before it; a query's result reads as pending until written (patch 12)
	 * and Mesa reads it again. So an early fence signal decides only how far
	 * the guest runs ahead of the GPU.
	 */
	#fence(type: number, reply: GpuReply): GpuReply | Promise<GpuReply> {
		const c = this.#core!;
		this.stats.fenced++;
		const seq = c.gpu.fence();
		if (type === GPU_CMD.TRANSFER_FROM_HOST_3D) {
			// The readback waited for the GPU work before it.
			this.#floor = seq;
			if (!this.#strict) return reply;
		}
		const need = this.#strict ? seq : this.#hold;
		if (!need || (!this.#waits.length && this.#done(need))) return reply;
		this.stats.parks++;
		return new Promise((resolve) => {
			this.#waits.push({ need, since: performance.now(), resolve: () => resolve(reply) });
			if (!this.#polling) {
				this.#polling = true;
				this.#rounds = 0;
				this.#later();
			}
		});
	}

	/**
	 * A command that failed: counted, kept as stats.lastError, and logged at
	 * most once a second (a client whose context is in error fails every
	 * command; the guest's kernel logs each, rate-limited, as "response
	 * 0x1200 (command 0x207)").
	 */
	#refused(dv: DataView, code: number, why: string, log: boolean): GpuReply {
		const type = dv.getUint32(0, true), ctx = dv.getUint32(16, true);
		const res = type === GPU_CMD.TRANSFER_TO_HOST_3D || type === GPU_CMD.TRANSFER_FROM_HOST_3D ? dv.getUint32(HDR + 32, true)
			: type !== GPU_CMD.SUBMIT_3D && type !== GPU_CMD.CTX_CREATE && type !== GPU_CMD.CTX_DESTROY && dv.byteLength >= HDR + 4 ? dv.getUint32(HDR, true) : 0;
		const name = CMD_NAMES.get(type) ?? `command 0x${type.toString(16)}`;
		this.stats.errors++;
		this.stats.lastError = `${name}${ctx ? ` ctx ${ctx}` : ""}${res ? ` resource ${res}` : ""}: 0x${code.toString(16)}, ${why}`;
		if (log) {
			const now = performance.now();
			if (now - this.#errorLogAt >= 1000) {
				this.#log(`[gl] virtio-gpu: ${this.stats.lastError}${this.#errorsUnlogged ? ` (${this.#errorsUnlogged} more failed since the last line)` : ""}`);
				this.#errorLogAt = now;
				this.#errorsUnlogged = 0;
			} else this.#errorsUnlogged++;
		}
		return { code };
	}

	/** A core is the current one: listen for its context's loss. */
	#attach(c: GpuRendererCore): void {
		this.#core = c;
		this.#glErrorsSeen = c.gpu.glErrors?.() ?? 0;
		this.#listening?.abort();
		const ac = new AbortController();
		this.#listening = ac;
		// The browser may drop the context (memory pressure, a GPU reset, a GPU
		// process ended in the background): #loseContext. preventDefault() lets
		// the browser restore it (GlLoader, which made it, releases it then).
		(c.gl.canvas as OffscreenCanvas).addEventListener?.("webglcontextlost", (e: Event) => {
			e.preventDefault();
			if (this.#core === c) this.#loseContext();
		}, { signal: ac.signal });
	}

	/**
	 * The WebGL2 context is gone, and with it every object of the renderer:
	 * the guest's contexts and resources cannot be had back (a restored
	 * context is a new, empty one; the guest's Mesa keeps no copy of what it
	 * made, and virtio-gpu has no way to tell the guest its GPU objects are
	 * gone). Say so once, answer 3D commands at once without a GL call (#stale:
	 * failed, or OK where nothing is left to do), and let waits for GPU work
	 * end now, so no guest program hangs on a fence. What the guest holds
	 * becomes stale; contexts that never submitted are made again in the
	 * next renderer (#renewed), which the guest's next new GL context asks for.
	 */
	#loseContext(): void {
		if (this.#lost) return;
		this.#lost = true;
		this.stats.contextLost = true;
		this.stats.losses++;
		this.#log("[gl] virtio-gpu: the WebGL2 context was lost (the browser dropped it: memory pressure, a GPU reset, the GPU process ended); " +
			"every GL object of the guest went with it, so the GL programs running now fail (the guest's kernel logs \"response 0x1200\") and must be restarted; " +
			(this.#renew ? "the next GL program gets a new renderer" : "reload the page for a new renderer"));
		this.stats.lastError = "the WebGL2 context was lost";
		this.#hold = 0;
		for (const w of this.#waits) w.resolve();
		this.#waits = [];
		this.#setScanout(null);
		for (const ctx of this.#contexts) (this.#submitted.has(ctx) ? this.#staleContexts : this.#idle).add(ctx);
		for (const id of this.#resources) this.#staleResources.add(id);
		this.#contexts.clear();
		this.#resources.clear();
		this.#submitted.clear();
	}

	/**
	 * A command while the context is lost, or one that names what a lost
	 * renderer had: its answer (at once), or null to run it. Destroy, unref,
	 * detach, scanout and flush of stale ids are dropped (OK: nothing is
	 * left); everything else naming them fails, and while no renderer is up
	 * every command fails but those.
	 */
	#stale(dv: DataView, type: number): GpuReply | null {
		const lost = this.#lost;
		const ctx = dv.byteLength >= HDR ? dv.getUint32(16, true) : 0, res = resourceOf(dv);
		const sc = !!ctx && this.#staleContexts.has(ctx), sr = !!res && this.#staleResources.has(res);
		const ok: GpuReply = { code: 0 };
		switch (type) {
			case GPU_CMD.CTX_CREATE:
				// The guest frees an id before it makes it again: a stale one cannot come back.
				this.#staleContexts.delete(ctx);
				this.#idle.delete(ctx);
				if (!lost) return null;
				this.#staleContexts.add(ctx);
				break;
			case GPU_CMD.CTX_DESTROY:
				if (!lost && !sc && !this.#idle.has(ctx)) return null;
				this.#staleContexts.delete(ctx);
				this.#idle.delete(ctx);
				return ok;
			case GPU_CMD.RESOURCE_CREATE_3D:
				this.#staleResources.delete(res);
				if (!lost) return null;
				this.#staleResources.add(res);
				break;
			case GPU_CMD.RESOURCE_UNREF:
				if (!lost && !sr) return null;
				this.#staleResources.delete(res);
				if (this.#scanout?.resource === res) this.#setScanout(null);
				return ok;
			case GPU_CMD.CTX_DETACH_RESOURCE:
				return lost || sc || sr ? ok : null;
			case GPU_CMD.SET_SCANOUT:
			case GPU_CMD.RESOURCE_FLUSH:
				if (!lost && !sr) return null;
				// Nothing to show: the page shows no 3D frame until a live resource is scanned out.
				if (type === GPU_CMD.SET_SCANOUT) this.#setScanout(null);
				return ok;
			case GPU_CMD.SUBMIT_3D:
				// A context made again after the loss (it never submitted) that submits while there is no renderer: its objects are lost too.
				if (lost && this.#idle.delete(ctx)) this.#staleContexts.add(ctx);
				if (!lost && !sc && !sr) return null;
				break;
			default:
				if (!lost && !sc && !sr) return null;
		}
		if (lost) {
			// Counted; lastError keeps saying the context was lost, and the loss was logged.
			this.stats.errors++;
			return { code: GPU_RESP.ERR_UNSPEC };
		}
		return this.#refused(dv, GPU_RESP.ERR_UNSPEC, `its ${sc ? "context" : "resource"} was in a WebGL2 context that was lost: restart the program`, true);
	}

	/**
	 * While the context is lost, the guest's next new GL context (CTX_CREATE
	 * of an id that is not stale) asks for a new renderer (`renew`): commands
	 * queue until it is up (#renewed) or failed (#renewFailed).
	 */
	#maybeRenew(req: GpuRequest): void {
		const c = this.#core;
		if (this.#queue || !c || !this.#renew) return;
		if (!this.#lost && c.gl.isContextLost()) this.#loseContext();
		if (!this.#lost) return;
		const dv = new DataView(req.cmd.buffer, req.cmd.byteOffset, req.cmd.byteLength);
		if (dv.byteLength < HDR || dv.getUint32(0, true) !== GPU_CMD.CTX_CREATE || this.#staleContexts.has(dv.getUint32(16, true))) return;
		if (performance.now() - this.#renewFailedAt < RENEW_RETRY_MS) return;
		this.#queue = [];
		this.#log("[gl] virtio-gpu: a new GL context after the WebGL2 context was lost: making a new renderer");
		let p: Promise<GpuRendererCore>;
		try {
			p = this.#renew();
		} catch (e) {
			p = Promise.reject(e);
		}
		p.then((c2) => this.#renewed(c2), (e: unknown) => this.#renewFailed(e));
	}

	/** The new renderer is up: make the idle contexts again, and run what queued. */
	#renewed(c: GpuRendererCore): void {
		if (c === this.#core || c.gl.isContextLost()) return this.#renewFailed(new Error("the new WebGL2 context is lost too"));
		for (const { id, version, data } of this.#capsets) {
			const cs = c.gpu.capset(id);
			if (!cs || cs.version !== version || cs.data.length !== data.length) return this.#renewFailed(new Error(`the new renderer's capset ${id} differs in version or size from the one the guest has`));
			if (cs.data.some((b, i) => b !== data[i]))
				this.#log(`[gl] virtio-gpu: the new WebGL2 context's capset ${id} differs from the one the guest's kernel cached (another GPU?): programs may use features it lacks`);
		}
		this.#attach(c);
		this.#lost = false;
		this.stats.contextLost = false;
		this.stats.renewals++;
		// A fresh start (the loss is in `losses`); a stale program's next command says so again.
		this.stats.lastError = "";
		this.#floor = 0;
		this.#hold = 0;
		for (const ctx of this.#idle) if (!c.gpu.command(hdr(GPU_CMD.CTX_CREATE, ctx))) this.#contexts.add(ctx);
		this.#idle.clear();
		this.#log(`[gl] virtio-gpu: a new renderer is up after the loss (${this.stats.renewals} so far); ${this.#staleContexts.size} stale contexts and ${this.#staleResources.size} stale resources remain until their programs end`);
		this.#flushQueue();
	}

	/** No new renderer: what queued is answered as while lost (the new context too: stale). */
	#renewFailed(e: unknown): void {
		this.#renewFailedAt = performance.now();
		const why = (e as Error)?.message ?? String(e);
		this.stats.lastError = `the WebGL2 context was lost, and no new renderer could be made: ${why}`;
		this.#log(`[gl] virtio-gpu: no new renderer after the loss: ${why}; the next GL program tries again`);
		this.#flushQueue();
	}

	#flushQueue(): void {
		const q = this.#queue ?? [];
		this.#queue = null;
		for (const { req, done } of q) {
			const r = this.#run(req);
			done?.(r);
		}
	}

	#done(seq: number): boolean {
		if (this.#lost) return true;
		return ((this.#core!.gpu.fencesDone() - seq) | 0) >= 0 || ((this.#floor - seq) | 0) >= 0;
	}

	/** Polls from later tasks (WebGL fences signal between tasks): messages first, then 1 ms timeouts. */
	#later(): void {
		if (this.#rounds++ < 16) {
			if (!this.#wake) {
				const ch = new MessageChannel();
				ch.port1.onmessage = () => this.#poll();
				this.#wake = ch.port2;
			}
			this.#wake.postMessage(0);
		} else setTimeout(() => this.#poll(), 1);
	}

	#poll(): void {
		while (this.#waits.length && this.#done(this.#waits[0]!.need)) {
			const w = this.#waits.shift()!;
			this.stats.parkedMs += performance.now() - w.since;
			w.resolve();
		}
		this.#polling = this.#waits.length > 0;
		if (this.#polling) this.#later();
	}

	#setScanout(s: Omit<GpuScanout, "seq"> | null): void {
		const was = this.#scanout;
		if (!s) {
			if (!was) return;
			this.#scanout = null;
			this.#bitmap?.close();
			this.#bitmap = null;
			this.#drawn = -1;
		} else {
			if (was && was.resource === s.resource && was.x === s.x && was.y === s.y && was.width === s.width && was.height === s.height) return;
			this.#scanout = { ...s, seq: was?.seq ?? 0 };
			// The picture of the new scanout: the next flush brings it.
		}
		try { this.onFrame?.(); } catch {}
	}

	/**
	 * Blit the scanout into the drawing buffer, opaque (kw_vgpu_present: the
	 * drawing buffer has alpha for image()), and take it as an ImageBitmap.
	 */
	#present(): void {
		const s = this.#scanout!, c = this.#core!;
		if (this.#lost) return;
		const canvas = c.gl.canvas as OffscreenCanvas;
		if (canvas.width !== s.width || canvas.height !== s.height) {
			canvas.width = s.width;
			canvas.height = s.height;
		}
		if (c.gpu.present(s.resource, s.x, s.y, s.width, s.height) < 0) {
			this.#log(`[gl] virtio-gpu: cannot present resource ${s.resource}`);
			return;
		}
		// The next frame's fenced commands wait for this one (not strict).
		this.#hold = c.gpu.fence();
		this.#bitmap?.close();
		this.#bitmap = typeof canvas.transferToImageBitmap === "function" ? canvas.transferToImageBitmap() : null;
		s.seq++;
		this.stats.presents++;
		try { this.onFrame?.(); } catch {}
	}
}

/** The device side's link to a GpuRenderer on the same thread (inline mode). */
export function inlineGpuLink(r: GpuRenderer): GpuLink {
	return {
		init: r.init,
		start: () => r.start(),
		call: (req) => r.call(req),
		post: (req) => r.post(req),
		reset: () => r.reset(),
		buffer: (n) => r.buffer(n),
	};
}
