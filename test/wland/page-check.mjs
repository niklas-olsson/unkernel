#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The page's Wayland apps (wland) in headless Chromium: starts the page's Vite dev
// server (web/, on --port, default 8092; never 8080, the one used by hand),
// a fresh browser profile (its own IndexedDB: the user's data disk is never
// touched), imports the prepared data disk (debian-disk.mjs: foot already
// installed, so nothing is downloaded) into that profile's data disk with
// KW.importData(), and checks, in the real page on Debian, once in worker
// mode (the page's default; --cpus N, default 1) and once inline
// (?worker=0):
//
//   1  the page listens for wland's relay but has fetched nothing of wland
//      (no request for wland.wasm, the Network domain) and has no Wayland
//      tile in the Dock (#dock-wayland) before a Wayland app runs, while the
//      relay the guest started at boot (kw.wayland=1 on the command line)
//      runs on demand, undialed
//   P  a plain `foot` (no wland prefix) in a login shell maps a window: the
//      relay dials at that app, wland is fetched only then; a second plain
//      foot maps on the same link (the relay connected once)
//   2  the launcher's foot tile (in its Graphics folder: the Dock's
//      #dock-launcher, then data-folder="gl" in #launcher-grid, then
//      data-app="foot" in #launcher-folder) runs foot in a terminal; a
//      window titled foot maps (KW.wayland.windows()) and has the focus
//      (wland's container #wl-desktop gets data-shown), the Dock has the
//      Wayland tile (#dock-wayland), wland.wasm was fetched after the first
//      app, and the page has read the window's pixels through vm.shm
//      (KW.wayland.stats())
//   3  a screenshot of the window's rectangle (Page.captureScreenshot) is not
//      blank: many distinct colours, not one flat fill
//   4  typed input reaches the app: a click on the window, then keys
//      (Input.dispatchKeyEvent: what a keyboard sends) type a shell command
//      into foot whose effect the guest shows (a file with 6*7 in it)
//   5  `exit` typed in foot closes it: the window goes, the focus leaves the
//      Wayland apps (no data-shown), and the relay keeps running (the Dock's
//      Wayland tile stays)
//   6  the keys typed into foot did not reach the app's terminal, a second
//      `wland CMD` reuses the running relay, and (worker mode) a relay that
//      is killed goes (the Dock's Wayland tile goes) and the next
//      `wland foot` starts a new one (on demand) that the page takes (a
//      window maps)
//
// Longer cases, behind flags (in the first mode run; --all for all):
//
//   --apps    two foot windows: the newer has the keyboard, a click moves it,
//             keys go to the focused one, closing one gives the other the
//             keyboard; Alt+F10 maximizes to the workspace's size (foot
//             redraws at it) and again restores; Alt+drag moves a window;
//             the page resized (the workspace) resizes a maximized window;
//             a quick click on foot's resize border starts no resize, a
//             drag on it resizes; the clipboard from wl-copy to foot
//             (Ctrl+Shift+V) and from foot's selection to wl-paste; wland's
//             bridge to the page's clipboard both ways (the permission
//             granted through the DevTools protocol)
//   --gtk     l3afpad (GTK 3): its window maps, typed text lands, a right
//             click opens its context menu (an xdg_popup) at the pointer,
//             Escape closes it, Ctrl-A Ctrl-A (the page's prefix twice:
//             select all) and Ctrl+C put the text on the clipboard (wl-paste)
//   --keys    in foot: Ctrl-C stops a command, arrow keys walk the shell's
//             history, Alt (Alt+. yanks the last argument), Ctrl-U, a held
//             key repeats (browser auto-repeat keydowns), Ctrl-A Ctrl-A
//             reaches foot as Ctrl-A; Ctrl-A w goes to the other windows and
//             the terminal takes the keys, Ctrl-A w back and foot has them
//             again; picking the app's terminal tab (#term-tab-N) leaves the
//             Wayland windows too
//   --pacing  frame pacing with a client that redraws continuously:
//             weston-simple-shm (and foot under heavy output) for a few
//             seconds each, commits per second, the reads' share of the
//             time and how many were in place (synchronous), in every mode run;
//             fails while another window is open (the counters are every window's)
//
//   --gpu     GL apps by GPU resource (guest GL's virtio-gpu; the prepared
//             disk debian-wland-gl.img, made with debian-disk.mjs --gl, has
//             Mesa and the clients), after the other cases of the first
//             mode: the relay runs with --dmabuf virtgpu and wland offers
//             linux-dmabuf v4 (four formats, implicit and LINEAR); the
//             renderer loads on the first GL frame; weston-simple-egl's
//             window by resource (the relay's "first 'AR24' ... → resource"
//             line, KW.wayland.stats()'s GPU counters, no shm reads) with
//             alpha kept and the right way up; -o (XRGB) opaque, and
//             stopped, its window equals its last resource's picture (no
//             stale frame); foot (shm) and a GL window together; the
//             renderer's WebGL2 context lost and restored under a GL window,
//             then a new GL window by resource (the relay kept, no renderer
//             error); gtk4-widget-factory with GTK's GL renderer; a relay without
//             --dmabuf (wland says so, GL apps go to shm); with --pacing
//             commits per second and per-commit cost at 250x250 and
//             maximized; in worker mode Suspend refused while es2gears
//             runs and done after, GL apps by resource after the resume;
//             then ?wlgpu=0 (no gpu source: no linux-dmabuf, software
//             rendering into shm windows; with --pacing the same rates) and
//             ?gpu=0 (the vtest link: virpipe frames in shm windows)
//
//   --chromium  instead of the cases above, in each mode: Debian's chromium
//             started plainly in a login shell (no wland prefix, no flags:
//             /etc/chromium.d/kw-wayland adds --ozone-platform=wayland), and
//             with no Wayland variables at all (the hook runs wland), each
//             maps a Chromium window
//             within 3 min, and renders on the GPU: its GPU process stays and
//             the window comes by GPU resource (GPU commits, the relay's
//             "first ... → resource" line); imports debian-wland-chromium.img
//             (debian-disk.mjs --chromium: chromium as apt installs it, and
//             Mesa's EGL, 260 MiB gzipped)
//
//   --chat-bench  measure typing and feed scroll on the same offline chat fixture
//             in the host browser and in Debian Chromium (see chat-bench.md).
//   --firefox  instead of the cases above, in worker mode on 4 CPUs with
//             mem=2048 (--only and --cpus change them): firefox-esr from a
//             login shell maps its window on a local page whose title shows
//             what reached it; two clicks on a button, typing into a text
//             field, a right click opens the context menu and Escape closes
//             it, the wheel scrolls down and back, a drag selects text (the
//             primary selection) and Ctrl+C copies it (wl-paste), a link
//             click and Ctrl+L with a typed URL and Enter navigate; imports
//             debian-wland-firefox.img (debian-disk.mjs --firefox)
//
//   S  with --suspend (worker mode): foot started again in the foot app's
//      terminal, Suspend (KW.suspend()) and a plain load resume the session;
//      the old foot is gone (its link dropped), the relay (a guest process)
//      goes idle and the new page fetches nothing of wland, and a plain
//      `foot` typed in that terminal maps (the relay dials again)
//
//   node test/wland/page-check.mjs [--port N] [--cpus N] [--only worker|inline] [--apps] [--gtk] [--keys] [--pacing] [--all] [--gpu] [--chromium] [--chat-bench] [--firefox] [--suspend] [--fresh] [--built] [--output DIR] [--chrome BIN] [--timeout S] [--shots DIR] [--keep-open] [--verbose]
//
// --fresh skips the prepared disk: the foot tile installs its packages with
// apt over the page's network (the internet; minutes) before foot maps; use
// it with --only. --built runs the built page (web/.output, pnpm build:web) instead of the
// dev server; --output DIR another build's output (web/.wland-local/output: a local wland, KW_WLAND_PKG). --gpu imports the GL disk instead (a superset of the default one). --shots DIR
// writes the page and each window screenshot there. --verbose shows the server's output. Exit 0 when every check
// passed, 1 on a failure, 2 when it could not run.
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { findChrome, sleep, startServer } from "../../web/test/lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const port = Number(opt("--port", "8092"));
const timeout = Number(opt("--timeout", "900")) * 1000;
const firefoxTest = args.includes("--firefox");
const chatTest = args.includes("--chat-bench");
const cpus = opt("--cpus", firefoxTest || chatTest ? "4" : "1");
const only = opt("--only", firefoxTest || chatTest ? "worker" : "");
const shots = opt("--shots", "");
const suspendTest = args.includes("--suspend");
const all = args.includes("--all");
const want = (f) => all || args.includes(f);
const output = opt("--output", "");
const built = args.includes("--built") || !!output;
const fresh = args.includes("--fresh");
const chromeBin = opt("--chrome", process.env.CHROME || findChrome());
const build = process.env.KW_BUILD ? resolve(process.env.KW_BUILD) : join(root, "vendor/build");
const gpuTest = args.includes("--gpu");
const chromiumTest = args.includes("--chromium");
if (chatTest) {
	const conflicts = ["--fresh", "--apps", "--gtk", "--keys", "--pacing", "--all", "--gpu", "--chromium", "--firefox", "--suspend"]
		.filter((arg) => args.includes(arg));
	if (conflicts.length || !["worker", "inline"].includes(only)) {
		console.error("--chat-bench runs by itself with a prepared Chromium disk and --only worker or inline");
		if (conflicts.length) console.error(`incompatible switches: ${conflicts.join(", ")}`);
		process.exit(2);
	}
}
const diskKind = chatTest ? "chromium" : firefoxTest ? "firefox" : gpuTest ? "gl" : chromiumTest ? "chromium" : "";
const diskGz = join(build, `wland/debian-wland${diskKind ? "-" + diskKind : ""}.img.kwsparse.gz`);
/** The kw layer's wland (not on the PATH of KW.vm.exec()'s shells). */
const WL = "/usr/lib/kw/bin/wland";
const t0 = performance.now();
const secs = () => ((performance.now() - t0) / 1000).toFixed(1);
const say = (s) => console.log(`[${secs()}] ${s}`);

let fails = 0;
const report = (name, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}  ${detail}`);
	if (!ok) fails++;
};

if (!fresh && !existsSync(diskGz)) {
	say("making the prepared disk (test/wland/debian-disk.mjs)");
	try { execFileSync(process.execPath, [join(here, "debian-disk.mjs"), ...(diskKind ? [`--${diskKind}`] : [])], { stdio: "inherit" }); } catch {
		console.error("the prepared disk could not be made");
		process.exit(2);
	}
}
if (shots) mkdirSync(shots, { recursive: true });

// The prepared disk for the page's import: any origin, with CORP (the page is cross-origin isolated).
const files = createServer((req, res) => {
	const h = { "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin" };
	if (req.url !== "/disk.kwsparse.gz") { res.writeHead(404, h).end(); return; }
	res.writeHead(200, { ...h, "content-type": "application/octet-stream", "content-length": statSync(diskGz).size });
	createReadStream(diskGz).pipe(res);
});
await new Promise((r) => files.listen(0, "127.0.0.1", r));
const diskUrl = `http://127.0.0.1:${files.address().port}/disk.kwsparse.gz`;

say(`${built ? `built server (${output || "web/.output"})` : "dev server"} on 127.0.0.1:${port}`);
const server = await startServer({ port, host: "127.0.0.1", dev: !built, ...(output ? { output: resolve(output) } : {}) }).catch((e) => {
	console.error(`the server did not start: ${e.message}`);
	process.exit(2);
});
const profile = mkdtempSync(join(tmpdir(), "kw-wlpage-"));
const dport = 30000 + Math.floor(Math.random() * 20000);
const chrome = spawn(chromeBin, [
	// --disable-dev-shm-usage: Chromium's shared memory in /tmp, not /dev/shm, which a container may
	// keep small (64 MiB): there the GL page's buffers and a Suspend's snapshot ran out of it (a crashed
	// renderer, then net::ERR_INSUFFICIENT_RESOURCES for the page's scripts, 2026-11-22).
	"--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--hide-scrollbars",
	...(chatTest ? ["--window-size=1600,1000", "--force-device-scale-factor=1"] : ["--window-size=1280,800"]), `--remote-debugging-port=${dport}`, `--user-data-dir=${profile}`, "about:blank",
], { stdio: ["ignore", "ignore", args.includes("--verbose") ? "inherit" : "ignore"] });
const cleanup = async () => {
	chrome.kill("SIGKILL");
	await server.kill();
	files.close();
	rmSync(profile, { recursive: true, force: true });
};
const watchdog = setTimeout(async () => {
	console.error(`no result within ${timeout / 1000} s`);
	await cleanup();
	process.exit(2);
}, timeout);

/** Decode an 8-bit RGB or RGBA PNG (what Page.captureScreenshot sends) to { width, height, rgba }. */
function decodePng(buf) {
	let at = 8, width = 0, height = 0, type = 0;
	const idat = [];
	while (at < buf.length) {
		const len = buf.readUInt32BE(at), name = buf.toString("latin1", at + 4, at + 8), data = buf.subarray(at + 8, at + 8 + len);
		if (name === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); type = data[9]; if (data[8] !== 8) throw new Error("PNG: not 8-bit"); }
		else if (name === "IDAT") idat.push(data);
		at += 12 + len;
	}
	const bpp = type === 6 ? 4 : type === 2 ? 3 : 0;
	if (!bpp) throw new Error(`PNG: colour type ${type}`);
	const raw = inflateSync(Buffer.concat(idat)), stride = width * bpp, rgba = new Uint8Array(width * height * 4);
	let prev = new Uint8Array(stride);
	for (let y = 0; y < height; y++) {
		const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), cur = new Uint8Array(stride);
		for (let i = 0; i < stride; i++) {
			const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
			const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
			cur[i] = (line[i] + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]) & 255;
		}
		for (let x = 0; x < width; x++) {
			rgba.set([cur[x * bpp], cur[x * bpp + 1], cur[x * bpp + 2], bpp === 4 ? cur[x * bpp + 3] : 255], (y * width + x) * 4);
		}
		prev = cur;
	}
	return { width, height, rgba };
}

