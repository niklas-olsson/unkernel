// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Guest Vulkan (vk/PROTOCOL.md): the host side of createKernel({ vk }).
//
//   guest app -> Vulkan loader -> libvulkan_kw.so (the guest's ICD)
//          -> AF_VSOCK, host CID 2, port VK_PORT (1018), one stream per VkInstance
//          -> VkHost (this file, on the thread that owns the VM, in both modes)
//          -> VkRenderer (vk-host.ts) on this thread's WebGPU device, with
//             the SPIR-V to WGSL translator (vk-shader.ts, kwvk-naga.wasm)
//
// Nothing loads before the guest's first Vulkan instance: the first
// connection requests the adapter and the device (the adapter's features
// and its maximum limits), imports the renderer and loads the translator's
// wasm (the web entry's kwvk-naga.wasm, or `vk.shaderWasm`). Only the web
// entry reaches the renderer's modules (Platform.vk, js/web.ts: dynamic
// imports, so they are chunks of their own), never a kernel worker's
// bundle. Where there is no `navigator.gpu` (Node, or a browser without
// WebGPU) `vk` is ignored with a log line, unless `vk.device` gives a
// device and the entry has the renderer. Renderer
// state is not in snapshots: a restore drops the connections (the guest's
// Vulkan programs see their link reset).

import type { Vsock, VsockConnection, VsockListener } from "./vsock.ts";

/** The vsock port the host's renderer listens on (the guest's ICD connects to CID 2 there). */
export const VK_PORT = 1018;

/** The parts of WebGPU this file uses (the SDK's TypeScript has no WebGPU types). */
export interface VkGpuAdapter {
	readonly features: Iterable<string> & { has(name: string): boolean };
	readonly limits: object;
	readonly info?: { vendor?: string; architecture?: string; device?: string; description?: string };
	requestDevice(desc?: { requiredFeatures?: string[]; requiredLimits?: Record<string, number> }): Promise<VkGpuDevice>;
}
export interface VkGpuDevice {
	readonly lost: Promise<{ reason?: string; message?: string }>;
	readonly features: Iterable<string>;
	destroy(): void;
}

export interface VkOptions {
	/** The translator's wasm (kwvk-naga.wasm): a URL or its bytes. Default: the one next to the web entry. */
	shaderWasm?: URL | string | BufferSource;
	/** A WebGPU device to render on, instead of one requested from navigator.gpu at the first connection. */
	device?: VkGpuDevice;
	/** With `device`: its adapter (for the hello reply's description). */
	adapter?: VkGpuAdapter;
	/** The adapter's power preference when the host requests one. */
	powerPreference?: "low-power" | "high-performance";
	/** Log every renderer line as "[vk] ..." (default true). */
	log?: boolean;
}
export type VkOption = boolean | VkOptions;

/** What vm.vk.status says about the renderer. */
export interface VkRendererStatus {
	/**
	 * idle: no guest Vulkan use yet; loading; ready; lost (the WebGPU device
	 * was lost: the next program's connection makes a new device and
	 * renderer); failed (`error`).
	 */
	state: "idle" | "loading" | "ready" | "lost" | "failed";
	/** When the load started (ms on performance.now()), or null. */
	startedAt: number | null;
	/** How long the load took, or null. */
	loadMs: number | null;
	error: string | null;
	/** The adapter ("vendor architecture description"), once there is one. */
	adapter: string | null;
}

export interface VkStats {
	/** Guest streams (VkInstances) being served, and served in all. */
	connections: number;
	opened: number;
	/** Bytes from and to the guest. */
	bytesIn: number;
	bytesOut: number;
	/** WebGPU devices lost (each time the open programs were cut off and a new renderer made on demand). */
	losses: number;
	/**
	 * The current renderer's counters (vk-host.ts VkStats: presents, draws,
	 * submits, bytesWritten, bytesRead, translations, errors, ...), or null
	 * before the first program and after a loss; they start again with each
	 * new renderer.
	 */
	renderer: Record<string, number> | null;
}

