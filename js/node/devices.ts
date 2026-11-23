// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The Node device kinds (core/devices.ts): "file" disks, "direct"
// networking over host sockets, and Wisp with NODE_WISP_HEADERS (Node's
// WebSocket sends no Origin). Used by the Node platform on the caller's
// thread and by the kernel worker (worker-entry.ts).

import { coreDevices, extendDevices, type DeviceContext, type DeviceRegistry, type FileDiskSpec, type NetBackendSpec } from "../core/devices.ts";
import { CowDisk } from "../core/block.ts";
import { FileBase, FileDisk } from "./disk.ts";
import { directBackend, wispBackend } from "./net.ts";

export const nodeDevices: DeviceRegistry = extendDevices(coreDevices, {
	disks: {
		file: (spec: FileDiskSpec, ctx: DeviceContext) =>
			spec.snapshot && !spec.readOnly ? new CowDisk(new FileBase(spec.path), { log: ctx.log }) : new FileDisk(spec.path, { readOnly: spec.readOnly }),
	},
	backends: {
		direct: () => directBackend(),
		wisp: (spec: Extract<NetBackendSpec, { kind: "wisp" }>, ctx: DeviceContext) => wispBackend(spec.servers, { headers: spec.headers, udp: spec.udp, log: ctx.log }),
	},
});
