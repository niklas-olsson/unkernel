// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// createKernel()'s browser platform: memory sized for the device (decided
// here, on the page's thread, since a worker has no say in it), worker mode
// on a Web Worker (worker.ts), and relative locations made absolute against
// the page, because the worker (a Blob URL in the package) has no useful
// base URL. Disk and network specs are built by webDevices (devices.ts).
// CPU threads for an SMP kernel (cpu.ts) start wherever the kernel runs in
// a worker of a cross-origin isolated page: worker mode's kernel worker,
// or a worker of the caller's own; never on the page's main thread
// (webCpuBlocker()).
// The entry (web.ts, or the page's web/src/sdk.ts) passes the
// default kernel's URL, the GL renderer's and the Vulkan translator's (web.ts only), so
// `new URL(..., import.meta.url)` stays in it.

import type { Platform } from "../core/instance.ts";
import type { VkPlatform } from "../core/vk.ts";
import { DEFAULT_MEMORY_FALLBACK_MIB, autoMemoryMiB } from "./memory.ts";
import { spawnWebCpu, webCpuBlocker } from "./cpu.ts";
import { webDevices } from "./devices.ts";
import { spawnWebWorker } from "./worker.ts";

export function webPlatform(defaultKernel: URL, glModule?: URL, vk?: VkPlatform): Platform {
	return {
		defaultKernel: () => defaultKernel,
		// The `gl` option's renderer (virgl.mjs), imported only when asked for.
		glModule: glModule && (() => glModule),
		// The `vk` option's renderer and its translator (kwvk-naga.wasm), loaded only at the guest's first Vulkan instance.
		vk: vk && (() => vk),
		defaultMemoryMiB: () => autoMemoryMiB().mib,
		defaultMemoryFallbackMiB: [...DEFAULT_MEMORY_FALLBACK_MIB],
		spawnWorker: spawnWebWorker,
		spawnCpu: spawnWebCpu,
		whyNoCpus: webCpuBlocker,
		absoluteUrl: (src) => new URL(src, location.href).href,
		devices: webDevices,
		// A distro URL (relative to the page) as a read-only "http" spec: read lazily with Range requests, no IndexedDB.
		distroSpec: (src) => ({ kind: "http", url: new URL(src, location.href).href, readOnly: true }),
	};
}