/** The renderer's shape (vk-host.ts, vk/PROTOCOL.md "Host API"). */
interface VkConnectionLike {
	feed(bytes: Uint8Array): void;
	close(): void;
}
interface VkRendererLike {
	/** `close`: the renderer ended the stream itself (device loss, a bad frame) */
	connect(send: (bytes: Uint8Array) => void, close?: () => void): VkConnectionLike;
	readonly stats?: object;
	/** vk-host.ts VkRenderer.external(): an external buffer's picture, or null */
	external?(ref: VkExternalRef): ImageBitmap | null;
}

/**
 * An external buffer the guest's ICD made for a swapchain image (wland's
 * ExternalRef: wland_external_buffer_manager_v1.create_buffer's arguments,
 * the id as (id_hi << 32) | id_lo). vk/PROTOCOL.md, Amendments, "External present".
 */
export interface VkExternalRef {
	id: bigint;
	width: number;
	height: number;
	/** DRM fourcc: ARGB8888 / XRGB8888 (the ICD's B8G8R8A8 swapchains), ABGR8888 / XBGR8888 */
	format: number;
	/** 1 y_invert (the ICD never sets it) */
	flags: number;
}

/** The renderer's modules (vk-host.ts, vk-shader.ts), as the entry that bundles them loads them. */
export interface VkModules {
	VkRenderer: unknown;
	loadVkShader: (wasm: never) => Promise<unknown>;
}

/** @internal An entry's Vulkan renderer (Platform.vk): the translator's wasm and the modules, imported on first use. */
export interface VkPlatform {
	shaderWasm: URL;
	load(): Promise<VkModules>;
}

/** @internal What createKernel({ vk }) prepared before the boot. */
export interface VkPrep {
	opts: VkOptions;
	shaderWasm: URL | string | BufferSource;
	load: () => Promise<VkModules>;
}

/**
 * @internal createKernel's `vk` before the boot (both modes, on the thread
 * that owns the VM): the options, or undefined with a log line where
 * WebGPU or the translator cannot be had.
 */
export function prepareVk(opt: VkOption | undefined, vsock: boolean, platform: VkPlatform | undefined, log: (msg: string) => void): VkPrep | undefined {
	if (!opt) return undefined;
	const opts: VkOptions = opt === true ? {} : opt;
	if (!vsock) {
		log("[host] vk: needs the vsock device (vsock: false was given, or vsock.raw); the guest gets no Vulkan renderer");
		return undefined;
	}
	const gpu = (globalThis.navigator as { gpu?: unknown } | undefined)?.gpu;
	if (!opts.device && !gpu) {
		log("[host] vk: no WebGPU on this thread (no navigator.gpu), so it is ignored");
		return undefined;
	}
	if (!platform) {
		log("[host] vk: this entry bundles no Vulkan renderer (the web entry does), so it is ignored");
		return undefined;
	}
	return { opts, shaderWasm: opts.shaderWasm ?? platform.shaderWasm, load: () => platform.load() };
}

/**
 * @internal Whether a WebGPU OffscreenCanvas can turn a texture into an
 * ImageBitmap here (external present, VkRenderer.external()), tried on a
 * device of its own: where that path is broken (headless Chrome without a GL
 * backend for canvases: no --use-angle) Chrome destroys the device, which on
 * the renderer's would cut off every Vulkan program. null when it works (or
 * there is no OffscreenCanvas, where the renderer offers none), else why
 * not; at most 2 s, in parallel with the renderer's own device request.
 */
