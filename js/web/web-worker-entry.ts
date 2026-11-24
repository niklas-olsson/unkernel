// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The kernel worker's entry in browsers (started by worker.ts): serve the
// kernel (core/worker-serve.ts) over the worker's own message port, with
// the browser device kinds (devices.ts: the IndexedDB data disk, HTTP
// disks, Wisp), starting an SMP kernel's other CPUs as nested workers
// (cpu.ts). Every
// URL it gets is absolute (in the package it runs from a Blob URL, whose
// base means nothing), and it finds nothing through import.meta.url. The
// build bundles it into a module that imports nothing.

import { serveKernel } from "../core/worker-serve.ts";
import type { ToWorker } from "../core/worker-protocol.ts";
import { spawnWebCpu, webCpuBlocker } from "./cpu.ts";
import { webDevices } from "./devices.ts";
import { spawnWebSampler } from "./sampler.ts";

/** The dedicated worker's global (the page's tsconfig has no webworker lib). */
const scope = globalThis as unknown as {
	postMessage(msg: unknown, transfer: Transferable[]): void;
	addEventListener(type: "message", fn: (e: MessageEvent<ToWorker>) => void): void;
};
serveKernel({
	post: (msg, transfer) => scope.postMessage(msg, transfer ?? []),
	listen: (handler) => scope.addEventListener("message", (e) => handler(e.data)),
}, { devices: webDevices, spawnCpu: spawnWebCpu, whyNoCpus: webCpuBlocker, spawnSampler: spawnWebSampler });
