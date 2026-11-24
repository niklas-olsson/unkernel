#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The page's Vulkan option in headless Chromium with WebGPU: starts the
// page's Vite dev server (web/, on a free port, or --port N) with the base
// bundle that carries the ICD (KW_KERNEL: $KW_BUILD/vk/base/unkernel.wasm
// where it exists, or --kernel FILE; else the dev server's own choice),
// imports the prepared data disk (test/vk/debian-disk.mjs: libvulkan1,
// vulkan-tools, weston; as a gzipped kwsparse next to it, made here once)
// into the fresh profile's data disk, loads the page's default URL
// (Debian; no ?vk=1) and checks, in the real page:
//
//   1  guest Vulkan is on by default (KW.config.vk, not asked), vm.vk
//      exists with its renderer idle, the Environment tab's Guest Vulkan row
//      says "on, not loaded yet", and the page has fetched no kwvk-naga.wasm
//      (every request seen through the DevTools protocol's Network domain)
//   2  `vulkaninfo --summary` in the guest names our device (kwvk); the
//      renderer then is loaded (vm.vk.status ready, with an adapter), the
//      wasm was fetched only after it started, and the row names the WebGPU
//      adapter and the load time
//   3  unless --no-tile: the launcher's vkcube tile (Graphics folder) maps a
//      Wayland window on the page whose pixels are not blank (a screenshot
//      of its canvas: several colours, many pixels off the most common one),
//      and the Guest Vulkan row then shows frames presented a second; with
//      vkcube also how it reached the page: where the guest's relay has
//      --external-buffers (its --version; --relay FILE pushes an aarch64
//      wlandr over the image's /usr/lib/kw/wlandr and restarts the boot's
//      relay) wland must offer them (KW.wayland.externalBuffers()), every
//      present be an external commit resolved to a picture
//      (KW.wayland.stats().extImages) with no byte read back
//      (vm.vk.stats.renderer.bytesRead), and the row say zero-copy; else
//      by readback (wl_shm), and the row says so. Then the vkmark and the
//      GTK on Vulkan tiles likewise, where the disk has vkmark and
//      gtk4-demo (--disk; --no-vkmark, --no-gtk); then the D3D12 gears
//      and triangle tiles (vkd3d's demos on Xwayland) where the disk has
//      vkd3d-demos, or with --vkd3d (their installer installs it, and
//      Xwayland, over the page's network; --no-vkd3d skips them): the
//      Xwayland window's pixels, the gears' changing between two
//      screenshots, and the row's frame rate (printed, not checked)
//   M  the resource monitor's Vulkan figures (stats.ts): at 1, System's
//      Overview has a Vulkan panel that says "Not loaded" and the top bar's
//      GPU meter says nothing of Vulkan; while vkcube runs (3), the meter's
//      label has Vulkan's frame rate and the panel frames a second. With
//      --shots DIR: topbar-*.png (the bar and its Resources popover),
//      monitor-*.png (the page) and monitor-vulkan-*.png (the panel), idle
//      and vkcube
//
//   node test/vk/page-check.mjs [--port N] [--kernel FILE] [--built] [--inline] [--fresh] [--no-tile] [--relay FILE] [--shots DIR] [--chrome BIN] [--timeout S] [--verbose]
//
// --built: the built Node server (web/.output) instead of the dev server;
// its kernel is the one the build took (build with KW_KERNEL=FILE
// pnpm build:web for a base with the ICD), --kernel is not used.
// --disk FILE: another prepared disk (e.g. $KW_BUILD/vk/debian-vk-apps.img,
// debian-disk.mjs --apps: with vkmark, whose tile step 3 then launches too;
// skipped where the disk has no vkmark, or with --no-vkmark).
// --inline: ?worker=0 (default the page's worker mode). --fresh: no
// prepared disk (?data=0; the tile installs vulkan-tools with apt over the
// page's network, which needs the internet; step 2 then runs after the
// tile). The browser: the Playwright Chromium (BIN or $CHROME), the only one
// with a WebGPU adapter here (SwiftShader; .agents/vk.md, Testing). Exit 0
// when every check run passed, 1 on a failure, 2 when it could not run.
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as netServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { sleep, startServer } from "../../web/test/lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const build = process.env.KW_BUILD ? resolve(process.env.KW_BUILD) : join(root, "vendor/build");
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const timeout = Number(opt("--timeout", "900")) * 1000;
const inline = args.includes("--inline");
const fresh = args.includes("--fresh");
const tile = !args.includes("--no-tile");
const built = args.includes("--built");
const verbose = args.includes("--verbose");
const shots = opt("--shots", "");
const kernel = opt("--kernel", existsSync(join(build, "vk/base/unkernel.wasm")) ? join(build, "vk/base/unkernel.wasm") : "");
const disk = resolve(opt("--disk", join(build, "vk/debian-vk.img")));
const relay = opt("--relay") ? resolve(opt("--relay")) : "";
if (relay && !existsSync(relay)) {
	console.error(`no ${relay} (--relay)`);
	process.exit(2);
}
const diskGz = `${disk}.kwsparse.gz`;
const WEBGPU_FLAGS = ["--headless", "--no-sandbox", "--disable-gpu-sandbox", "--enable-unsafe-webgpu",
	"--enable-features=Vulkan,WebGPU", "--use-vulkan=swiftshader", "--use-webgpu-adapter=swiftshader", "--ignore-gpu-blocklist",
	// a GL backend for WebGPU canvases (external present's pictures; without it Chrome destroys the device: vk.ts probeCanvas)
	"--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
const t0 = performance.now();
const secs = () => ((performance.now() - t0) / 1000).toFixed(1);
const say = (s) => console.log(`[${secs()}] ${s}`);

let fails = 0;
const report = (name, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}  ${detail}`);
	if (!ok) fails++;
};

function playwrightChromium() {
	const explicit = opt("--chrome", process.env.CHROME);
	if (explicit) return explicit;
	const base = join(homedir(), ".cache/ms-playwright");
	for (const d of existsSync(base) ? readdirSync(base).sort().reverse() : []) {
		const p = join(base, d, "chrome-linux64/chrome");
		if (/^chromium-\d+$/.test(d) && existsSync(p)) return p;
	}
	return "chromium";
}

/** Decode an 8-bit RGB or RGBA PNG (Page.captureScreenshot's) to { width, height, rgba }. */
function decodePng(buf) {
	let at = 8, width = 0, height = 0, type = 0;
	const idat = [];
	while (at < buf.length) {
		const len = buf.readUInt32BE(at), name = buf.toString("latin1", at + 4, at + 8), data = buf.subarray(at + 8, at + 8 + len);
		if (name === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); type = data[9]; }
		else if (name === "IDAT") idat.push(data);
		at += 12 + len;
	}
	const bpp = type === 6 ? 4 : 3, raw = inflateSync(Buffer.concat(idat)), stride = width * bpp, rgba = new Uint8Array(width * height * 4);
	let prev = new Uint8Array(stride);
	for (let y = 0; y < height; y++) {
		const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), cur = new Uint8Array(stride);
		for (let i = 0; i < stride; i++) {
			const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
			const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
			cur[i] = (line[i] + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]) & 255;
		}
		for (let x = 0; x < width; x++) rgba.set([cur[x * bpp], cur[x * bpp + 1], cur[x * bpp + 2], 255], (y * width + x) * 4);
		prev = cur;
	}
	return { width, height, rgba };
}

if (!fresh && !existsSync(diskGz)) {
	if (!existsSync(disk)) {
		say("making the prepared disk (test/vk/debian-disk.mjs)");
		if (spawnSync(process.execPath, [join(here, "debian-disk.mjs")], { stdio: "inherit" }).status !== 0) {
			console.error("the prepared disk could not be made");
			process.exit(2);
		}
	}
	say(`writing ${diskGz} (the page's import format)`);
	const { gzipBlob, kwsparseHeader, isZeroBlock } = await import("../../js/node.ts");
	const BLOCK = 4096, indices = [], blocks = [];
	let at = 0;
	for await (const chunk of createReadStream(disk, { highWaterMark: 1 << 20 })) {
		for (let o = 0; o < chunk.length; o += BLOCK) {
			const b = chunk.subarray(o, o + BLOCK);
			if (!isZeroBlock(b)) { indices.push((at + o) / BLOCK); blocks.push(new Uint8Array(b)); }
		}
		at += chunk.length;
	}
	const gz = await gzipBlob([kwsparseHeader(statSync(disk).size, BLOCK, indices), ...blocks]);
	writeFileSync(diskGz, new Uint8Array(await gz.arrayBuffer()));
}
if (shots) mkdirSync(shots, { recursive: true });

// The prepared disk for the page's import: any origin, with CORP (the page is cross-origin isolated).
const files = createServer((req, res) => {
	const h = { "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin" };
	if (req.url === "/wlandr" && relay) {
		res.writeHead(200, { ...h, "content-type": "application/octet-stream", "content-length": statSync(relay).size });
		createReadStream(relay).pipe(res);
		return;
	}
	if (req.url !== "/disk.kwsparse.gz" || fresh) { res.writeHead(404, h).end(); return; }
	res.writeHead(200, { ...h, "content-type": "application/octet-stream", "content-length": statSync(diskGz).size });
	createReadStream(diskGz).pipe(res);
});
await new Promise((r) => files.listen(0, "127.0.0.1", r));
const diskUrl = `http://127.0.0.1:${files.address().port}/disk.kwsparse.gz`;

const port = Number(opt("--port", "0")) || await new Promise((r) => {
	const s = netServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); });
});
say(built ? `built server (web/.output) on 127.0.0.1:${port}` : `dev server on 127.0.0.1:${port}${kernel ? ` with KW_KERNEL=${kernel}` : ""}`);
const server = await startServer({ port, host: "127.0.0.1", dev: !built, env: kernel && !built ? { KW_KERNEL: resolve(kernel) } : {} }).catch((e) => {
	console.error(`the dev server did not start: ${e.message}`);
	process.exit(2);
});
const chromeBin = playwrightChromium();
const profile = mkdtempSync(join(tmpdir(), "kw-vkpage-"));
const dport = 30000 + Math.floor(Math.random() * 20000);
const chrome = spawn(chromeBin, [...WEBGPU_FLAGS, "--disable-dev-shm-usage", "--hide-scrollbars", "--window-size=1280,800",
	`--remote-debugging-port=${dport}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", verbose ? "inherit" : "ignore"] });
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
	const wasmRequests = [];
	// A load of the page after the checks began: the dev server reloads it when a source changes
	// (another edit in this tree), which ends the VM; the run then says so instead of failing a check.
	let checking = false, reloaded = 0;
	ws.onmessage = (m) => {
		const msg = JSON.parse(m.data);
		if (msg.method === "Page.frameNavigated" && !msg.params.frame.parentId && checking) {
			reloaded++;
			say("the page was reloaded (a source changed under the dev server?)");
		}
		if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
		if (msg.method === "Network.requestWillBeSent" && /kwvk-naga[^/]*\.wasm(\?|$)/.test(msg.params.request.url)) {
			wasmRequests.push({ url: msg.params.request.url.replace(/^https?:\/\/[^/]+/, ""), at: Number(secs()) });
			say(`page requests ${msg.params.request.url}`);
		}
		if (msg.method === "Runtime.consoleAPICalled") {
			const line = msg.params.args.map((a) => a.value ?? a.description).join(" ");
			if (verbose || /vulkan|\[vk\]|vk:/i.test(line)) say(`page: ${line.slice(0, 300)}`);
		}
		if (msg.method === "Network.responseReceived" && msg.params.response.status >= 400) say(`page request ${msg.params.response.url}: ${msg.params.response.status}`);
		if (msg.method === "Inspector.targetCrashed") {
			console.error(`[${secs()}] the page crashed`);
			void cleanup().then(() => process.exit(2));
		}
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
			if (v || performance.now() > end) return v;
			await sleep(step);
		}
	};
	const sh = (cmd, ms = 120000) => evaluate(`KW.vm.exec("bash", ["-lc", ${JSON.stringify(cmd)}], { timeout: ${ms} }).then((r) => ({ code: r.exitCode, out: (r.stdout + r.stderr).trim() }))`);
	const openPage = async (u) => {
		say(`open ${u}`);
		await send("Page.navigate", { url: u });
		await sleep(500);
		if (!await waitFor("typeof globalThis.KW?.ready === 'function'", 120000)) throw new Error("the page did not load");
		await evaluate("KW.ready().then(() => 1)");
	};
	// M: the monitor's Vulkan figures: Resources from the top bar (under the GPU meter where it shows), then System's
	// Overview; their text, and with --shots their pictures; System closed again (it would cover the Wayland windows).
	const monitor = async (tag, wait) => {
		const shot = async (name, clip) => {
			if (!shots) return;
			const s = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
			writeFileSync(join(shots, name), Buffer.from(s.result.data, "base64"));
			say(`shot ${join(shots, name)}`);
		};
		const rect = async (sel) => JSON.parse(await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return "null"; e.scrollIntoView({ block: "nearest" }); const r = e.getBoundingClientRect(); return JSON.stringify(r.width > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null); })()`));
		const meter = await evaluate(`(() => { const m = document.getElementById("tb-gpu") ?? document.getElementById("tb-net"); m?.click(); return m?.id ?? ""; })()`);
		await waitFor(`!!document.getElementById("tb-res")`, 5000);
		await sleep(wait); // full samples (every 2 s while Resources shows)
		const gpuLabel = await evaluate(`document.getElementById("tb-gpu")?.getAttribute("aria-label") ?? ""`);
		const res = await rect("#tb-res");
		const vw = await evaluate("innerWidth");
		await shot(`topbar-${tag}.png`, { x: 0, y: 0, width: vw, height: Math.ceil(res ? res.y + res.height + 8 : 40) });
		await evaluate(`document.getElementById("tb-res-system")?.click(), 1`);
		await waitFor(`!!document.querySelector('#system [data-tab="status"]')`, 5000);
		await evaluate(`document.querySelector('#system [data-tab="status"]')?.click(), 1`);
		await waitFor(`!!document.querySelector('#system section[aria-label="Vulkan"]')`, 5000);
		await sleep(4500);
		const card = await evaluate(`document.querySelector('#system section[aria-label="Vulkan"]')?.innerText.replace(/\\s+/g, " ") ?? ""`);
		await shot(`monitor-${tag}.png`);
		const box = await rect('#system section[aria-label="Vulkan"]');
		if (box) await shot(`monitor-vulkan-${tag}.png`, box);
		await evaluate(`document.querySelector('button[aria-label="Close System"]')?.click(), 1`);
		await waitFor(`!document.querySelector('#system section[aria-label="Vulkan"]') && 1`, 5000);
		say(`monitor (${tag}): meter #${meter}, its label "${gpuLabel.replace(/\n/g, " | ")}"; Vulkan panel: ${card.slice(0, 400)}`);
		return { gpuLabel, card };
	};
	const rowAt = (re, ms = 10000) => waitFor(`(() => { const l = KW.ui.diagText().split("\\n").find((x) => / Guest Vulkan: /.test(x)); return l && ${re}.test(l) ? l.trim() : ""; })()`, ms)
		.then(async (v) => v || (await evaluate(`KW.ui.diagText().split("\\n").find((x) => / Guest Vulkan: /.test(x))?.trim() ?? "(no Guest Vulkan row)"`)));
	await send("Inspector.enable");
	await send("Runtime.enable");
	await send("Network.enable");
	await send("Page.enable");
	// The default URL but for the test's own parameters: no ?vk=.
	const url = `http://127.0.0.1:${port}/?distro=debian&cpus=1&mem=1024&autosuspend=0&askleave=0&autohide=0${inline ? "&worker=0" : ""}${fresh ? "&data=0" : ""}`;

	if (!fresh) {
		await openPage(url);
		say("importing the prepared data disk");
		const imp = await evaluate(`fetch(${JSON.stringify(diskUrl)}).then((r) => r.blob()).then((b) => KW.importData(b)).then((r) => JSON.stringify(r))`).catch((e) => `(the page reloaded: ${e.message.split("\n")[0]})`);
		say(`imported: ${imp}`);
		await sleep(1500);
		wasmRequests.length = 0;
	}
	await openPage(url);
	wasmRequests.length = 0; // a reload's requests before this boot are not this boot's
	checking = true;

	// 1: on by default, idle
	const cfg = JSON.parse(await evaluate("JSON.stringify({ vk: KW.config.vk, asked: KW.config.vkAsked, why: KW.config.vkWhy, blocked: KW.config.vkBlocked, worker: KW.config.worker, gpu: !!navigator.gpu })"));
	say(`config: ${JSON.stringify(cfg)}`);
	const st0 = JSON.parse(await evaluate("JSON.stringify(KW.vm.vk ? KW.vm.vk.status : null)"));
	const row0 = await rowAt("/ Guest Vulkan: on, not loaded yet/");
	say(`row: ${row0}`);
	report("vk on by default, renderer idle", cfg.vk === true && cfg.asked === false && st0?.state === "idle" && wasmRequests.length === 0 && / Guest Vulkan: on, not loaded yet/.test(row0),
		`${JSON.stringify(cfg)}; status ${JSON.stringify(st0)}; ${wasmRequests.length} kwvk-naga.wasm requests; ${row0.slice(0, 160)}`);
	const m0 = await monitor("idle", 2500);
	report("the monitor: Vulkan not loaded", /^Vulkan .*Not loaded/.test(m0.card) && !/Vulkan:/.test(m0.gpuLabel) && wasmRequests.length === 0,
		`panel "${m0.card.slice(0, 120)}"; GPU meter "${m0.gpuLabel}"; ${wasmRequests.length} kwvk-naga.wasm requests`);
	const icd = await sh("ls -l /usr/lib/kw/libvulkan_kw.so /usr/share/vulkan/icd.d/; command -v vulkaninfo vkcube");
	say(`guest: ${icd.out.replace(/\n/g, " | ")}`);
	// --relay: the relay under test over the image's, and the boot's relay started again with it
	if (relay) {
		const put = await evaluate(`fetch(${JSON.stringify(diskUrl.replace(/\/disk\.kwsparse\.gz$/, "/wlandr"))}).then((r) => r.arrayBuffer()).then((b) => KW.vm.exec("sh", ["-c",
			"cat >/usr/lib/kw/wlandr.new && chmod 755 /usr/lib/kw/wlandr.new && mv -f /usr/lib/kw/wlandr.new /usr/lib/kw/wlandr && { pkill -x wlandr; sleep 0.5; /usr/lib/kw/bin/wland --boot; sleep 1; ps -eo user,args | grep '[w]landr'; }"],
			{ input: new Uint8Array(b), user: "root" })).then((r) => ({ code: r.exitCode, out: (r.stdout + r.stderr).trim() }))`);
		say(`relay pushed (exit ${put.code}): ${put.out.replace(/\n/g, " | ")}`);
	}
	const relayFeatures = (await sh("/usr/lib/kw/wlandr --version 2>/dev/null | sed -n 's/^features: //p'")).out;
	const relayExt = / external-buffers( |$)/.test(` ${relayFeatures}`);
	say(`guest relay features: ${relayFeatures || "(none: an older relay)"}`);

	// 2: vulkaninfo names kwvk; the renderer loaded on first use
	const vulkaninfo = async () => {
		const first = Number(secs());
		const v = await sh("vulkaninfo --summary 2>&1", 300000);
		const dev = /deviceName\s*=\s*(.*)/.exec(v.out)?.[1] ?? "?", api = /apiVersion\s*=\s*(.*)/.exec(v.out)?.[1] ?? "?";
		report("vulkaninfo --summary names kwvk", v.code === 0 && /kwvk/.test(dev), `exit ${v.code}; deviceName "${dev}", apiVersion ${api}${/kwvk/.test(dev) ? "" : `\n${v.out.slice(-1200)}`}`);
		const st = JSON.parse(await evaluate("JSON.stringify(KW.vm.vk.status)"));
		const row = await rowAt("/^\\s*\\[(pass|warn)\\] Guest Vulkan: /");
		say(`row: ${row}`);
		report("renderer loaded on first use, the row names the adapter", st.state === "ready" && !!st.adapter && row.includes(st.adapter) && / loaded in /.test(row) &&
			(fresh || (wasmRequests.length > 0 && wasmRequests.every((r) => r.at >= first))),
			`status ${JSON.stringify(st)}; wasm ${JSON.stringify(wasmRequests)} (the first instance at ${first} s); ${row.slice(0, 260)}`);
	};
	if (!fresh) await vulkaninfo();

	// 3: the launcher's Vulkan tiles (vkcube, then vkmark), each window's pixels; with vkcube the row's frame rate
	// opts: wait (ms for the window: an install over the network takes longer), animated (two screenshots
	// must differ), rate (print the row's frame rate)
	const tileCase = async (id, re, proc, rowCheck, opts = {}) => {
		const clicked = await evaluate(`(async () => {
			const until = async (f) => { for (let i = 0; i < 50 && !f(); i++) await new Promise((r) => setTimeout(r, 100)); return f(); };
			await until(() => document.querySelector("#dock-launcher"));
			if (!document.querySelector("#launcher")) document.querySelector("#dock-launcher").click();
			const folder = await until(() => document.querySelector('#launcher-grid [data-folder="gl"]'));
			if (!folder) return "no Graphics folder";
			folder.click();
			const b = await until(() => document.querySelector('#launcher-folder [data-app="${id}"]'));
			if (!b) return "no ${id} tile";
			if (b.getAttribute("aria-disabled") === "true") return "disabled: " + b.title;
			b.click();
			return "clicked";
		})()`);
		say(`${id} tile: ${clicked}`);
		const find = `KW.wayland.windows().find((w) => ${re}.test(w.title + ' ' + w.appId))`;
		const win = await waitFor(`${find} && JSON.stringify(KW.wayland.windows())`, opts.wait ?? (fresh ? 900000 : 180000), 500);
		if (!win) {
			report(`${id} window`, false, `tile ${clicked}; windows ${await evaluate("JSON.stringify(KW.wayland?.windows() ?? null)")}`);
			const term = await evaluate(`(() => { const w = KW.windows.list().find((x) => x.name === "${id}"); return w ? KW.windows.text(w.n).trim().split("\\n").slice(-15).join("\\n") : "(no ${id} terminal)"; })()`).catch((e) => e.message);
			console.log(`--- the ${id} app's terminal:\n${term}`);
			const guest = await sh(`ps -eo pid,stat,etime,args | grep -E '[${proc[0]}]${proc.slice(1)}|[w]land'; echo; tail -15 /run/user/1000/wlandr.log`, 30000).catch((e) => ({ out: e.message }));
			console.log(`--- the guest's processes and the relay's log:\n${guest.out}`);
			console.log(`--- vm.vk: ${await evaluate("JSON.stringify({ status: KW.vm.vk.status, stats: KW.vm.vk.stats, wl: KW.wayland.stats?.() })")}`);
		} else {
			const counters = `JSON.stringify({ ext: KW.wayland.externalBuffers(), wl: KW.wayland.stats(), r: KW.vm.vk.stats.renderer })`;
			await sleep(1500); // past the first frames (a resize may make a new swapchain)
			const c0 = rowCheck ? JSON.parse(await evaluate(counters)) : null;
			await sleep(4500); // a few frames, and the row's next 2 s update
			const rect = JSON.parse(await evaluate(`(() => { const w = ${find}; const el = w && KW.wayland.container().querySelector('[data-wland-window="' + w.key + '"]'); const c = el && [...el.querySelectorAll("canvas")].map((x) => x.getBoundingClientRect()).sort((a, b) => b.width * b.height - a.width * a.height)[0]; return JSON.stringify(c && c.width > 50 ? { x: c.x, y: c.y, width: c.width, height: c.height } : null); })()`));
			if (!rect) report(`${id} window pixels`, false, `windows ${win}; no canvas`);
			else {
				const s = await send("Page.captureScreenshot", { format: "png", clip: { ...rect, scale: 1 } });
				const png = Buffer.from(s.result.data, "base64");
				if (shots) writeFileSync(join(shots, `${id}.png`), png);
				const img = decodePng(png);
				const colours = new Map();
				for (let i = 0; i < img.rgba.length; i += 4) {
					const k = (img.rgba[i] << 16) | (img.rgba[i + 1] << 8) | img.rgba[i + 2];
					colours.set(k, (colours.get(k) ?? 0) + 1);
				}
				const most = Math.max(...colours.values()), other = img.width * img.height - most;
				const vst = JSON.parse(await evaluate("JSON.stringify({ status: KW.vm.vk.status.state, renderer: KW.vm.vk.stats.renderer, losses: KW.vm.vk.stats.losses })"));
				report(`${id} window pixels`, colours.size >= 16 && other >= img.width * img.height / 50,
					`windows ${win}; ${img.width}x${img.height}: ${colours.size} colours, ${other} pixels off the most common; ${JSON.stringify(vst)}`);
				if (opts.animated) {
					await sleep(1000);
					const s2 = await send("Page.captureScreenshot", { format: "png", clip: { ...rect, scale: 1 } });
					const img2 = decodePng(Buffer.from(s2.result.data, "base64"));
					let changed = 0;
					for (let i = 0; i < Math.min(img.rgba.length, img2.rgba.length); i += 4)
						if (img.rgba[i] !== img2.rgba[i] || img.rgba[i + 1] !== img2.rgba[i + 1] || img.rgba[i + 2] !== img2.rgba[i + 2]) changed++;
					report(`${id} animates`, changed >= img.width * img.height / 200, `${changed} pixels changed over 1 s`);
				}
			}
			if (opts.rate) say(`${id}: ${(await rowAt("/ frames presented a second, /")).replace(/^.*Guest Vulkan: /, "")}`);
			if (rowCheck) {
				const row = await rowAt("/ frames presented a second, /");
				const fps = /([\d.]+) frames presented a second, ([\d.]+) draws a frame/.exec(row);
				report("the row's frame rate while vkcube runs", !!fps && Number(fps[1]) > 0, fps ? `${fps[1]} frames/s, ${fps[2]} draws a frame` : row.slice(0, 300));
				// how the frames reached the page: external buffers (no readback) where the relay has them
				const c1 = JSON.parse(await evaluate(counters));
				const d = (k) => (c1.r?.[k] ?? 0) - (c0.r?.[k] ?? 0), dw = (k) => (c1.wl?.[k] ?? 0) - (c0.wl?.[k] ?? 0);
				const what = `externalBuffers ${c1.ext}; over the window: ${d("presents")} presents, ${d("externalPresents")} external, ${dw("extCommits")} external commits, ${dw("extImages")} pictures, ${d("bytesRead")} bytes read back, ` +
					`resolve ${(dw("extMs") / Math.max(1, dw("extCommits"))).toFixed(2)} ms (max ${c1.wl?.extMaxMs?.toFixed(2)}), draw ${(dw("extDrawMs") / Math.max(1, dw("extImages"))).toFixed(2)} ms`;
				const zrow = await rowAt(relayExt ? "/zero-copy presentation/" : "/by readback into wl_shm/");
				if (relayExt)
					report("vkcube by external buffers (zero-copy)", c1.ext === true && d("presents") > 5 && d("externalPresents") === d("presents") && dw("extImages") > 5 && d("bytesRead") === 0 && /zero-copy presentation/.test(zrow), `${what}; row: ${zrow.slice(zrow.indexOf("Wayland windows"), zrow.indexOf("Wayland windows") + 160)}`);
				else
					report("vkcube by readback (the relay has no external buffers)", c1.ext === false && d("presents") > 5 && d("externalPresents") === 0 && d("bytesRead") > 0 && /by readback into wl_shm/.test(zrow), what);
				const m1 = await monitor("vkcube", 6000);
				report("the monitor: Vulkan's frames while vkcube runs", /Vulkan: [\d.]+ fps · 1 instance/.test(m1.gpuLabel) && /^Vulkan .*\d fps/.test(m1.card),
					`GPU meter "${m1.gpuLabel.replace(/\n/g, " | ")}"; panel "${m1.card.slice(0, 200)}"`);
			}
		}
		await sh(`pkill -x ${proc}; true`);
		await waitFor(`!${find} && 1`, 20000);
	};
	if (tile) {
		await tileCase("vkcube", "/cube/i", "vkcube", true);
		if (fresh) await vulkaninfo();
		if (!fresh && !args.includes("--no-vkmark")) {
			const has = await sh("command -v vkmark");
			if (has.code === 0) await tileCase("vkmark", "/vkmark/i", "vkmark", false);
			else say("vkmark: not on this disk (debian-vk-apps.img has it: --disk FILE); skipped");
		}
		// GTK 4's demo on its Vulkan renderer, where the disk has it (debian-vk-apps.img: gtk-4-examples).
		if (!fresh && !args.includes("--no-gtk") && (await sh("command -v gtk4-demo")).code === 0) await tileCase("gtkvk", "/gtk|demo/i", "gtk4-demo", false);
		// vkd3d's Direct3D 12 demos on Xwayland (one X screen, the window's app id org.freedesktop.Xwayland)
		if (!args.includes("--no-vkd3d") && (args.includes("--vkd3d") || (!fresh && (await sh("command -v vkd3d-gears")).code === 0))) {
			await tileCase("d3d12gears", "/xwayland/i", "vkd3d-gears", false, { wait: 900000, animated: true, rate: true });
			await tileCase("d3d12triangle", "/xwayland/i", "vkd3d-triangle", false, { rate: true });
		}
	}
	if (reloaded) {
		console.log(`the page was reloaded ${reloaded} time(s) during the checks (the dev server saw a source change): the results above do not count`);
		fails = -1;
	}
} catch (e) {
	console.error(`error: ${e.stack ?? e}`);
	fails = fails || -1;
} finally {
	clearTimeout(watchdog);
	await cleanup();
}
console.log(fails === 0 ? `all passed (${secs()} s)` : fails < 0 ? "could not run" : `${fails} failed`);
process.exit(fails === 0 ? 0 : fails < 0 ? 2 : 1);
