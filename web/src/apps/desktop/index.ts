// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The launcher's Desktop folder: Debian's GUI apps (GTK 3, Chromium) as
// Wayland windows on the page (wayland.ts), and X11 apps on an X screen in
// one such window (Xwayland rootful, ../xwl.ts), installed on first launch.
// One file per app in this folder, listed below in the order it shows them.
import { defineGroup } from "../types.ts";
import thunar from "./thunar.ts";
import chromium from "./chromium.ts";
import discord from "./discord.ts";
import l3afpad from "./l3afpad.ts";
import galculator from "./galculator.ts";
import x11 from "./x11.ts";
import xpaint from "./xpaint.ts";
import xfce from "./xfce.ts";

export default defineGroup({
	id: "desktop", title: "Desktop", desc: "GUI apps in windows on the page",
	// Two windows, one over the other.
	icon: { svg: '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2"/><rect x="3" y="9" width="14" height="12" rx="2"/><path d="M3 13h14"/></g>' },
	colors: ["#14b8a6", "#134e4a"],
}, [chromium, discord, thunar, l3afpad, galculator, x11, xfce, xpaint]);
