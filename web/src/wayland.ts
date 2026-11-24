// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Wayland apps in the guest as windows of the page's desktop: wland
// (https://github.com/pithings/wland), its compositor (wasm) on this
// thread, each toplevel a window of the window manager (wm.ts). The guest
// runs wland's relay (/usr/lib/kw/wlandr, in the Debian image: started at
// boot where the command line has kw.wayland=1, which boot.ts adds with
// kwshm, else by `wland CMD`): apps speak Wayland to it over its unix
// socket, and it connects to the page over vsock port WAYLAND_PORT when the
// first app connects (--link-on-demand; a relay without it dials at once);
// the apps' buffers stay in guest memory, exported through /dev/kwshm, and
// the compositor reads them in place with vm.shm (createKernel({ shm }),
// boot.ts).
// - attachWayland(vm) (boot.ts, once the kernel runs; the kernel needs vsock
//   and kwshm) listens on the port. The first connection loads wland (a
//   chunk of its own, with its wasm: a page that never runs a Wayland app
//   fetches neither) and starts it on #wl-desktop (components/WaylandOutput.tsx);
//   the relay's next connection after a drop (a reload, a resume, the relay
//   killed: it dials again at its next app) goes to the same wland, which
//   starts a fresh compositor. The relay counts a completed connect as the
//   compositor attached, and the SDK's listener completes every connect, so
//   a connection is only taken when wland will serve it: one at a time (a
//   second relay's is reset, so its apps fail at once instead of waiting),
//   none once wland failed to load (the listener closes: dials are refused).
//   A connection gone before wland took it (a dial that timed out while
//   wland loaded) is skipped. The link stays up after the last window
//   closes (wland stays loaded; nothing to free but the compositor's state,
//   and closing would race an app that connects meanwhile). Its result
//   stops it all (at the kernel's exit).
// - wland runs as createWland() sets it up, for an embedder's window
//   manager: each toplevel's element mounted in a WM window, moves and
//   resizes taken by the page's WM (`interactive`), keyboard focus given
//   only by it (autoFocus off), window elements shown and hidden by it
//   (manageDisplay off), and server-side decorations for the apps that ask
//   (the WM's frame: decorations 'server').
// - Drags from the host are the page's (drop.ts): createWland's own bridge is
//   off (dnd: false) and drop.ts waylandDnd() makes one that knows the apps'
//   windows are not in wland's container. Plain text on the clipboard is
//   wland's bridge (on by default); HTML, images and files pasted into an app
//   are wayland/paste.ts; files copied in an app can be saved to the host
//   (wayland/copyout.ts).
// - The parts, in wayland/: buffers.ts (the guest's buffers: kwshm and GPU
//   resources, and their stats), host.ts (the toplevels as WM windows:
//   frames, sizes, tiles, states, focus, moves and resizes, where they are,
//   their names, icons and launcher apps by app id, close), icons.ts (an
//   app's icon from the guest, by its app id), state.ts (the shared state:
//   the container, the current wland and its host, waylandFocused()).
// - The store's Wayland state (store.ts wayland): available (the page listens), attached (the
//   relay is connected: the Dock's #dock-wayland) and windows (wland's list);
//   waylandFocused(): a Wayland window has the WM's focus.
import { waylandDnd } from "./drop.ts";
import { KW } from "./kw.ts";
import { ui$ } from "./store.ts";
import type { KernelHandle, VsockConnection, VsockListener } from "./sdk.ts";
import type { DndBridge, Wland } from "wland/client";
import { getGpuLast, gpuSource, handleSource, stats, type Stats } from "./wayland/buffers.ts";
import { createCopyOut, withholdPaths } from "./wayland/copyout.ts";
import { createHost } from "./wayland/host.ts";
import { attachPaste } from "./wayland/paste.ts";
import { getContainer, getCurrent, getHost, setCurrent, setHost } from "./wayland/state.ts";

export { focusWayland, isWaylandWindow, setWaylandContainer, useWaylandFocused, waylandFocused } from "./wayland/state.ts";

/** The host port wland's relay connects to (wlandr --link vsock:2:1023). */
export const WAYLAND_PORT = 1023;

/** wland's wire-level log (every decoded Wayland message), the last LOG_LINES, for KW.wayland.log(). */
const LOG_LINES = 500;
const wireLog: string[] = [];
let wireAt = 0;
/** The popups mapped now (menus, tooltips), "conn:surface", for KW.wayland.popups(). */
const popups = new Set<string>();

