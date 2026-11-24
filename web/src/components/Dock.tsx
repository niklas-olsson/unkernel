// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The Dock, macOS style: a pill of glass centered at the bottom (#dock is its
// strip, which the workspace ends above; the material is style.css's
// .glass, its menus' too), whose tiles magnify under a mouse (useMagnify).
// Left to right:
// - the launcher (#dock-launcher: the Launchpad overlay, Launcher.tsx; also
//   Ctrl-A o; dimmed while the system does not run: data-off, store.ts
//   isRunning);
// - the apps and launcher groups kept in the Dock (pins.ts; by default
//   Terminal, Browsers, AI, Desktop, Graphics, Games and Settings; on phones
//   Terminal, glmark2, Galculator, Desktop and Settings), in their order. A
//   group's tile (#dock-group-<id>, GroupFace: its icon in front of a small
//   fan of cards) opens its apps in a stack above it (DockStack.tsx
//   #dock-stack; useStackHover below: a mouse resting on the tile opens it,
//   a click keeps it open, a second click closes it), has a running dot while
//   one of its apps runs and the bar of one being installed; dimmed while the
//   system does not run (a press says why). An app's tile has its app's
//   icon, title and key (appwindows.ts
//   appMeta(): a page app's is its window's). Such a tile stands
//   for the app's window (appwindows.ts windowApp(): a page app's own window,
//   Settings' app-settings, System's app-system; for Terminal the console's
//   Terminal window; a Terminal window whose only tab is a terminal app's; a
//   Wayland window whose app id is a terminal app's, before its Terminal
//   window, its title then the tile's label and menu header): that
//   window then has no tile of its own, and the pinned tile has its running
//   dot, its pressed state, its tab count and its menu, and a click on it does
//   what a click on the window's tile does. A terminal app whose terminal is
//   a tab of a shared Terminal window gets the dot only (its tab's state); a
//   click selects that tab. Not running, a click launches the app
//   (launcher.ts launch()); one that cannot run now (unavailable(), or a
//   terminal app before the system runs) is dimmed, with why in its label
//   and in a toast. Settings' tile is #dock-settings (key ,); another
//   pinned tile has its window's id (#dock-terminal-1 for Terminal,
//   #dock-system, key s), else #dock-app-<id>;
// - a separator, then one tile per other open window (wm.ts), in the order
//   they opened, with its descriptor's icon and key (wm.ts meta) and the
//   name appwindows.ts windowName() gives it, and a dot under it (its
//   status: busy faint, error red; dim while minimized). A Terminal window
//   (termtabs.ts) has one tile for all
//   its tabs (#dock-terminal-K; its tab count when it has several; the tabs
//   themselves, #term-tab-N, are in its title bar); one that holds only an
//   app's terminal (apps/: a REPL, an agent) shows that app's icon and
//   title. A click shows the window
//   (restored, raised, focused; for a Terminal window selectTerminal() of its
//   shown tab); a click on the focused one minimizes it (not in compact
//   mode, where the Dock is the switcher). New tabs open from a Terminal
//   window's own + (#term-tab-new is the console's window's). The guest preview's Browser
//   window is one of these tiles (#dock-preview, key p: preview.ts), and so is
//   the guest's Display window while a program has the display open
//   (#dock-display, key d: display.ts), and each Wayland app's window
//   (#dock-wl-<key>, its title the label and the menu's header; its
//   launcher app's icon, else the guest's for its app id: wayland/host.ts);
// - while wland's relay is connected, #dock-wayland (key w: toggleWayland()):
//   to the Wayland windows (the top one), or, pressed while one has the
//   focus, back to the window under them.
// An app being installed (installer.ts) has its installer window's tile: its
// pinned tile when it is kept (the installer carries its descriptor), else a
// window tile with its icon; either has a progress bar over its face.
// Under a mouse, or with the keyboard's focus ring, a tile shows its label
// above it at once, as on macOS (#dock-label, useDockLabel: one for the
// Dock): its name, then in a quieter tone its state (why it is dimmed, an
// install's progress, minimized) and its key; tiles have no native tooltip.
// A group's tile under a mouse has none (its stack, titled, is what shows),
// but while it is dimmed.
// System's window has a window tile like any other (#dock-system). The
// state, the data disk, memory, Errors, the Control Center and the rest of the
// system's commands are in the top bar (TopBar.tsx).
// While the prefix is armed each item shows its key (which-key style; keys
// are looked up by command id, keys.ts keyFor()); the shortcuts HUD
// (KeysHud.tsx) shows every command. Hidden while the on-screen keyboard is
// up (style.css: kb). Tiles are buttons, so phones get
// around by tapping; coarse pointers get larger targets (style.css). The Dock
// is never wider than the screen: the pinned and window tiles scroll sideways
// when they do not fit, keeping the focused one in view. A right click, a long
// press or Shift-F10 on a tile opens its menu (useTileMenu, windowMenu;
// Menu.tsx): Show, then the window's own items (winmenu.tsx windowItems(),
// as in the top bar's app menu: New Tab, New Window and Close Tab for a
// Terminal window, Minimize, Maximize, Tile Left, Tile Right, Close Window),
// with Keep in Dock before Close Window for one that stands for
// an app not kept (windowApp()); a pinned tile's has its window's items, or
// Open (Show for a tab of a shared window; a group's: its stack), then Move
// Left, Move Right (the order of the pins) and Remove from Dock, and keeps
// them while it is dimmed.
//
// A group's stack (useStackHover, DockStack.tsx), with a mouse (pointerType
// "mouse"; touch and pens tap, as below):
// - Resting on its tile for OPEN_DELAY ms opens it, unpinned, with no button
//   down, no menu open, the system running and the page focused; the focus
//   stays where it is. Resting: the wait starts again each time the pointer
//   has moved more than REST_SLOP px from where it started, so a pointer
//   that crosses the tile, however slowly, opens nothing. With a stack open
//   (not one opened from the keyboard), resting on another group's tile for
//   SWITCH_DELAY ms switches to that one (unpinned, no growing in), unless
//   the pointer is on its way from the open stack's tile to the stack (the
//   triangle from where it left the tile to the stack's bottom corners):
//   then after OPEN_DELAY ms.
// - Unpinned, it closes GRACE ms after the pointer left its tile, the stack,
//   the group tiles and that triangle (or the page), unless its app menu is
//   open; back in time, it stays.
// - A click on the tile opens it pinned, or pins it when a hover opened it;
//   pinned, a click closes it. Pinned, it stays until a press outside, Esc, a
//   pick, the page losing the focus or a resize (DockStack.tsx). Closed with
//   the pointer on its tile, a hover does not open it again before the
//   pointer leaves the tile.
// - A tap (touch, a pen) toggles it, pinned. Enter or Space on the focused
//   tile toggles it, opened from the keyboard (its first app takes the
//   focus; a hover-opened one is pinned and takes it); the focus passing over
//   a tile opens nothing.
// - A tile's menu, the launcher opening, the system stopping or the group
//   leaving the Dock close it. The tile stays pressed (aria-expanded) while
//   its stack is open, the Dock's magnification follows the pointer over
//   the Dock and holds while it is over the stack.
import {
	createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState,
	type Dispatch, type KeyboardEvent as RKeyboardEvent, type MouseEvent, type PointerEvent as RPointerEvent, type ReactNode, type RefObject, type SetStateAction,
} from "react";
import { isPageApp, type App, type Group } from "../apps/types.ts";
import { appMeta, appTab, appWindow, WAYLAND, windowApp, windowName } from "../appwindows.ts";
import { reducedMotion, useLongPress } from "../hooks.ts";
import { useInstalls, type Install } from "../installer.ts";
import { KW } from "../kw.ts";
import { launch, toggleLauncher, unavailable } from "../launcher.ts";
import { canPin, canPinGroup, groupApps, isPinned, move, pin, pinIndex, pinned, unpin, usePins, type PinTarget } from "../pins.ts";
import { command, directKeys, keyFor, PREFIX_SHORT, type CommandId } from "../keys.ts";
import { isRunning, ui$, useStore } from "../store.ts";
import { selectTerminal } from "../terminals.ts";
import { useTermTabs, windowOf } from "../termtabs.ts";
import { useWaylandFocused } from "../wayland.ts";
import { useWm, wm, wm$, type WmWindow } from "../wm.ts";
import { setTileRect } from "../wmfx.ts";
import { showWindow, toggleWayland, windowItems } from "../winmenu.tsx";
import { DockStack, type StackClose } from "./DockStack.tsx";
import {
	AppGlyph, DesktopIcon, GridIcon, MetaIcon,
} from "./icons.tsx";
import { WallpaperCredit } from "./Wallpaper.tsx";
import { TileProgress } from "./Installer.tsx";
import { KeyHint } from "./KeyHint.tsx";
import { Menu, type MenuClose, type MenuEntry } from "./Menu.tsx";

