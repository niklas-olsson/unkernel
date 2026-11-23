// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Apps and the desktop windows they stand for, as the Dock (its pinned tiles
// and window tiles, components/Dock.tsx), the top bar (the current app,
// components/TopBar.tsx) and the title bars (components/Window.tsx) all see
// them, so they agree. What a window shows is its descriptor (wm.ts
// WindowSpec.meta, apps/types.ts AppMeta), which the window kind declares
// where it opens the window; this module adds what needs the launcher's
// registry:
// - appMeta(app): a launcher app's descriptor: a page app is its own
//   (apps/system/: Terminal, Settings, System, Browser); a terminal app's is
//   its title and its launcher glyph (termtabs.ts gives it to a Terminal
//   window whose only tab is the app's terminal: terminalAppMeta());
// - waylandApp(appId): the terminal app a Wayland window stands for, by its
//   app id (xdg_toplevel.set_app_id): the app's id, or one of its
//   waylandIds (wayland/host.ts then gives the window the app's descriptor);
// - windowName(w): what its Dock tile and that tile's menu call it, and
//   windowDetail(w): the quieter title after the app's name in the top bar;
// - windowApp(id): the launcher app a window stands for (its descriptor's
//   id), whose pinned tile it is drawn as: a page app's own window, a
//   terminal app's Terminal window or Wayland window, or its installer while
//   it is installed (installer.ts); Terminal stands for the console's
//   Terminal window only;
// - appWindow(app): the window a pinned app's tile stands for, the first
//   that windowApp() gives it (a Wayland window before the others: the app's
//   own window rather than the terminal it was started from);
// - appTab(app): a terminal app's terminal while it is a tab of a shared
//   Terminal window (no window of its own).
// All read live (termtabs.ts, wm.ts), so a menu built later agrees with the
// tiles; a component that shows them subscribes to both stores itself.
import { APPS } from "./apps/index.ts";
import { isPageApp, type App, type AppMeta } from "./apps/types.ts";
import { CONSOLE_WIN, termTabs$ } from "./termtabs.ts";
import { wm, type WmWindow } from "./wm.ts";

const BY_ID = new Map(APPS.map((a) => [a.id, a]));
/** Terminal apps' descriptors, made once (termtabs.ts compares them by identity). */
const TERM_META = new Map<string, AppMeta>();

/** A launcher app's descriptor (see the top of this file). */
export function appMeta(app: App): AppMeta {
	if (isPageApp(app)) return app;
	let m = TERM_META.get(app.id);
	if (!m) TERM_META.set(app.id, (m = { id: app.id, title: app.title, glyph: app.icon, colors: app.colors }));
	return m;
}

/** The descriptor of the terminal app a terminal is named after (launcher.ts names it by the app's id), if any (termtabs.ts configureTerminals()). */
export function terminalAppMeta(name: string): AppMeta | undefined {
	const app = BY_ID.get(name);
	return app && !isPageApp(app) ? appMeta(app) : undefined;
}

/** The Wayland windows' kind (wm.ts appId; wayland/host.ts). */
export const WAYLAND = "wayland";

/** Terminal apps by the Wayland app ids their windows set (their id, their waylandIds), lower case. */
const BY_WL_ID = new Map(APPS.flatMap((a) => (isPageApp(a) ? [] : [a.id, ...(a.waylandIds ?? [])].map((id) => [id.toLowerCase(), a] as const))));

/**
 * The terminal app a Wayland window with this app id stands for: the app id
 * is the app's id or one of its waylandIds (any case), or, reverse-DNS
 * (org.gnome.Tali, two dots or more), ends in one.
 */
export function waylandApp(appId: string): App | undefined {
	const id = appId.toLowerCase(), parts = id.split(".");
	return BY_WL_ID.get(id) ?? (parts.length > 2 ? BY_WL_ID.get(parts[parts.length - 1]!) : undefined);
}

/**
 * What its Dock tile calls it: its app's name when it stands for another app
 * than its kind's (a Terminal window that is a terminal app's), else its own
 * title (a Terminal window's tab, the Browser's page); a Wayland window's
 * title always (it says more than its app's name: "tmp - Thunar").
 */
export const windowName = (w: WmWindow): string => (w.meta.id !== w.appId && w.appId !== WAYLAND ? w.meta.title : w.title);

/** The top bar's quieter title after the app's name: the window's own, when it says more than the name or the app's id. */
export const windowDetail = (w: WmWindow): string => (w.title === w.meta.title || w.title === w.meta.id ? "" : w.title);

/** The launcher app window id stands for, if any (see the top of this file). */
export function windowApp(id: string): App | undefined {
	const w = wm.get(id), app = w && BY_ID.get(w.meta.id);
	// The other Terminal windows are more of its windows: tiles of their own, no Keep in Dock.
	if (app?.id === "terminal" && id !== CONSOLE_WIN) return undefined;
	return app;
}

/** The window a pinned app's tile stands for (the first that windowApp() gives it, a Wayland window first). */
export function appWindow(app: Pick<App, "id">): WmWindow | undefined {
	const ws = wm.list().filter((w) => windowApp(w.id)?.id === app.id);
	return ws.find((w) => w.appId === WAYLAND) ?? ws[0];
}

/** A terminal app's terminal while it is a tab of a shared Terminal window (no window of its own). */
export const appTab = (app: App): number | undefined =>
	(isPageApp(app) || appWindow(app) ? undefined : termTabs$.get().terms.find((t) => t.name === app.id)?.n);
