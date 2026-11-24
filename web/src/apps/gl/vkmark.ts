// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// vkmark: the Vulkan benchmark's scenes in a window on the page's Wayland
// desktop, with guest Vulkan on (the base's ICD on the page's WebGPU; each
// frame read back into a wl_shm buffer, as vkcube's). Prints a score per
// scene and the total (Debian).
import type { TerminalApp } from "../types.ts";

export default {
	id: "vkmark",
	title: "vkmark",
	desc: "The Vulkan benchmark in a window on the page: its scenes rendered on this browser's WebGPU (guest Vulkan), with FPS per scene",
	// A gauge (crafted).
	icon: { svg: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M4.2 17a9 9 0 1 1 15.6 0M12 14l4-5"/><circle cx="12" cy="14" r="1.6"/>' },
	colors: ["#ac162c", "#7c2d12"],
	needs: { net: true, wayland: true, vk: true },
	packages: { debian: ["libvulkan1", "vkmark"] },
	waylandIds: ["vkmark"],
	files: {
		README: "vkmark runs its scenes in a window, each for a few seconds, on the guest's\n" +
			"Vulkan (the page's WebGPU, guest Vulkan in Options); frames are read back.\n" +
			"More to try:\n" +
			"  vkmark --winsys wayland -b cube    (one scene)\n" +
			"  vkmark --list-scenes\n",
	},
	commands: ["cat README", "vkmark --winsys wayland"],
} satisfies TerminalApp;