/**
 * A press on a tile never moves the keyboard focus, as on the top bar: it
 * stays where it was (the terminal) until what the tile shows takes it.
 * Keyboard activation keeps the focus on the tile, so focus comes back to
 * it when a system app's window opened from it closes with Esc (sysapps.ts).
 */
const keepFocus = (e: MouseEvent<HTMLElement>) => e.preventDefault();

/** A window's running dot: its status, dim while minimized. */
const dotOf = (w: WmWindow): "on" | "dim" | "busy" | "error" =>
	w.status === "error" ? "error" : w.status === "busy" ? "busy" : w.minimized ? "dim" : "on";

/** A tile's context menu (Menu.tsx): its header and items, built when it renders; null: none (its window is gone). */
interface TileMenu { header: string; items: MenuEntry[] }
type MenuBuild = () => TileMenu | null;
/** Opens a tile's menu against the tile (the Dock's state). */
const DockMenu = createContext<((el: HTMLElement, build: MenuBuild) => void) | null>(null);

/**
 * A tile's menu triggers: a right click (contextmenu), a long press on touch
 * (hooks.ts useLongPress, 500 ms without moving more than 8 px: the tap that
 * ends it does nothing else; a drag or a scroll of the tiles cancels it),
 * Shift-F10 and the ContextMenu key. Returns the button's handlers, its
 * click (`click`) and keepFocus included.
 */
function useTileMenu(build: MenuBuild | undefined, click: (e: MouseEvent<HTMLButtonElement>) => void) {
	const open = useContext(DockMenu);
	const menu = build && open ? (el: HTMLElement) => open(el, build) : undefined;
	const long = useLongPress(menu && ((at) => menu(at.el)), { ms: 500 });
	const onClick = (e: MouseEvent<HTMLButtonElement>) => { if (!long.consumed()) click(e); };
	if (!menu) return { onMouseDown: keepFocus, onClick };
	return {
		onMouseDown: keepFocus,
		onClick,
		onContextMenu: (e: MouseEvent<HTMLButtonElement>) => {
			e.preventDefault();
			long.context();
			menu(e.currentTarget);
		},
		...long.handlers,
		onKeyDown: (e: RKeyboardEvent<HTMLButtonElement>) => {
			if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) { e.preventDefault(); menu(e.currentTarget); }
		},
	};
}

/**
 * A window tile's menu: Show, then the window's items (winmenu.tsx
 * windowItems(), `more` before Close Window: the Dock's items, dockItems()).
 * `header`: its title (else the window's); `open`: a pinned tile's Open
 * while it has no window (else no menu then).
 */
function windowMenu(id: string, header?: string, open?: () => void, more?: () => MenuEntry[]): MenuBuild {
	return () => {
		const extra = more?.() ?? [];
		const items = windowItems(id, { first: [{ label: "Show", run: () => showWindow(id) }], more: extra });
		if (!items) return open ? { header: header ?? id, items: [{ label: "Open", run: open }, ...(extra.length ? [null, ...extra] : [])] } : null;
		return { header: header ?? wm.get(id)?.title ?? id, items };
	};
}

/**
 * The Dock's own items for an app's or a group's tile (pins.ts): Keep in
 * Dock while it is not kept; kept, Move Left and Move Right (with another pin
 * to pass) and Remove from Dock. None for what cannot be pinned (a hidden
 * app) or a window that stands for no app.
 */
function dockItems(t: PinTarget | undefined): MenuEntry[] {
	if (!t || !(t.group ? canPinGroup(t.group) : canPin(t.app))) return [];
	const n = pinned().length, i = pinIndex(t);
	if (i < 0) return [{ label: "Keep in Dock", run: () => pin(t) }];
	const items: MenuEntry[] = [];
	if (n > 1) {
		items.push(
			{ label: "Move Left", disabled: i === 0, run: () => move(t, i - 1) },
			{ label: "Move Right", disabled: i === n - 1, run: () => move(t, i + 1) });
	}
	items.push({ label: "Remove from Dock", run: () => unpin(t) });
	return items;
}

