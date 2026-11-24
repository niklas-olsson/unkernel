// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A paste into a Wayland app of what wland's clipboard bridge does not
// carry (it is plain text only, and stays the way for that): the page
// clipboard's HTML, image or files become the Wayland selection
// (engine.setSelection()):
// - text with HTML: both (text/html and wland's plain text types);
// - an image (a screenshot, a browser's Copy image: one image file named
//   image.*): its bytes under its type, and the HTML that came with it;
// - files (copied in the host's file manager): put into the guest's
//   ~/Downloads (drop.ts uploadFiles()), then their URIs as text/uri-list
//   and x-special/gnome-copied-files (what GTK file managers paste), their
//   paths as text, and a single image's bytes too.
// - wland holds the paste chord's key until the paste event (300 ms at
//   most). This listener is on the window, capturing, so before wland's: a
//   paste it takes goes no further, and once the selection is set a paste
//   event of its own (REPLAY: no text, another type) reaches wland, which
//   sends the key, and notes that the page clipboard holds something it does
//   not know. An upload longer than the hold leaves the app a selection
//   with nothing to paste, and a toast says when to paste again.
// - The page clipboard stays what it was while apps copy things that do not
//   reach it (an image): content seen before is not taken again over an
//   app's selection, which is newer.
// Guest to host is wland's bridge alone: plain text (files: copyout.ts).
import { uploadFiles } from "../drop.ts";
import { KW } from "../kw.ts";
import type { Wland } from "wland/client";

type Data = Record<string, string | Uint8Array>;

/** wland's hold of the paste chord (input.ts PASTE_WAIT_MS), less a margin. */
const HOLD_MS = 250;
/** The largest image taken (wland holds 64 MiB in all). */
const IMAGE_MAX = 32 * 1024 * 1024;
const TEXT_MAX = 4 * 1024 * 1024;
/** What a selection offers while its files are on their way: nothing an app takes. */
const PENDING = "application/x-kw-pending";

/** FNV-1a of the bytes, for `seen`. */
function hash(b: Uint8Array): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i]!, 0x01000193);
	return h >>> 0;
}

/** The HTML as the browsers hand it, without the fragment markers Windows adds. */
const htmlOf = (dt: DataTransfer): string => dt.getData("text/html").replace(/<!--(Start|End)Fragment-->/g, "");

const fileUri = (path: string): string => `file://${path.split("/").map(encodeURIComponent).join("/")}`;

/** The selection that pastes these files of the guest. */
function filesData(textMimes: readonly string[], paths: readonly string[]): Data {
	const uris = paths.map(fileUri);
	const data: Data = {
		"text/uri-list": uris.map((u) => `${u}\r\n`).join(""),
		"x-special/gnome-copied-files": `copy\n${uris.join("\n")}`,
	};
	for (const m of textMimes) data[m] = paths.join("\n");
	return data;
}

/** Take the pastes into wland's apps (see the top) until the returned stop runs. `container`: wland's, whose sink has the focus then. */
export function attachPaste(wl: Wland, container: HTMLElement, textMimes: readonly string[], log: (line: string) => void): () => void {
	const { engine } = wl;
	/** The page clipboard's content taken last (see the top). */
	let seen = "";
	let replaying = false, turn = 0, stopped = false;

	/** wland's turn: the chord's keys go to the app. */
	function replay(target: EventTarget): void {
		const dt = new DataTransfer();
		dt.setData("text/html", " ");
		replaying = true;
		try { target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); } finally { replaying = false; }
	}
	/** Whether the content is to be set: new, or its selection went (the link opened again). */
	function fresh(sig: string): boolean {
		const same = sig === seen, sel = engine.selection();
		seen = sig;
		return !same || !sel.mimes.length;
	}
	const set = (data: Data): void => { if (!engine.setSelection(data)) log("[host] clipboard: the Wayland selection was not set (too large, or the link is closed)"); };

	async function takeImage(f: File, html: string, my: number): Promise<void> {
		const bytes = new Uint8Array(await f.arrayBuffer());
		if (stopped || my !== turn || !fresh(`image ${f.type} ${bytes.length} ${hash(bytes)}`)) return;
		set({ [f.type]: bytes, ...(html ? { "text/html": html } : {}) });
	}
	/** Whether the app could paste them at once (within wland's hold). */
	async function takeFiles(files: File[], my: number): Promise<boolean> {
		if (!fresh(`files ${files.map((f) => `${f.name} ${f.size} ${f.lastModified}`).join("\n")}`)) return true;
		const t0 = performance.now();
		const pending = `${PENDING}-${my}`;
		set({ [pending]: " " });
		const paths = await uploadFiles(files);
		const one = files.length === 1 && files[0]!.type.startsWith("image/") && files[0]!.size <= IMAGE_MAX ? files[0]! : null;
		const image: Data = one && paths.length ? { [one.type]: new Uint8Array(await one.arrayBuffer()) } : {};
		if (stopped) return true;
		// Something else was pasted or copied meanwhile: theirs.
		if (!engine.selection().mimes.includes(pending)) return true;
		if (!paths.length) { seen = ""; engine.setSelection(null); return true; }
		set({ ...filesData(textMimes, paths), ...image });
		return performance.now() - t0 < HOLD_MS;
	}

	function onPaste(ev: ClipboardEvent): void {
		const dt = ev.clipboardData, sink = document.activeElement;
		if (replaying || !dt || !sink || !container.contains(sink) || engine.selectionBridged() !== true) return;
		const text = dt.getData("text/plain"), html = htmlOf(dt);
		// macOS gives a copied file's name as text too; otherwise text that comes with a picture of itself (a spreadsheet's) is text.
		let files = [...dt.files];
		if (text && text.trim().split(/\r?\n|\r/).join("\n") !== files.map((f) => f.name).join("\n")) files = [];
		const image = files.length === 1 && files[0]!.type.startsWith("image/") && /^image\.\w+$/.test(files[0]!.name) && files[0]!.size <= IMAGE_MAX ? files[0]! : null;
		if (!files.length && (!html || !text || text.length + html.length > TEXT_MAX)) {
			seen = ""; // plain text (or nothing known): wland's, whose selection then is not ours
			return;
		}
		ev.preventDefault();
		ev.stopImmediatePropagation();
		const my = ++turn;
		if (!files.length) {
			if (fresh(`html ${text}\n${html}`)) {
				const data: Data = { "text/html": html };
				for (const m of textMimes) data[m] = text;
				set(data);
			}
			replay(sink);
			return;
		}
		const done = image ? takeImage(image, html, my).then(() => true) : takeFiles(files, my);
		done.catch((e: unknown) => { log(`[host] clipboard: the paste failed: ${(e as Error)?.message ?? e}`); return true; }).then((inTime) => {
			if (stopped) return;
			if (!inTime) KW.ui!.toast("Copied to ~/Downloads: paste again to use it");
			if (document.activeElement === sink) replay(sink);
		});
	}
	addEventListener("paste", onPaste, true);
	return () => {
		stopped = true;
		removeEventListener("paste", onPaste, true);
	};
}
