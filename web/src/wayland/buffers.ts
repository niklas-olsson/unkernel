// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The compositor's access to the apps' pixels (wayland.ts), and what it
// cost (stats, KW.wayland.stats()):
// - Buffers (handleSource()): opening a buffer is a round trip (openId()).
//   Wherever this thread sees the kernel's memory (ShmFile.inPlace: inline,
//   and worker mode on an SMP kernel with the shared transport) wland takes
//   the export's page runs in place (view: ShmFile.views(), no copy of
//   ours; it presents a single run as is and gathers the damaged spans of
//   several); else it reads every damaged span of a commit in one call
//   (readv), each span a round trip to the kernel's worker (ShmFile.read():
//   with the shared transport served at the kernel's next clock read, about
//   0.6 ms, without it at the kernel's next yield), all posted together.
//   A token stays bound to its export: once the guest releases it, reads
//   fail and the commit is skipped; nothing ever resolves an id again.
// - GPU apps (gpuSource()): with guest GL's virtio-gpu device and its
//   renderer on this thread (vm.gl.gpu) the relay runs with --dmabuf
//   virtgpu (the guest's wland script, where /dev/dri/renderD128 exists)
//   and names each GL client's buffer by its virtio-gpu resource; wland
//   asks us for the resource's picture at each commit, which the renderer
//   blits into an ImageBitmap (vm.gl.gpu.image(): no readback, the pixels
//   never leave the WebGL2 context's GPU memory until the 2D canvas draws
//   them). Without vm.gl.gpu (GL off, ?gpu=0, no WebGL2) or with ?wlgpu=0
//   wland offers no linux-dmabuf, and GL apps render in software (llvmpipe)
//   into wl_shm buffers like any other app.
// - Vulkan apps (gpuSource()'s resolveExternal): with guest Vulkan (vm.vk)
//   and a relay with --external-buffers (the guest's wland script, where
//   the relay has them) wland offers wland_external_buffer_manager_v1, and
//   the kw ICD names each swapchain image by an id (its connection's token
//   and the image's export id) instead of sending its pixels; wland asks us
//   for the picture at each commit, which the Vulkan renderer copies from
//   the image's GPUTexture into an ImageBitmap (vm.vk.externalImage(): no
//   readback, synchronous). Without vm.vk (?vk=0, no WebGPU) or a relay
//   without the flag the global is absent and the ICD reads frames back
//   into wl_shm buffers.
import type { KernelHandle, ShmFile } from "../sdk.ts";
import type { BufferHandle, ExternalRef, GpuRef, GpuSource, HandleRead, HandleSource } from "wland/engine";

/**
 * What the compositor did with the guest's buffers (KW.wayland.stats()):
 * handles opened, reads (a view, a readv or a read: one per commit, or one
 * per span with wland 0.1.0), how many of them in place (synchronous; views
 * among them) and the bytes they covered, the time reads took (a round trip
 * each unless in place), commits that latched new pixels (shm and GPU
 * alike); GPU commits (gpuCommits), the images the renderer made for them
 * (gpuImages; the rest were null: unknown resource, an offset, no
 * renderer), how many waited for the renderer to load (gpuWaits), the
 * time image() took (total, longest) and the time from resolve() to
 * release() of each image (gpuDrawMs: image() and wland drawing it into the
 * window's canvas, where a GPU-backed image's work is waited for). Vulkan
 * apps' external buffers alike: extCommits, extImages (the rest were null:
 * an id no running program made, a lost device), extMs, extMaxMs (the time
 * vm.vk.externalImage() took), extDrawMs.
 */
export const stats = {
	opens: 0, reads: 0, inPlace: 0, views: 0, bytes: 0, readMs: 0, readMaxMs: 0, commits: 0,
	gpuCommits: 0, gpuImages: 0, gpuWaits: 0, gpuMs: 0, gpuMaxMs: 0, gpuDrawMs: 0,
	extCommits: 0, extImages: 0, extMs: 0, extMaxMs: 0, extDrawMs: 0,
};
export type Stats = typeof stats;
const timed = (t: number, total: "readMs" | "gpuMs" | "extMs", max: "readMaxMs" | "gpuMaxMs" | "extMaxMs") => {
	const ms = performance.now() - t;
	stats[total] += ms;
	if (ms > stats[max]) stats[max] = ms;
};
/** The last GPU buffer a commit named (KW.wayland.gpuLast(), for the tests). */
let gpuLast: GpuRef | null = null;
export const getGpuLast = (): GpuRef | null => gpuLast;
/** DRM fourccs of the formats without alpha that the relay offers: XR24 (XRGB8888), XB24 (XBGR8888). */
const XRGB8888 = 0x34325258, XBGR8888 = 0x34324258;

function checkHandle(h: BufferHandle): asserts h is Extract<BufferHandle, { kind: "kwshm" }> {
	if (h.kind !== "kwshm") throw new Error(`a ${h.kind} buffer handle: the relay must run with --buffers kwshm`);
}

