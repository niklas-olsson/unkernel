// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The window manager: the desktop's windows as plain state (its own store,
// read with useWm()), and the operations on them. React only draws it
// (components/Workspace.tsx, Window.tsx, Dock.tsx); apps (termtabs.ts: the
// Terminal windows) open and drive windows through `wm` and never through React.
//
// The app/window contract (WindowSpec), shaped loosely like xdg_toplevel:
// - id: unique and stable (a Terminal window is terminal-K: termtabs.ts);
//   meta: what the chrome shows of it (apps/types.ts AppMeta: the name the
//   top bar and its Dock tile give it, its icon there and in its title bar,
//   its key), declared once by the window kind that opens it and updated
//   with the window when it changes; appId: the window's kind, for CSS (the
//   body has data-app; default meta.id, kept when meta changes); title: the
//   window's own (default meta.title); titleContent: a React node drawn in the title bar
//   in place of the title (the Terminal windows' tab strip), and in the
//   compact strip; presses on its buttons do not move the window, presses
//   on the rest of it do;
// - frame: "normal" draws a title bar (title, minimize, maximize, close; drag
//   it to move, double-click or double-tap it to maximize), "none" draws
//   nothing: the app draws its own decorations (a Wayland toplevel with
//   client-side decorations) and starts moves and resizes itself with
//   startMove() and startResize() (xdg_toplevel.move/resize). Both get resize
//   edges and corners, and both are raised and focused by a press anywhere;
// - content: an element the window mounts in its body (and moves there if it
//   is elsewhere; it is never recreated, so an app may keep state in it), or
//   a React node it renders. An element lent elsewhere for a while comes
//   back with adoptContent(id) (components/Window.tsx); onRelease(el): the
//   body let go of it (the window closed and its close effect is over), so
//   the app can keep it somewhere (else it goes with the body);
// - geometry: x, y, w, h in CSS px in the workspace (the area between the top bar and the Dock);
//   left out, a new window is cascaded from the top one at w x h (default
//   DEFAULT_W x DEFAULT_H), or centered when it is the first; minW, minH; it is
//   clamped into the workspace when that shrinks (a maximized one when it is
//   restored). maximized: open maximized;
// - closable (default true; false: no close button, close() refuses);
//   resizable (default true; false: a fixed-size window, such as an app's
//   installer: no edges, no maximize button or double-click, no tiles; its
//   app may still resize() it, and compact mode still draws it maximized);
// - status: "busy" or "error", shown on the Dock's running dot;
// - dockId: the Dock item's element id;
// - onClose(): a request (the close button, close()); returning false keeps
//   the window (the app may close it later with remove(), say after asking);
//   onFocus()/onBlur(): it became the focused window, or stopped being it
//   (keys go where the app puts the DOM focus); onVisible(visible): shown or
//   not (minimized; in compact mode, not the one on top), so an app can stop
//   painting; onResize(size): its content box's size changed.
//
// State: windows in the order they opened (the Dock's order, and React's, so
// raising one never moves DOM nodes), z-order (order, bottom to top), one
// focused window (the top one that is not minimized; focusing raises), the
// workspace's size, and compact: phones and narrow viewports, where every
// window is drawn maximized without chrome, only the top one shows, and the
// Dock is the switcher. Geometry is kept in compact mode and used again when
// the viewport widens. While a maximized window is shown (dockHides()) the
// Dock hides itself and the workspace takes its strip too. Callbacks run
// synchronously from the store's listener after each change, so an app sees
// focus and visibility changes at once.
//
// Snapping (the snap section below; the geometry is wmsnap.ts's): a window's
// x, y, w, h are always its own geometry; maximized, or snapped to a tile
// (snap: a half or a quarter of the workspace, with gaps), it is drawn at
// that instead (drawnGeom), so the own geometry is what Restore, a drag out
// and the keys go back to, and tiles follow the workspace's size by
// themselves. A move (startMove: the title bar, an app's own) shows the
// zone under the pointer (snapPreview$, components/SnapPreview.tsx) and
// tiles or maximizes the window when it is released there; Esc ends the move
// where it started. Dragging a tiled or maximized window restores its own
// size under the pointer; resizing a tiled one by hand makes the tile its
// own geometry; maximizing one forgets the tile. A frameless app sizes
// itself: the size it takes for its tile is kept (fitTile) and drawn against
// the tile's outer side and corner.
import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import type { AppMeta } from "./apps/types.ts";
import { createStore } from "./store.ts";
import { anchorTile, nextTile, tileRect, zoneAt, type Arrow, type Snap, type Zone } from "./wmsnap.ts";