/** A pinned app's tile menu: its window's (windowMenu), else Show (a tab of a shared window) or Open (`open`), with dockItems(). */
function pinMenu(app: App, open: () => void): MenuBuild {
	return () => {
		const w = appWindow(app);
		if (w) return windowMenu(w.id, w.appId === WAYLAND ? windowName(w) : app.title, undefined, () => dockItems({ app }))();
		const n = appTab(app);
		const first: MenuEntry = n !== undefined ? { label: "Show", run: () => selectTerminal(n) } : { label: "Open", run: open };
		return { header: app.title, items: [first, null, ...dockItems({ app })] };
	};
}

/** A tile's note for an install: "installing 40%", "install failed". */
const installNote = (inst: Install | undefined): string =>
	!inst ? "" : inst.state === "failed" ? "install failed" : `installing${inst.progress === null ? "" : ` ${Math.round(inst.progress * 100)}%`}`;

/** A tile's note from its parts, those set: "2 terminals, minimized". */
const notes = (...parts: Array<string | false | undefined>): string => parts.filter(Boolean).join(", ");

/**
 * A Dock tile: a rounded face with the icon, a running dot under it when `dot` is set; `title`: its name
 * (its label, useDockLabel), `note`: its state after it in the label, both in its accessible name unless
 * `label` names it; `cmd`: its command (its key shows while the prefix is armed, and in the label;
 * `shortcut`: another key there instead); `menu`: its context menu; `install`: its app's install (a bar over
 * the face); `expanded`: it opens a popover (a group's stack), shown or not; `onHover`: the pointer entered,
 * moved over or left it.
 */
function Tile({ id, win, title, note, label, cmd, shortcut, on, off, keepMenu, dot, badge, install, expanded, colors, menu, onHover, onClick, children }: {
	id?: string;
	/** An app's own colours (as its launcher tile's): a round disc under its icon, on the Dock's glass face; none: the icon alone. */
	colors?: [string, string];
	/** The window it stands for (data-win: a pinned app's tile stands for its app's window; tileRect() finds it by this). */
	win?: string;
	title: string; note?: string; label?: string; cmd?: CommandId; shortcut?: string; on?: boolean; dot?: "on" | "dim" | "busy" | "error";
	/** It needs a running system, which is not (or its app cannot run): dimmed (style.css data-off), no menu, no magnification; a press still reaches onClick (which says why). */
	off?: boolean;
	/** Its menu stays while it is off (a pinned app's: Remove from Dock). */
	keepMenu?: boolean;
	badge?: string; install?: Install; expanded?: boolean; menu?: MenuBuild;
	onHover?: (e: RPointerEvent<HTMLButtonElement>, how: Hover) => void;
	onClick: (e: MouseEvent<HTMLButtonElement>) => void; children: ReactNode;
}) {
	const handlers = useTileMenu(off && !keepMenu ? undefined : menu, onClick);
	const long = "onPointerLeave" in handlers ? handlers : undefined;
	const hover = onHover && {
		onPointerEnter: (e: RPointerEvent<HTMLButtonElement>) => onHover(e, "enter"),
		onPointerMove: (e: RPointerEvent<HTMLButtonElement>) => { long?.onPointerMove(e); onHover(e, "move"); },
		onPointerLeave: (e: RPointerEvent<HTMLButtonElement>) => { long?.onPointerLeave(); onHover(e, "leave"); },
	};
	const hint = cmd && keyFor(cmd);
	// The label's text (useDockLabel reads it from the button): the name, then the note and the key.
	const quiet = [note, shortcut ?? (hint && `${PREFIX_SHORT} ${hint}`)].filter(Boolean).join(" · ");
	return (
		<button id={id} type="button" aria-label={label ?? notes(title, note)} data-label={title} data-label-note={quiet || undefined} aria-pressed={on}
			aria-haspopup={expanded === undefined ? undefined : "dialog"} aria-expanded={expanded}
			aria-disabled={off || undefined} data-off={off || undefined} data-win={win} className="dock-tile group relative flex-none" {...handlers} {...hover}>
			<span className="dock-face">
				{colors ? <span className="dock-disc" style={{ backgroundImage: `linear-gradient(135deg, ${colors[0]}, ${colors[1]})` }}>{children}</span> : children}
			</span>
			{badge && <span aria-hidden="true" className="absolute right-1 bottom-[calc(7px+2px)] font-mono text-[9.5px] leading-none text-faint">{badge}</span>}
			<TileProgress inst={install} />
			{dot && <span aria-hidden="true" className="dock-dot" data-dot={dot} />}
			{hint && <KeyHint k={hint} />}
		</button>
	);
}

const Sep = () => <span aria-hidden="true" className="dock-sep" />;

/**
 * Where window id's tile is drawn now, for wmfx.ts (a minimized window flies
 * into it, a restored one out of it): the face of the tile that stands for it
 * (data-win, else its dock id), as drawn (magnified or not), kept within the
 * visible part of a strip whose tiles scroll; the Dock's middle when it has
 * no tile; null while the Dock is not shown (the on-screen keyboard).
 */
function tileRect(id: string): DOMRect | null {
	const dock = document.querySelector<HTMLElement>("#dock .dock-pill");
	const d = dock?.getBoundingClientRect();
	if (!dock || !d?.width || !d.height) return null;
	const w = wm.get(id);
	let tile = dock.querySelector<HTMLElement>(`[data-win="${CSS.escape(id)}"]`) ?? document.getElementById(w?.dockId ?? `dock-${id}`);
	if (tile && !dock.contains(tile)) tile = null;
	const face = tile?.querySelector(".dock-face")?.getBoundingClientRect();
	if (!tile || !face?.width) {
		const s = dock.querySelector(".dock-face")?.getBoundingClientRect().width || 40;
		return new DOMRect(d.left + d.width / 2 - s / 2, d.top + (d.height - s) / 2, s, s);
	}
	const strip = tile.closest<HTMLElement>("[data-scroll]");
	if (!strip) return face;
	const r = strip.getBoundingClientRect();
	return new DOMRect(Math.min(Math.max(face.left, r.left), r.right - face.width), face.top, face.width, face.height);
}
setTileRect(tileRect);

/** Show window w (minimize it when it has the focus already). */
function activate(w: WmWindow): void {
	const s = wm$.get();
	if (!w.minimized && s.focused === w.id && !s.compact) { wm.minimize(w.id); return; }
	showWindow(w.id);
}