/** The compositor's access to the guest's buffers: vm.shm (see the top). */
export function handleSource(vm: KernelHandle): HandleSource<ShmFile> {
	const shm = vm.shm!;
	const open = async (h: BufferHandle) => {
		checkHandle(h);
		const f = await shm.openId(h.id);
		if (f.size !== h.size) {
			void f.close();
			throw new Error(`kwshm export ${h.id}: ${f.size} bytes, the relay says ${h.size}`);
		}
		stats.opens++;
		return f;
	};
	const close = (f: ShmFile) => { void f.close(); }; // a guest export: ends this handle only
	const counted = (t: number, n: number, inPlace: boolean) => {
		stats.reads++;
		if (inPlace) stats.inPlace++;
		stats.bytes += n;
		timed(t, "readMs", "readMaxMs");
	};
	/** EAGAIN from readSync()/views(): the page list is being replaced or withdrawn; read() says which. */
	const again = (e: unknown) => (e as { code?: string }).code === "EAGAIN";
	/** In place, no copy: the export's page runs (null declines: wland then reads). */
	const view = (f: ShmFile, offset: number, length: number): Uint8Array[] | null => {
		if (!f.inPlace) return null;
		const t = performance.now();
		try {
			const v = f.views(offset, length);
			stats.views++;
			counted(t, length, true);
			return v;
		} catch (e) {
			if (again(e)) return null;
			throw e;
		}
	};
	/** Every damaged span of a commit: copies in place, else one read() each, posted together. */
	const readv = (f: ShmFile, reads: readonly HandleRead[]): void | Promise<void> => {
		const t = performance.now();
		let n = 0;
		for (const r of reads) n += r.dst.length;
		if (f.inPlace) {
			try {
				for (const r of reads) f.readSync(r.offset, r.dst.length, r.dst);
				counted(t, n, true);
				return;
			} catch (e) {
				if (!again(e)) throw e;
			}
		}
		return Promise.all(reads.map(async (r) => { r.dst.set(await f.read(r.offset, r.dst.length)); }))
			.then(() => counted(t, n, false));
	};
	/** One span (what wland 0.1.0 calls; a later one uses view, else readv). */
	const read = (f: ShmFile, offset: number, dst: Uint8Array): void | Promise<void> => readv(f, [{ offset, dst }]);
	return { open, close, view, readv, read };
}

/**
 * GPU apps' buffers by resource (see the top): the resource's picture now,
 * as an ImageBitmap of the renderer's (a promise only while the renderer
 * loads), which wland draws during the commit and then closes. Row 0 at the
 * top (y_invert flips), alpha premultiplied as the client rendered it, X
 * formats opaque. A plane offset is not supported (Mesa's virgl gives 0):
 * null, so the window keeps its last content. Vulkan apps' external buffers
 * (resolveExternal, where vm.vk is): the swapchain image's picture, always
 * synchronous (a promise would stall every window of the link).
 * Each resolver is there only with its source: their presence is what wland
 * offers apps (linux-dmabuf, wland_external_buffer_manager_v1).
 */
export function gpuSource(gpu: NonNullable<KernelHandle["gl"]>["gpu"] | undefined, vk: KernelHandle["vk"] | undefined, log: (line: string) => void): GpuSource<ImageBitmap> | undefined {
	if (!gpu && !vk) return undefined;
	let offsetSaid = false;
	const started = new WeakMap<ImageBitmap, [number, "gpuDrawMs" | "extDrawMs"]>();
	const done = (t: number, img: ImageBitmap | null) => {
		if (img) {
			stats.gpuImages++;
			started.set(img, [t, "gpuDrawMs"]);
		}
		timed(t, "gpuMs", "gpuMaxMs");
		return img;
	};
	const resolveExternal = vk && ((ref: ExternalRef) => {
		stats.extCommits++;
		const t = performance.now();
		const img = vk.externalImage(ref);
		if (img) {
			stats.extImages++;
			started.set(img, [t, "extDrawMs"]);
		}
		timed(t, "extMs", "extMaxMs");
		return img;
	});
	return {
		...(resolveExternal ? { resolveExternal } : {}),
		release(img) {
			const s = started.get(img);
			if (s) stats[s[1]] += performance.now() - s[0];
			img.close();
		},
		...(gpu ? { resolve: (ref: GpuRef) => resolveGpu(gpu, ref) } : {}),
	};
	function resolveGpu(gpu: NonNullable<NonNullable<KernelHandle["gl"]>["gpu"]>, ref: GpuRef) {
		stats.gpuCommits++;
		gpuLast = ref;
		if (ref.offset !== 0) {
			if (!offsetSaid) log(`[host] wayland: a GPU buffer at offset ${ref.offset} of resource ${ref.resource}: not supported, not shown`);
			offsetSaid = true;
			return null;
		}
		const t = performance.now();
		const r = gpu.image(ref.resource, {
			width: ref.width,
			height: ref.height,
			opaque: ref.format === XRGB8888 || ref.format === XBGR8888,
			flipY: (ref.flags & 1) !== 0,
		});
		if (!(r instanceof Promise)) return done(t, r);
		stats.gpuWaits++;
		return r.then((img) => done(t, img));
	}
}
