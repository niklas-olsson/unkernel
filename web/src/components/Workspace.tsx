// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The workspace: the area of the desktop (#desktop) its windows live in
// (#workspace, inside the safe areas and below the top bar, TopBar.tsx: style.css
// --tb-space, nothing while the on-screen keyboard is up), drawn from the WM's state (wm.ts), one
// Window each, in the order they opened (z-index is the z-order, so raising
// one moves no DOM node), with the ghosts of windows closing (wmfx.ts
// drawn(): kept in their places while their close effect runs). Its size is the WM's workspace; compact mode is on
// for phones (KW.config.mobile) and viewports below COMPACT_PX. Over the
// windows, wland's container (WaylandOutput.tsx: #wl-desktop, the Wayland apps'
// output, the workspace's size; their windows are WM windows, wayland.ts).
// A right click or long press on the bare workspace opens the desktop's menu
// (DesktopMenu.tsx, a portal into the body).
// Under the windows, the resource widget (Widget.tsx; in compact mode the
// wallpaper photo's credit instead, Wallpaper.tsx), and the
// snap preview of a window being moved (SnapPreview.tsx: at that window's
// z-index and before it in the DOM, so just under it).
//
// The terminals' windows (termtabs.ts) get their tab strip
// (TerminalTabs.tsx), close action (terminals.ts closeTerminalWindow) and
// the terminal apps' descriptors (appwindows.ts terminalAppMeta) here, and the console's Terminal window is opened when this module loads,
// with the console, terminal 0, as its tab, so the window (and #term in it)
// is there from the first render: boot.ts finds #term with getElementById,
// App.tsx's bottom tracking starts on it at mount. #term is made once and
// never touched again (wterm owns it); its tab cannot be closed, and its
// window only minimizes. wterms.ts hooks in its focus and visibility
// handling once the terminal exists.
import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { terminalAppMeta } from "../appwindows.ts";
import { KW } from "../kw.ts";
import { closeTerminalWindow } from "../terminals.ts";
import { configureTerminals, openConsoleWindow } from "../termtabs.ts";
import { isVisible, useWm, wm } from "../wm.ts";
import { drawn, useWmFx } from "../wmfx.ts";
import { WaylandOutput } from "./WaylandOutput.tsx";
import { DesktopMenu } from "./DesktopMenu.tsx";
import { SnapPreview } from "./SnapPreview.tsx";
import { TerminalTabs } from "./TerminalTabs.tsx";
import { WallpaperCredit } from "./Wallpaper.tsx";
import { ResourcesWidget } from "./Widget.tsx";
import { Window } from "./Window.tsx";

/** Below this viewport width (px) the desktop is compact: every window maximized, one shown. */
export const COMPACT_PX = 640;

configureTerminals({ strip: (id) => <TerminalTabs id={id} />, close: (id) => void closeTerminalWindow(id), appMeta: terminalAppMeta });

/** The console's window: large and centered on desktops (the Dock and the safe areas are taken off by fitting it). */
function openConsole(): void {
	// wterm renders the console's rows as DOM text in #term (boot.ts), and sets its own class.
	let el = document.getElementById("term");
	if (!el) { el = document.createElement("div"); el.id = "term"; }
	const w = Math.round(Math.min(1180, Math.max(720, innerWidth * 0.74)));
	const h = Math.round(Math.max(420, (innerHeight - 64) * 0.84));
	openConsoleWindow(el, { w, h }); // once: a hot reload of this module keeps the window and its #term
}
openConsole();
KW.wm = wm;

const compactQuery = () => matchMedia(`(max-width: ${COMPACT_PX - 0.02}px)`);
const onCompactChange = (cb: () => void) => {
	const q = compactQuery();
	q.addEventListener("change", cb);
	return () => q.removeEventListener("change", cb);
};
/** Phones, and viewports below COMPACT_PX (re-renders when that changes). */
export function useCompact(): boolean {
	const narrow = useSyncExternalStore(onCompactChange, () => compactQuery().matches);
	return !!KW.config?.mobile || narrow;
}

export function Workspace() {
	const s = useWm((st) => st);
	const fx = useWmFx();
	const compact = useCompact();
	const ref = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => wm.setCompact(compact), [compact]);
	useLayoutEffect(() => {
		wm.attachWorkspace(ref.current);
		return () => wm.attachWorkspace(null);
	}, []);
	return (
		<div id="workspace" ref={ref} className="absolute isolate top-[calc(var(--st)+var(--tb-space,0px))] right-(--sr) bottom-0 left-(--sl)">
			{s.compact && <WallpaperCredit />}
			{!s.compact && <ResourcesWidget />}
			<SnapPreview />
			{drawn(s, fx).map(({ win: w, z, ghost }) => (
				<Window key={w.id} win={w} z={z} focused={!ghost && s.focused === w.id} visible={ghost || isVisible(w, s)} closing={ghost} compact={s.compact} area={s.area} />
			))}
			<WaylandOutput />
			<DesktopMenu />
		</div>
	);
}
