// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The launcher's Browsers folder: web browsers as Wayland windows on the
// page (wayland.ts), installed on first launch: Debian's Chromium and
// Firefox ESR, and Ladybird from its own apt repository.
// One file per app in this folder, listed below in the order it shows them.
import { defineGroup } from "../types.ts";
import chromium from "./chromium.ts";
import firefox from "./firefox.ts";
import ladybird from "./ladybird.ts";

export default defineGroup({
	id: "browsers", title: "Browsers", desc: "Web browsers in windows on the page",
	// A browser window: its toolbar, an address bar and a page (crafted).
	icon: { svg: '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M6 6.5h.01M8.5 6.5h.01"/><path d="M11 6.5h7"/></g>' },
	colors: ["#3b82f6", "#172554"],
}, [chromium, firefox, ladybird]);