/** Why a pinned app that is not running cannot start now, or null. */
const whyNot = (app: App, running: boolean): string | null =>
	!isPageApp(app) && !running ? "opens once the system is running" : unavailable(app);

/** A pinned tile's click: its window as a window tile's click (activate()), its tab, else launch the app (or say why not). */
function openPinned(app: App): void {
	const w = appWindow(app);
	if (w) { activate(w); return; }
	const n = appTab(app);
	if (n !== undefined) { selectTerminal(n); return; }
	const why = whyNot(app, isRunning(ui$().get()));
	if (why) { KW.ui?.toast(`${app.title}: ${why}`); return; }
	void launch(app);
}

const GRAY = "#52525b";
/**
 * A pinned group's face: the launcher's folder fan, flat and at the Dock's
 * size (style.css .dock-fan): the group's own icon on its colour in front
 * (the fan's app glyphs would be a few px wide here), two cards in its first
 * apps' colours tilted out behind it, so it reads as a stack.
 */
function GroupFace({ g }: { g: Group }) {
	const behind = groupApps(g).slice(0, 2);
	return (
		<span aria-hidden="true" className="dock-fan">
			{behind.map((a, i) => <span key={a.id} data-fan={i ? "l" : "r"} style={{ background: a.colors?.[0] ?? GRAY }} />).reverse()}
			<span style={{ background: g.colors?.[0] ?? GRAY }}><AppGlyph icon={g.icon ?? g.title[0]!.toUpperCase()} className="size-[62%]" /></span>
		</span>
	);
}

/** A group's app runs: a page app's window is open, or a terminal is named after it. */
const groupLive = (g: Group, terms: { name?: string }[]): boolean =>
	groupApps(g).some((a) => (isPageApp(a) ? !!appWindow(a) : terms.some((x) => x.name === a.id)));

/** A tab's dot (a terminal app in a shared Terminal window): its state, dim while its window is minimized. */
function tabDot(state: "opening" | "open" | "ended" | undefined, w: WmWindow | undefined): "on" | "dim" | "busy" | "error" {
	return state === "ended" ? "error" : state === "opening" ? "busy" : w?.minimized ? "dim" : "on";
}

/** A window tile's note: its tab count, its status. */
const windowNote = (w: WmWindow, tabs: number): string =>
	notes(tabs > 1 && `${tabs} terminals`, w.status === "busy" && "starting", w.status === "error" && "ended", w.minimized && "minimized");

/** A window tile's Keep in Dock: for a window that stands for an app not kept (windowApp(), read when the menu is built). */
function keepItems(id: string): MenuEntry[] {
	const app = windowApp(id);
	return canPin(app) && !isPinned({ app }) ? dockItems({ app }) : [];
}

/** Magnification: the scale of the tile under the pointer, and how far it reaches each side, in tiles. */
const MAG_MAX = 1.3, MAG_REACH = 2.5;
/** A mouse-like pointer (a live MediaQueryList, made once: magnifies() runs on each pointer move). */
const FINE = typeof matchMedia === "function" ? matchMedia("(hover: hover) and (pointer: fine)") : null;
const magnifies = () => !!FINE?.matches && !reducedMotion();

/**
 * macOS-style magnification, for a mouse: the tile under the pointer grows
 * to MAG_MAX from its bottom edge and its neighbours less (a cosine falloff
 * over MAG_REACH tiles each side), and the Dock's other items move aside to
 * make room, so nothing overlaps; the glass (.dock-pill::before) widens by as
 * much each side (--grow-l, --grow-r), the tile under the pointer staying
 * under it. Transforms only: each item gets --mx (and a tile --m, its scale)
 * once a frame, from its layout position (offsetLeft, which transforms do
 * not change). Not on touch, with reduced motion, or while the window tiles
 * scroll (the strip clips then: tiles magnified when they start to go back
 * at once, held or not); not over an open menu. `held` (a tile's
 * menu or a pinned stack is open): it stays as it is, so the tile does not
 * shrink away under its menu, and lets go once the menu closes with the
 * pointer elsewhere. `keep` (a stack the mouse opened): it follows the
 * pointer over the Dock but stays as it is when the pointer leaves the Dock
 * (for the stack above its tile), and lets go likewise.
 */
function useMagnify(dock: RefObject<HTMLElement | null>, strip: RefObject<HTMLElement | null>, held: boolean, keep: boolean): void {
	const hold = useRef(held);
	hold.current = held;
	const stay = useRef(keep);
	stay.current = keep;
	const release = useRef<() => void>(() => {});
	useEffect(() => { if (!held && !keep) release.current(); }, [held, keep]);
	useEffect(() => {
		const nav = dock.current;
		if (!nav) return;
		const styled = new Set<HTMLElement>();
		let x = 0, frame = 0, inside = false;
		const clear = () => {
			cancelAnimationFrame(frame);
			frame = 0;
			for (const el of styled) { el.style.removeProperty("--mx"); el.style.removeProperty("--m"); }
			styled.clear();
			nav.style.removeProperty("--grow-l");
			nav.style.removeProperty("--grow-r");
		};
		const apply = () => {
			frame = 0;
			if (strip.current?.hasAttribute("data-scroll")) return;
			const els = [...nav.children].flatMap((el) => (el === strip.current ? [...el.children] : [el])) as HTMLElement[];
			const items = els.map((el) => ({ el, c: el.offsetLeft + el.offsetWidth / 2, w: el.offsetWidth, tile: el.classList.contains("dock-tile") && !el.hasAttribute("data-off") }));
			const unit = (items.find((it) => it.tile)?.w ?? 40) + 4;
			// g: how much wider the item gets.
			const grown = items.map((it) => {
				const t = Math.abs(x - it.c) / (MAG_REACH * unit);
				return { ...it, g: it.tile && t < 1 ? (it.w * (MAG_MAX - 1) * (1 + Math.cos(Math.PI * t))) / 2 : 0 };
			});
			// k: the growth left of the pointer (the glass widens that much to the left).
			let k = 0, total = 0, left = 0;
			for (const it of grown) { k += it.g * Math.min(1, Math.max(0, (x - it.c + it.w / 2) / (it.w || 1))); total += it.g; }
			for (const it of grown) {
				it.el.style.setProperty("--mx", `${(left + it.g / 2 - k).toFixed(2)}px`);
				if (it.tile) it.el.style.setProperty("--m", (1 + it.g / it.w).toFixed(4));
				left += it.g;
				styled.add(it.el);
			}
			nav.style.setProperty("--grow-l", `${k.toFixed(2)}px`);
			nav.style.setProperty("--grow-r", `${(total - k).toFixed(2)}px`);
		};
		const move = (e: PointerEvent) => {
			inside = true;
			if (hold.current) return;
			if (e.pointerType !== "mouse" || !magnifies() || strip.current?.hasAttribute("data-scroll") || (e.target as Element).closest?.('[role="menu"]')) {
				if (styled.size || frame) clear();
				return;
			}
			x = e.clientX - nav.getBoundingClientRect().left - nav.clientLeft;
			if (!frame) frame = requestAnimationFrame(apply);
		};
		const leave = () => { inside = false; if (!hold.current && !stay.current) clear(); };
		release.current = () => { if (!inside) clear(); };
		// The tiles start to scroll (useScrollFlag): the strip would clip a magnified tile, held or not.
		const scrolls = new MutationObserver(() => { if (strip.current?.hasAttribute("data-scroll")) clear(); });
		if (strip.current) scrolls.observe(strip.current, { attributes: true, attributeFilter: ["data-scroll"] });
		nav.addEventListener("pointermove", move);
		nav.addEventListener("pointerleave", leave);
		return () => { scrolls.disconnect(); nav.removeEventListener("pointermove", move); nav.removeEventListener("pointerleave", leave); clear(); };
	}, [dock, strip]);
}