/**
 * Listen for wland's relay and show its apps (see the top). Returns the stop
 * function, or null when the kernel has no vsock or no kwshm.
 */
export function attachWayland(vm: KernelHandle, log: (line: string) => void): (() => void) | null {
	if (!vm.vsock || !vm.shm) return null;
	const listener: VsockListener = vm.vsock.listen(WAYLAND_PORT);
	let stopped = false;
	let mine: Wland | null = null;
	ui$().set((s) => ({ wayland: { ...s.wayland, available: true } }));
	// The connections wland's link takes (see the top): `pending` waits for wland to take it
	// (the first while wland loads), `idle` is wland's link asking for the next one.
	let loading = false;
	let pending: VsockConnection | null = null;
	let idle = null as ((c: VsockConnection | null) => void) | null;
	const gone = new WeakSet<VsockConnection>();
	let refusedSaid = false;
	const take = (): Promise<VsockConnection | null> => {
		const c = pending;
		pending = null;
		if (c && !gone.has(c)) return Promise.resolve(c);
		if (stopped) return Promise.resolve(null);
		return new Promise((r) => { idle = r; });
	};
	const link: AsyncIterable<VsockConnection> & { close(): void } = {
		[Symbol.asyncIterator]: () => ({
			next: async (): Promise<IteratorResult<VsockConnection>> => {
				const c = await take();
				return c ? { value: c, done: false } : { value: undefined, done: true };
			},
		}),
		close: () => listener.close(),
	};
	const load = async (first: VsockConnection) => {
		loading = true;
		pending = first;
		const gpu = KW.config.wlGpu ? vm.gl?.gpu : undefined;
		const vk = KW.config.wlGpu ? vm.vk : undefined;
		const what = [gpu && "GPU buffers by resource: guest GL's renderer", vk && "external buffers: guest Vulkan's renderer"].filter(Boolean).join("; ");
		log(`[host] wayland: the relay connected (vsock port ${WAYLAND_PORT}); loading wland${what ? ` (${what})` : ""}`);
		const [W, { default: wasm }] = await Promise.all([import("wland/client"), import("wland/wland.wasm?url")]);
		if (stopped) return;
		const container = getContainer();
		if (!container) throw new Error("no desktop container");
		const hosted = createHost(W.ROLE_POPUP);
		setHost(hosted);
		let started: Wland;
		let dnd: DndBridge | null = null;
		const copyOut = createCopyOut(vm, () => mine);
		try {
			started = await W.createWland({
				container,
				wasm,
				link: W.createStreamLink(link),
				buffers: handleSource(vm),
				...(gpu || vk ? { gpu: gpuSource(gpu, vk, log) } : {}),
				// The page's WM owns the windows (see the top; wayland/host.ts).
				decorations: "server",
				autoFocus: false,
				manageDisplay: false,
				mount: hosted.mount,
				unmount: hosted.unmount,
				interactive: hosted.interactive,
				dnd: false, // drop.ts waylandDnd()
				onWindowsChange: hosted.schedule,
				onFocusChange: hosted.schedule,
				onEvent(ev) {
					hosted.event(ev);
					dnd?.handle(ev);
					if (stopped) return;
					copyOut(ev);
					if (ev.type === "log") wireLog[wireAt++ % LOG_LINES] = ev.line;
					else if (ev.type === "commit") stats.commits++;
					else if (ev.type === "surface") {
						if (ev.role === W.ROLE_POPUP) popups.add(`${ev.conn}:${ev.surface}`);
						else popups.delete(`${ev.conn}:${ev.surface}`);
					} else if (ev.type === "destroy") popups.delete(`${ev.conn}:${ev.surface}`);
					else if (ev.type === "disconnect") { for (const k of popups) if (k.startsWith(`${ev.conn}:`)) popups.delete(k); }
					else if (ev.type === "open") {
						ui$().set((s) => ({ wayland: { ...s.wayland, attached: true } }));
						log("[host] wayland: compositor started");
					} else if (ev.type === "close") {
						popups.clear();
						ui$().set((s) => ({ wayland: { ...s.wayland, attached: false } }));
						log("[host] wayland: the relay's link closed; its apps are gone (it dials again for the next app)");
					} else if (ev.type === "error") {
						log(`[host] wayland: ${ev.detail}`);
					}
				},
			});
		} catch (e) {
			if (getHost() === hosted) setHost(null);
			hosted.dispose();
			throw e;
		}
		hosted.attach(started);
		withholdPaths(started.engine, W.TEXT_MIMES);
		dnd = waylandDnd(W, started, log);
		const unPaste = attachPaste(started, container, W.TEXT_MIMES, log);
		// Its dispose ends the host and the drags too.
		const wl: Wland = { ...started, dispose() { unPaste(); started.dispose(); dnd?.dispose(); hosted.dispose(); if (getHost() === hosted) setHost(null); } };
		// Stopped while wland loaded: this kernel is gone, and a later one may have its own.
		if (stopped) wl.dispose();
		else setCurrent(mine = wl);
		loading = false;
	};
	void (async () => {
		for (;;) {
			const c = await listener.accept();
			if (!c || stopped) return;
			void c.closed.then(() => gone.add(c));
			if (idle) {
				// wland's link waits for the relay's next connection.
				const r = idle;
				idle = null;
				r(c);
			} else if (!mine && !loading) {
				load(c).catch((e: unknown) => {
					// Nothing will serve the relay: refuse its dials from now on (its apps fail at once).
					loading = false;
					pending = null;
					c.reset();
					listener.close();
					log(`[host] wayland: wland did not load (${(e as Error)?.message ?? e}); the relay's connections are refused`);
				});
			} else if (pending && gone.has(pending)) {
				// The relay dialed again while wland loaded for a connection it gave up on.
				pending = c;
			} else {
				// wland serves a link (or loads for one): one at a time.
				c.reset();
				if (!refusedSaid) log(`[host] wayland: a second connection on vsock port ${WAYLAND_PORT} while the relay's link is up: refused (one relay at a time)`);
				refusedSaid = true;
			}
		}
	})();
	return () => {
		if (stopped) return;
		stopped = true;
		listener.close();
		const r = idle;
		idle = null;
		r?.(null);
		pending = null;
		if (mine) {
			mine.dispose();
			if (getCurrent() === mine) setCurrent(null);
			mine = null;
		}
		popups.clear();
		ui$().set((s) => ({ wayland: { ...s.wayland, available: false, attached: false, windows: [] } }));
	};
}

