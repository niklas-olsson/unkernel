// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>

import { Worker } from "node:worker_threads";
import type { SamplerSpawner } from "../core/profile.ts";

export const spawnNodeSampler: SamplerSpawner = (init, onError) => {
	const entry: URL | string = new URL("./sampler-entry.ts", import.meta.url);
	const w = typeof entry === "string" ? new Worker(entry, { eval: true, workerData: init }) : new Worker(entry, { workerData: init });
	// The sampler never keeps the process alive.
	w.unref();
	w.on("error", onError);
	return {
		stop() {
			const ctl = new Int32Array(init.ctl);
			Atomics.store(ctl, 0, 1);
			Atomics.notify(ctl, 0);
			void w.terminate();
		},
	};
};
