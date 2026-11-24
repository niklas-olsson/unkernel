// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>

import type { SamplerInit } from "./profile.ts";

/** Run on a dedicated sampler thread, setting profile IRQs without waking idle CPUs. */
export function runSampler(init: SamplerInit): void {
	const mem = new Int32Array(init.buffer), ctl = new Int32Array(init.ctl);
	const n = init.cpus, bit = 1 << init.bit, words = init.words >>> 2;
	let next = performance.now();
	for (;;) {
		next += init.periodMs;
		const wait = next - performance.now();
		if (wait < -50 * init.periodMs) next = performance.now(); // descheduled for long: no burst of ticks
		if (wait > 0) Atomics.wait(ctl, 0, 0, wait);
		if (Atomics.load(ctl, 0)) break;
		for (let c = 0; c < n; c++) {
			const w = c === 0 ? init.irq0 : Atomics.load(mem, words + c) >>> 0;
			if (!w) continue;
			Atomics.add(ctl, 1 + c, 1);
			if (Atomics.or(mem, w >>> 2, bit) & bit) Atomics.add(ctl, 1 + n + c, 1);
		}
	}
}