export type Frame = "normal" | "none";
/** A resize edge or corner. */
export type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export interface Geom { x: number; y: number; w: number; h: number }

export interface WindowSpec {
	id: string;
	meta: AppMeta;
	/** Default meta.id. */
	appId?: string;
	/** Default meta.title. */
	title?: string;
	/** Drawn in the title bar in place of the title (see the top of this file). */
	titleContent?: ReactNode;
	frame?: Frame;
	content: HTMLElement | ReactNode;
	x?: number;
	y?: number;
	w?: number;
	h?: number;
	minW?: number;
	minH?: number;
	maximized?: boolean;
	closable?: boolean;
	/** Default true; false: a fixed size (see the top of this file). */
	resizable?: boolean;
	status?: "busy" | "error";
	dockId?: string;
	onClose?(): boolean | void;
	onFocus?(): void;
	onBlur?(): void;
	onVisible?(visible: boolean): void;
	onResize?(size: { w: number; h: number }): void;
	onRelease?(el: HTMLElement): void;
}

/** A window as the store keeps it: its spec, and where and how it is now. */
export interface WmWindow extends Omit<WindowSpec, "x" | "y" | "w" | "h" | "frame" | "maximized" | "appId" | "title">, Geom {
	appId: string;
	title: string;
	frame: Frame;
	minimized: boolean;
	maximized: boolean;
	/** Snapped to a tile (not while maximized): drawn there, x, y, w, h kept as its own geometry. */
	snap: Snap | null;
	/** The size a frameless app took for its tile (fitTile), while the tile is tw x th. */
	tileSize?: { tw: number; th: number; w: number; h: number };
	/** It has a geometry in the workspace (placed once the workspace has a size outside compact mode). */
	placed: boolean;
}

export interface WmState {
	/** In the order they opened. */
	windows: WmWindow[];
	/** Ids, bottom to top. */
	order: string[];
	focused: string | null;
	/** The workspace's size (0 until it is measured). */
	area: { w: number; h: number };
	compact: boolean;
}

/** A new window's size when its spec gives none. */
export const DEFAULT_W = 760, DEFAULT_H = 480;
const MIN_W = 240, MIN_H = 140;
/** A moved window keeps this much of its title bar inside the workspace. */
const KEEP = 72, TITLE = 34;
/** The cascade's step. */
const STEP = 30;

const $ = createStore<WmState>({ windows: [], order: [], focused: null, area: { w: 0, h: 0 }, compact: false });
export const wm$ = $;

/** A field of the WM's state; the component re-renders when it changes. */
export function useWm<U>(select: (s: WmState) => U): U {
	return useSyncExternalStore($.subscribe, () => select($.get()));
}

const find = (s: WmState, id: string | null) => (id ? s.windows.find((w) => w.id === id) : undefined);
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** Shown: not minimized, and in compact mode the top one. */
export function isVisible(w: WmWindow, s: WmState = $.get()): boolean {
	if (w.minimized) return false;
	if (!s.compact) return true;
	return topId(s) === w.id;
}
/** The top window that is not minimized. */
function topId(s: WmState): string | null {
	for (let i = s.order.length - 1; i >= 0; i--) {
		const w = find(s, s.order[i]!);
		if (w && !w.minimized) return w.id;
	}
	return null;
}

/** The Dock hides itself (components/Dock.tsx) and the workspace has its strip: a maximized window is shown. Not in compact mode, where the Dock is the switcher. */
export const dockHides = (s: WmState = $.get()): boolean => !s.compact && s.windows.some((w) => w.maximized && !w.minimized);

/** The geometry it is drawn at: maximized (or compact) fills the workspace, snapped its tile (snapGeom). */
export function drawnGeom(w: WmWindow, s: WmState = $.get()): Geom {
	return w.maximized || s.compact ? { x: 0, y: 0, w: s.area.w, h: s.area.h } : w.snap ? snapGeom(w, s.area) : { x: w.x, y: w.y, w: w.w, h: w.h };
}

