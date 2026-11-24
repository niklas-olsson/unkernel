// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Guest Vulkan without a browser (vk/PROTOCOL.md, .agents/vk.md): VkHost
// (js/core/vk.ts) on a fake vsock with a fake renderer module and device:
// nothing loads before the first connection, each connection gets its own
// renderer connection, bytes go both ways, a close reaches the renderer; and
// the vsock ports the host listens on do not collide; the SPIR-V translator (js/core/vk-shader.ts) on test/vk/guest/double.comp
// when $KW_BUILD/vk/kwvk-naga.wasm exists (vk/build.sh naga).
//
//   node --test test/vk.test.ts
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadVkShader } from "../js/core/vk-shader.ts";
import { prepareVk, startVk, VK_PORT, type VkGpuDevice, type VkModules } from "../js/core/vk.ts";
import type { Vsock, VsockConnection } from "../js/core/vsock.ts";
import { P9_PORT } from "../js/core/9p.ts";
import { CMD_PORT } from "../js/core/commands.ts";
import { GL_PORT } from "../js/core/gl.ts";
import { TTY_PORT } from "../js/core/tty.ts";
import { WASI_EXEC_PORT } from "../js/core/wasi-exec.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const build = process.env.KW_BUILD ? resolve(process.env.KW_BUILD) : join(root, "vendor/build");

/** A guest stream as the host sees it: `push` is what the guest sends, `sent` what the host wrote. */
function fakeConn() {
	let ctl!: ReadableStreamDefaultController<Uint8Array>;
	const sent: Uint8Array[] = [];
	let resetCalled = false;
	const conn = {
		localPort: VK_PORT,
		remotePort: 50000,
		readable: new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) }),
		writable: new WritableStream<Uint8Array | string>({ write: (b) => void sent.push(typeof b === "string" ? new TextEncoder().encode(b) : b) }),
		close() {},
		reset: () => void (resetCalled = true),
		closed: new Promise<"closed" | "reset">(() => {}),
	};
	return { conn: conn as unknown as VsockConnection, push: (b: Uint8Array) => ctl.enqueue(b), end: () => ctl.close(), sent, wasReset: () => resetCalled };
}