/**
 * The window tiles' strip gets data-scroll while its tiles do not fit: only
 * then does it scroll sideways (style.css), so a magnified tile is not
 * clipped the rest of the time. Checked after each render and on resize.
 */
function useScrollFlag(strip: RefObject<HTMLElement | null>): void {
	const check = () => { const s = strip.current; if (s) s.toggleAttribute("data-scroll", s.scrollWidth > s.clientWidth + 1); };
	useLayoutEffect(check);
	useEffect(() => {
		const s = strip.current;
		if (!s) return;
		const ro = new ResizeObserver(check);
		ro.observe(s);
		if (s.parentElement) ro.observe(s.parentElement);
		return () => ro.disconnect();
	}, [strip]);
}

/** Scroll the tiles' strip so tile el is in view (only while they scroll). */
function reveal(box: HTMLElement, el: HTMLElement): void {
	if (box.scrollWidth <= box.clientWidth) return;
	const b = box.getBoundingClientRect(), r = el.getBoundingClientRect();
	if (r.left < b.left) box.scrollLeft -= b.left - r.left;
	else if (r.right > b.right) box.scrollLeft += r.right - b.right;
}

/** The label's gap above the tile's drawn face, and its least distance from the viewport's sides (px). */
const LABEL_GAP = 6, LABEL_EDGE = 8;
/** Frames the face holds still before the label stops following it (the magnify transition is .14 s). */
const LABEL_STILL = 8;

/**
 * The tiles' label (#dock-label, `label`), as macOS names a Dock icon: one
 * element in the Dock's root (outside the strip, which clips while it
 * scrolls), moved to the tile under a mouse or the tile with the keyboard's
 * focus ring (:focus-visible), at once. Its text is the tile's data-label
 * (its name) and data-label-note (its state and key, Tile). It is placed by
 * a transform from the tile's face as drawn (magnified), centred over it,
 * within the viewport: read once a frame while the pointer moves and until
 * the face holds still (LABEL_STILL), after each render of the Dock (a
 * changed text, a tile gone) too. Over a gap between tiles it stays. It
 * goes when the pointer leaves the Dock, on a press or Enter (until another
 * tile), when the tiles scroll, and while `off` (a tile's menu or a group's
 * stack is open, the prefix is armed, compact mode); never for touch or a
 * pen, so a tap leaves none, nor for a group's tile under the mouse (its
 * stack shows instead) unless it is dimmed.
 */
function useDockLabel(dock: RefObject<HTMLElement | null>, nav: RefObject<HTMLElement | null>, strip: RefObject<HTMLElement | null>, label: RefObject<HTMLElement | null>, off: boolean): void {
	const off$ = useRef(off);
	off$.current = off;
	const sync = useRef(() => {});
	useLayoutEffect(() => sync.current());
	useEffect(() => {
		const root = dock.current, bar = nav.current, el = label.current, box = strip.current;
		if (!root || !bar || !el) return;
		const [nameEl, noteEl] = [...el.children] as HTMLElement[];
		// tile: the one labelled (null: none shown); focus: for the focus ring, not the pointer; pressed: no label until another tile.
		let tile: HTMLElement | null = null, focus = false, pressed: HTMLElement | null = null;
		let frame = 0, still = 0, last = "", text = "", width = 0;
		const hide = () => {
			tile = null;
			cancelAnimationFrame(frame);
			frame = 0;
			last = "";
			el.removeAttribute("data-show");
		};
		// One frame: the text (a write), then the face's, the Dock's and the label's boxes (one layout), then the transform.
		const place = () => {
			frame = 0;
			if (!tile || off$.current || !bar.contains(tile)) { hide(); return; }
			const t = `${tile.dataset.label ?? ""}\n${tile.dataset.labelNote ?? ""}`;
			if (t !== text) {
				text = t;
				const [name = "", note = ""] = t.split("\n");
				nameEl!.textContent = name;
				noteEl!.textContent = note;
				width = 0;
			}
			const f = (tile.querySelector(".dock-face") ?? tile).getBoundingClientRect(), d = root.getBoundingClientRect();
			if (!f.width) { hide(); return; }
			if (!width) width = el.offsetWidth;
			const key = `${f.left} ${f.top} ${f.width} ${d.left} ${d.top} ${width}`;
			if (key === last) still++;
			else {
				still = 0;
				last = key;
				const half = width / 2, vw = document.documentElement.clientWidth;
				const cx = Math.min(Math.max(f.left + f.width / 2, LABEL_EDGE + half), vw - LABEL_EDGE - half);
				el.style.transform = `translate(${(cx - d.left).toFixed(1)}px, ${(f.top - d.top - LABEL_GAP).toFixed(1)}px) translate(-50%, -100%)`;
			}
			if (!el.hasAttribute("data-show")) el.setAttribute("data-show", "");
			if (still < LABEL_STILL) frame = requestAnimationFrame(place);
		};
		const follow = () => {
			if (off$.current) { if (tile) hide(); return; }
			still = 0;
			if (tile && !frame) frame = requestAnimationFrame(place);
		};
		sync.current = () => { if (tile) follow(); };
		const tileOf = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLElement>(".dock-tile") : null);
		const ring = (t: Element) => { try { return t.matches(":focus-visible"); } catch { return false; } };
		const move = (e: PointerEvent) => {
			if (e.pointerType !== "mouse" || e.buttons) return;
			const t = tileOf(e.target);
			if (t && t !== pressed) {
				pressed = null;
				focus = false;
				// A group's tile opens its stack under the mouse instead (but dimmed).
				if (t.getAttribute("aria-haspopup") === "dialog" && !t.hasAttribute("data-off")) { hide(); return; }
				tile = t;
			}
			follow();
		};
		const leave = () => {
			pressed = null;
			if (focus) return;
			hide();
			// Back to the tile with the focus ring, if one has it.
			const a = document.activeElement;
			if (a instanceof HTMLElement && a.classList.contains("dock-tile") && bar.contains(a) && ring(a)) { tile = a; focus = true; follow(); }
		};
		const down = (e: PointerEvent) => { pressed = tileOf(e.target); hide(); };
		const key = (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { pressed = tileOf(e.target); hide(); } };
		const focusIn = (e: FocusEvent) => {
			const t = tileOf(e.target);
			if (!t || t !== e.target || t === pressed || !ring(t)) return;
			pressed = null;
			tile = t;
			focus = true;
			follow();
		};
		const focusOut = (e: FocusEvent) => { if (focus && !(e.relatedTarget instanceof Node && bar.contains(e.relatedTarget))) hide(); };
		const scrolled = () => { if (tile) { pressed = tile; hide(); } };
		bar.addEventListener("pointermove", move);
		bar.addEventListener("pointerleave", leave);
		bar.addEventListener("pointerdown", down);
		bar.addEventListener("keydown", key);
		bar.addEventListener("focusin", focusIn);
		bar.addEventListener("focusout", focusOut);
		box?.addEventListener("scroll", scrolled, { passive: true });
		return () => {
			sync.current = () => {};
			hide();
			bar.removeEventListener("pointermove", move);
			bar.removeEventListener("pointerleave", leave);
			bar.removeEventListener("pointerdown", down);
			bar.removeEventListener("keydown", key);
			bar.removeEventListener("focusin", focusIn);
			bar.removeEventListener("focusout", focusOut);
			box?.removeEventListener("scroll", scrolled);
		};
	}, [dock, nav, strip, label]);
}

