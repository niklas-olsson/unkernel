// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// GTK 4 on Vulkan: gtk4-demo with GTK's Vulkan renderer (GSK_RENDERER=vulkan)
// in a window on the page's Wayland desktop, with guest Vulkan on (the base's
// ICD on the page's WebGPU; frames read back into wl_shm, as vkcube's)
// (Debian).
import type { TerminalApp } from "../types.ts";

export default {
	id: "gtkvk",
	title: "GTK on Vulkan",
	desc: "GTK 4's demo with its Vulkan renderer in a window on the page, rendered on this browser's WebGPU (guest Vulkan)",
	// A window with a cube in it (crafted).
	icon: { svg: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M3 5h18v14H3zM3 9h18"/><path d="M12 11l3.5 2v3.6L12 18.6l-3.5-2V13Z"/>' },
	colors: ["#ac162c", "#1e3a8a"],
	needs: { net: true, wayland: true, vk: true },
	packages: { debian: ["libvulkan1", "gtk-4-examples"] },
	waylandIds: ["org.gtk.Demo4"],
	files: {
		README: "gtk4-demo with GSK_RENDERER=vulkan: GTK 4 draws with Vulkan, which here is the\n" +
			"page's WebGPU (guest Vulkan in Options). More to try:\n" +
			"  GSK_RENDERER=vulkan gtk4-widget-factory\n" +
			"  GSK_RENDERER=vulkan GSK_DEBUG=renderer gtk4-demo   (says which renderer runs)\n",
	},
	commands: ["cat README", "GSK_RENDERER=vulkan gtk4-demo"],
} satisfies TerminalApp;