/** Fit a geometry into the workspace: as large as it may be, then wholly inside it where it fits. */
function fit(g: Geom, w: WmWindow, area: WmState["area"]): Geom {
	if (!area.w || !area.h) return g;
	const ww = clamp(g.w, Math.min(w.minW ?? MIN_W, area.w), area.w), hh = clamp(g.h, Math.min(w.minH ?? MIN_H, area.h), area.h);
	return { w: ww, h: hh, x: clamp(g.x, 0, area.w - ww), y: clamp(g.y, 0, area.h - hh) };
}

/** Where a new window goes: as its spec says, else centered (the first) or cascaded from the top placed one. */
function place(w: WmWindow, s: WmState): WmWindow {
	const { area } = s;
	const ww = Math.min(w.w, area.w), hh = Math.min(w.h, area.h);
	let x: number, y: number;
	const anchor = [...s.order].reverse().map((id) => find(s, id)).find((o) => o && o.id !== w.id && o.placed && !o.minimized && !o.maximized && !o.snap);
	if (specPos.has(w.id)) {
		x = w.x; y = w.y;
	} else if (!anchor) {
		x = (area.w - ww) / 2; y = (area.h - hh) / 2;
	} else {
		x = anchor.x + STEP; y = anchor.y + STEP;
		if (x + ww > area.w || y + hh > area.h) {
			const k = s.windows.length % 6;
			x = 24 + k * STEP; y = 16 + k * STEP;
		}
	}
	specPos.delete(w.id);
	return { ...w, ...fit({ x: Math.round(x), y: Math.round(y), w: ww, h: hh }, w, area), placed: true };
}
/** Windows whose spec gave a position, until they are placed. */
const specPos = new Set<string>();

/** Keep the invariants: one focused window, the top visible one; unplaced windows placed when they can be. */
function commit(next: WmState): void {
	let s = next;
	if (s.area.w > 0 && s.area.h > 0 && !s.compact && s.windows.some((w) => !w.placed)) {
		let cur = s;
		for (const w of s.windows) if (!w.placed) cur = { ...cur, windows: cur.windows.map((o) => (o.id === w.id ? place(o, cur) : o)) };
		s = cur;
	}
	const f = find(s, s.focused);
	if (!f || f.minimized || (s.compact && topId(s) !== f.id)) s = { ...s, focused: topId(s) };
	$.set(s);
}

/** A window's spec fields that update() may change. */
export type WindowPatch = Partial<Omit<WindowSpec, "id" | "appId" | "x" | "y" | "w" | "h" | "maximized">>;

/**
 * Open a window (focused and on top, unless `focus` is false: then at the
 * bottom). An id that is already open is updated with the spec and focused.
 */
function open(spec: WindowSpec, { focus = true }: { focus?: boolean } = {}): string {
	const s = $.get();
	if (find(s, spec.id)) {
		const { x: _x, y: _y, w: _w, h: _h, maximized: _m, appId: _a, ...patch } = spec;
		update(spec.id, patch);
		if (focus) focusWin(spec.id);
		return spec.id;
	}
	if (spec.x !== undefined && spec.y !== undefined) specPos.add(spec.id);
	const w: WmWindow = {
		...spec, appId: spec.appId ?? spec.meta.id, title: spec.title ?? spec.meta.title, frame: spec.frame ?? "normal",
		x: spec.x ?? 0, y: spec.y ?? 0, w: spec.w ?? DEFAULT_W, h: spec.h ?? DEFAULT_H,
		minimized: false, maximized: !!spec.maximized, snap: null, placed: false,
	};
	commit({
		...s, windows: [...s.windows, w],
		order: focus ? [...s.order, w.id] : [w.id, ...s.order],
		focused: focus ? w.id : s.focused,
	});
	return w.id;
}

/** Ask the window to close: onClose() may keep it (false), else it is removed. False: it stays. */
function close(id: string): boolean {
	const w = find($.get(), id);
	if (!w || w.closable === false) return false;
	if (w.onClose?.() === false) return false;
	remove(id);
	return true;
}

/** Remove a window at once (the app closed it); the next one down takes the focus. */
function remove(id: string): void {
	const s = $.get();
	if (!find(s, id)) return;
	commit({ ...s, windows: s.windows.filter((w) => w.id !== id), order: s.order.filter((o) => o !== id), focused: s.focused === id ? null : s.focused });
}