/** KW.wayland, for the tests: the apps' windows as wland lists them. */
export const waylandApi = {
	windows: () => getCurrent()?.windows().map((w) => ({ key: w.key, title: w.title, appId: w.appId, decorated: w.decorated, focused: w.focused, maximized: w.maximized, fullscreen: w.fullscreen, minimized: w.minimized })) ?? [],
	/** wland itself (its engine, view, input, window manager), for debugging. */
	wland: () => getCurrent(),
	/** The element the apps' window elements (their canvases) are in: the workspace (#workspace), which also holds wland's own container #wl-desktop. */
	container: () => { const container = getContainer(); return container?.parentElement ?? container; },
	loaded: () => !!getCurrent(),
	/** Popups (menus) mapped now. */
	popups: () => popups.size,
	/** Their keys (wland's c<conn>s<surface>: the data-wland of their canvases). */
	popupKeys: () => [...popups].map((k) => { const [c, sf] = k.split(":"); return `c${c}s${sf}`; }),
	/** wland's last wire-level log lines (decoded Wayland messages), oldest first. */
	log: () => (wireAt <= LOG_LINES ? wireLog.slice(0, wireAt) : [...wireLog.slice(wireAt % LOG_LINES), ...wireLog.slice(0, wireAt % LOG_LINES)]),
	/** The last GPU buffer a commit named (wland's GpuRef, the modifier as a hex string), or null. */
	gpuLast: () => { const gpuLast = getGpuLast(); return gpuLast ? { ...gpuLast, modifier: `0x${gpuLast.modifier.toString(16)}` } : null; },
	/** What the compositor read of the guest's buffers and what GPU commits cost (see `stats` in wayland/buffers.ts). */
	stats: (): Stats => ({ ...stats }),
	/** wland's engine.externalBuffers() on the current link: true (Vulkan apps present by external buffers), false (not offered), null (no link settled). */
	externalBuffers: (): boolean | null => getCurrent()?.engine.externalBuffers() ?? null,
};