export async function probeCanvas(gpu: { requestAdapter(o?: object): Promise<VkGpuAdapter | null> }): Promise<string | null> {
	const OC = (globalThis as { OffscreenCanvas?: new (w: number, h: number) => any }).OffscreenCanvas;
	if (!OC) return null; // the renderer offers no external present without one anyway
	let dev: any;
	try {
		const adapter = await gpu.requestAdapter();
		if (!adapter) return "no adapter for the probe";
		dev = await adapter.requestDevice();
		let lost: string | null = null;
		dev.lost.then((i: { reason?: string; message?: string }) => (lost = `${i?.reason ?? "?"}: ${i?.message ?? ""}`));
		const tex = dev.createTexture({ size: [4, 4], format: "bgra8unorm", usage: 1 | 4 }); // COPY_SRC | TEXTURE_BINDING
		const cv = new OC(4, 4);
		const ctx = cv.getContext("webgpu");
		if (!ctx) return "no WebGPU context for an OffscreenCanvas";
		ctx.configure({ device: dev, format: "bgra8unorm", usage: 2 | 16, alphaMode: "premultiplied" }); // COPY_DST | RENDER_ATTACHMENT
		const e = dev.createCommandEncoder();
		e.copyTextureToTexture({ texture: tex }, { texture: ctx.getCurrentTexture() }, [4, 4, 1]);
		dev.queue.submit([e.finish()]);
		cv.transferToImageBitmap().close();
		const timeout = new Promise((r) => setTimeout(() => r("timeout"), 2000));
		const done = await Promise.race([dev.queue.onSubmittedWorkDone().then(() => "done"), timeout]).catch((err: unknown) => `failed (${(err as Error)?.message ?? err})`);
		await new Promise((r) => setTimeout(r, 20));
		if (lost) return `the WebGPU canvas path destroyed its device (${lost})`;
		return done === "done" ? null : `the WebGPU canvas path ${done}`;
	} catch (err) {
		return `the WebGPU canvas path threw (${(err as Error)?.message ?? err})`;
	} finally {
		try {
			dev?.destroy();
		} catch {}
	}
}

/** @internal createKernel's `vk` once the kernel runs: a VkHost, or undefined. */
export function startVk(prep: VkPrep | undefined, vsock: Vsock | undefined, log: (msg: string) => void): VkHost | undefined {
	if (!prep || !vsock) return undefined;
	return new VkHost(vsock, prep, log);
}

/** The guest's Vulkan renderer: vsock port 1018 served on this thread (vm.vk). */
export class VkHost {
	/** Resolves once the host listens (the renderer itself loads on the guest's first Vulkan instance). */
	readonly ready: Promise<string>;
	/** Settles once the renderer is loaded (the adapter's description) or failed; never while the guest uses no Vulkan. */
	readonly loaded: Promise<string>;
	#prep: VkPrep;
	#log: (msg: string) => void;
	#listener: VsockListener | undefined;
	#conns = new Set<VsockConnection>();
	#renderer: Promise<VkRendererLike> | undefined;
	#current: VkRendererLike | undefined;
	#device: VkGpuDevice | undefined;
	#loadedResolve!: (s: string) => void;
	#loadedReject!: (e: Error) => void;
	#status: VkRendererStatus = { state: "idle", startedAt: null, loadMs: null, error: null, adapter: null };
	#stats: Omit<VkStats, "renderer"> = { connections: 0, opened: 0, bytesIn: 0, bytesOut: 0, losses: 0 };
	#down = false;