test("VkHost: lazy load, one renderer connection per stream, bytes both ways", async () => {
	let onConn: ((c: VsockConnection) => void) | undefined;
	let port = 0;
	const vsock = { listen: (p: number, h: (c: VsockConnection) => void) => ((port = p), (onConn = h), { close() {} }) } as unknown as Vsock;
	let loads = 0;
	const fed: string[] = [];
	let closes = 0;
	class FakeRenderer {
		opts: { device: unknown; shaders: unknown };
		constructor(opts: { device: unknown; shaders: unknown }) {
			this.opts = opts;
		}
		connect(send: (b: Uint8Array) => void) {
			return {
				feed: (b: Uint8Array) => {
					fed.push(new TextDecoder().decode(b));
					send(new TextEncoder().encode(`re:${new TextDecoder().decode(b)}`));
				},
				close: () => void closes++,
			};
		}
	}
	const modules: VkModules = { VkRenderer: FakeRenderer, loadVkShader: async () => ({ translate() {} }) };
	const device = { lost: new Promise(() => {}), features: [] } as unknown as VkGpuDevice;
	const logs: string[] = [];
	const prep = prepareVk({ device }, true, { shaderWasm: new URL("file:///none.wasm"), load: async () => (loads++, modules) }, (m) => logs.push(m));
	assert.ok(prep, logs.join("\n"));
	const host = startVk(prep, vsock, (m) => logs.push(m))!;
	assert.equal(port, VK_PORT);
	assert.match(await host.ready, new RegExp(`vsock port ${VK_PORT}`));
	assert.equal(host.status.state, "idle");
	assert.equal(loads, 0, "nothing loads before the first connection");

	const a = fakeConn(), b = fakeConn();
	onConn!(a.conn);
	onConn!(b.conn);
	a.push(new TextEncoder().encode("hello-a"));
	b.push(new TextEncoder().encode("hello-b"));
	assert.equal(await host.loaded, "WebGPU (vk.device)");
	for (let i = 0; i < 50 && fed.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
	assert.equal(loads, 1, "one load for both connections");
	assert.deepEqual(fed.sort(), ["hello-a", "hello-b"]);
	assert.equal(new TextDecoder().decode(a.sent[0]), "re:hello-a");
	assert.equal(new TextDecoder().decode(b.sent[0]), "re:hello-b");
	assert.equal(host.stats.connections, 2);
	a.end();
	for (let i = 0; i < 50 && closes < 1; i++) await new Promise((r) => setTimeout(r, 10));
	assert.equal(closes, 1);
	assert.equal(host.stats.connections, 1);
	assert.equal(host.stats.opened, 2);
	assert.equal(host.status.state, "ready");
	host.shutdown();
	assert.ok(b.wasReset(), "shutdown resets the open connections");
});

test("VkHost: a stream the renderer ends is closed after its last frame (the reason) is written", async () => {
	let onConn: ((c: VsockConnection) => void) | undefined;
	const vsock = { listen: (_p: number, h: (c: VsockConnection) => void) => ((onConn = h), { close() {} }) } as unknown as Vsock;
	class FakeRenderer {
		connect(send: (b: Uint8Array) => void, close?: () => void) {
			return {
				// a lost device: the {"lost"} frame, then the close, at once
				feed: () => {
					send(new TextEncoder().encode('{"r":0,"lost":"why"}'));
					close?.();
				},
				close() {},
			};
		}
	}
	const modules: VkModules = { VkRenderer: FakeRenderer, loadVkShader: async () => ({ translate() {} }) };
	const device = { lost: new Promise(() => {}), features: [] } as unknown as VkGpuDevice;
	const prep = prepareVk({ device }, true, { shaderWasm: new URL("file:///none.wasm"), load: async () => modules }, () => {});
	const host = startVk(prep, vsock, () => {})!;
	const a = fakeConn();
	const order: string[] = [];
	// writes complete a tick late, as the vsock's do once the guest gives credit
	(a.conn as unknown as { writable: WritableStream }).writable = new WritableStream({ write: () => new Promise((r) => setTimeout(() => (order.push("written"), r(undefined)), 5)) });
	(a.conn as unknown as { close(): void }).close = () => void order.push("closed");
	onConn!(a.conn);
	a.push(new Uint8Array([1]));
	for (let i = 0; i < 50 && !order.includes("closed"); i++) await new Promise((r) => setTimeout(r, 10));
	assert.deepEqual(order, ["written", "closed"]);
	host.shutdown();
});

test("VkHost: a lost device cuts its programs off, the next one gets a new device and renderer", async () => {
	let onConn: ((c: VsockConnection) => void) | undefined;
	const vsock = { listen: (_p: number, h: (c: VsockConnection) => void) => ((onConn = h), { close() {} }) } as unknown as Vsock;
	const renderers: { onLost: (i: object) => void; closers: (() => void)[] }[] = [];
	class FakeRenderer {
		onLost: (i: object) => void;
		closers: (() => void)[] = [];
		stats = { presents: 0 };
		constructor(opts: { onLost: (i: object) => void }) {
			this.onLost = opts.onLost;
			renderers.push(this);
		}
		connect(_send: (b: Uint8Array) => void, close?: () => void) {
			this.closers.push(close!);
			return { feed: () => void this.stats.presents++, close() {} };
		}
	}
	let devices = 0;
	const adapter = { features: [], limits: { maxBindGroups: 4 }, info: { vendor: "fake" },
		requestDevice: async () => (devices++, { lost: new Promise(() => {}), features: [] }) };
	const nav = globalThis.navigator as unknown as Record<string, unknown>;
	Object.defineProperty(nav, "gpu", { value: { requestAdapter: async () => adapter }, configurable: true });
	try {
		const modules: VkModules = { VkRenderer: FakeRenderer, loadVkShader: async () => ({}) };
		const logs: string[] = [];
		const host = startVk(prepareVk(true, true, { shaderWasm: new URL("file:///x"), load: async () => modules }, (m) => logs.push(m)), vsock, (m) => logs.push(m))!;
		const a = fakeConn();
		let closedA = false;
		(a.conn as unknown as { close(): void }).close = () => void (closedA = true);
		onConn!(a.conn);
		a.push(new Uint8Array([1]));
		await host.loaded;
		for (let i = 0; i < 50 && !renderers[0]?.closers.length; i++) await new Promise((r) => setTimeout(r, 10));
		assert.equal(host.stats.renderer?.presents, 1, "the renderer's counters are in vm.vk.stats");
		// the renderer fails and closes its streams, then reports the loss
		renderers[0]!.closers[0]!();
		assert.ok(closedA, "a stream the renderer ended is closed towards the guest");
		renderers[0]!.onLost({ reason: "destroyed", message: "test" });
		assert.equal(host.status.state, "lost");
		assert.equal(host.stats.losses, 1);
		assert.equal(host.stats.renderer, null);
		assert.ok(logs.some((l) => /device was lost/.test(l)));
		const b = fakeConn();
		onConn!(b.conn);
		for (let i = 0; i < 50 && renderers.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
		assert.equal(renderers.length, 2, "a new renderer for the next program");
		assert.equal(devices, 2, "on a new device");
		assert.equal(host.status.state, "ready");
		host.shutdown();
	} finally {
		delete nav.gpu;
	}
});

test("prepareVk: ignored with a log line without WebGPU or a renderer", () => {
	const logs: string[] = [];
	assert.equal(prepareVk(true, true, { shaderWasm: new URL("file:///x"), load: async () => ({}) as VkModules }, (m) => logs.push(m)), undefined);
	assert.match(logs.pop()!, /no WebGPU/);
	assert.equal(prepareVk({ device: {} as VkGpuDevice }, true, undefined, (m) => logs.push(m)), undefined);
	assert.match(logs.pop()!, /bundles no Vulkan renderer/);
	assert.equal(prepareVk(true, false, undefined, (m) => logs.push(m)), undefined);
	assert.match(logs.pop()!, /needs the vsock device/);
});

test("the host's vsock ports are distinct", () => {
	// the page's Wayland relay (web/src/wayland.ts) is read from its source: it imports browser-only modules
	const wayland = Number(/export const WAYLAND_PORT = (\d+)/.exec(readFileSync(join(root, "web/src/wayland.ts"), "utf8"))?.[1]);
	const ports: Record<string, number> = { P9_PORT, GL_PORT, CMD_PORT, WASI_EXEC_PORT, TTY_PORT, VK_PORT, WAYLAND_PORT: wayland };
	assert.ok(wayland > 0, "WAYLAND_PORT in web/src/wayland.ts");
	const seen = new Map<number, string>();
	for (const [name, port] of Object.entries(ports)) {
		assert.ok(!seen.has(port), `${name} and ${seen.get(port)} are both vsock port ${port}`);
		seen.set(port, name);
	}
});

const wasm = join(build, "vk/kwvk-naga.wasm");
test("the translator: a compute shader to WGSL", { skip: !existsSync(wasm) && `no ${wasm} (vk/build.sh naga)` }, async () => {
	const words = [...readFileSync(join(root, "test/vk/guest/double_comp.h"), "utf8").matchAll(/0x[0-9a-f]{8}/gi)].map((m) => Number(m[0]));
	assert.equal(words[0], 0x07230203, "SPIR-V magic");
	const t = await loadVkShader(pathToFileURL(wasm));
	const r = t.translate(new Uint8Array(new Uint32Array(words).buffer), { stage: "compute", entryPoint: "main" });
	assert.match(r.wgsl, /@compute/);
	assert.match(r.wgsl, /@workgroup_size\(64/);
	const bnd = r.bindings.find((x) => x.set === 0 && x.binding === 0);
	assert.ok(bnd, JSON.stringify(r.bindings));
	assert.equal(bnd.kind, "storage");
	assert.throws(() => t.translate(new Uint8Array(16), { stage: "compute", entryPoint: "main" }));
});