/** Raise it, restore it if minimized, and give it the focus. */
function focusWin(id: string): void {
	const s = $.get(), w = find(s, id);
	if (!w) return;
	if (s.focused === id && !w.minimized && s.order[s.order.length - 1] === id) return;
	commit({
		...s, focused: id,
		order: [...s.order.filter((o) => o !== id), id],
		windows: w.minimized ? s.windows.map((o) => (o.id === id ? { ...o, minimized: false } : o)) : s.windows,
	});
}

function patchWin(id: string, f: (w: WmWindow, s: WmState) => Partial<WmWindow>): void {
	const s = $.get(), w = find(s, id);
	if (!w) return;
	commit({ ...s, windows: s.windows.map((o) => (o.id === id ? { ...o, ...f(o, s) } : o)) });
}

/** Minimize it: hidden, out of the focus order (the Dock restores it). */
const minimize = (id: string): void => patchWin(id, () => ({ minimized: true }));
/** Maximize it (true; a tile is forgotten), restore its own geometry (false; from a tile too), or toggle. */
const maximize = (id: string, on?: boolean): void => patchWin(id, (w, s) => ((on ?? !w.maximized) ? (w.resizable === false ? {} : { maximized: true, ...UNSNAP }) : { maximized: false, ...UNSNAP, ...unmaxGeom(w, s) }));
/** Back to its own geometry, shown. */
const restore = (id: string): void => { patchWin(id, (w, s) => ({ maximized: false, minimized: false, ...UNSNAP, ...unmaxGeom(w, s) })); focusWin(id); };
/** A maximized or snapped window keeps its own geometry while the workspace shrinks (setArea): fitted when it is restored. */
const unmaxGeom = (w: WmWindow, s: WmState): Partial<Geom> => ((w.maximized || w.snap) && w.placed ? fit(w, w, s.area) : {});
const UNSNAP = { snap: null, tileSize: undefined } satisfies Partial<WmWindow>;

/** Move it, keeping part of its title bar inside the workspace. */
function move(id: string, x: number, y: number): void {
	patchWin(id, (w, s) => {
		const { area } = s;
		if (!area.w) return { x, y };
		return { x: Math.round(clamp(x, KEEP - w.w, area.w - KEEP)), y: Math.round(clamp(y, 0, area.h - TITLE)) };
	});
}
/** Set its geometry (any of x, y, w, h), within its minimum size and the workspace. A snapped window leaves its tile (from the tile's geometry). */
function resize(id: string, g: Partial<Geom>): void {
	patchWin(id, (w0, s) => {
		const w = w0.snap ? { ...w0, ...snapGeom(w0, s.area) } : w0;
		const n = { x: g.x ?? w.x, y: g.y ?? w.y, w: g.w ?? w.w, h: g.h ?? w.h };
		n.w = Math.max(n.w, w.minW ?? MIN_W);
		n.h = Math.max(n.h, w.minH ?? MIN_H);
		if (s.area.w) { n.w = Math.min(n.w, s.area.w); n.h = Math.min(n.h, s.area.h); }
		return { x: Math.round(n.x), y: Math.round(n.y), w: Math.round(n.w), h: Math.round(n.h), placed: true, ...UNSNAP };
	});
}
/** Change spec fields (title, meta, status, callbacks…). */
function update(id: string, patch: WindowPatch): void {
	patchWin(id, () => patch as Partial<WmWindow>);
}

// ---- the workspace -----------------------------------------------------------
let areaEl: HTMLElement | null = null;
let areaRo: ResizeObserver | null = null;

/** dockHides() when the workspace was last measured. */
let hadDock = true;
/**
 * Set the workspace's size (components/Workspace.tsx): windows are placed in
 * it, and clamped into it when it shrinks (maximized ones when restored); when
 * only the Dock came back, no further than to keep their title bars in it, so
 * maximizing a window and restoring it leaves the others where they were.
 */
