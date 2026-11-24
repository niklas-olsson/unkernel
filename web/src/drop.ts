// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Drags from the host (files, text, links: another program, another tab)
// dropped on the page. Files are put into the guest (upload.ts), into
// ~/Downloads but for a shell at its prompt, by what they were dropped on:
// - a Wayland app's surface: wland's drag and drop bridge has it
//   (waylandDnd(), with wayland.ts): the app sees a Wayland drag hover and
//   gets the files as text/uri-list, or the dragged text, HTML or link. The
//   window is raised and focused at the drop;
// - a terminal whose shell is at its prompt: they go into the shell's
//   directory, and a toast says so (nothing is typed);
// - a terminal where a program runs (an agent, an editor): their paths,
//   quoted, are pasted into it;
//   either way, a dragged text or link is pasted as it is;
// - anything else of the page: a toast says where they are.
// A text field keeps its own drops of text, a file input its files. Every other drop is cancelled: the
// browser would open the dropped file or link in this tab, over the running
// machine.
// - This module's listeners are on the window, capturing, so before wland's
//   (on the document).
// - wland's bridge asks its `container` only whether an element is inside
//   it. The apps' elements are in WM windows, outside wland's container
//   (#wl-desktop, which takes no pointer), so createWland's own bridge never
//   sees a drag here: it is off (dnd: false), and waylandDnd() makes one
//   whose container answers for the apps' surfaces instead.
import { KW } from "./kw.ts";
import type { KernelHandle } from "./sdk.ts";
import { isHeld, isRunning, ui$ } from "./store.ts";
import { termWindow } from "./termtabs.ts";
import { promptDir, shellQuote, uploadFile } from "./upload.ts";
import { getCurrent } from "./wayland/state.ts";
import { wm } from "./wm.ts";
import type { DndBridge, Wland } from "wland/client";

/** How long an app's read of dropped files waits for them to be in the guest. */
const FILES_TIMEOUT = 10 * 60_000;
/** How often the progress toast changes. */
const PROGRESS_MS = 400;

/** Files can go into the guest now (a held machine runs nothing). */
const ready = (): boolean => { const s = ui$().get(); return !!KW.vm && isRunning(s) && !isHeld(s); };

/**
 * Put `files` into `dir` in the guest (default ~/Downloads), with a toast while it takes
 * time; resolves the absolute paths of those that got there (a toast says
 * which did not).
 */
export async function uploadFiles(files: readonly File[], dir?: string): Promise<string[]> {
	const ui = KW.ui!, vm = KW.vm as KernelHandle | undefined;
	if (!vm || !ready()) { ui.toast("Files can be copied in once the system is running"); return []; }
	const total = files.reduce((n, f) => n + f.size, 0);
	const what = files.length === 1 ? files[0]!.name : `${files.length} files`;
	let done = 0, shown: number | undefined, at = performance.now();
	const paths: string[] = [];
	let failed: Error | null = null;
	for (const f of files) {
		try {
			paths.push(await uploadFile(vm, f, {
				dir,
				onBytes: (sent) => {
					const t = performance.now();
					if (t - at < PROGRESS_MS) return;
					at = t;
					shown = ui.toast(`Copying ${what}… ${total ? Math.floor(((done + sent) / total) * 100) : 100}%`, { ms: 60_000 });
				},
			}));
		} catch (e) {
			failed ??= e as Error;
			ui.hostLog(`[host] drop: ${(e as Error)?.message ?? e}`);
		}
		done += f.size;
	}
	if (shown !== undefined) ui.toastHide(shown);
	if (failed) ui.toast(`Not copied: ${failed.message}`, { ms: 6000 });
	return paths;
}

/** wland's drag and drop bridge for the apps' surfaces (see the top): feed it every engine event, dispose it with wland. */
export function waylandDnd(W: typeof import("wland/client"), wl: Wland, log: (line: string) => void): DndBridge {
	const region = document.createElement("div");
	region.contains = (n) => !!n && !!wl.view.surfaceOf(n);
	return W.createDndBridge({ engine: wl.engine, view: wl.view, input: wl.input, container: region, files: (files) => uploadFiles(files), filesTimeout: FILES_TIMEOUT, log: (l) => log(`[host] wayland: ${l}`) });
}

