// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// vkcube: Vulkan's spinning cube (vulkan-tools) as a window on the page's
// Wayland desktop (wayland.ts). With guest Vulkan on, the Vulkan loader finds
// the base's ICD (/usr/lib/kw/libvulkan_kw.so, .agents/vk.md), which renders
// on the page's WebGPU; each frame is read back into a wl_shm buffer, so the
// window is an ordinary shared-memory window (Debian).
import type { TerminalApp } from "../types.ts";

export default {
	id: "vkcube",
	title: "vkcube",
	desc: "Vulkan's spinning cube in a window on the page: the guest's Vulkan rendered on this browser's WebGPU (guest Vulkan)",
	// A solid cube, its three faces apart (crafted).
	icon: { svg: '<path fill-rule="evenodd" d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7Zm0 2.3L6.2 7.9 12 11l5.8-3.1Zm-6.5 4.8v6.2l5.5 3V12.6Zm13 0-5.5 3v6.2l5.5-3Z"/>' },
	colors: ["#ac162c", "#2e1065"],
	needs: { net: true, wayland: true, vk: true },
	packages: { debian: ["libvulkan1", "vulkan-tools"] },
	waylandIds: ["vkcube"],
	files: {
		README: "Vulkan in the guest runs on this browser's WebGPU (guest Vulkan, Options):\n" +
			"the base's ICD (/usr/lib/kw/libvulkan_kw.so) talks to the page over vsock.\n" +
			"vkcube draws into a Wayland window; its frames are read back from WebGPU.\n" +
			"More to try:\n" +
			"  vulkaninfo --summary\n" +
			"  vkcube --wsi wayland --c 300      (300 frames, then it exits)\n",
	},
	commands: ["cat README", "vulkaninfo --summary 2>/dev/null | grep -E 'deviceName|driverName|apiVersion' || true", "vkcube --wsi wayland"],
} satisfies TerminalApp;
