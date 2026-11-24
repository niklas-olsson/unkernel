// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Files copied in a Wayland app (Thunar's Copy), for the host. A page cannot
// put files on the host's clipboard, only text, HTML and images. So a copy
// that offers text/uri-list with file: URIs shows a toast whose button saves
// the files through the browser, under their own names (a folder or several:
// one .tar.gz). Nothing is read until then but the list. A cut shows none,
// nor does the page's own selection.
// - Such a selection also offers the files' paths as text, which wland's
//   bridge would put on the host's clipboard: guest paths, of no use there (a
//   paste in macOS's Finder makes a "Pasted ….textClipping" of them).
//   withholdPaths() has the bridge read them as empty text, so it clears the
//   host's clipboard instead, by its own rules (it stays what the bridge last
//   saw there). The apps' own pastes are unaffected.
import { KW } from "../kw.ts";
import { isHeld, isRunning, ui$ } from "../store.ts";
import { readPaths, uriPaths } from "../upload.ts";
import type { KernelHandle } from "../sdk.ts";
import type { Wland } from "wland/client";
import type { Engine, Event as WlEvent } from "wland/engine";

const URIS = "text/uri-list", GNOME = "x-special/gnome-copied-files";
const TOAST_MS = 10_000;

/** The files the selection names, or [] (not the app's, or no files). */
async function selectedFiles(engine: Engine, read: Engine["readSelection"]): Promise<string[]> {
	const sel = engine.selection();
	if (!sel.conn || !sel.mimes.includes(URIS)) return [];
	const b = await read.call(engine, URIS, { maxBytes: 1 << 20 });
	return b ? uriPaths(new TextDecoder().decode(b)) : [];
}

/** File paths are not text for the host's clipboard (see the top): reads of a file selection's text are empty from now on. */
export function withholdPaths(engine: Engine, textMimes: readonly string[]): void {
	const read = engine.readSelection;
	engine.readSelection = async (mime, options) => {
		if (textMimes.includes(mime) && (await selectedFiles(engine, read)).length) return new Uint8Array(0);
		return read.call(engine, mime, options);
	};
}

async function save(vm: KernelHandle, paths: string[]): Promise<void> {
	const ui = KW.ui!, s = ui$().get();
	if (!isRunning(s) || isHeld(s)) { ui.toast("Files can be saved once the system is running"); return; }
	const id = ui.toast("Reading from the guest…", { ms: 60_000 });
	try {
		const { name, blob } = await readPaths(vm, paths);
		ui.toastHide(id);
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = name;
		document.body.append(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
	} catch (e) {
		ui.toast(`Not saved: ${(e as Error)?.message ?? e}`, { ms: 6000 });
	}
}

/** Feed it every engine event (see the top). */
export function createCopyOut(vm: KernelHandle, wl: () => Wland | null): (ev: WlEvent) => void {
	let seq = 0;
	return (ev) => {
		if (ev.type !== "selection") return;
		const my = ++seq, engine = wl()?.engine;
		if (!engine || ev.conn === 0 || !ev.mimes.includes(URIS) || engine.selectionBridged() !== true) return;
		const text = async (mime: string) => new TextDecoder().decode(await engine.readSelection(mime, { maxBytes: 1 << 20 }) ?? new Uint8Array());
		void (async () => {
			if (ev.mimes.includes(GNOME) && (await text(GNOME)).startsWith("cut")) return;
			const paths = await selectedFiles(engine, engine.readSelection);
			if (my !== seq || !paths.length) return;
			const what = paths.length === 1 ? paths[0]!.split("/").pop() || "/" : `${paths.length} files`;
			KW.ui!.toast(`Copied ${what} in the guest`, { action: "Download to host", run: () => void save(vm, paths), ms: TOAST_MS });
		})().catch(() => {});
	};
}
