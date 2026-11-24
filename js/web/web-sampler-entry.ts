// SPDX-License-Identifier: MIT
// Copyright (C) 2026 the unkernel contributors

import type { SamplerInit } from "../core/profile.ts";
import { runSampler } from "../core/sampler.ts";

const scope = globalThis as unknown as {
	postMessage(message: unknown): void;
	addEventListener(type: "message", fn: (event: MessageEvent<SamplerInit>) => void, opts: { once: boolean }): void;
};
scope.addEventListener("message", (event) => {
	// The owner can release the inlined script's Blob URL once the module runs.
	scope.postMessage(null);
	runSampler(event.data);
}, { once: true });