function setArea(w: number, h: number): void {
	const s = $.get();
	w = Math.floor(w); h = Math.floor(h);
	if (s.area.w === w && s.area.h === h) return;
	const shrank = w < s.area.w || h < s.area.h;
	const area = { w, h };
	const dock = !dockHides(s), dockOnly = dock && !hadDock && w === s.area.w;
	hadDock = dock;
	const refit = (o: WmWindow): Partial<Geom> => (dockOnly ? { y: clamp(o.y, 0, h - TITLE), h: Math.min(o.h, h) } : fit(o, o, area));
	commit({ ...s, area, windows: shrank ? s.windows.map((o) => (o.placed && !o.maximized ? { ...o, ...refit(o) } : o)) : s.windows });
}
/** Compact mode (phones, narrow viewports): every window maximized without chrome, one shown. */
function setCompact(compact: boolean): void {
	const s = $.get();
	if (s.compact !== compact) commit({ ...s, compact });
}
/** The element windows are drawn in (components/Workspace.tsx: #workspace); its size is the workspace's. */
function attachWorkspace(el: HTMLElement | null): void {
	areaRo?.disconnect();
	areaRo = null;
	areaEl = el;
	if (!el) return;
	setArea(el.clientWidth, el.clientHeight);
	areaRo = new ResizeObserver(() => setArea(el.clientWidth, el.clientHeight));
	areaRo.observe(el);
}

// ---- callbacks: focus and visibility, after each change -------------------------
let lastFocused: string | null = null;
const shown = new Map<string, boolean>();
$.subscribe(() => {
	const s = $.get();
	for (const w of s.windows) {
		const v = isVisible(w, s);
		if (shown.get(w.id) !== v) { shown.set(w.id, v); w.onVisible?.(v); }
	}
	for (const id of [...shown.keys()]) if (!find(s, id)) shown.delete(id);
	if (s.focused !== lastFocused) {
		const prev = find(s, lastFocused);
		lastFocused = s.focused;
		prev?.onBlur?.();
		find(s, s.focused)?.onFocus?.();
	}
});

const sizes = new Map<string, string>();
/** The window's content box measured this size (components/Window.tsx): onResize() when it changed. */
function reportSize(id: string, w: number, h: number): void {
	const key = `${Math.round(w)}x${Math.round(h)}`;
	if (sizes.get(id) === key) return;
	sizes.set(id, key);
	find($.get(), id)?.onResize?.({ w: Math.round(w), h: Math.round(h) });
}

// ---- interactive move and resize (the title bar, the edges; an app's own decorations) ----
/** A pointer press to follow: from a pointerdown (React's or the DOM's). */
export interface Press { pointerId: number; clientX: number; clientY: number; button?: number; target: EventTarget | null }

/**
 * Follow a press with pointer capture until it is released: moves call
 * step(dx, dy) at most once a frame. While it lasts the root has
 * wm-dragging (style.css: iframes and canvases take no pointer events, no
 * text selection, the cursor stays `cursor`), so nothing under the pointer
 * steals the moves. Mouse, touch and pen alike. Returns a cancel: it ends
 * the follow at once without a last step (done gets moved true, so a
 * cancelled press is no tap), or null when there is nothing to follow.
 */
function follow(e: Press, cursor: string, step: (dx: number, dy: number) => void, done?: (moved: boolean) => void): (() => void) | null {
	if (e.button !== undefined && e.button !== 0) return null;
	const el = e.target as Element | null;
	if (!el) return null;
	try { el.setPointerCapture(e.pointerId); } catch { /* the pointer is gone already */ }
	const root = document.documentElement;
	root.classList.add("wm-dragging");
	root.style.setProperty("--wm-cursor", cursor);
	let dx = 0, dy = 0, raf = 0, moved = false;
	const onMove = (ev: PointerEvent) => {
		if (ev.pointerId !== e.pointerId) return;
		dx = ev.clientX - e.clientX; dy = ev.clientY - e.clientY;
		if (!moved && Math.hypot(dx, dy) < 3) return;
		moved = true;
		raf ||= requestAnimationFrame(() => { raf = 0; step(dx, dy); });
	};
	let over = false;
	const finish = (cancel: boolean) => {
		if (over) return;
		over = true;
		removeEventListener("pointermove", onMove, true);
		removeEventListener("pointerup", end, true);
		removeEventListener("pointercancel", end, true);
		try { el.releasePointerCapture(e.pointerId); } catch { /* not held */ }
		if (raf) { cancelAnimationFrame(raf); raf = 0; if (moved && !cancel) step(dx, dy); }
		root.classList.remove("wm-dragging");
		root.style.removeProperty("--wm-cursor");
		done?.(moved || cancel);
	};
	const end = (ev: PointerEvent) => { if (ev.pointerId === e.pointerId) finish(false); };
	// On the window, not on el: the capture is only there to keep the events coming while the pointer
	// is outside the page. It may not take (a frameless app's press was captured by its own element,
	// which lets go only now: wayland.ts), and losing it must not end the drag.
	addEventListener("pointermove", onMove, true);
	addEventListener("pointerup", end, true);
	addEventListener("pointercancel", end, true);
	return () => finish(true);
}