/**
 * The open group stack (DockStack.tsx): its group, its tile, the y it stands above (stackTop()), opened from
 * the keyboard, opened by a hover and not pinned, it replaced another (no growing in).
 */
interface Stack { group: Group; el: HTMLElement; top: number; kb: boolean; hover: boolean; quick: boolean }

/** What the pointer did on a group's tile (Tile onHover). */
type Hover = "enter" | "move" | "leave";
/**
 * A mouse resting on a group's tile this long opens its stack; with another stack open, this long switches to
 * it; one a hover opened closes this long after the pointer left (ms).
 */
const OPEN_DELAY = 500, SWITCH_DELAY = 130, GRACE = 300;
/** The pointer rests while it stays this close to where the wait started (px); further, the wait starts again. */
const REST_SLOP = 5;
/** How far the triangle toward the stack reaches past its bottom corners (px). */
const AIM_SLACK = 12;

/**
 * The y a stack stands above: its tile's top, or with magnification the top
 * of the tile fully magnified, so the stack does not move up and down as the
 * tile under it grows, nor when it switches to another tile.
 */
function stackTop(el: HTMLElement): number {
	const r = el.getBoundingClientRect(), pill = el.closest(".dock-pill")?.getBoundingClientRect();
	if (!pill || !magnifies() || el.closest("[data-scroll]")) return r.top;
	return Math.min(r.top, pill.top + el.offsetTop - (MAG_MAX - 1) * el.offsetHeight);
}

