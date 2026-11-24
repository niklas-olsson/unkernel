// SPDX-License-Identifier: MIT
// Copyright (C) 2026 the unkernel contributors
import type { CommitEvent } from "wland/engine";
import type { ProfileReport } from "../../js/core/profile.ts";
import type { KernelHandle } from "./sdk.ts";
import { summarizeProfile } from "./trace-summary.ts";

type Build = typeof __KW_BUILD__ & {
	bootAsset: string; kernelAsset: string; distro: string; distroAsset: string | null; imageId: string | null;
	worker: boolean; transport: KernelHandle["transport"]; jit: boolean; memoryMiB: number; userAgent: string;
};
type Args = Record<string, string | number | boolean>;
interface Instant {
	ph: "i"; s: "t"; pid: number; tid: number; ts: number; cat: string; name: string; args?: Args;
}
interface Capture {
	label: string;
	before: ProfileReport;
	request: number;
	ready: number;
	listeners: AbortController;
	events: Instant[];
	dropped: number;
}

// Chrome Trace Event timestamps are microseconds on the page's monotonic clock.
const now = () => Math.round(performance.now() * 1000);
const LIMIT = 2048;
const span = (cat: string, name: string, ts: number, end: number) =>
	({ ph: "X", pid: 1, tid: 1, cat, name, ts, dur: end - ts });
function checkLabel(label: string) {
	if (typeof label !== "string" || !label.length || label.length > 128) throw new Error("Trace label must be 1–128 characters");
}

/** Two cumulative guest profiles bracket a host timeline. Only explicit captures listen for input. */
export function createDesktopTrace(vm: Pick<KernelHandle, "profile" | "exited">, build: Build, target: EventTarget) {
	let active: Capture | undefined;
	let pending = false;
	let ended = false;
	void vm.exited.then(() => {
		ended = true;
		active?.listeners.abort();
	});
	async function snapshot() {
		const profile = await vm.profile();
		if (!profile) throw new Error("This kernel did not provide a guest profile");
		return profile;
	}
	function record(cat: string, name: string, args?: Args) {
		if (!active) return;
		if (active.events.length === LIMIT) { active.dropped++; return; }
		active.events.push({ ph: "i", s: "t", pid: 1, tid: 1, ts: now(), cat, name, args });
	}
	function input(e: Event) {
		if (e.isTrusted) record("input", e.type);
	}
	const api = {
		async start(label = "desktop") {
			if (active || pending) throw new Error("A desktop trace is already active or taking a profile");
			if (ended) throw new Error("The guest has exited");
			checkLabel(label);
			pending = true;
			try {
				const request = now();
				const before = await snapshot();
				if (ended) throw new Error("The guest exited while starting the trace");
				const listeners = new AbortController();
				active = { label, before, request, ready: now(), listeners, events: [], dropped: 0 };
				for (const name of ["keydown", "pointerdown", "wheel"]) {
					target.addEventListener(name, input, { capture: true, passive: true, signal: listeners.signal });
				}
			} finally {
				pending = false;
			}
		},
		mark(label: string) {
			if (!active) throw new Error("No desktop trace is recording");
			checkLabel(label);
			record("mark", label);
		},
		async stop() {
			if (!active) throw new Error("No desktop trace is recording");
			const c = active, end = now();
			active = undefined;
			pending = true;
			c.listeners.abort();
			try {
				const after = await snapshot();
				const returned = now();
				const profile = summarizeProfile(c.before, after);
				return {
					traceEvents: [
						span("profile", "start snapshot", c.request, c.ready),
						span("workload", c.label, c.ready, end), ...c.events,
						span("profile", "end snapshot", end, returned),
						span("profile", "summarize snapshots", returned, now()),
					],
					schemaVersion: 1, label: c.label, build,
					pageTimeOriginMs: performance.timeOrigin, droppedEvents: c.dropped, profile,
				};
			} finally {
				pending = false;
			}
		},
	};
	// wland calls this after its view has handled the commit, on the page's thread.
	function onCommit(ev: CommitEvent) {
		if (!active) return;
		record("wayland", "surface commit observed", {
			conn: ev.conn, surface: ev.surface, root: ev.root, format: ev.format,
			width: ev.width, height: ev.height, damageRects: ev.damage.length / 4,
			...(ev.gpu ? { resource: ev.gpu.resource } : {}),
			...(ev.external ? { external: true } : {}),
			...(ev.format === "gpu" ? { imageAvailable: ev.image != null } : {}),
		});
	}
	return { api, onCommit };
}