/**
 * Move the window with the pointer (the title bar; xdg_toplevel.move). A
 * maximized or snapped window is restored to its own size first, under the
 * pointer at the same share of its width. Snapping zones on the way
 * (moveSnap); Esc puts it back as it was and ends the move. Not in compact
 * mode.
 */
function startMove(id: string, e: Press, done?: (moved: boolean) => void): void {
	const s0 = $.get(), w0 = find(s0, id);
	if (!w0 || s0.compact) return;
	// In page px, the workspace's place read again on each move.
	const at = () => { const r = areaEl?.getBoundingClientRect(); return { left: r?.left ?? 0, top: r?.top ?? 0 }; };
	const r0 = at(), d0 = drawnGeom(w0, s0);
	let start = { x: d0.x + r0.left, y: d0.y + r0.top };
	let tiled = w0.maximized || !!w0.snap;
	const snapping = moveSnap(id, e, w0);
	const cancel = follow(e, "grabbing", (dx, dy) => {
		const s = $.get(), w = find(s, id);
		if (!w) return;
		if (tiled) {
			tiled = false;
			const r = at();
			const share = d0.w ? (e.clientX - r0.left - d0.x) / d0.w : 0.5;
			start = { x: e.clientX - share * w.w, y: Math.max(r.top, e.clientY - TITLE / 2) };
			commit({ ...s, windows: s.windows.map((o) => (o.id === id ? { ...o, maximized: false, ...UNSNAP, x: start.x - r.left, y: start.y - r.top } : o)) });
		}
		const r = at();
		move(id, start.x + dx - r.left, start.y + dy - r.top);
		snapping.track(e.clientX + dx, e.clientY + dy);
	}, (moved) => { snapping.end(moved); done?.(moved); });
	if (cancel) snapping.arm(cancel);
	else snapping.end(false);
}

const CURSOR: Record<Edge, string> = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize" };

/** Resize the window from an edge or corner with the pointer (xdg_toplevel.resize). Not maximized, not in compact mode; a snapped one leaves its tile from the tile's geometry (resize()). */
function startResize(id: string, edge: Edge, e: Press): void {
	const s0 = $.get(), w0 = find(s0, id);
	if (!w0 || s0.compact || w0.maximized || w0.resizable === false) return;
	const g0 = drawnGeom(w0, s0);
	const minW = w0.minW ?? MIN_W, minH = w0.minH ?? MIN_H;
	follow(e, CURSOR[edge], (dx, dy) => {
		const { area } = $.get();
		let { x, y, w, h } = g0;
		if (edge.includes("e")) w = clamp(g0.w + dx, minW, (area.w || Infinity) - g0.x);
		if (edge.includes("s")) h = clamp(g0.h + dy, minH, (area.h || Infinity) - g0.y);
		if (edge.includes("w")) { const nx = clamp(g0.x + dx, 0, g0.x + g0.w - minW); w = g0.w + g0.x - nx; x = nx; }
		if (edge.includes("n")) { const ny = clamp(g0.y + dy, 0, g0.y + g0.h - minH); h = g0.h + g0.y - ny; y = ny; }
		resize(id, { x, y, w, h });
	});
}

// ---- snapping: tiles, a move's zones and their preview (the geometry: wmsnap.ts) ----------
/** Where a snapped window is drawn: its tile (at least its minimum size), or the size its app took for this tile (fitTile), against the tile's outer side and corner. */
export function snapGeom(w: WmWindow, area: WmState["area"]): Geom {
	if (!w.snap) return { x: w.x, y: w.y, w: w.w, h: w.h };
	const r = tileRect(w.snap, area), t = w.tileSize;
	const size = t && t.tw === r.w && t.th === r.h ? { w: t.w, h: t.h }
		: { w: Math.max(r.w, Math.min(w.minW ?? MIN_W, area.w)), h: Math.max(r.h, Math.min(w.minH ?? MIN_H, area.h)) };
	return anchorTile(w.snap, r, size, area);
}

