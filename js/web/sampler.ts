// SPDX-License-Identifier: MIT
// Copyright (C) 2026 the unkernel contributors

import type { SamplerSpawner } from "../core/profile.ts";

let blobUrl: string | undefined;

/** @internal The package's inlined sampler source as a Blob URL. */
export function inlineSamplerUrl(code: string): URL {
	blobUrl = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
	return new URL(blobUrl);
}

export const spawnWebSampler: SamplerSpawner = (init, onError) => {
	blobUrl = undefined;
	let w: Worker;
	try {
		w = new Worker(new URL("./web-sampler-entry.ts", import.meta.url), { type: "module", name: "unkernel-sampler" });
	} catch (error) {
		if (blobUrl) URL.revokeObjectURL(blobUrl);
		throw error;
	}
	const url = blobUrl as string | undefined;
	const revoke = () => {
		if (url) URL.revokeObjectURL(url);
	};
	const fail = (event: Event) => {
		event.preventDefault();
		const message = (event as ErrorEvent).message || "the sampler worker's script or message could not be loaded";
		onError(new Error(message));
	};
	const stop = () => {
		const ctl = new Int32Array(init.ctl);
		Atomics.store(ctl, 0, 1);
		Atomics.notify(ctl, 0);
		w.removeEventListener("error", fail);
		w.removeEventListener("messageerror", fail);
		w.terminate();
		revoke();
	};
	w.addEventListener("message", revoke, { once: true });
	w.addEventListener("error", fail);
	w.addEventListener("messageerror", fail);
	try {
		w.postMessage(init);
	} catch (error) {
		stop();
		throw error;
	}
	return { stop };
};
