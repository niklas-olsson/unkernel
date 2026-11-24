// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Chromium: Debian's chromium as a window on the page's Wayland desktop
// (wayland.ts). The kw layer's /etc/chromium.d/kw-wayland gives it
// --ozone-platform=wayland and dark mode; Mesa's EGL (libegl1,
// libegl-mesa0), which the package does not pull in, lets its GPU process
// run on guest GL (virgl), else it renders in software (.agents/web.md,
// Wayland desktop). The largest app here: about 700 MiB installed, 180 MiB
// to download (the image's package lists, 2026-11-22), and it wants the
// page's 2 GiB of memory; its window maps 10 to 14 s after the start.
// It runs in a session bus of its own (dbus-run-session), else it logs a
// failed bus connection for each of its D-Bus clients (the system bus,
// which no machine here runs, still fails, a few lines); and without its
// background requests to Google's services (updates, variations, Safe
// Browsing lists), work an emulated CPU need not do.
// Its window is no narrower than MIN_W (532 px at scale 1, maximized,
// 2026-11-23): on a narrower workspace (a phone) it ignored the maximized
// size and was cut off at the right, its menu button too. There it starts
// with a smaller scale factor, the largest step of 0.05 at which it fits
// (0.7 on a 390 px phone; not below 0.6: at 0.5 its window went away), as
// the workspace is when it starts (a phone turned later keeps it).
import { wm$ } from "../../wm.ts";
import type { TerminalApp } from "../types.ts";

/** Chromium's narrowest window at scale 1, px. */
const MIN_W = 532;

/** --force-device-scale-factor for the workspace's width, or "" (it fits as it is). */
function scaleFlag(): string {
	const w = wm$.get().area.w || innerWidth;
	if (w >= MIN_W) return "";
	const scale = Math.max(0.6, Math.floor((w / MIN_W) * 20) / 20);
	return ` --force-device-scale-factor=${scale}`;
}

export const chromiumRuntime = {
	needs: { net: true, wayland: true },
	packages: { debian: ["chromium", "libegl1", "libegl-mesa0", "fonts-liberation", "dbus-daemon"] },
} satisfies Pick<TerminalApp, "needs" | "packages">;

export function chromiumCommand(flags: string): string {
	return `dbus-run-session -- chromium --no-first-run --no-default-browser-check ${flags}${scaleFlag()}`;
}

export default {
	id: "chromium",
	title: "Chromium",
	desc: "The web browser, in a window on the page (a large install)",
	// Chromium's mark: three segments round a centre (crafted).
	icon: { svg: '<path d="M3.7 6.42A10 10 0 0 1 20.98 7.6H12a4.4 4.4 0 0 0-3.81 6.6Z"/><path opacity=".75" d="M20.98 7.6a10 10 0 0 1-9.66 14.38l4.49-7.78A4.4 4.4 0 0 0 12 7.6Z"/><path opacity=".5" d="M11.32 21.98A10 10 0 0 1 3.7 6.42l4.49 7.78a4.4 4.4 0 0 0 7.62 0Z"/><circle cx="12" cy="12" r="3.4"/>' },
	colors: ["#60a5fa", "#1e3a8a"],
	...chromiumRuntime,
	// Read when it launches (run.sh): the scale for the workspace then.
	get commands() {
		return [chromiumCommand("--disable-background-networking")];
	},
} satisfies TerminalApp;