type Place = { kind: "app"; win: string } | { kind: "terminal"; n: number } | { kind: "own" } | { kind: "page" };

/** What a drag over `t` is over. */
function place(t: EventTarget | null, files: boolean): Place {
	const el = t instanceof Element ? t : null;
	const s = el && getCurrent()?.view.surfaceOf(el);
	if (s) return { kind: "app", win: `wl-c${s.conn}s${s.root}` };
	const tw = termWindow(el?.closest('section[id^="win-"]')?.id.slice(4));
	if (tw) return { kind: "terminal", n: tw.active };
	// A text field takes text only: the browser would open a file dropped there.
	if (el?.closest(files ? 'input[type="file"]' : "input, textarea, select, [contenteditable]")) return { kind: "own" };
	return { kind: "page" };
}

/** Paste into terminal n: bracketed while it is the current one (focused at the drop). */
function pasteInto(n: number, text: string): void {
	const cur = KW.windows?.list().find((x) => x.current)?.n;
	if (cur === n && KW.term) KW.term.paste(text);
	else KW.windows?.send(n, text);
}

/** Files dropped on the page (`n`: on terminal n). */
async function dropFiles(files: File[], n?: number): Promise<void> {
	const ui = KW.ui!, vm = KW.vm as KernelHandle | undefined;
	// Where terminal n's shell is, unless a program runs there. A terminal with no session (opening, ended) has neither.
	const term = n === undefined ? undefined : KW.windows?.list().find((x) => x.n === n);
	const open = !!term && (n === 0 || (term.state === "open" && term.pid !== undefined));
	const dir = open && vm && ready() ? await promptDir(vm, term.pid).catch(() => null) : null;
	const paths = await uploadFiles(files, dir ?? undefined);
	if (!paths.length) return;
	if (open && !dir) return pasteInto(n!, `${paths.map(shellQuote).join(" ")} `);
	const home = (p: string) => p.replace(/^(\/home\/user|\/root)(?=\/|$)/, "~");
	ui.toast(`${paths.length === 1 ? paths[0]!.split("/").pop() : `${paths.length} files`} copied to ${home(paths[0]!.slice(0, paths[0]!.lastIndexOf("/")) || "/")}`);
}

/** The types of a drag a terminal takes as text. */
const hasText = (dt: DataTransfer): boolean => dt.types.includes("text/plain") || dt.types.includes("text/uri-list");

function onOver(ev: DragEvent): void {
	const dt = ev.dataTransfer;
	if (!dt) return;
	const files = dt.types.includes("Files"), at = place(ev.target, files);
	if (at.kind === "app" || at.kind === "own") return;
	ev.preventDefault();
	const takes = files ? ready() : at.kind === "terminal" && hasText(dt);
	dt.dropEffect = takes ? "copy" : "none";
}

function onDrop(ev: DragEvent): void {
	const dt = ev.dataTransfer;
	if (!dt) return;
	const at = place(ev.target, dt.types.includes("Files"));
	if (at.kind === "own") return;
	if (at.kind === "app") {
		// After wland's bridge made the drop.
		setTimeout(() => { if (wm.get(at.win)) wm.focus(at.win); }, 0);
		return;
	}
	ev.preventDefault();
	const files = [...dt.files];
	const text = files.length ? "" : dt.getData("text/plain") || dt.getData("text/uri-list");
	if (at.kind === "terminal" && (files.length || text)) KW.windows?.select(at.n);
	if (files.length) void dropFiles(files, at.kind === "terminal" ? at.n : undefined);
	else if (at.kind === "terminal" && text) pasteInto(at.n, text);
}

/** main.tsx: the page takes the host's drags from now on. */
export function initDrop(): void {
	addEventListener("dragenter", onOver, true);
	addEventListener("dragover", onOver, true);
	addEventListener("drop", onDrop, true);
}
