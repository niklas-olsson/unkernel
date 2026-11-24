// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The launcher's Graphics folder: OpenGL on the GPU, rendered through the browser's WebGL2,
// Vulkan through its WebGPU, and Wayland apps in windows on the page.
// One file per app in this folder, listed below in the order it shows them.
import { defineGroup } from "../types.ts";
import kmscube from "./kmscube.ts";
import glmark2 from "./glmark2.ts";
import xglamor from "./xglamor.ts";
import foot from "./foot.ts";
import wlgl from "./wlgl.ts";
import vkcube from "./vkcube.ts";
import vkmark from "./vkmark.ts";
import gtkvk from "./gtkvk.ts";
import d3d12gears from "./d3d12gears.ts";
import d3d12triangle from "./d3d12triangle.ts";

export default defineGroup({
	id: "gl", title: "Graphics", desc: "OpenGL and Vulkan on the GPU, and Wayland windows",
	// A cube.
	icon: { svg: '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.8 20 7.4v9.2L12 21.2 4 16.6V7.4Z"/><path d="M4 7.4 12 12l8-4.6M12 12v9.2"/></g>' },
	colors: ["#8b5cf6", "#2e1065"],
}, [kmscube, glmark2, xglamor, wlgl, vkcube, vkmark, gtkvk, d3d12gears, d3d12triangle, foot]);