	/** @internal Use createKernel({ vk }). */
	constructor(vsock: Vsock, prep: VkPrep, log: (msg: string) => void) {
		this.#prep = prep;
		this.#log = log;
		this.loaded = new Promise<string>((res, rej) => ((this.#loadedResolve = res), (this.#loadedReject = rej)));
		this.loaded.catch(() => {});
		this.#listener = vsock.listen(VK_PORT, (conn) => this.#serve(conn));
		const what = `WebGPU renderer, loaded on the guest's first Vulkan instance, on vsock port ${VK_PORT}`;
		log(`[host] vk: ${what}`);
		this.ready = Promise.resolve(what);
	}

	/** Where the renderer is: idle (no guest Vulkan yet), loading, ready, lost, failed. */
	get status(): VkRendererStatus {
		return { ...this.#status };
	}

	/** Streams served, bytes carried, device losses, and the current renderer's counters. */
	get stats(): VkStats {
		const r = this.#current?.stats;
		return { ...this.#stats, renderer: r ? { ...(r as Record<string, number>) } : null };
	}

	/** The WebGPU device the renderer runs on, once there is one (undefined before the first program and after a loss). */
	get device(): VkGpuDevice | undefined {
		return this.#current ? this.#device : undefined;
	}

	/**
	 * A page compositor's resolver for the ICD's external buffers (wland's
	 * `gpu.resolveExternal`: give it the ref as wland does): the swapchain
	 * image's current picture as an ImageBitmap of the caller's (close() it),
	 * copied GPU to GPU on the renderer's device (no readback), row 0 at the
	 * top, premultiplied alpha or opaque as the format says. Synchronous, on
	 * this thread (the renderer's, in both modes). null keeps the surface's
	 * last content: no renderer (not loaded, or lost), an id no live program
	 * made (a wrong token, a destroyed image, an image not yet presented) or
	 * a size, format or flags that are not the image's. It never starts the
	 * load. The ICD uses external buffers only where wland offers its
	 * wland_external_buffer_manager_v1, i.e. where the page passes this as
	 * resolveExternal.
	 */
	externalImage(ref: VkExternalRef): ImageBitmap | null {
		const r = this.#current;
		if (!r?.external) return null;
		try {
			return r.external(ref);
		} catch (e) {
			this.#log(`[host] vk: externalImage: ${(e as Error)?.message ?? e}`);
			return null;
		}
	}

	/** Load the renderer now, as the guest's first Vulkan instance would; resolves as `loaded`. */
	load(): Promise<string> {
		this.#load().catch(() => {});
		return this.loaded;
	}

	#load(): Promise<VkRendererLike> {
		if (!this.#renderer) {
			this.#renderer = this.#make();
			this.#renderer.catch(() => {});
		}
		return this.#renderer;
	}

	async #make(): Promise<VkRendererLike> {
		const t0 = performance.now();
		this.#status = { ...this.#status, state: "loading", startedAt: t0 };
		try {
			const { opts } = this.#prep;
			let adapter = opts.adapter, device = opts.device;
			// external present (pictures through a WebGPU OffscreenCanvas) only where that path works (probeCanvas)
			let canvas: Promise<string | null> = Promise.resolve(null);
			if (!device) {
				const gpu = (globalThis.navigator as unknown as { gpu?: { requestAdapter(o?: object): Promise<VkGpuAdapter | null> } }).gpu;
				if (!gpu) throw new Error("no navigator.gpu");
				canvas = probeCanvas(gpu);
				adapter = (await gpu.requestAdapter(opts.powerPreference ? { powerPreference: opts.powerPreference } : undefined)) ?? undefined;
				if (!adapter) throw new Error("navigator.gpu.requestAdapter() gave no adapter");
				// Every feature the adapter has and its maximum limits: the ICD derives Vulkan's from them.
				const requiredLimits: Record<string, number> = {};
				const limits = adapter.limits as Record<string, unknown>;
				for (const k in limits) if (typeof limits[k] === "number") requiredLimits[k] = limits[k] as number;
				device = await adapter.requestDevice({ requiredFeatures: [...adapter.features], requiredLimits });
			}
			const { VkRenderer, loadVkShader } = await this.#prep.load();
			const shaders = await loadVkShader(this.#prep.shaderWasm as never);
			const verbose = opts.log ?? true;
			const fixed = !!opts.device;
			let renderer: VkRendererLike | undefined;
			// The renderer fails and closes its connections when the device is lost, then calls this
			// once: drop it, so that the next program gets a new device and renderer (with vk.device,
			// which cannot be replaced, the state stays failed).
			const onLost = (info: { reason?: string; message?: string } | undefined) => {
				if (this.#down || !renderer || this.#current !== renderer) return;
				this.#stats.losses++;
				this.#current = undefined;
				this.#renderer = fixed ? Promise.reject(new Error("the WebGPU device (vk.device) was lost")) : undefined;
				this.#renderer?.catch(() => {});
				const why = `${info?.reason ?? "?"}: ${info?.message ?? ""}`;
				this.#status = { ...this.#status, state: fixed ? "failed" : "lost", error: `device lost (${why})` };
				this.#log(`[host] vk: the WebGPU device was lost (${why}); its programs were cut off${fixed ? "; vk.device cannot be replaced" : ", the next one gets a new device"}`);
			};
			const broken = await canvas;
			if (broken) this.#log(`[host] vk: no external present (Wayland windows by readback): ${broken}`);
			renderer = new (VkRenderer as unknown as new (o: object) => VkRendererLike)({
				device, adapter, shaders, onLost, ...(broken ? { external: false } : {}),
				log: (line: string) => verbose && this.#log(`[vk] ${line}`),
			});
			this.#current = renderer;
			this.#device = device;
			const info = adapter?.info;
			const name = info ? [info.vendor, info.architecture, info.description || info.device].filter(Boolean).join(" ") || "WebGPU" : "WebGPU (vk.device)";
			const loadMs = performance.now() - t0;
			this.#status = { ...this.#status, state: "ready", loadMs, adapter: name };
			this.#log(`[host] vk: renderer ready on ${name} (${loadMs.toFixed(0)} ms)`);
			this.#loadedResolve(name);
			return renderer;
		} catch (e) {
			const msg = (e as Error)?.message ?? String(e);
			this.#status = { ...this.#status, state: "failed", error: msg, loadMs: performance.now() - t0 };
			this.#log(`[host] vk: no renderer: ${msg}`);
			this.#loadedReject(new Error(msg));
			throw e;
		}
	}

	#serve(conn: VsockConnection): void {
		if (this.#down) {
			conn.reset();
			return;
		}
		this.#conns.add(conn);
		this.#stats.connections++;
		this.#stats.opened++;
		const writer = conn.writable.getWriter();
		const stats = this.#stats;
		let link: VkConnectionLike | undefined;
		let broken = false;
		const fail = (what: string, e: unknown) => {
			if (broken) return;
			broken = true;
			if (!this.#down) this.#log(`[host] vk: ${what}: ${(e as Error)?.message ?? e}`);
			conn.reset();
		};
		// writes not yet taken by the stream: a close waits for them (the
		// renderer's last frame before it ends a stream says why: {"lost"})
		let inflight = 0;
		let drained: (() => void) | undefined;
		const send = (bytes: Uint8Array) => {
			stats.bytesOut += bytes.length;
			inflight++;
			writer
				.write(bytes)
				.catch((e) => fail("a write to the guest failed", e))
				.finally(() => {
					if (--inflight === 0) drained?.();
				});
		};
		const closeAfterWrites = () => {
			if (!inflight) conn.close();
			else drained = () => conn.close();
		};
		const run = async () => {
			const reader = conn.readable.getReader();
			// Bytes that arrive while the renderer loads wait in the stream (vsock credit holds the guest).
			let renderer: VkRendererLike;
			try {
				renderer = await this.#load();
			} catch (e) {
				fail("the guest's Vulkan instance gets no renderer", e);
				return;
			}
			// The renderer ends a stream itself on a device loss or a bad frame: close it towards the guest.
			link = renderer.connect(send, closeAfterWrites);
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				stats.bytesIn += value.length;
				link.feed(value);
			}
		};
		run()
			.catch((e) => fail("the link broke", e))
			.finally(() => {
				try {
					link?.close();
				} catch (e) {
					this.#log(`[host] vk: closing a connection threw: ${(e as Error)?.message ?? e}`);
				}
				if (!broken) writer.close().catch(() => {});
				this.#conns.delete(conn);
				this.#stats.connections--;
			});
	}

	/** @internal The kernel exited. */
	shutdown(): void {
		this.#down = true;
		this.#listener?.close();
		for (const c of this.#conns) c.reset();
	}
}