/** Point (x, y) is in the triangle a, b, c (its edges included). */
function inTriangle(x: number, y: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
	const side = (px: number, py: number, qx: number, qy: number) => (x - qx) * (py - qy) - (px - qx) * (y - qy);
	const d1 = side(ax, ay, bx, by), d2 = side(bx, by, cx, cy), d3 = side(cx, cy, ax, ay);
	return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/**
 * A group's stack under the mouse (the header's list: OPEN_DELAY,
 * SWITCH_DELAY, REST_SLOP, GRACE, the triangle toward the stack). Returns
 * `tile` (a group tile's pointer entered, moved or left it), `cancel` (a pending open goes: a press, a menu, a click) and
 * `closed` (a stack closed: with the pointer on its tile, no hover opens it
 * again before the pointer leaves). A stable object; it reads the stack from
 * a ref.
 */
function useStackHover(stack: Stack | null, setStack: Dispatch<SetStateAction<Stack | null>>) {
	const now = useRef(stack);
	now.current = stack;
	// intent: the open pending (its tile, where the wait started, its timer); exit: where the pointer left the open stack's tile; quiet: a tile the
	// pointer is on whose stack just closed.
	const intent = useRef<{ el: HTMLElement; x: number; y: number; t: ReturnType<typeof setTimeout> } | null>(null);
	const exit = useRef<{ x: number; y: number } | null>(null);
	const quiet = useRef<HTMLElement | null>(null);
	const [api] = useState(() => {
		const cancel = () => { if (intent.current) { clearTimeout(intent.current.t); intent.current = null; } };
		/** On the way from the open stack's tile to the stack: above the tile, or in the triangle from where it left the tile to the stack's bottom corners. */
		const aiming = (x: number, y: number): boolean => {
			const s = now.current, from = exit.current, box = document.getElementById("dock-stack")?.getBoundingClientRect();
			if (!s || !box?.width) return false;
			const r = s.el.getBoundingClientRect();
			if (x >= r.left && x <= r.right && y >= box.bottom && y <= r.bottom) return true;
			return !!from && inTriangle(x, y, from.x, from.y, box.left - AIM_SLACK, box.bottom, box.right + AIM_SLACK, box.bottom);
		};
		/** A hover may open one: the page has the focus, the system runs, no menu is open. */
		const may = () => document.hasFocus() && isRunning(ui$().get()) && !document.querySelector('[role="menu"]');
		const open = (g: Group, el: HTMLElement) => setStack((s) => (s?.kb || s?.group.id === g.id || !el.isConnected ? s
			: { group: g, el, top: stackTop(el), kb: false, hover: true, quick: !!s }));
		const tile = (g: Group, e: RPointerEvent<HTMLButtonElement>, how: Hover) => {
			const el = e.currentTarget, s = now.current, p = intent.current;
			if (how === "leave") {
				if (p?.el === el) cancel();
				if (quiet.current === el) quiet.current = null;
				if (s?.el === el) exit.current = { x: e.clientX, y: e.clientY };
				return;
			}
			if (s?.el === el) { exit.current = null; return; }
			if (e.pointerType !== "mouse" || e.buttons || quiet.current === el || s?.kb || !may()) { if (p?.el === el) cancel(); return; }
			// Resting where the wait started: it goes on. Else it starts (again) from here.
			if (p?.el === el && Math.hypot(e.clientX - p.x, e.clientY - p.y) <= REST_SLOP) return;
			cancel();
			// Another stack is open: this one after SWITCH_DELAY, unless the pointer is on its way to that stack.
			const ms = s && !aiming(e.clientX, e.clientY) ? SWITCH_DELAY : OPEN_DELAY;
			intent.current = { el, x: e.clientX, y: e.clientY, t: setTimeout(() => { intent.current = null; if (el.matches(":hover") && may()) open(g, el); }, ms) };
		};
		const closed = (el: HTMLElement | undefined) => { if (el?.matches(":hover")) quiet.current = el; };
		return { tile, cancel, closed, aiming };
	});
	// A press anywhere: no hover opens one now.
	useEffect(() => {
		document.addEventListener("pointerdown", api.cancel, true);
		return () => { document.removeEventListener("pointerdown", api.cancel, true); api.cancel(); };
	}, [api]);
	// One a hover opened: it goes GRACE ms after the pointer left its tile, the stack (and its app menu), the group
	// tiles (another's hover switches) and the way to it, or left the page; back in time, it stays.
	useEffect(() => {
		exit.current = null;
		if (!stack?.hover) return;
		let t: ReturnType<typeof setTimeout> | undefined;
		const keep = () => { clearTimeout(t); t = undefined; };
		const away = () => {
			if (document.getElementById("dock-stack-menu")) return;
			t ??= setTimeout(() => setStack((s) => (s?.hover ? null : s)), GRACE);
		};
		const move = (e: PointerEvent) => {
			if (e.pointerType !== "mouse") return;
			const at = e.target instanceof Element ? e.target : null;
			if (at?.closest("#dock-stack, #dock-stack-menu")) { exit.current = null; keep(); }
			else if ((at && stack.el.contains(at)) || at?.closest('.dock-tile[aria-haspopup="dialog"]:not([data-off])') || api.aiming(e.clientX, e.clientY)) keep();
			else away();
		};
		const out = (e: globalThis.MouseEvent) => { if (!e.relatedTarget) away(); };
		document.addEventListener("pointermove", move, true);
		document.addEventListener("mouseout", out, true);
		return () => {
			keep();
			document.removeEventListener("pointermove", move, true);
			document.removeEventListener("mouseout", out, true);
		};
	}, [stack, setStack, api]);
	return api;
}

export function Dock() {
	const wayland = useStore((s) => s.wayland);
	const wlFocused = useWaylandFocused();
	const launcher = useStore((s) => s.launcher);
	const running = useStore(isRunning);
	const windows = useWm((s) => s.windows);
	const focused = useWm((s) => s.focused);
	const termWindows = useTermTabs((s) => s.windows);
	const terms = useTermTabs((s) => s.terms);
	const pins = usePins();
	const installs = useInstalls();
	// Each pinned app and the window its tile stands for (windowApp() reads the windows' descriptors,
	// which termtabs.ts keeps current); those windows get no tile of their own.
	const pinWins = pins.map((p) => (p.app ? appWindow(p.app) : undefined));
	const claimed = new Set(pinWins.flatMap((w) => (w ? [w.id] : [])));
	const appWins = windows.filter((w) => !claimed.has(w.id));
	const strip = useRef<HTMLDivElement>(null);
	const nav = useRef<HTMLElement>(null);
	const root = useRef<HTMLElement>(null);
	const label = useRef<HTMLDivElement>(null);
	const prefix = useStore((s) => s.prefix);
	const compact = useWm((s) => s.compact);
	// The open group stack (DockStack.tsx) and its hover controller (useStackHover).
	const [stack, setStack] = useState<Stack | null>(null);
	const hover = useStackHover(stack, setStack);
	// A tile's context menu (useTileMenu), built again on each render so it follows its window.
	const [menu, setMenu] = useState<{ el: HTMLElement; rect: DOMRect; build: MenuBuild } | null>(null);
	const openMenu = useCallback((el: HTMLElement, build: MenuBuild) => {
		hover.cancel();
		setStack(null);
		setMenu((m) => (m?.el === el ? m : { el, rect: el.getBoundingClientRect(), build }));
	}, [hover]);
	/**
	 * A group tile's click (or Enter, `kb`): its stack, opened pinned; one a hover opened is pinned (from the
	 * keyboard its first app takes the focus); a pinned one closes. Once the system runs; before, why not.
	 */
	const toggleStack = (g: Group, el: HTMLElement | null, kb: boolean) => {
		hover.cancel();
		if (!isRunning(ui$().get())) { KW.ui?.toast(`${g.title}: opens once the system is running`); return; }
		if (!el) { setStack(null); return; }
		if (stack?.group.id === g.id) {
			if (stack.hover) setStack({ ...stack, hover: false, kb: stack.kb || kb });
			else { hover.closed(el); setStack(null); }
			return;
		}
		if (strip.current) reveal(strip.current, el);
		setStack({ group: g, el, top: stackTop(el), kb, hover: false, quick: false });
	};
	const closeStack = (how: StackClose) => {
		const el = stack?.el;
		hover.closed(el);
		setStack(null);
		if (how === "key" && el?.isConnected) el.focus({ preventScroll: true });
	};
	// Its group was taken out of the Dock, the system stopped or the launcher opened: it goes.
	useEffect(() => {
		if (stack && (!running || launcher || !pins.some((p) => p.group?.id === stack.group.id) || !stack.el.isConnected)) setStack(null);
	}, [stack, running, launcher, pins]);
	const spec = menu?.build() ?? null;
	useEffect(() => { if (menu && !spec) setMenu(null); }, [menu, spec]);
	/** Esc or Tab gives the focus back to the tile; a pick leaves it where the pick put it. */
	const closeMenu = (how: MenuClose) => {
		const el = menu?.el;
		setMenu(null);
		if (how === "key" && el?.isConnected) el.focus({ preventScroll: true });
	};
	useScrollFlag(strip);
	useMagnify(nav, strip, !!menu || (!!stack && !stack.hover), !!stack?.hover);
	// No label over an open menu or stack, the shortcuts HUD and the tiles' key hints (the prefix), or on a phone.
	useDockLabel(root, nav, strip, label, !!menu || !!stack || prefix || compact);
	// Keep the focused window's tile in view when the tiles scroll (phones).
	useEffect(() => {
		const box = strip.current, el = box?.querySelector<HTMLElement>(':scope > [aria-pressed="true"]');
		if (box && el) reveal(box, el);
	}, [focused, appWins.length, pins.length]);
	const wlTitles = wayland.windows.map((w) => w.title || "untitled").join(", "), wlCount = wayland.windows.length;
	const views = wayland.attached || wlFocused;

	return (
		<footer id="dock" ref={root} aria-label="Dock" className="relative flex flex-none items-center justify-center select-none">
			{!compact && <WallpaperCredit />}
			<div id="dock-label" ref={label} aria-hidden="true"><span /><span /></div>
			{menu && spec && <Menu id="dock-tile-menu" label={spec.header} header={spec.header} items={spec.items} anchor={menu.rect} onClose={closeMenu} />}
			{stack && <DockStack key={stack.group.id} group={stack.group} tile={stack.el} top={stack.top} kb={stack.kb} quick={stack.quick} inside={(t) => !!stack.el.contains(t as Node)} onClose={closeStack} />}
			<DockMenu.Provider value={openMenu}>
			<nav ref={nav} aria-label="Windows and system" className="dock-pill">
				<Tile id="dock-launcher" title="Apps" label="unkernel: Apps" cmd="launcher" shortcut={directKeys(command("launcher"))[0]} on={launcher} off={!running} onClick={toggleLauncher}
					menu={() => ({ header: "Apps", items: [{ label: launcher ? "Close Apps" : "Open Apps", icon: <GridIcon />, run: toggleLauncher }] })}>
					<GridIcon size={19} />
				</Tile>
				<div ref={strip} className="dock-apps">
					{pins.map((p, i) => {
						if (p.group) {
							const g = p.group, open = stack?.group.id === g.id;
							const instApp = groupApps(g).find((a) => installs[a.id]);
							const inst = instApp && installs[instApp.id];
							return (
								<Tile key={`pin-${p.key}`} id={`dock-group-${g.id}`} title={g.title}
									note={instApp ? notes(instApp.title, installNote(inst)) : !running ? "opens once the system is running" : undefined}
									off={!running} keepMenu expanded={open} install={inst} dot={groupLive(g, terms) ? "on" : undefined}
									menu={() => ({ header: g.title, items: [{ label: "Open", run: () => toggleStack(g, document.getElementById(`dock-group-${g.id}`), true) }, null, ...dockItems({ group: g })] })}
									onHover={(e, how) => hover.tile(g, e, how)} onClick={(e) => toggleStack(g, e.currentTarget, e.detail === 0)}>
									<GroupFace g={g} />
								</Tile>
							);
						}
						const app = p.app, w = pinWins[i], meta = appMeta(app);
						// Without a window of its own: a terminal app's terminal in a shared Terminal window.
						const n = w || isPageApp(app) ? undefined : terms.find((x) => x.name === app.id)?.n;
						const tabWin = n !== undefined ? windowOf(n) : undefined;
						const tabs = w ? termWindows.find((t) => t.id === w.id)?.tabs.length ?? 0 : 0;
						const why = w || n !== undefined ? null : whyNot(app, running);
						const inst = installs[app.id];
						const title = !inst && w?.appId === WAYLAND ? windowName(w) : meta.title;
						const note = inst ? notes(installNote(inst), w?.minimized && "minimized")
							: w ? windowNote(w, tabs) : n !== undefined ? `running in terminal ${n}` : why ?? undefined;
						// Settings' pinned tile is #dock-settings with or without its window (whose Dock id it is), a handle the tests use.
						return (
							<Tile key={`pin-${app.id}`} id={app.id === "settings" ? "dock-settings" : w ? w.dockId ?? `dock-${w.id}` : `dock-app-${app.id}`} win={w?.id}
								title={title} note={note} cmd={meta.cmd} colors={meta.colors}
								on={!!w && focused === w.id} off={!!why} keepMenu badge={tabs > 1 ? String(tabs) : undefined} install={inst}
								dot={w ? dotOf(w) : n !== undefined ? tabDot(terms.find((x) => x.n === n)?.state, tabWin && windows.find((x) => x.id === tabWin.id)) : undefined}
								menu={pinMenu(app, () => openPinned(app))} onClick={() => openPinned(app)}>
								<MetaIcon meta={meta} size={19} />
							</Tile>
						);
					})}
					{appWins.length > 0 && <Sep />}
					{appWins.map((w) => {
						const tw = termWindows.find((t) => t.id === w.id);
						const tabs = tw?.tabs.length ?? 0;
						const name = windowName(w);
						const inst = w.appId === "installer" ? installs[w.meta.id] : undefined;
						return (
							<Tile key={w.id} id={w.dockId ?? `dock-${w.id}`} win={w.id} title={name} note={inst ? notes(installNote(inst), w.minimized && "minimized") : windowNote(w, tabs)} cmd={w.meta.cmd} colors={w.meta.colors}
								on={focused === w.id} badge={tabs > 1 ? String(tabs) : undefined} install={inst}
								dot={dotOf(w)}
								menu={windowMenu(w.id, name, undefined, () => keepItems(w.id))} onClick={() => activate(w)}>
								<MetaIcon meta={w.meta} size={19} />
							</Tile>
						);
					})}
				</div>
				{views && <Sep />}
				{views && (
					<Tile id="dock-wayland" on={wlFocused} cmd="wayland" dot={wayland.attached ? "on" : undefined} onClick={toggleWayland}
						title="Wayland apps" note={wlCount ? `${wlCount} window${wlCount > 1 ? "s" : ""}` : "no windows"}
						label={`Wayland apps${wlTitles ? ` (${wlTitles})` : ", no windows"}: ${wlFocused ? "back to the other windows" : "show them"}`}>
						<DesktopIcon size={19} />
					</Tile>
				)}
			</nav>
			</DockMenu.Provider>
		</footer>
	);
}
