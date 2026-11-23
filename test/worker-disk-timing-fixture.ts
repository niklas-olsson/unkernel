// SPDX-License-Identifier: MIT
// Copyright 2026 the unkernel contributors
// The SDK's worker with browser disk construction and a deterministic boot clock.
import { parentPort } from "node:worker_threads";
import { extendDevices, type DataDiskSpec, type DeviceContext } from "../js/core/devices.ts";
import { serveKernel } from "../js/core/worker-serve.ts";
import { nodeReadFile } from "../js/node/platform.ts";
import { webDevices } from "../js/web/devices.ts";

const port = parentPort;
if (!port) throw new Error("Expected a worker thread");

const realNow = performance.now;
let now = 0;
performance.now = () => now;
const readFile = nodeReadFile();
const openData = webDevices.disks.data!;
const devices = extendDevices(webDevices, {
	disks: {
		http() {
			now += 19000;
			throw new Error("unrelated disk was deliberately skipped");
		},
		async data(spec: DataDiskSpec, ctx: DeviceContext) {
			try {
				return await openData(spec as never, ctx);
			} finally {
				// Advance after the actual async template open succeeds or fails.
				now += spec.template === "bundled" ? 23 : 7;
			}
		},
	},
});
serveKernel({
	post(m, transfer) {
		if (m.t === "progress" && m.p.stage === "disk" && m.p.index === 2) performance.now = realNow;
		port.postMessage(m, transfer);
	},
	listen: (h) => port.on("message", h),
}, {
	devices,
	readFile(src) {
		now += 8000;
		return readFile(src);
	},
});