// What a US keyboard sends for each character: [code, key, shift].
const KEYS = new Map();
{
	const pair = (code, plain, shifted) => { KEYS.set(plain, [code, plain, false]); KEYS.set(shifted, [code, shifted, true]); };
	for (const c of "abcdefghijklmnopqrstuvwxyz") pair(`Key${c.toUpperCase()}`, c, c.toUpperCase());
	"1234567890".split("").forEach((d, i) => pair(`Digit${d}`, d, "!@#$%^&*()"[i]));
	for (const [code, a, b] of [["Minus", "-", "_"], ["Equal", "=", "+"], ["BracketLeft", "[", "{"], ["BracketRight", "]", "}"], ["Semicolon", ";", ":"], ["Quote", "'", '"'], ["Backquote", "`", "~"], ["Backslash", "\\", "|"], ["Comma", ",", "<"], ["Period", ".", ">"], ["Slash", "/", "?"]]) pair(code, a, b);
	KEYS.set(" ", ["Space", " ", false]);
	KEYS.set("\n", ["Enter", "Enter", false]);
}

try {
	let target;
	for (let i = 0; i < 100 && !target; i++) {
		await sleep(100);
		try { target = (await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json()).find((t) => t.type === "page"); } catch {}
	}
	if (!target) throw new Error(`${chromeBin} did not start`);
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
	let id = 0;
	const pending = new Map();
	let wlandRequests = [];
	ws.onmessage = (m) => {
		const msg = JSON.parse(m.data);
		if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
		if (msg.method === "Network.requestWillBeSent" && /\/wland[/_.-]|wland_client|\/assets\/client-[\w-]+\.js/.test(msg.params.request.url)) {
			wlandRequests.push({ url: msg.params.request.url.replace(/^https?:\/\/[^/]+/, ""), at: Number(secs()) });
			say(`page requests ${msg.params.request.url}`);
		}
		if (msg.method === "Runtime.consoleAPICalled") {
			const line = msg.params.args.map((a) => a.value ?? a.description).join(" ");
			if (/wayland|wland/i.test(line)) say(`page: ${line}`);
		}
		if (msg.method === "Network.responseReceived" && msg.params.response.status >= 400) say(`page request ${msg.params.response.url}: ${msg.params.response.status}`);
		if (msg.method === "Network.loadingFailed" && !msg.params.canceled) say(`page request failed: ${msg.params.errorText} (${msg.params.type})`);
		if (msg.method === "Inspector.targetCrashed") {
			console.error(`[${secs()}] the page crashed (its renderer process is gone)`);
			void cleanup().then(() => process.exit(2));
		}
		if (msg.method === "Runtime.exceptionThrown") say(`page exception: ${msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text}`);
	};
	const send = (method, params = {}) => new Promise((r) => {
		pending.set(++id, r);
		ws.send(JSON.stringify({ id, method, params }));
	});
	const evaluate = async (expression) => {
		const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
		return r.result?.result?.value;
	};
	const waitFor = async (expression, ms, step = 200) => {
		const end = performance.now() + ms;
		for (;;) {
			const v = await evaluate(expression).catch(() => undefined);
			if (v) return v;
			if (performance.now() > end) return v;
			await sleep(step);
		}
	};
	const sh = (cmd, user) => evaluate(`KW.vm.exec("sh", ["-c", ${JSON.stringify(cmd)}], { timeout: 60000${user ? `, user: ${JSON.stringify(user)}` : ""} }).then((r) => (r.stdout + r.stderr).trim())`);
	await send("Inspector.enable");
	await send("Runtime.enable");
	await send("Network.enable");
	await send("Page.enable");
	const openPage = async (u) => {
		say(`open ${u}`);
		await send("Page.navigate", { url: u });
		await sleep(500);
		if (!await waitFor("typeof globalThis.KW?.ready === 'function'", 120000)) throw new Error(`the page did not load: ${await evaluate("location.href + ' | ' + document.body?.innerText.replace(/\\s+/g, ' ').slice(0, 600)").catch((e) => e.message)}`);
		await evaluate("KW.ready().then(() => 1)");
	};
	const base = `http://127.0.0.1:${port}/?distro=debian${cpus !== "0" ? `&cpus=${cpus}` : ""}&mem=${firefoxTest || chatTest ? 2048 : 1024}&autosuspend=0&askleave=0&autohide=0${chatTest ? "&net=0&gl=1" : ""}`;

	// --- input as a keyboard and a mouse send it (Input.dispatch*) ---
	const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
	const MODKEY = { alt: ["AltLeft", "Alt", 18], ctrl: ["ControlLeft", "Control", 17], shift: ["ShiftLeft", "Shift", 16] };
	/** One key with modifiers held: code, key, its virtual key code; text for printable keys without Ctrl or Alt. */
	const press = async (code, key, vk, mods = [], opts = {}) => {
		const m = mods.reduce((a, k) => a | MOD[k], 0);
		let held = 0;
		for (const k of mods) { held |= MOD[k]; await send("Input.dispatchKeyEvent", { type: "rawKeyDown", code: MODKEY[k][0], key: MODKEY[k][1], windowsVirtualKeyCode: MODKEY[k][2], modifiers: held }); }
		const text = opts.text ?? (key.length === 1 && !(m & (MOD.ctrl | MOD.alt)) ? key : code === "Enter" ? "\r" : undefined);
		await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", code, key, windowsVirtualKeyCode: vk, modifiers: m, ...(text ? { text } : {}), ...(opts.commands ? { commands: opts.commands } : {}) });
		for (let i = 0; i < (opts.repeats ?? 0); i++) {
			await sleep(i ? opts.repeatMs ?? 33 : opts.delayMs ?? 500);
			await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", code, key, windowsVirtualKeyCode: vk, modifiers: m, autoRepeat: true, ...(text ? { text } : {}) });
		}
		if (opts.holdMs) await sleep(opts.holdMs);
		await send("Input.dispatchKeyEvent", { type: "keyUp", code, key, windowsVirtualKeyCode: vk, modifiers: m });
		for (const k of [...mods].reverse()) { held &= ~MOD[k]; await send("Input.dispatchKeyEvent", { type: "keyUp", code: MODKEY[k][0], key: MODKEY[k][1], windowsVirtualKeyCode: MODKEY[k][2], modifiers: held }); }
		await sleep(15);
	};
	const letter = (c) => [`Key${c.toUpperCase()}`, c, c.toUpperCase().charCodeAt(0)];
	const SPECIAL = { Enter: 13, Escape: 27, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, F10: 121, Home: 36, Period: 190 };
	const special = (k) => [k, k, SPECIAL[k]];
	const typeText = async (text) => {
		for (const ch of text) {
			const k = KEYS.get(ch);
			if (!k) throw new Error(`no key for ${JSON.stringify(ch)}`);
			const [code, key, shift] = k;
			const vk = code === "Enter" ? 13 : code === "Space" ? 32 : key.toUpperCase().charCodeAt(0);
			await press(code, key, vk, shift ? ["shift"] : []);
		}
	};
	/**
	 * A click (or a drag to `to`) as a hand makes it: the button held `holdMs` before the release
	 * (a person's click lasts 50 to 150 ms). A press and release sent back to back reach the app
	 * together, and l3afpad's button-press handler runs a nested main loop (gtk_clipboard_wait_for_text
	 * on PRIMARY) that dispatches the release before GtkTextView's gestures have seen the press: they
	 * stay pressed, and its next right click opened no menu about every other time (2026-11-22).
	 * holdMs 0: a click whose release comes before the app's answer to the press (foot's resize border).
	 */
	const mouse = async (x, y, { button = "left", mods = [], to = null, clicks = 1, holdMs = 60 } = {}) => {
		const modifiers = mods.reduce((a, k) => a | MOD[k], 0);
		const buttons = button === "right" ? 2 : 1;
		await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
		await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons, clickCount: clicks, modifiers });
		if (holdMs && !to) await sleep(holdMs);
		if (to) {
			for (let i = 1; i <= 10; i++) { await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + (to[0] - x) * i / 10, y: y + (to[1] - y) * i / 10, button, buttons, modifiers }); await sleep(20); }
			[x, y] = to;
		}
		await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: clicks, modifiers });
		await sleep(100);
	};
	/** Poll a guest file until `re` matches its contents (or the time is up); returns them. */
	const fileFor = async (path, re, ms = 20000) => {
		let v = "";
		const end = performance.now() + ms;
		while (performance.now() < end) { v = await sh(`cat ${path} 2>/dev/null`); if (re.test(v)) break; await sleep(400); }
		return v;
	};
	/** The windows wland lists, with each window element's rectangle on the page and its largest canvas's backing size. */
	const windows = async () => JSON.parse(await evaluate(`JSON.stringify(KW.wayland.windows().map((w) => {
		const el = KW.wayland.container().querySelector('[data-wland-window="' + w.key + '"]');
		const r = el?.getBoundingClientRect();
		const c = el ? [...el.querySelectorAll("canvas")].sort((a, b) => b.width * b.height - a.width * a.height)[0] : null;
		return { ...w, rect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null, canvas: c ? [c.width, c.height] : null };
	}))`));
	/** wland's container (#wl-desktop: the workspace's size, what maximize fills), and whether a Wayland window has the focus (its data-shown). */
	const desk = async () => JSON.parse(await evaluate(`JSON.stringify((() => { const r = document.querySelector("#wl-desktop").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, shown: !!document.querySelector("#wl-desktop[data-shown]") }; })())`));
	const byTitle = (list, t) => list.find((w) => w.title === t);
	const inside = (w, x, y) => x >= w.rect.x && x < w.rect.x + w.rect.w && y >= w.rect.y && y < w.rect.y + w.rect.h;
	/**
	 * Click the window titled `t` where no other window covers it (a 5x5 grid
	 * of points, the outer ones 16 px inside its edges), keeping 12 px off the others' edges: their
	 * resize borders (foot's are subsurfaces outside its window), which a click
	 * would start resizing. Then wait until it has the keyboard.
	 */
	const clickWindow = async (t, opts) => {
		const list = await windows(), w = byTitle(list, t);
		const others = list.filter((o) => o !== w && o.rect && !o.minimized).map((o) => ({ rect: { x: o.rect.x - 12, y: o.rect.y - 12, w: o.rect.w + 24, h: o.rect.h + 24 } }));
		const pts = [];
		for (const y of [w.rect.h / 2, w.rect.h * 0.3, w.rect.h * 0.7, w.rect.h - 16, 40]) for (const x of [w.rect.w / 2, w.rect.w * 0.3, w.rect.w * 0.7, w.rect.w - 16, 16]) pts.push([w.rect.x + x, w.rect.y + y]);
		const pt = pts.find(([x, y]) => !others.some((o) => inside(o, x, y)));
		if (!pt) throw new Error(`no uncovered point of ${t}`);
		await mouse(...pt, opts);
		await waitFor(`KW.wayland.windows().find((w) => w.focused)?.title === ${JSON.stringify(t)} && 1`, 3000, 100);
		return pt;
	};
	const centre = (w) => [w.rect.x + w.rect.w / 2, w.rect.y + w.rect.h / 2];
	/** Start a Wayland app in the background (as the console's user) through wland, its output in /tmp/wl-LOG.log. */
	const launch = (cmd, log) => sh(`setsid ${WL} ${cmd} >/tmp/wl-${log}.log 2>&1 </dev/null & sleep 0.2; echo started`);
	/** The same without wland: as typed in a login shell (kw-wayland.sh gives it the session). */
	launch.plain = (cmd, log) => sh(`setsid bash -lc 'exec ${cmd}' >/tmp/wl-${log}.log 2>&1 </dev/null & sleep 0.2; echo started`);
	const waitWindow = (title, ms = 60000) => waitFor(`KW.wayland.windows().some((w) => w.title === ${JSON.stringify(title)}) && 1`, ms, 300);
	const activeIn = () => evaluate(`document.activeElement?.closest?.("#wl-desktop") ? "desktop" : document.activeElement?.closest?.("#workspace") ? "terminal" : (document.activeElement?.id || document.activeElement?.tagName)`);
	/** Ctrl-A, then a key: the page's prefix (keys.ts). */
	const prefix = async (code, key, vk, mods = []) => { await press(...letter("a"), ["ctrl"]); await sleep(50); await press(code, key, vk, mods); await sleep(150); };
	const focusedTitle = async () => (await windows()).find((w) => w.focused)?.title ?? null;
	// pkill -x matches the 15 characters of a process's name; -f with ^ matches the command line from its start, never this sh -c's own.
	// SIGKILL for what SIGTERM left after 5 s (a foot under `yes` output outlived it).
	const cleanupApps = async () => {
		await sh(`k() { pkill $1 -x foot; pkill $1 -x l3afpad; pkill $1 -x wl-copy; pkill $1 -f '^(/usr/(local/)?bin/)?(weston-|es2gears|glmark2|gtk4-)'; }
			k; for i in $(seq 20); do pgrep -x foot >/dev/null || pgrep -x l3afpad >/dev/null || pgrep -f '^(/usr/(local/)?bin/)?(weston-|es2gears|glmark2|gtk4-)' >/dev/null || break; sleep 0.25; done; k -9; true`);
		await waitFor("KW.wayland.windows().length === 0 && 1", 15000);
	};
	/**
	 * Page code: an async function that opens the launcher (the Dock's
	 * #dock-launcher) unless it is open, then its Graphics folder
	 * (data-folder="gl" in #launcher-grid: a folder opens before its apps'
	 * tiles can be clicked), and resolves with app `id`'s tile there
	 * (data-app in #launcher-folder), or null.
	 */
	const GL_TILE = `(async (id) => {
		const until = async (f) => { for (let i = 0; i < 50 && !f(); i++) await new Promise((r) => setTimeout(r, 100)); return f(); };
		if (!document.querySelector("#launcher")) document.querySelector("#dock-launcher").click();
		const folder = await until(() => document.querySelector('#launcher-grid [data-folder="gl"]'));
		if (!folder) return null;
		folder.click();
		return await until(() => document.querySelector('#launcher-folder [data-app="' + id + '"]'));
	})`;
	/**
	 * The pixels wland drew for the window titled `t` (its largest canvas, read
	 * back from its 2D context; null on wland's WebGL presenter): its size,
	 * the RGBA of a corner (6, 6), how many distinct colours, and the mean row
	 * of the opaque pixels that are mostly blue and of those mostly red or
	 * green (weston-simple-egl's triangle has its blue corner at the top:
	 * upside down, the blue mean would be below the others').
	 */
	const windowPixels = async (t) => JSON.parse(await evaluate(`(() => {
		const w = KW.wayland.windows().find((x) => x.title === ${JSON.stringify(t)});
		const el = w && KW.wayland.container().querySelector('[data-wland-window="' + w.key + '"]');
		const c = el && [...el.querySelectorAll("canvas")].sort((a, b) => b.width * b.height - a.width * a.height)[0];
		const ctx = c?.getContext("2d");
		if (!ctx) return "null";
		const { width, height } = c, d = ctx.getImageData(0, 0, width, height).data;
		const colours = new Set();
		let by = 0, bn = 0, ry = 0, rn = 0, opaque = 0;
		for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
			if (colours.size < 5000) colours.add((r << 24 | g << 16 | b << 8 | a) >>> 0);
			if (a !== 255) continue;
			opaque++;
			if (b > 120 && b > (r + g) * 1.5) { by += y; bn++; } else if (Math.max(r, g) > 120 && b < Math.max(r, g) / 2) { ry += y; rn++; }
		}
		const k = (6 * width + 6) * 4;
		return JSON.stringify({ size: [width, height], corner: [...d.subarray(k, k + 4)], colours: colours.size, opaque, blueY: bn ? +(by / bn).toFixed(1) : null, redGreenY: rn ? +(ry / rn).toFixed(1) : null });
	})()`));
	/** The relay's log. */
	const relayLog = () => sh("cat /run/user/1000/wlandr.log");
	/** Counters over an interval: KW.wayland.stats() and the time. */
	const statsNow = async () => JSON.parse(await evaluate("JSON.stringify({ ...KW.wayland.stats(), t: performance.now() })"));

	/**
	 * --firefox: firefox-esr from a login shell on a local page whose title
	 * shows what reached it (clicks, wheel events, scroll position, the last
	 * key, the text field, context menus, its innerHeight: where the content
	 * starts below Firefox's own bars), then pointer, keyboard, menu, wheel,
	 * selection and navigation, each seen in the window's title.
	 */
	const firefoxCase = async (mode) => {
		const page = `<!doctype html><meta charset="utf-8"><title>kwtest</title>
<style>body{margin:0;height:4000px;font:28px sans-serif}#b,#i,#s,#a{position:absolute;left:0;margin:0}#b{top:0;width:300px;height:150px}#i{top:170px;width:300px;height:40px;font-size:20px}#s{top:230px}#a{top:290px;width:300px;height:80px;display:block;background:#fc8}</style>
<button id="b">click</button><input id="i"><p id="s">selectme words</p><a id="a" href="t2.html">link</a>
<script>const s={c:0,x:0,w:0,k:""},i=document.getElementById("i");
const T=()=>{document.title="kwtest c"+s.c+" x"+s.x+" w"+s.w+" s"+Math.round(scrollY)+" h"+innerHeight+" k:"+s.k+" i:"+i.value;};
document.getElementById("b").onclick=()=>{s.c++;T();};addEventListener("contextmenu",()=>{s.x++;T();});addEventListener("wheel",()=>{s.w++;T();});
addEventListener("scroll",T);addEventListener("resize",T);addEventListener("keydown",(e)=>{s.k=e.key;T();});i.oninput=T;T();</script>`;
		const prefs = 'user_pref("browser.shell.checkDefaultBrowser", false);\nuser_pref("datareporting.policy.firstRunURL", "");\n';
		await sh(`pkill -x firefox-esr; rm -rf /tmp/ffp; mkdir -p /tmp/ffp; cd /tmp; echo ${Buffer.from(page).toString("base64")} | base64 -d > t.html; echo '<title>kwtwo</title>two' > t2.html; echo '<title>kwthree</title>three' > t3.html; printf '${prefs.replace(/\n/g, "\\n")}' > /tmp/ffp/user.js`);
		const before = await statsNow();
		const started = performance.now();
		await launch.plain("firefox-esr --profile /tmp/ffp --no-remote file:///tmp/t.html", "firefox");
		const title = (re, ms = 20000) => waitFor(`KW.wayland.windows().map((w) => w.title).find((t) => ${re}.test(t)) || ""`, ms, 300);
		const titleNow = () => evaluate("KW.wayland.windows().map((w) => w.title).join(' | ')");
		const ffShot = async (name) => { if (shots) writeFileSync(join(shots, `${mode}-firefox-${name}.png`), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).result.data, "base64")); };
		const mapped = await title(/^kwtest .* h\d+/, 240000);
		const mapSecs = ((performance.now() - started) / 1000).toFixed(1);
		const w = (await windows()).find((x) => /^kwtest/.test(x.title));
		const st = await statsNow();
		const gpuPath = st.gpuCommits > before.gpuCommits;
		report(`${mode}: firefox-esr maps its window with the page`, !!mapped && !!w?.rect, `${mapped ? `"${mapped}" after ${mapSecs} s` : "no window in 240 s"}; ${w ? `${w.rect.w}x${w.rect.h}, maximized ${w.maximized}, focused ${w.focused}` : ""}; ${st.gpuCommits - before.gpuCommits} GPU commits, ${st.commits - before.commits} commits${mapped ? "" : `\n--- its output:\n${await sh("tail -15 /tmp/wl-firefox.log")}\n--- relay log:\n${await relayLog()}`}`);
		if (!mapped || !w?.rect) return void await sh("pkill -x firefox-esr; true");
		// The page's content: the window's bottom innerHeight pixels.
		const ox = w.rect.x, oy = w.rect.y + w.rect.h - Number(/ h(\d+)/.exec(mapped)[1]);
		const at = (x, y) => [ox + x, oy + y];
		await mouse(...at(150, 75));
		await mouse(...at(150, 75));
		const clicked = await title(/^kwtest c2 /);
		await mouse(...at(150, 190));
		await typeText("abc");
		const typed = await title(/ i:abc /);
		report(`${mode}: firefox: two clicks on a button, then typing into a text field`, !!clicked && !!typed, `after the clicks "${clicked}"; after typing "${typed}"`);
		await mouse(...at(600, 300), { button: "right" });
		const menu = await waitFor("KW.wayland.popups() === 1 && 1", 20000, 250);
		const xEvent = await title(/ x1 /, 5000);
		await ffShot("menu");
		await press(...special("Escape"));
		const menuGone = await waitFor("KW.wayland.popups() === 0 && 1", 10000, 250);
		report(`${mode}: firefox: a right click opens its context menu, Escape closes it`, !!menu && !!xEvent && !!menuGone, `popup ${!!menu}, contextmenu event ${!!xEvent}, closed ${!!menuGone}`);
		const wheel = async (dy) => {
			const [x, y] = at(600, 300);
			await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
			for (let n = 0; n < 3; n++) { await send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: dy }); await sleep(120); }
		};
		await wheel(120);
		// Firefox may count more wheel events than notches (smooth scrolling): the position tells.
		const down = await title(/ w[1-9]\d* s[1-9]/);
		await wheel(-120);
		const up = await title(/ w([4-9]|\d\d+) s0 /);
		if (!down || !up) await ffShot("wheel");
		report(`${mode}: firefox: the wheel scrolls the page down and back`, !!down && !!up, `"${down}", then "${up}"${down && up ? "" : `; now "${await titleNow()}"`}`);
		await mouse(...at(2, 247), { to: at(215, 247) });
		// Firefox takes the primary selection a moment after the release.
		const primary = await sh(`for i in $(seq 10); do p=$(timeout 10 ${WL} wl-paste -p -n 2>&1); rc=$?; [ $rc = 0 ] && break; sleep 0.5; done; echo "$p rc=$rc"`);
		await press(...letter("c"), ["ctrl"]);
		const clip = await sh(`for i in $(seq 10); do sleep 0.5; p=$(timeout 10 ${WL} wl-paste -n 2>&1); rc=$?; [ $rc = 0 ] && break; done; echo "$p rc=$rc"`);
		await ffShot("selection");
		report(`${mode}: firefox: a drag selects text (primary selection), Ctrl+C copies it (wl-paste)`, /^selectme words rc=0/.test(primary) && /^selectme words rc=0/.test(clip), `primary ${JSON.stringify(primary)}, clipboard ${JSON.stringify(clip)}`);
		await mouse(...at(50, 330));
		const link = await title(/^kwtwo/, 30000);
		// A loaded machine slows Firefox down enough that the URL bar may not have the focus yet when
		// the typing starts (2026-11-22, a load of 14 on 16 cores): a second try (Ctrl+L selects what is there).
		let typedUrl = "", tries = 0;
		while (!typedUrl && tries++ < 2) {
			await press(...letter("l"), ["ctrl"]);
			await sleep(2000);
			await typeText("file:///tmp/t3.html");
			await press(...special("Enter"));
			typedUrl = await title(/^kwthree/, 30000);
		}
		report(`${mode}: firefox: a click on a link navigates; Ctrl+L, a typed URL and Enter navigate`, !!link && !!typedUrl, `"${link}", then "${typedUrl}"${typedUrl && tries > 1 ? ` (try ${tries})` : ""}${typedUrl ? "" : `; now "${await titleNow()}"`}`);
		await sh("pkill -x firefox-esr; for i in $(seq 20); do pgrep -x firefox-esr >/dev/null || break; sleep 0.5; done; pkill -9 -x firefox-esr; true");
		await waitFor("KW.wayland.windows().length === 0 && 1", 30000);
	};

	// Both arms use the same CDP input through the outer browser. The app sends its
	// results back in a single title update after the timed input and scrolling.
	const chatCase = async (mode, cfg) => {
		const fixture = new URL("./chat-bench.html", import.meta.url);
		const guest = mode !== "host";
		const draft = "m".repeat(24);
		const wheel = { count: 180, deltaY: 46, intervalMs: 1000 / 60 };
		let key, x = 0, y = 0;
		if (guest) {
			if (!await sh("command -v chromium")) throw new Error("chat: Chromium is missing from the prepared disk");
			const contents = readFileSync(fixture).toString("base64");
			await sh(`printf '%s' '${contents}' | base64 -d >/tmp/kw-chat.html`);
			const chromeApp = [
				'chromium --ozone-platform=wayland --user-data-dir="$(mktemp -d)"',
				"--no-first-run --no-default-browser-check --disable-background-networking --disable-component-update",
				"--window-size=1000,700 --force-device-scale-factor=1 --app=file:///tmp/kw-chat.html",
			].join(" ");
			await launch.plain(chromeApp, "chat");
			if (!await waitWindow("kw-chat-ready", 240000)) throw new Error(`chat: guest fixture not ready: ${await sh("tail -20 /tmp/wl-chat.log")}`);
			// Let the host window animation settle before reading canvas coordinates.
			await sleep(250);
			key = (await windows()).find((w) => w.title === "kw-chat-ready").key;
			const bounds = await evaluate(`document.querySelector('canvas[data-wland="' + ${JSON.stringify(key)} + '"]').getBoundingClientRect().toJSON()`);
			({ x, y } = bounds);
		} else {
			await send("Page.navigate", { url: fixture.href });
			if (!await waitFor("document.title === 'kw-chat-ready'", 10000)) throw new Error("chat: host fixture not ready");
		}
		const title = guest ? `KW.wayland.windows().find(w => w.key === ${JSON.stringify(key)})?.title` : "document.title";
		await mouse(x + 300, y + 606); // composer
		await press("F8", "F8", 119);
		if (!await waitFor(`${title} === "kw-chat-armed"`, 15000)) throw new Error("chat: composer did not gain focus");
		for (const ch of draft) {
			const deadline = performance.now() + 350;
			await press(...letter(ch));
			await sleep(Math.max(0, deadline - performance.now()));
		}
		await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + 450, y: y + 300 });
		if (guest) await evaluate(`(() => {
			const { view } = KW.wayland.wland(), before = view.handle;
			const commits = [], wheels = [];
			const onWheel = (event) => { if (event.isTrusted) wheels.push(performance.now()); };
			document.addEventListener("wheel", onWheel, true);
			view.handle = function (event) {
				if (event.type === "commit" && "c" + event.conn + "s" + event.surface === ${JSON.stringify(key)})
					commits.push({ at: performance.now(), gpu: !!event.gpu });
				return before.call(this, event);
			};
			window.chatCommits = () => {
				view.handle = before;
				document.removeEventListener("wheel", onWheel, true);
				delete window.chatCommits;
				return { wheels, commits: commits.filter(({ at }) => at >= wheels[0] && at <= wheels.at(-1)) };
			};
		})()`);
		const start = performance.now();
		const sends = [], dispatched = [];
		for (let i = 0; i < wheel.count; i++) {
			await sleep(Math.max(0, start + wheel.intervalMs * i - performance.now()));
			dispatched.push(performance.now());
			sends.push(send("Input.dispatchMouseEvent", {
				type: "mouseWheel", x: x + 450, y: y + 300, deltaX: 0, deltaY: wheel.deltaY,
			}));
		}
		await Promise.all(sends);
		await sleep(1500);
		const observed = guest ? await evaluate("window.chatCommits()") : null;
		await press("F9", "F9", 120);
		const prefix = "kw-chat-result ";
		const result = await waitFor(`(${title})?.startsWith(${JSON.stringify(prefix)}) && (${title})`, 30000);
		if (!result) throw new Error("chat: fixture did not report its result");
		const app = JSON.parse(result.slice(prefix.length));
		const commits = observed?.commits ?? [];
		const duration = (times) => times.length ? +(times.at(-1) - times[0]).toFixed(2) : null;
		const gaps = commits.slice(1).map(({ at }, i) => at - commits[i].at).sort((a, b) => a - b);
		const at = (p) => +gaps[Math.ceil(p * gaps.length) - 1].toFixed(2);
		const browser = guest ? await sh("chromium --version") : (await send("Browser.getVersion")).result.product;
		const guestState = guest ? { ...cfg, ramMiB: await evaluate("KW.memActualMiB"), onlineCpus: await sh("cat /sys/devices/system/cpu/online") } : null;
		const ok = app.draft === draft && app.keydownToInputMs.n === draft.length && app.scrollTop > 0 && app.wheelEvents > 0;
		console.log(JSON.stringify({ benchmark: "chat", mode, browser, guest: guestState, ok,
			wheel: { ...wheel, dispatchMs: duration(dispatched) }, ...app,
			...(observed ? { wayland: { wheelEvents: observed.wheels.length, wheelMs: duration(observed.wheels),
				commits: commits.length, gpuCommits: commits.filter(c => c.gpu).length,
				commitGapMs: gaps.length ? { n: gaps.length, p50: at(.5), p95: at(.95) } : { n: 0 } } } : {}),
		}));
		if (!ok) fails++;
	};

	if (chatTest) await chatCase("host");

	// The prepared disk into this profile's data disk (the page reloads itself after the import); --fresh: none.
	if (!fresh) {
		await openPage(`${base}&worker=0`);
		say("importing the prepared data disk");
		// Its reload may end this evaluation first.
		const imp = await evaluate(`fetch(${JSON.stringify(diskUrl)}).then((r) => r.blob()).then((b) => KW.importData(b)).then((r) => JSON.stringify(r))`).catch((e) => `(the page reloaded: ${e.message.split("\n")[0]})`);
		say(`imported: ${imp}`);
		await sleep(1500);
		if (!await waitFor("typeof globalThis.KW?.ready === 'function'", 120000)) throw new Error("the page did not load after the import");
		await evaluate("KW.ready().then(() => 1)");
	}

	const modes = [["worker", ""], ["inline", "&worker=0"]].filter(([m]) => !only || only === m);
	let first = !fresh; // the import's page is the inline one
	for (const [mode, param] of modes) {
		if (!first || mode !== "inline") await openPage(`${base}${param}`);
		first = false;
		wlandRequests = [];
		const cfg = JSON.parse(await evaluate("JSON.stringify({ worker: KW.config.worker, cpus: KW.config.cpus, transport: KW.vm.transport ?? 'inline' })"));
		say(`${mode}: ${JSON.stringify(cfg)}`);
		if (chatTest) { await chatCase(mode, cfg); continue; }
		const has = await sh("command -v foot; ls /usr/lib/kw/wlandr /usr/lib/kw/bin/wland");
		if (chromiumTest) {
			// As typed in a terminal (a login shell: the session from kw-wayland.sh), then with no Wayland
			// variables at all (a plain sh: the chromium.d hook gets them from wland).
			await sh("pkill -x chromium; true");
			for (const [how, start] of [["in a login shell", "bash -lc 'exec chromium'"], ["with no Wayland variables", "chromium"]]) {
				const before = await statsNow();
				await sh(`setsid ${start} >/tmp/wl-chromium.log 2>&1 </dev/null & sleep 0.2; echo started`);
				const win = await waitFor("KW.wayland.windows().find((w) => /Chromium/.test(w.title)) && JSON.stringify(KW.wayland.windows())", 180000, 1000);
				const flags = await sh("tr '\\0' ' ' < /proc/$(pgrep -o -x chromium)/cmdline 2>/dev/null | grep -o -- '--ozone-platform=[a-z]*'");
				report(`${mode}: plain chromium ${how} maps a window`, !!win && /wayland/.test(flags), `windows ${win}; ${flags || "no chromium running"}${win ? "" : `\n--- its output:\n${await sh("grep -v ssl_client /tmp/wl-chromium.log | tail -15")}\n--- relay log:\n${await relayLog()}`}`);
				// The GPU path (the disk has Mesa's EGL; the renderer's multisample renderbuffers give
				// ANGLE OpenGL ES 3.0): Chromium's GPU process stays, and its window comes by GPU
				// resource (GPU commits, no shm reads; the relay logs its first buffer by resource once).
				if (win) {
					await sleep(5000);
					const after = await statsNow();
					const firsts = (await relayLog()).split("\n").filter((l) => /virtgpu: conn \d+ buffer \d+: first /.test(l));
					const gpuLog = await sh("grep -E 'Exiting GPU process|Requested version is not supported|gpu_init' /tmp/wl-chromium.log | grep -v ssl_client | head -3; echo \"gpu processes $(pgrep -f type=gpu-process | wc -l)\"");
					const gpuCommits = after.gpuCommits - before.gpuCommits, reads = after.reads - before.reads;
					report(`${mode}: chromium ${how} renders on the GPU (its window by resource)`, gpuCommits > 0 && reads === 0 && firsts.length > 0 && !/Exiting GPU process/.test(gpuLog),
						`${gpuCommits} GPU commits, ${after.commits - before.commits} commits, ${reads} shm reads; ${firsts.at(-1)?.replace(/^.*virtgpu: /, "") ?? "no buffer by resource"}; ${gpuLog.replace(/\n/g, "; ")}`);
				}
				await sh("pkill -x chromium; true");
				await waitFor("KW.wayland.windows().length === 0 && 1", 30000);
			}
			continue;
		}
		if (firefoxTest) {
			await firefoxCase(mode);
			continue;
		}
		if ((!fresh && !/foot/.test(has)) || !/wlandr/.test(has)) { report(`${mode}: guest`, false, has); continue; }

		// 1: nothing of wland before an app
		const avail = await waitFor("KW.ui && document.querySelector('#dock-launcher') && KW.wayland && 1", 10000);
		const pre = JSON.parse(await evaluate("JSON.stringify({ icon: !!document.querySelector('#dock-wayland'), loaded: KW.wayland?.loaded?.() ?? null })"));
		// The relay the guest started at boot (wland --boot from the kw layer's rc), on demand: not dialed yet.
		const boot = (await sh("cat /proc/cmdline; p=$(cat /run/user/1000/wlandr.pid); tr '\\0' ' ' < /proc/$p/cmdline; echo; grep VmRSS /proc/$p/status; cat /run/user/1000/wlandr.log")).split("\n");
		const bootOk = / kw\.wayland=1\b/.test(boot[0]) && /--link-on-demand/.test(boot[1]) && boot.some((l) => /: on demand/.test(l)) && !boot.some((l) => /dialing| connected/.test(l));
		report(`${mode}: idle before an app`, !!avail && !pre.icon && pre.loaded === false && wlandRequests.length === 0 && bootOk, `${JSON.stringify(pre)}, ${wlandRequests.length} requests for wland's modules or wasm${wlandRequests.length ? `: ${wlandRequests.map((r) => r.url).join(" ")}` : ""}; boot relay: ${boot.slice(1).join(" | ")}`);

		// P: plain foot (no wland prefix) in a login shell, as typed at a prompt; then a second one on the same link
		const plainAt = Number(secs());
		{
			await launch.plain("foot -T plain", "plain");
			const pw = await waitWindow("plain", fresh ? 900000 : 120000);
			const mapped = Number(secs());
			await launch.plain("foot -T plain2", "plain2");
			const pw2 = await waitWindow("plain2", 60000);
			const log = await relayLog();
			const dials = (log.match(/an app is waiting; dialing/g) ?? []).length, links = (log.match(/ connected$/gm) ?? []).length;
			report(`${mode}: plain foot maps a window, wland fetched only then; a second one on the same link`,
				!!pw && !!pw2 && dials === 1 && links === 1 && wlandRequests.some((r) => /\.wasm/.test(r.url)) && wlandRequests.every((r) => r.at >= plainAt),
				`window ${!!pw} ${(mapped - plainAt).toFixed(1)} s after the start, second ${!!pw2}; relay: ${dials} dial(s), ${links} link(s); wland fetched ${JSON.stringify(wlandRequests.map((r) => `${r.url.replace(/\?.*/, "")} at ${r.at}`))} (started at ${plainAt} s)${pw ? "" : `\n--- foot: ${await sh("tail -5 /tmp/wl-plain.log")}\n--- relay log:\n${log}`}`);
			await cleanupApps();
		}

		// 2: the launcher's tile
		const clickAt = Number(secs());
		const clicked = await evaluate(`(async () => {
			const b = await ${GL_TILE}("foot");
			if (!b) return "no foot tile";
			if (b.getAttribute("aria-disabled") === "true") return "disabled: " + b.title;
			b.click();
			return "clicked";
		})()`);
		say(`${mode}: foot tile ${clicked}`);
		const win = await waitFor("KW.wayland.windows().find((w) => /foot/.test(w.title)) && JSON.stringify(KW.wayland.windows())", fresh ? 900000 : 180000, 500);
		const state = JSON.parse(await evaluate(`JSON.stringify({ shown: !!document.querySelector("#wl-desktop[data-shown]"), icon: !!document.querySelector("#dock-wayland"), buffers: KW.wayland.stats(), appTerm: KW.windows.list().find((w) => w.name === "foot")?.n ?? null })`));
		if (shots) writeFileSync(join(shots, `${mode}-page.png`), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
		report(`${mode}: foot window`, !!win && state.shown && state.icon && state.buffers.reads > 0 && wlandRequests.some((r) => /\.wasm/.test(r.url)) && wlandRequests.every((r) => r.at >= plainAt),
			`windows ${win}; ${JSON.stringify(state)}; wland fetched ${JSON.stringify(wlandRequests.map((r) => `${r.url.replace(/\?.*/, "")} at ${r.at}`))} (clicked at ${clickAt} s, the first app at ${plainAt} s)`);
		if (!win) {
			// Its packages install in the launcher's installer window (web/src/installer.ts), whose log is #installer-foot-log.
			console.log(`--- the foot app's installer: ${await evaluate(`(() => { const el = document.querySelector("#installer-foot"); return el ? el.dataset.state + ": " + (document.querySelector("#installer-foot-step")?.textContent ?? "") + "\\n" + (document.querySelector("#installer-foot-log")?.textContent ?? "(log closed)").trim().split("\\n").slice(-15).join("\\n") : "none"; })()`)}`);
			console.log(`--- the foot app's terminal (${state.appTerm}):\n${await evaluate(`KW.windows.text(${state.appTerm ?? 0}).trim().split("\\n").slice(-15).join("\\n")`)}`);
			console.log(`--- relay log:\n${await sh("tail -20 /run/user/1000/wlandr.log")}`);
			continue;
		}
		await sleep(3000); // foot draws its prompt

		// 3: pixels
		const rect = JSON.parse(await evaluate(`(() => { const c = [...KW.wayland.container().querySelectorAll("canvas")].map((x) => x.getBoundingClientRect()).filter((r) => r.width > 100 && r.height > 50).sort((a, b) => b.width * b.height - a.width * a.height)[0]; return JSON.stringify(c ? { x: c.x, y: c.y, width: c.width, height: c.height } : null); })()`));
		const shot = async (name) => {
			const s = await send("Page.captureScreenshot", { format: "png", clip: { ...rect, scale: 1 } });
			const png = Buffer.from(s.result.data, "base64");
			if (shots) writeFileSync(join(shots, `${mode}-${name}.png`), png);
			return decodePng(png);
		};
		if (!rect) report(`${mode}: window pixels`, false, "no canvas in the workspace");
		else {
			const img = await shot("foot");
			const colours = new Map();
			for (let i = 0; i < img.rgba.length; i += 4) {
				const k = (img.rgba[i] << 16) | (img.rgba[i + 1] << 8) | img.rgba[i + 2];
				colours.set(k, (colours.get(k) ?? 0) + 1);
			}
			const most = Math.max(...colours.values()), other = img.width * img.height - most;
			// A terminal with its prompt: a flat background, and text in a few colours.
			report(`${mode}: window pixels`, colours.size >= 8 && other >= 200, `${img.width}x${img.height} at ${rect.x.toFixed(0)},${rect.y.toFixed(0)}: ${colours.size} colours, ${other} pixels not the background's`);
		}

		// 4: typing
		await sh("rm -f /tmp/wland-typed");
		const cx = rect ? rect.x + rect.width / 2 : 300, cy = rect ? rect.y + rect.height / 2 : 300;
		for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: cx, y: cy, button: "left", clickCount: 1 });
		await sleep(300);
		const focus = await evaluate(`JSON.stringify({ active: document.activeElement?.closest?.("#wl-desktop") ? "desktop" : document.activeElement?.id || document.activeElement?.tagName, focused: KW.wayland.windows().filter((w) => w.focused).map((w) => w.title) })`);
		await typeText("echo typed $((6*7)) > /tmp/wland-typed\n");
		let typed = "";
		for (let i = 0; i < 60 && !/typed 42/.test(typed); i++) { await sleep(500); typed = await sh("cat /tmp/wland-typed 2>&1"); }
		report(`${mode}: typing reaches foot`, /^typed 42$/.test(typed), `focus ${focus}; /tmp/wland-typed: ${JSON.stringify(typed)}`);
		if (rect) await shot("typed");

		// 5: exit
		await typeText("exit\n");
		const gone = await waitFor("KW.wayland.windows().length === 0 && !document.querySelector('#wl-desktop[data-shown]')", 30000);
		const after = JSON.parse(await evaluate(`JSON.stringify({ icon: !!document.querySelector("#dock-wayland"), windows: KW.wayland.windows().length })`));
		const relay = await sh("tail -4 /run/user/1000/wlandr.log; kill -0 $(cat /run/user/1000/wlandr.pid) && echo relay-alive");
		report(`${mode}: foot exits, the Wayland apps lose the focus, the relay and its Dock tile stay`, !!gone && after.icon && /relay-alive/.test(relay), `${JSON.stringify(after)}; relay: ${relay.replace(/\n/g, " | ")}`);
		const stats = await evaluate("JSON.stringify(KW.wayland.stats())");
		say(`${mode}: buffers read ${stats}`);

		// 6: foot's keys stayed out of the terminal; a second wland reuses the relay; killed, it is replaced
		{
			const termHad = await evaluate(`KW.windows.text(${state.appTerm ?? 0})`);
			const pid1 = await sh("cat /run/user/1000/wlandr.pid");
			const reuse = await sh(`${WL} true; echo rc=$?; cat /run/user/1000/wlandr.pid`);
			let restart = "not checked inline", restartOk = true;
			if (mode === "worker") {
				await sh(`kill ${pid1}`);
				const lost = await waitFor("!document.querySelector('#dock-wayland') && 1", 10000);
				await launch("foot -T again", "again");
				const back = await waitWindow("again");
				const pid2 = await sh("cat /run/user/1000/wlandr.pid");
				const od = await sh(`tr '\\0' ' ' < /proc/${pid2}/cmdline`);
				restartOk = !!lost && !!back && pid2 !== pid1 && /--link-on-demand/.test(od);
				restart = `killed ${pid1}: Dock tile gone ${!!lost}; wland foot: new relay ${pid2} (${od.trim()}), window ${!!back}`;
				await cleanupApps();
			}
			report(`${mode}: keys stay out of the terminal; wland reuses the relay${mode === "worker" ? ", and replaces a killed one" : ""}`,
				!/wland-typed/.test(termHad) && reuse === `rc=0\n${pid1}` && restartOk, `terminal has foot's keys: ${/wland-typed/.test(termHad)}; wland true: ${JSON.stringify(reuse)} (relay ${pid1}); ${restart}`);
		}

		const firstMode = mode === modes[0][0];
		// --apps: two windows, focus, the window manager, the page resized, the clipboard
		if (want("--apps") && firstMode) {
			await cleanupApps();
			// The page's clipboard for wland's bridge (checked below): granted before any app copies, as a
			// user's browser lets a page write it around a click; focus as a window in front has it.
			await send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"], origin: `http://127.0.0.1:${port}` });
			await send("Emulation.setFocusEmulationEnabled", { enabled: true });
			await sh("rm -f /tmp/wl-a1 /tmp/wl-a2 /tmp/wl-clip1 /tmp/wl-left");
			await launch("env WIN=one foot -T one", "one");
			const w1 = await waitWindow("one");
			await sleep(1500);
			await launch("env WIN=two foot -T two", "two");
			const w2 = await waitWindow("two");
			await sleep(2000); // both draw their prompts
			let list = await windows();
			const newer = list.find((w) => w.focused)?.title;
			const one = byTitle(list, "one"), two = byTitle(list, "two");
			await clickWindow("one");
			const f1 = await focusedTitle();
			await typeText("echo $WIN > /tmp/wl-a1\n");
			const a1 = await fileFor("/tmp/wl-a1", /\w/);
			const a2 = await sh("cat /tmp/wl-a2 2>/dev/null");
			report("apps: two windows, the newer has the keyboard, a click gives it to the other", !!w1 && !!w2 && newer === "two" && f1 === "one" && a1 === "one" && !a2,
				`${list.map((w) => `${w.title} ${w.rect ? `${w.rect.w}x${w.rect.h}@${w.rect.x},${w.rect.y}` : "?"}`).join(", ")}; focused at first ${newer}, after the click ${f1}; /tmp/wl-a1 ${JSON.stringify(a1)}`);

			// The window manager: Alt+F10 maximizes, Alt+drag moves; the page resized resizes the maximized window.
			// Maximized, the WM window fills the workspace (foot asks for server-side decorations: its element is under the WM's title bar).
			await clickWindow("two");
			const before = byTitle(await windows(), "two");
			await press(...special("F10"), ["alt"]);
			const maxed = await waitFor(`(() => { const w = KW.wayland.container().querySelector('[data-wland-window="${before.key}"]'); const d = document.querySelector("#wl-desktop").getBoundingClientRect(); const r = (w.closest(".wm-win") ?? w).getBoundingClientRect(); const c = [...w.querySelectorAll("canvas")].sort((a, b) => b.width * b.height - a.width * a.height)[0]; return Math.abs(r.width - d.width) < 3 && Math.abs(r.height - d.height) < 3 && c && c.width >= d.width - 3 && c.height >= d.height - 40; })()`, 15000, 250);
			const m = byTitle(await windows(), "two"), d0 = await desk();
			if (shots) writeFileSync(join(shots, "apps-maximized.png"), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
			report("apps: Alt+F10 maximizes to the workspace's size, foot redraws at it (its title bar is a canvas of its own)", !!maxed && m.maximized,
				`workspace ${d0.w}x${d0.h}; window ${m.rect.w}x${m.rect.h} at ${m.rect.x},${m.rect.y}, canvas ${m.canvas}, maximized ${m.maximized} (was ${before.rect.w}x${before.rect.h})`);
			await send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 640, deviceScaleFactor: 1, mobile: false });
			const resized = await waitFor(`(() => { const w = KW.wayland.container().querySelector('[data-wland-window="${before.key}"]'); const d = document.querySelector("#wl-desktop").getBoundingClientRect(); const r = (w.closest(".wm-win") ?? w).getBoundingClientRect(); const c = [...w.querySelectorAll("canvas")].sort((a, b) => b.width * b.height - a.width * a.height)[0]; return d.width <= 1000 && Math.abs(r.width - d.width) < 3 && Math.abs(r.height - d.height) < 3 && c && Math.abs(c.width - d.width) < 3; })()`, 15000, 250);
			const m2 = byTitle(await windows(), "two"), d1 = await desk();
			await send("Emulation.clearDeviceMetricsOverride");
			const back = await waitFor(`(() => { const w = KW.wayland.container().querySelector('[data-wland-window="${before.key}"]'); const d = document.querySelector("#wl-desktop").getBoundingClientRect(); const c = [...w.querySelectorAll("canvas")].sort((a, b) => b.width * b.height - a.width * a.height)[0]; return d.width > 1100 && c && Math.abs(c.width - d.width) < 3; })()`, 15000, 250);
			report("apps: the page resized, the maximized window follows the workspace", !!resized && !!back, `workspace ${d1.w}x${d1.h}: window ${m2.rect.w}x${m2.rect.h}, canvas ${m2.canvas}; back to ${(await desk()).w}: ${!!back}`);
			await press(...special("F10"), ["alt"]);
			const restored = await waitFor(`(() => { const w = KW.wayland.windows().find((x) => x.title === "two"); const el = KW.wayland.container().querySelector('[data-wland-window="${before.key}"]'); const r = el.getBoundingClientRect(); return !w.maximized && Math.abs(r.width - ${before.rect.w}) < 3 && Math.abs(r.x - ${before.rect.x}) < 3; })()`, 15000, 250);
			const r0 = byTitle(await windows(), "two");
			const [mx, my] = centre(r0);
			await mouse(mx, my, { mods: ["alt"], to: [mx + 120, my + 60] });
			const moved = byTitle(await windows(), "two");
			const dx = moved.rect.x - r0.rect.x, dy = moved.rect.y - r0.rect.y;
			report("apps: Alt+F10 again restores it, Alt+drag moves it", !!restored && Math.abs(dx - 120) < 4 && Math.abs(dy - 60) < 4,
				`restored ${r0.rect.w}x${r0.rect.h} at ${r0.rect.x},${r0.rect.y} (${!!restored}); moved by ${dx},${dy}`);

			// foot's resize border (a subsurface just outside its left edge): a quick click there starts no
			// resize (foot asks for it after the release; wland 0.1.0 then resized with the pointer until
			// the next click), a drag resizes by the drag.
			{
				const r1 = byTitle(await windows(), "two");
				const bx = r1.rect.x - 2, by = r1.rect.y + r1.rect.h / 2;
				await mouse(bx, by, { holdMs: 0 });
				for (let i = 1; i <= 8; i++) { await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: bx - i * 10, y: by, buttons: 0 }); await sleep(30); }
				await sleep(1000);
				const r2 = byTitle(await windows(), "two");
				await mouse(bx, by, { to: [bx - 100, by] });
				await sleep(1500);
				const r3 = byTitle(await windows(), "two");
				const grew = r3.rect.w - r2.rect.w, left = r2.rect.x - r3.rect.x;
				report("apps: a quick click on foot's resize border then a move without buttons leaves it as it was; a drag on the border resizes it",
					Math.abs(r2.rect.w - r1.rect.w) < 2 && Math.abs(r2.rect.x - r1.rect.x) < 2 && grew > 80 && grew < 120 && Math.abs(left - grew) < 4,
					`${r1.rect.w}x${r1.rect.h} at ${r1.rect.x},${r1.rect.y}; after the click and the move ${r2.rect.w}x${r2.rect.h} at ${r2.rect.x},${r2.rect.y}; dragged 100 px left: ${r3.rect.w}x${r3.rect.h} at ${r3.rect.x},${r3.rect.y} (grew ${grew})`);
			}

			// The clipboard: wl-copy (an app of its own) to foot's paste (Ctrl+Shift+V), foot's selection to wl-paste.
			const copy = await sh(`printf wlclip42 | timeout 20 ${WL} wl-copy; echo rc=$?`);
			await sleep(500);
			await clickWindow("two");
			await typeText("echo ");
			await press(...letter("v"), ["ctrl", "shift"]);
			await typeText(" $WIN > /tmp/wl-clip1\n");
			const clip1 = await fileFor("/tmp/wl-clip1", /wlclip42/, 10000); // pasted into two
			// Select foot's whole text (a drag over the window) after a command whose output differs from its line, copy it.
			await typeText("clear; echo $((6*7))XY\n");
			await sleep(1000);
			const t = byTitle(await windows(), "two");
			await mouse(t.rect.x + 4, t.rect.y + 30, { to: [t.rect.x + t.rect.w - 6, t.rect.y + t.rect.h - 6] });
			await press(...letter("c"), ["ctrl", "shift"]);
			await sleep(300);
			const paste = await sh(`timeout 20 ${WL} wl-paste -n; echo; echo rc=$?`);
			report("apps: clipboard from wl-copy to foot, and from foot's selection to wl-paste", clip1 === "wlclip42 two" && /42XY/.test(paste),
				`wl-copy ${JSON.stringify(copy)}; foot pasted ${JSON.stringify(clip1)}; wl-paste after foot's copy: ${JSON.stringify(paste.slice(-200))}`);

			// The page's clipboard (wland's bridge): text copied on the page (the user left the Wayland
			// windows for it: a click on the Dock's strip beside its pill, where there is no window and
			// no tile) pasted into foot (the paste chord's paste event carries it), and an app's copy
			// written to it at the next click in a Wayland window.
			{
				const gesture = (expression) => send("Runtime.evaluate", { expression, awaitPromise: true, userGesture: true, returnByValue: true }).then((r) => r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description);
				const strip = JSON.parse(await evaluate(`(() => { const s = document.querySelector("#dock").getBoundingClientRect(), p = document.querySelector("#dock .dock-pill").getBoundingClientRect(); return JSON.stringify([(s.left + p.left) / 2, s.top + s.height / 2]); })()`));
				await mouse(...strip);
				const put = await gesture(`navigator.clipboard.writeText("pageclip7").then(() => "ok", (e) => e.message)`);
				await sh("rm -f /tmp/wl-pg");
				await clickWindow("two");
				await typeText("echo ");
				await press(...letter("v"), ["ctrl", "shift"], { commands: ["paste"] });
				await typeText(" > /tmp/wl-pg\n");
				const pg = await fileFor("/tmp/wl-pg", /\w/, 10000);
				const copied = await sh(`printf appclip9 | timeout 20 ${WL} wl-copy; echo rc=$?`);
				await sleep(800);
				await clickWindow("two");
				await sleep(500);
				const got = await gesture(`navigator.clipboard.readText().catch((e) => "error: " + e.message)`);
				report("apps: the page's clipboard pasted into foot, wl-copy's text on the page's clipboard (wland's bridge)", put === "ok" && pg === "pageclip7" && got === "appclip9",
					`page clipboard written: ${put}; foot pasted ${JSON.stringify(pg)}; wl-copy ${JSON.stringify(copied)}, then the page's clipboard: ${JSON.stringify(got)}`);
			}

			// Closing one window: the other gets the keyboard and the focus (data-shown stays).
			await clickWindow("one");
			const f3 = await focusedTitle();
			await typeText("exit\n");
			const closed = await waitFor(`KW.wayland.windows().length === 1 && 1`, 15000);
			await sleep(300);
			const f4 = await focusedTitle(), dk = await desk();
			await typeText("echo $WIN > /tmp/wl-a2\n");
			const a22 = await fileFor("/tmp/wl-a2", /\w/, 10000);
			report("apps: closing one gives the other the keyboard, the Wayland windows keep the focus", f3 === "one" && !!closed && f4 === "two" && dk.shown && a22 === "two",
				`closed ${f3}: ${!!closed}; focused now ${f4}; a Wayland window focused ${dk.shown}; typed into two: ${JSON.stringify(a22)}`);
			await cleanupApps();
		}

		// --gtk: l3afpad (GTK 3): a window, typed text, a context menu (a popup), select all and copy
		if (want("--gtk") && firstMode) {
			await cleanupApps();
			const t0g = performance.now();
			await launch("l3afpad", "gtk");
			const gw = await waitFor(`KW.wayland.windows().find((w) => /untitled|l3afpad/i.test(w.title))?.title`, 90000, 300);
			const mapMs = performance.now() - t0g;
			if (!gw) {
				report("gtk: l3afpad maps", false, `no window after 90 s; ${await sh("tail -5 /tmp/wl-gtk.log")}`);
			} else {
				await sleep(1500);
				const g = byTitle(await windows(), gw);
				const [gx, gy] = centre(g);
				await mouse(gx, gy);
				await typeText("hello gtk");
				await sleep(500);
				await mouse(gx, gy, { button: "right" });
				const pop = await waitFor("KW.wayland.popups() > 0 && KW.wayland.popups()", 10000, 200);
				await sleep(500);
				// Where the menu landed: its canvas, and the top left of its opaque pixels (the menu, inside
				// its shadow), against the click (wland 0.1.0 drew it about 20 px up and left).
				const place = JSON.parse(await evaluate(`(() => {
					const k = KW.wayland.popupKeys()[0], c = k && KW.wayland.container().querySelector('canvas[data-wland="' + k + '"]');
					if (!c) return "null";
					const r = c.getBoundingClientRect(), ctx = c.getContext("2d");
					let o = null;
					if (ctx) {
						const d = ctx.getImageData(0, 0, c.width, c.height).data;
						let x0 = 1e9, y0 = 1e9;
						for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] === 255) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); }
						if (x0 < 1e9) o = [+(r.x + x0 * r.width / c.width).toFixed(1), +(r.y + y0 * r.height / c.height).toFixed(1)];
					}
					return JSON.stringify({ canvas: [r.x, r.y, r.width, r.height], opaque: o });
				})()`));
				const off = place?.opaque ? [place.opaque[0] - gx, place.opaque[1] - gy] : null;
				if (shots) writeFileSync(join(shots, "gtk-menu.png"), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
				await press(...special("Escape"));
				const popGone = await waitFor("KW.wayland.popups() === 0 && 1", 10000, 200);
				// Ctrl-A is the page's prefix: Ctrl-A Ctrl-A sends it on (select all), then Ctrl+C copies.
				await press(...letter("a"), ["ctrl"]);
				await press(...letter("a"), ["ctrl"]);
				await press(...letter("c"), ["ctrl"]);
				await sleep(500);
				const paste = await sh(`timeout 20 ${WL} wl-paste -n; echo; echo rc=$?`);
				report("gtk: l3afpad maps, takes typing, opens and closes its context menu, copies (Ctrl-A Ctrl-A, Ctrl+C)", !!pop && !!popGone && /hello gtk/.test(paste),
					`window ${JSON.stringify(gw)} ${g.rect.w}x${g.rect.h} after ${(mapMs / 1000).toFixed(1)} s; popups ${pop || 0}, closed by Escape ${!!popGone}; wl-paste ${JSON.stringify(paste)}`);
				report("gtk: the context menu opens at the pointer", !!off && Math.abs(off[0]) <= 6 && Math.abs(off[1]) <= 6,
					`right click at ${gx},${gy}: menu canvas ${JSON.stringify(place?.canvas)}, its opaque part from ${JSON.stringify(place?.opaque)} (${off ? `${off[0].toFixed(1)}, ${off[1].toFixed(1)} from the click` : "?"})`);
			}
			await cleanupApps();
		}

		// --keys: in foot; then the page's shortcuts and the focus between the Wayland windows and the terminal
		if (want("--keys") && firstMode) {
			await cleanupApps();
			await sh("rm -f /tmp/wl-k*");
			await launch("foot -T keys", "keys");
			await waitWindow("keys");
			await sleep(1500);
			await mouse(...centre(byTitle(await windows(), "keys")));
			// Ctrl-C
			await typeText("sleep 20; echo late > /tmp/wl-klate\n");
			await sleep(1500);
			await press(...letter("c"), ["ctrl"]);
			await typeText("echo after > /tmp/wl-kafter\n");
			const after = await fileFor("/tmp/wl-kafter", /after/, 10000);
			const late = await sh("cat /tmp/wl-klate 2>/dev/null");
			// History (Up, Up, Enter) and Left
			await typeText("echo hist1 > /tmp/wl-khist\n");
			await typeText("rm /tmp/wl-khist\n");
			await sleep(500);
			await press(...special("ArrowUp"));
			await press(...special("ArrowUp"));
			await press(...special("Enter"));
			const hist = await fileFor("/tmp/wl-khist", /hist1/, 10000);
			await typeText("echo ab > /tmp/wl-kleft");
			for (let i = 0; i < " > /tmp/wl-kleft".length; i++) await press(...special("ArrowLeft"));
			await typeText("X\n");
			const left = await fileFor("/tmp/wl-kleft", /ab/, 10000);
			// Alt+. (the last argument), Ctrl-U (kill the line)
			await typeText("echo /tmp/wl-kalt\n");
			await typeText("touch ");
			await press("Period", ".", 190, ["alt"]);
			await press(...special("Enter"));
			const altOk = /yes/.test(await waitFor(`KW.vm.exec("sh", ["-c", "test -e /tmp/wl-kalt && echo yes"]).then((r) => r.stdout.includes("yes") && "yes")`, 10000, 400) || "");
			await typeText("garbage");
			await press(...letter("u"), ["ctrl"]);
			await typeText("echo cu > /tmp/wl-kcu\n");
			const cu = await fileFor("/tmp/wl-kcu", /cu/, 10000);
			// A held key: the browser's auto-repeat keydowns (after 500 ms, every 33 ms) for 1.13 s.
			await typeText("echo ");
			await press(...letter("x"), [], { repeats: 20, repeatMs: 33, holdMs: 0 });
			await typeText(" > /tmp/wl-krep\n");
			const rep = await fileFor("/tmp/wl-krep", /x/, 10000);
			// Ctrl-A Ctrl-A: the second goes to foot (readline: the line's start)
			await typeText(" > /tmp/wl-kca");
			await press(...letter("a"), ["ctrl"]);
			await press(...letter("a"), ["ctrl"]);
			await typeText("echo ca\n");
			const ca = await fileFor("/tmp/wl-kca", /ca/, 10000);
			const xs = (rep.match(/x/g) ?? []).length;
			report("keys: Ctrl-C, Up and Left, Alt+., Ctrl-U, a held key repeats, Ctrl-A Ctrl-A reaches foot", after === "after" && !late && hist === "hist1" && left === "abX" && altOk && cu === "cu" && xs >= 3 && xs <= 40 && ca === "ca",
				`Ctrl-C: after ${JSON.stringify(after)}, late ${JSON.stringify(late)}; history ${JSON.stringify(hist)}; left ${JSON.stringify(left)}; Alt+. ${altOk}; Ctrl-U ${JSON.stringify(cu)}; held x for 1.13 s: ${xs} x (wland: repeat 25/s after 400 ms); Ctrl-A Ctrl-A ${JSON.stringify(ca)}`);

			// The page's shortcuts and the focus: Ctrl-A w goes to the other windows (the terminal takes the keys), again back (foot has them).
			await prefix(...letter("w"));
			const hidden = await desk(), act1 = await activeIn();
			await typeText("echo term > /tmp/wl-kterm\n");
			const term = await fileFor("/tmp/wl-kterm", /term/, 10000);
			await prefix(...letter("w"));
			await sleep(300);
			const shownAgain = await desk(), act2 = await activeIn(), f = await focusedTitle();
			await typeText("echo back > /tmp/wl-kback\n");
			const backTyped = await fileFor("/tmp/wl-kback", /back/, 10000);
			// The foot app's terminal tab (in its Terminal window's title bar) leaves the Wayland windows too.
			const winBtn = await evaluate(`(() => { const b = document.querySelector("#term-tab-${state.appTerm ?? 0}"); b?.click(); return !!b; })()`);
			await sleep(300);
			const hidden2 = await desk(), act3 = await activeIn();
			report("keys: Ctrl-A w goes to the other windows and the terminal takes the keys, again back and foot has them, the app's terminal tab leaves them",
				!hidden.shown && act1 === "terminal" && term === "term" && shownAgain.shown && act2 === "desktop" && f === "keys" && backTyped === "back" && winBtn && !hidden2.shown && act3 === "terminal",
				`away: Wayland focused ${hidden.shown}, focus ${act1}, typed ${JSON.stringify(term)}; back: ${shownAgain.shown}, focus ${act2}, window ${f}, typed ${JSON.stringify(backTyped)}; terminal tab: Wayland focused ${hidden2.shown}, focus ${act3}`);
			await prefix(...letter("w"));
			await cleanupApps();
		}

		// --pacing: a client that redraws continuously; commits per second and the reads' share of the time
		if (want("--pacing")) {
			await cleanupApps();
			const raf = await evaluate("new Promise((r) => { let n = 0; const t = performance.now(); const f = () => { n++; if (performance.now() - t < 1000) requestAnimationFrame(f); else r(n); }; requestAnimationFrame(f); })");
			const measure = async (label, cmd, title, secsLong = 6) => {
				await launch(cmd, label);
				const ok = await waitWindow(title, 60000);
				if (!ok) { report(`${mode}: pacing ${label}`, false, `no window ${title}: ${await sh(`tail -3 /tmp/wl-${label}.log`)}`); return; }
				await sleep(1500);
				const a = JSON.parse(await evaluate("JSON.stringify({ ...KW.wayland.stats(), t: performance.now() })"));
				await sleep(secsLong * 1000);
				const b = JSON.parse(await evaluate("JSON.stringify({ ...KW.wayland.stats(), t: performance.now() })"));
				const s = (b.t - a.t) / 1000, commits = b.commits - a.commits, reads = b.reads - a.reads;
				const list = await windows(), w = byTitle(list, title);
				// The counters are every window's: another client still drawing (a weston-simple-shm that
				// cleanupApps once missed) would be counted as this one's (60 commits/s for foot's 13).
				const others = list.filter((x) => x.title !== title).map((x) => x.title);
				const line = `${(commits / s).toFixed(1)} commits/s, ${(reads / s).toFixed(1)} reads/s of ${reads ? ((b.bytes - a.bytes) / reads / 1024).toFixed(0) : 0} KiB, ${(b.inPlace ?? 0) - (a.inPlace ?? 0)} in place, reads ${reads ? ((b.readMs - a.readMs) / reads).toFixed(2) : 0} ms each (${((b.readMs - a.readMs) / (b.t - a.t) * 100).toFixed(0)}% of the time; longest so far ${b.readMaxMs.toFixed(0)} ms); window ${w?.canvas}${others.length ? `; other windows open: ${JSON.stringify(others)}` : ""}`;
				say(`${mode} pacing ${label}: ${line}`);
				report(`${mode}: pacing ${label}`, commits / s >= 5 && !others.length, line);
				await cleanupApps();
			};
			say(`${mode}: the page's frame rate: ${raf} rAF/s`);
			await measure("simple-shm", "weston-simple-shm", "simple-shm");
			await measure("foot-busy", `foot -T busy sh -c "yes | tr y x"`, "busy");
		}

		// S: suspend with foot running, resume with a plain load
		if (suspendTest && mode === "worker") {
			const n = state.appTerm;
			await evaluate(`KW.windows.send(${n}, "wland foot\\n")`);
			const again = await waitFor("KW.wayland.windows().length === 1", 60000, 500);
			const sv = await evaluate("KW.suspend().then((r) => JSON.stringify(r), (e) => 'failed: ' + e.message)");
			say(`suspend with foot open (${again ? "mapped" : "not mapped"}): ${sv}`);
			wlandRequests = [];
			await openPage(`${base}${param}`);
			let row = "";
			for (let i = 0; i < 100 && !/ resumed| not resumed/.test(row); i++) {
				row = await evaluate(`KW.ui.diagText().split("\\n").find((x) => / Suspended session: /.test(x))?.trim() ?? ""`);
				await sleep(200);
			}
			// The resume reset the relay's link: its apps are gone, and it waits for the next app (on demand).
			const idleLog = await fileFor("/run/user/1000/wlandr.log", /dialing again for the next app/, 20000);
			const idle = JSON.parse(await evaluate("JSON.stringify({ icon: !!document.querySelector('#dock-wayland'), loaded: KW.wayland.loaded(), windows: KW.wayland.windows().length })"));
			const idleReqs = wlandRequests.length;
			const idleOk = /dialing again for the next app/.test(idleLog) && !idle.icon && !idle.loaded && !idle.windows && idleReqs === 0;
			const log = await sh("grep -c ' connected$' /run/user/1000/wlandr.log; tail -6 /run/user/1000/wlandr.log");
			await evaluate(`KW.windows.send(${n}, "foot\\n")`);
			const third = await waitFor("KW.wayland.windows().find((w) => /foot/.test(w.title)) && 1", 60000, 500);
			report("suspend and resume with foot open: the relay goes idle, a plain foot maps", !/^failed/.test(sv) && / resumed/.test(row) && !/not resumed/.test(row) && idleOk && !!third,
				`suspend ${sv}; ${row.slice(0, 100)}; after the resume ${JSON.stringify(idle)}, ${idleReqs} wland requests (${wlandRequests.length} after the plain foot); a plain foot mapped: ${!!third}; relay log: ${log.replace(/\n/g, " | ")}`);

			// A session saved without kwshm (?shm=0 boots as the page did before the Wayland apps): the foot
			// tile is disabled with why, wland says so; a plain load resumes it as it was (no kwshm), and the
			// next fresh boot has kwshm again.
			const noShm = async () => JSON.parse(await evaluate(`(async () => {
				const b = await ${GL_TILE}("foot");
				const r = { shm: !!KW.vm.shm, disabled: b?.getAttribute("aria-disabled") === "true", why: b?.title ?? null };
				document.querySelector("#dock-launcher").click();
				return JSON.stringify(r);
			})()`));
			await openPage(`${base}${param}&shm=0`);
			const off = await noShm();
			const said = await sh(`${WL} foot 2>&1; echo rc=$?`);
			// No kw.wayland=1 without kwshm: no relay at boot, no session in a login shell.
			const offBoot = await sh("grep -c ' kw.wayland=1' /proc/cmdline; pgrep -x wlandr | wc -l; bash -lc 'echo \"[$WAYLAND_DISPLAY]\"'");
			const sv2 = await evaluate("KW.suspend().then((r) => JSON.stringify(r), (e) => 'failed: ' + e.message)");
			await openPage(`${base}${param}`);
			let row2 = "";
			for (let i = 0; i < 100 && !/ resumed| not resumed/.test(row2); i++) {
				row2 = await evaluate(`KW.ui.diagText().split("\\n").find((x) => / Suspended session: /.test(x))?.trim() ?? ""`);
				await sleep(200);
			}
			const resumedOff = await noShm();
			const logged = await evaluate(`KW.ui.diagText().includes("without kwshm")`);
			await openPage(`${base}${param}`);
			const fresh = await noShm();
			report("a session saved without kwshm resumes as it was; a fresh boot has kwshm", !off.shm && off.disabled && /no \/dev\/kwshm/.test(said) && offBoot.split("\n").join(" ") === "0 0 []" && !/^failed/.test(sv2) && / resumed/.test(row2) && !/not resumed/.test(row2) && !resumedOff.shm && resumedOff.disabled && fresh.shm && !fresh.disabled,
				`?shm=0: ${JSON.stringify(off)}, wland: ${JSON.stringify(said)}, kw.wayland=1 / relays / WAYLAND_DISPLAY: ${JSON.stringify(offBoot)}; suspended ${sv2}; plain load: ${row2.slice(0, 80)}, ${JSON.stringify(resumedOff)}, logged ${logged}; next load: ${JSON.stringify(fresh)}`);
		}

		// --gpu: GL apps by GPU resource (the relay's --dmabuf virtgpu, the page's vm.gl.gpu.image())
		if (gpuTest && firstMode) {
			await cleanupApps();
			const pre = JSON.parse(await evaluate("JSON.stringify({ gpu: !!KW.vm.gl?.gpu, state: KW.vm.gl?.status?.state ?? null, errors: KW.vm.gl?.stats?.gpu?.errors ?? null })"));
			const info = await sh(`${WL} wayland-info 2>&1 | sed -n '/zwp_linux_dmabuf_v1/,/^interface/p'`);
			const node = await sh("ls -l /dev/dri/renderD128; tr '\\0' ' ' < /proc/$(cat /run/user/1000/wlandr.pid)/cmdline");
			let log = await relayLog();
			const formats = ["AR24", "XR24", "AB24", "XB24"].every((f) => ["INVALID", "LINEAR"].every((m) => new RegExp(`'${f}'; 0x[0-9a-f]+ = ${m}`).test(info)));
			report("gpu: the relay runs with --dmabuf virtgpu --no-fence-wait, wland offers zwp_linux_dmabuf_v1 v4 (AR24, XR24, AB24, XB24; implicit and LINEAR), the renderer not loaded yet",
				pre.gpu && pre.state === "idle" && /--dmabuf virtgpu\S* --no-fence-wait/.test(node) && /dmabuf: virtgpu, main device 0xe280.*no fence wait/.test(log) && /zwp_linux_dmabuf_v1',\s+version:\s+4/.test(info) && formats,
				`vm.gl ${JSON.stringify(pre)}; ${node.replace(/\n/g, " | ")}; ${info.split("\n").length} lines of wayland-info (${formats ? "all 8 format/modifier pairs" : info.replace(/\n/g, " | ")}); relay: ${log.split("\n").find((l) => /dmabuf/.test(l))}`);

			// A translucent GL client (ARGB): its window from the GPU, alpha kept, the right way up.
			say("gpu: weston-simple-egl");
			let a = await statsNow();
			await launch("weston-simple-egl", "egl");
			const egl = await waitWindow("simple-egl");
			await sleep(2500);
			let b = await statsNow();
			const px = egl ? await windowPixels("simple-egl") : null;
			log = await relayLog();
			const first = log.split("\n").find((l) => /virtgpu: conn \d+ buffer \d+: first 'AR24'/.test(l)) ?? "";
			const loaded = JSON.parse(await evaluate("JSON.stringify(KW.vm.gl.status)"));
			report("gpu: weston-simple-egl (ARGB) by resource: the renderer loads on its first frame, its window has the triangle the right way up over a translucent background",
				!!egl && !!first && b.gpuCommits - a.gpuCommits > 30 && b.gpuImages - a.gpuImages === b.gpuCommits - a.gpuCommits && b.reads - a.reads <= 2 && loaded.state === "ready" &&
					px && px.corner[3] > 100 && px.corner[3] < 160 && px.blueY !== null && px.redGreenY !== null && px.blueY < px.redGreenY,
				`${first.replace(/^info: /, "")}; ${b.gpuCommits - a.gpuCommits} GPU commits in ${((b.t - a.t) / 1000).toFixed(1)} s (${b.gpuImages - a.gpuImages} images, image() ${((b.gpuMs - a.gpuMs) / Math.max(1, b.gpuCommits - a.gpuCommits)).toFixed(2)} ms, to release ${((b.gpuDrawMs - a.gpuDrawMs) / Math.max(1, b.gpuCommits - a.gpuCommits)).toFixed(2)} ms each), shm reads ${b.reads - a.reads} (a cursor image at most); renderer ${loaded.state} (loaded in ${loaded.loadMs?.toFixed(0)} ms); pixels ${JSON.stringify(px)}`);
			if (shots) writeFileSync(join(shots, "gpu-egl.png"), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).result.data, "base64"));

			// An opaque one (XRGB), and no stale frame: with the client stopped, the window holds what the resource holds.
			say("gpu: weston-simple-egl -o, stale frames");
			await cleanupApps();
			await launch("weston-simple-egl -o", "eglo");
			const eglo = await waitWindow("simple-egl");
			await sleep(2000);
			const po = eglo ? await windowPixels("simple-egl") : null;
			log = await relayLog();
			const firstX = log.split("\n").find((l) => /first 'XR24'/.test(l)) ?? "";
			let stale = null;
			for (let attempt = 0; attempt < 3 && !(stale?.differ === 0); attempt++) {
				await sh("pkill -STOP -f '^weston-simple-egl'");
				await sleep(700);
				stale = JSON.parse(await evaluate(`(async () => {
					const ref = KW.wayland.gpuLast();
					const w = KW.wayland.windows().find((x) => x.title === "simple-egl");
					const c = [...KW.wayland.container().querySelector('[data-wland-window="' + w.key + '"]').querySelectorAll("canvas")].sort((a, b) => b.width * b.height - a.width * a.height)[0];
					const img = await KW.vm.gl.gpu.image(ref.resource, { width: ref.width, height: ref.height, opaque: true, flipY: (ref.flags & 1) !== 0 });
					const o = new OffscreenCanvas(ref.width, ref.height).getContext("2d");
					o.drawImage(img, 0, 0);
					img.close();
					const x = o.getImageData(0, 0, ref.width, ref.height).data, y = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
					let differ = 0;
					for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) { differ++; i |= 3; }
					return JSON.stringify({ resource: ref.resource, size: [ref.width, ref.height], canvas: [c.width, c.height], differ });
				})()`));
				await sh("pkill -CONT -f '^weston-simple-egl'");
				if (stale.differ) await sleep(500);
			}
			report("gpu: weston-simple-egl -o (XRGB) is opaque, and stopped, its window shows what its last committed resource holds (no stale frame)",
				!!eglo && !!firstX && po?.corner[3] === 255 && stale?.differ === 0,
				`${firstX.replace(/^info: /, "")}; corner ${JSON.stringify(po?.corner)}; stopped: ${JSON.stringify(stale)}`);

			// shm and GPU windows together.
			say("gpu: foot and weston-simple-egl");
			await launch(`foot -T mix sh -c "while :; do date +%s.%N; sleep 0.1; done"`, "mix");
			const mix = await waitWindow("mix");
			await sleep(1500);
			a = await statsNow();
			await sleep(3000);
			b = await statsNow();
			const pf = await windowPixels("mix"), pe = await windowPixels("simple-egl");
			report("gpu: a foot window (shm) and a GL window (GPU) at once, both updating",
				!!mix && b.reads - a.reads >= 10 && b.gpuCommits - a.gpuCommits >= 60 && pf?.colours >= 8 && pe?.colours >= 8,
				`in ${((b.t - a.t) / 1000).toFixed(1)} s: ${b.reads - a.reads} shm reads (${b.views - a.views} views in place), ${b.gpuCommits - a.gpuCommits} GPU commits; foot ${pf?.colours} colours, simple-egl ${pe?.colours}`);
			await cleanupApps();

			// The renderer's WebGL2 context lost and restored (WEBGL_lose_context; .agents/gl.md,
			// Context loss) under a GL window: its client is stale and ended; the relay's context
			// (it never submitted) is made again in the new renderer, and a GL app started after the
			// loss shows by resource with no renderer error.
			say("gpu: the WebGL2 context lost and restored");
			{
				await launch("weston-simple-egl", "egl-lose");
				const w0 = await waitWindow("simple-egl");
				await sleep(1500);
				const lost = JSON.parse(await evaluate(`(async () => {
					const ref = KW.wayland.gpuLast(), t = ref && KW.vm.gl.gpu.texture(ref.resource);
					const ext = t?.gl.getExtension("WEBGL_lose_context");
					if (!ext) return JSON.stringify({ lost: false });
					ext.loseContext();
					for (let i = 0; i < 50 && !KW.vm.gl.gpu.stats.contextLost; i++) await new Promise((r) => setTimeout(r, 50));
					const at = { contextLost: KW.vm.gl.gpu.stats.contextLost, state: KW.vm.gl.status.state };
					await new Promise((r) => setTimeout(r, 1000));
					ext.restoreContext();
					return JSON.stringify({ lost: true, ...at });
				})()`));
				await cleanupApps();
				const e0 = await evaluate("KW.vm.gl.stats.gpu.errors");
				a = await statsNow();
				await launch("weston-simple-egl", "egl-after-loss");
				const w1 = await waitWindow("simple-egl");
				await sleep(2500);
				b = await statsNow();
				const e1 = await evaluate("KW.vm.gl.stats.gpu.errors");
				const pl = w1 ? await windowPixels("simple-egl") : null;
				const st = JSON.parse(await evaluate("JSON.stringify({ state: KW.vm.gl.status.state, gpu: KW.vm.gl.stats.gpu })"));
				report("gpu: the WebGL2 context lost and restored under a GL window: a GL app started after it shows by resource, the relay as it was, no renderer error",
					!!w0 && lost.lost && lost.contextLost && lost.state === "lost" && !!w1 && b.gpuImages - a.gpuImages > 30 && st.state === "ready" && st.gpu.renewals >= 1 && !st.gpu.contextLost &&
						e1 === e0 && pl?.blueY != null && pl?.redGreenY != null && pl.blueY < pl.redGreenY,
					`at the loss ${JSON.stringify(lost)}; after it ${b.gpuCommits - a.gpuCommits} GPU commits, ${b.gpuImages - a.gpuImages} images in ${((b.t - a.t) / 1000).toFixed(1)} s, ` +
						`${e1 - e0} renderer errors; renderer ${st.state}, losses ${st.gpu.losses}, renewals ${st.gpu.renewals}; pixels ${JSON.stringify(pl)}`);
				await cleanupApps();
			}

			// GTK 4 with its GL renderer (GskGLRenderer on virgl).
			say("gpu: gtk4-widget-factory");
			a = await statsNow();
			const err0 = await evaluate("KW.vm.gl.stats.gpu.errors");
			await launch("env GSK_DEBUG=renderer gtk4-widget-factory", "gtk4");
			const g4 = await waitFor("KW.wayland.windows().find((w) => /Widget Factory/.test(w.title))?.title", 90000, 500);
			await sleep(4000);
			b = await statsNow();
			const pg = g4 ? await windowPixels(g4) : null;
			const err1 = await evaluate("KW.vm.gl.stats.gpu.errors");
			const glog = await sh("grep -h -i 'renderer' /tmp/wl-gtk4.log | head -2");
			if (shots) writeFileSync(join(shots, "gpu-gtk4.png"), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
			report("gpu: gtk4-widget-factory draws with GTK's GL renderer by resource, the renderer refuses nothing",
				!!g4 && /GskGLRenderer/.test(glog) && b.gpuImages - a.gpuImages > 0 && pg?.colours >= 200 && err1 === err0,
				`${g4}: ${glog.trim()}; ${b.gpuImages - a.gpuImages} GPU images; ${pg?.colours} colours (${JSON.stringify(pg?.size)}); renderer errors ${err0} -> ${err1}; relay: ${(await sh("grep -E 'still being written|refused|cannot name' /run/user/1000/wlandr.log | tail -3")).replace(/\n/g, " | ") || "no warnings"}`);
			await cleanupApps();

			// A relay started without --dmabuf (before the render node was there): wland says so, GL apps render in software.
			say("gpu: a relay without --dmabuf");
			{
				const old = await sh("cat /run/user/1000/wlandr.pid");
				await sh(`kill ${old}; sleep 0.5; XDG_RUNTIME_DIR=/run/user/1000 setsid /usr/lib/kw/wlandr --link vsock:2:1023 --buffers kwshm --display wayland-0 </dev/null >/run/user/1000/wlandr.log 2>&1 & echo $! > /run/user/1000/wlandr.pid; sleep 1.5`);
				const said = await sh(`${WL} true 2>&1; echo rc=$?`);
				const inf = await sh(`${WL} wayland-info 2>&1 | grep -c zwp_linux_dmabuf`);
				a = await statsNow();
				await launch("weston-simple-egl", "egl-nodmabuf");
				const w = await waitWindow("simple-egl");
				await sleep(2000);
				b = await statsNow();
				const p = w ? await windowPixels("simple-egl") : null;
				report("gpu: a relay without --dmabuf: wland says how to restart it, GL apps render in software into shm windows",
					/renders GL apps in software/.test(said) && /rc=0/.test(said) && inf.trim() === "0" && !!w && b.reads - a.reads > 10 && b.gpuCommits === a.gpuCommits && p?.blueY < p?.redGreenY,
					`wland: ${JSON.stringify(said.slice(0, 160))}; linux-dmabuf listed ${inf.trim()} times; ${b.reads - a.reads} shm reads, ${b.gpuCommits - a.gpuCommits} GPU commits; pixels ${JSON.stringify(p)}`);
				await cleanupApps();
				await sh("pkill -x wlandr; sleep 0.5");
				await waitFor("!document.querySelector('#dock-wayland') && 1", 10000);
			}

			// --link-on-demand with a render node missing at the relay's start: a warning, and the node is looked
			// up again at the dial (here a link made after the start), which then offers linux-dmabuf.
			say("gpu: the render node looked up at the dial");
			{
				await sh(`rm -f /tmp/kw-rnode; XDG_RUNTIME_DIR=/run/user/1000 setsid /usr/lib/kw/wlandr --link vsock:2:1023 --buffers kwshm --link-on-demand --dmabuf virtgpu:/tmp/kw-rnode --no-fence-wait --display wayland-0 </dev/null >/run/user/1000/wlandr.log 2>&1 & echo $! > /run/user/1000/wlandr.pid; sleep 1.5; ln -s /dev/dri/renderD128 /tmp/kw-rnode`);
				const before = await relayLog();
				const inf = await sh(`${WL} wayland-info 2>&1 | grep -c zwp_linux_dmabuf`);
				a = await statsNow();
				await launch("weston-simple-egl", "egl-late-node");
				const w = await waitWindow("simple-egl");
				await sleep(2000);
				b = await statsNow();
				const after = await relayLog();
				report("gpu: an on-demand relay started without its render node finds it at the dial: GL apps by resource",
					/linux-dmabuf off for now/.test(before) && !/main device/.test(before) && /dmabuf: virtgpu, main device/.test(after) && Number(inf) >= 1 && !!w && b.gpuImages - a.gpuImages > 10,
					`at the start: ${before.split("\n").find((l) => /dmabuf/.test(l))}; after the dial: ${after.split("\n").find((l) => /main device/.test(l))}; linux-dmabuf listed ${inf.trim()} times; ${b.gpuImages - a.gpuImages} GPU images`);
				await cleanupApps();
				await sh("pkill -x wlandr; rm -f /tmp/kw-rnode; sleep 0.5");
				await waitFor("!document.querySelector('#dock-wayland') && 1", 10000);
				// A relay as the boot leaves one, for the plain apps of the cases below (the launcher's tile).
				await sh("/usr/lib/kw/bin/wland true");
			}

			// Frame rates of a continuously drawing GL client, at 250x250 and maximized, by resource.
			const rates = async (path) => {
				const out = [];
				for (const [label, cmd] of [["250x250", "weston-simple-egl -o"], ["maximized", "weston-simple-egl -o -m"]]) {
					await launch(cmd, `rate-${label}`);
					if (!await waitWindow("simple-egl")) { out.push(`${label}: no window`); continue; }
					await sleep(3000);
					const x = await statsNow();
					await sleep(6000);
					const y = await statsNow();
					const list = await windows(), w = byTitle(list, "simple-egl");
					const others = list.filter((o) => o.title !== "simple-egl").map((o) => o.title);
					const s = (y.t - x.t) / 1000, n = y.commits - x.commits, g = y.gpuCommits - x.gpuCommits, r = y.reads - x.reads;
					out.push(`${label} (${w?.canvas}${others.length ? `; other windows open, counted too: ${JSON.stringify(others)}` : ""}): ${(n / s).toFixed(1)} commits/s, ` + (g
						? `image() ${((y.gpuMs - x.gpuMs) / g).toFixed(2)} ms, to release ${((y.gpuDrawMs - x.gpuDrawMs) / g).toFixed(2)} ms per commit`
						: `reads ${r ? ((y.readMs - x.readMs) / r).toFixed(2) : 0} ms, ${r ? ((y.bytes - x.bytes) / r / 1024).toFixed(0) : 0} KiB, ${y.inPlace - x.inPlace} of ${r} in place`));
					await cleanupApps();
				}
				say(`gpu pacing (${path}, ${cfg.cpus} CPU${cfg.cpus > 1 ? "s" : ""}, ${cfg.transport}): ${out.join("; ")}`);
				return out;
			};
			if (want("--pacing")) {
				const raf = await evaluate("new Promise((r) => { let n = 0; const t = performance.now(); const f = () => { n++; if (performance.now() - t < 1000) requestAnimationFrame(f); else r(n); }; requestAnimationFrame(f); })");
				const out = await rates("by resource");
				report("gpu: frame rates by resource (reported)", out.every((l) => !/no window|other windows open/.test(l)), `${raf} rAF/s; ${out.join("; ")}`);
			}

			// The launcher's GL windows tile: es2gears_wayland by resource.
			{
				say("gpu: the GL windows tile");
				a = await statsNow();
				const clicked = await evaluate(`(async () => {
					const b = await ${GL_TILE}("wlgl");
					if (!b) return "no GL windows tile";
					if (b.getAttribute("aria-disabled") === "true") return "disabled: " + b.title;
					b.click();
					return "clicked";
				})()`);
				const tw = await waitWindow("es2gears", 120000);
				await sleep(2000);
				b = await statsNow();
				const term = await evaluate(`(() => { const w = KW.windows.list().find((x) => x.name === "wlgl"); return w ? KW.windows.text(w.n).trim().split("\\n").filter((l) => /renderer|version/i.test(l)).slice(0, 3).join(" | ") : "no wlgl window"; })()`);
				report("gpu: the launcher's GL windows tile runs es2gears_wayland by resource", clicked === "clicked" && !!tw && b.gpuImages - a.gpuImages > 20,
					`tile ${clicked}; window ${!!tw}; ${b.gpuImages - a.gpuImages} GPU images; its terminal: ${term}`);
				await cleanupApps();
			}

			// Suspend: refused while a GL app runs, done once it exited; after the resume GL apps work again.
			say("gpu: Suspend");
			if (mode === "worker") {
				await launch("es2gears_wayland", "gears");
				const gw = await waitWindow("es2gears");
				await sleep(1500);
				const refused = await evaluate("KW.suspend().then((r) => 'suspended ' + JSON.stringify(r), (e) => 'refused: ' + e.message)");
				const still = await evaluate("KW.wayland.windows().some((w) => w.title === 'es2gears')");
				await cleanupApps();
				await sleep(1000);
				const sv = await evaluate("KW.suspend().then((r) => 'suspended ' + JSON.stringify(r), (e) => 'refused: ' + e.message)");
				await openPage(`${base}${param}`);
				let row = "";
				for (let i = 0; i < 100 && !/ resumed| not resumed/.test(row); i++) {
					row = await evaluate(`KW.ui.diagText().split("\\n").find((x) => / Suspended session: /.test(x))?.trim() ?? ""`);
					await sleep(200);
				}
				// The relay's link went with the resume; it dials again at the next app.
				await fileFor("/run/user/1000/wlandr.log", /dialing again for the next app/, 30000);
				a = await statsNow();
				await launch("es2gears_wayland", "gears2");
				const again = await waitWindow("es2gears");
				await sleep(2000);
				b = await statsNow();
				report("gpu: Suspend is refused while a GL app runs (it runs on), done once it exited; resumed, GL apps show by resource again",
					!!gw && /^refused: .*using the GPU/.test(refused) && still && /^suspended/.test(sv) && / resumed/.test(row) && !/not resumed/.test(row) && !!again && b.gpuImages - a.gpuImages > 20,
					`with es2gears: ${refused.slice(0, 90)}...; it ran on: ${still}; after it exited: ${sv}; ${row.slice(0, 60)}; es2gears again: ${b.gpuImages - a.gpuImages} GPU images`);
				await cleanupApps();
			}

			// ?wlgpu=0: no gpu source, so wland offers no linux-dmabuf to the relay that has --dmabuf: GL apps render in software into shm.
			say("gpu: ?wlgpu=0");
			{
				await openPage(`${base}${param}&wlgpu=0`);
				const relay = await sh(`${WL} true; tr '\\0' ' ' < /proc/$(cat /run/user/1000/wlandr.pid)/cmdline`);
				const inf = await sh(`${WL} wayland-info 2>&1 | grep -c zwp_linux_dmabuf`);
				a = await statsNow();
				await launch("weston-simple-egl", "egl-sw");
				const w = await waitWindow("simple-egl");
				await sleep(2500);
				b = await statsNow();
				const p = w ? await windowPixels("simple-egl") : null;
				report("gpu: ?wlgpu=0 (no gpu source): the relay has --dmabuf, wland offers no linux-dmabuf, weston-simple-egl renders in software into an shm window (alpha, the right way up)",
					/--dmabuf virtgpu/.test(relay) && inf.trim() === "0" && !!w && b.reads - a.reads > 10 && b.gpuCommits === a.gpuCommits && p?.corner[3] > 100 && p?.corner[3] < 160 && p?.blueY < p?.redGreenY,
					`relay: ${relay.split("\n").pop()}; linux-dmabuf listed ${inf.trim()} times; ${b.reads - a.reads} shm reads, ${b.gpuCommits - a.gpuCommits} GPU commits; pixels ${JSON.stringify(p)}`);
				await cleanupApps();
				if (want("--pacing")) {
					const out = await rates("software, ?wlgpu=0");
					report("gpu: frame rates in software over shm (reported)", out.every((l) => !/no window|other windows open/.test(l)), out.join("; "));
				}
			}

			// ?gpu=0: no render node; with the vtest link (GALLIUM_DRIVER=virpipe) Mesa's software winsys presents virgl frames in shm windows.
			say("gpu: ?gpu=0");
			{
				await openPage(`${base}${param}&gpu=0`);
				const relay = await sh(`${WL} true; ls /dev/dri 2>&1; tr '\\0' ' ' < /proc/$(cat /run/user/1000/wlandr.pid)/cmdline`);
				a = await statsNow();
				await launch("env GALLIUM_DRIVER=virpipe LIBGL_ALWAYS_SOFTWARE=1 weston-simple-egl", "egl-vtest");
				const w = await waitWindow("simple-egl");
				await sleep(3000);
				b = await statsNow();
				const p = w ? await windowPixels("simple-egl") : null;
				const gl = JSON.parse(await evaluate("JSON.stringify({ state: KW.vm.gl?.status?.state, clients: KW.vm.gl?.stats?.clients })"));
				report("gpu: ?gpu=0: the relay has no --dmabuf, a GL app on the vtest link (virpipe) shows in an shm window",
					!/--dmabuf/.test(relay) && !!w && b.reads - a.reads > 5 && b.gpuCommits === a.gpuCommits && gl.state === "ready" && p?.blueY < p?.redGreenY,
					`${relay.replace(/\n/g, " | ")}; ${b.reads - a.reads} shm reads in ${((b.t - a.t) / 1000).toFixed(1)} s; renderer ${JSON.stringify(gl)}; pixels ${JSON.stringify(p)}`);
				await cleanupApps();
			}
		}
	}
	if (args.includes("--keep-open")) { say(`--keep-open: DevTools on 127.0.0.1:${dport}; Ctrl-C ends it`); await new Promise(() => {}); }
} catch (e) {
	console.error(`could not run: ${e?.stack || e}`);
	clearTimeout(watchdog);
	await cleanup();
	process.exit(2);
}
clearTimeout(watchdog);
await cleanup();
console.log(fails ? `${fails} check(s) failed` : "all checks passed");
process.exit(fails ? 1 : 0);