/** Snap it to a tile, maximize it ("max"), or put it back at its own geometry (null). Not in compact mode, nor before it is placed. */
function snapTo(id: string, zone: Zone | null): void {
	const s = $.get(), w = find(s, id);
	if (!w || s.compact || !w.placed || !s.area.w || (zone && w.resizable === false)) return;
	if (zone === "max") maximize(id, true);
	else if (zone) patchWin(id, () => ({ maximized: false, snap: zone, tileSize: undefined }));
	else maximize(id, false);
}

/** The focused window, one tile on by an arrow key (wmsnap.ts nextTile; the prefix's arrows, keys.ts). */
function snapKey(key: Arrow): void {
	const s = $.get(), w = find(s, s.focused);
	if (!w || w.minimized) return;
	const cur = w.maximized ? "max" : w.snap;
	const next = nextTile(cur, key);
	if (next !== cur) snapTo(w.id, next);
}

/** A frameless app took this size for its tile (wayland.ts): drawn at it, against the tile's outer side and corner, while the tile keeps its size. */
function fitTile(id: string, size: { w: number; h: number }): void {
	const s = $.get(), w = find(s, id);
	if (!w?.snap) return;
	const r = tileRect(w.snap, s.area), t = w.tileSize;
	if (t && t.tw === r.w && t.th === r.h && t.w === size.w && t.h === size.h) return;
	patchWin(id, () => ({ tileSize: { tw: r.w, th: r.h, w: size.w, h: size.h } }));
}

/** The zone a move would put its window in, and the window's z-index (components/SnapPreview.tsx draws it just under the window). */
export interface SnapPreview { id: string; zone: Zone; z: number }
export const snapPreview$ = createStore<{ preview: SnapPreview | null }>({ preview: null });

/**
 * A move's snapping (startMove): the zone under the pointer (wmsnap.ts
 * zoneAt) is previewed while the pointer is in it, and applied at the
 * release: the window tiled or maximized, its own geometry as before the
 * move. The zone the press was in counts only once the pointer has left it
 * (a title bar at the workspace's top). Esc, once armed with the move's
 * cancel, puts the window back as it was and ends the move.
 */
function moveSnap(id: string, e: Press, w0: WmWindow) {
	const zoneOf = (cx: number, cy: number): Zone | null => {
		if (w0.resizable === false) return null; // a fixed-size window takes no tile
		const r = areaEl?.getBoundingClientRect();
		return r ? zoneAt({ x: cx - r.left, y: cy - r.top }, $.get().area, -r.top) : null;
	};
	const z0 = zoneOf(e.clientX, e.clientY);
	let live = z0 === null, zone: Zone | null = null, cancel: (() => void) | null = null;
	const show = (z: Zone | null) => {
		if (z === zone) return;
		zone = z;
		const index = Number(document.getElementById(`win-${id}`)?.style.zIndex) || 0;
		snapPreview$.set({ preview: z ? { id, zone: z, z: index } : null });
	};
	const onKey = (ev: KeyboardEvent) => {
		if (ev.key !== "Escape" || !cancel) return;
		ev.preventDefault();
		ev.stopImmediatePropagation();
		show(null);
		cancel();
		patchWin(id, () => ({ x: w0.x, y: w0.y, maximized: w0.maximized, snap: w0.snap, tileSize: w0.tileSize }));
	};
	return {
		arm(c: () => void): void { cancel = c; addEventListener("keydown", onKey, true); },
		track(cx: number, cy: number): void {
			let z = zoneOf(cx, cy);
			if (!live) { if (z === z0) z = null; else live = true; }
			show(z);
		},
		end(moved: boolean): void {
			removeEventListener("keydown", onKey, true);
			const z = zone;
			show(null);
			if (moved && z && !$.get().compact) patchWin(id, () => ({ x: w0.x, y: w0.y, maximized: z === "max", snap: z === "max" ? null : z, tileSize: undefined }));
		},
	};
}

/** The WM's operations (see the top of this file). */
export const wm = {
	open, close, remove, focus: focusWin, minimize, maximize, restore, move, resize, update,
	startMove, startResize, snap: snapTo, snapKey, fitTile,
	setArea, setCompact, attachWorkspace, reportSize,
	get: (id: string): WmWindow | undefined => find($.get(), id),
	list: (): WmWindow[] => $.get().windows,
	focused: (): string | null => $.get().focused,
	isVisible: (id: string): boolean => { const w = find($.get(), id); return !!w && isVisible(w); },
};
export type Wm = typeof wm;
