#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Guest Vulkan end to end in headless Chrome with WebGPU: unkernel (the
// built package, dist/) boots Debian with the prepared data disk
// (debian-disk.mjs: the Vulkan loader and vulkan-tools from apt, made once)
// and createKernel({ vk: true }), whose renderer (js/core/vk.ts,
// vk-host.ts) runs on the page's WebGPU device (SwiftShader's Vulkan here,
// software). The page (unkernel-page.js) puts the ICD
// ($KW_BUILD/vk/libvulkan_kw.so) and its manifest into the guest at
// /usr/lib/kw/libvulkan_kw.so and /usr/share/vulkan/icd.d/kw_icd.json
// (where the base's kw layer will carry them; --no-push uses the base's),
// then runs, in the guest, with no Vulkan environment variables:
//
//   h  the link without the ICD: a hello frame (vk/PROTOCOL.md) through
//      `kwbox vsock connect 1018`; the reply must be the hello reply (the
//      renderer loads at this first connection)
//   a  vulkaninfo --summary: must exit 0 and name the kwvk device
//      (deviceName containing "kw", or --device-re REGEX)
//   b  the ICD's test programs (test/vk/guest/*.c, built for aarch64 by
//      vk/icd/build.sh: every executable vk-* in --tests DIR, default
//      $KW_BUILD/vk),
//      each must exit 0; pictures they leave in /tmp (*.ppm, *.png) are
//      copied to --out
//   c  vkcube --wsi wayland --c 30 under weston's headless backend (the
//      pixman renderer, started with --debug by /usr/local/bin/kwvk-wl, which
//      the page writes) in the guest: must exit 0 (not run without weston);
//      then weston-screenshooter takes the screen with a running vkcube
//      (vkcube.png in --out): the window must have many colours and the
//      LunarG texture's teal, not olive (red and blue swapped)
//   w  vkcube on Wayland through wland: wland/headless on the page (from
//      web/node_modules/wland) serves vsock port 1023 with
//      gpu.resolveExternal = vm.vk.externalImage, the relay runs in the
//      guest (--relay FILE: an aarch64 wlandr pushed to /tmp/kwvk-wlandr,
//      else the image's). With a relay that has --external-buffers: vkcube
//      (IMMEDIATE) at each --wsizes size (default 500x500,1280x720) for
//      --wsecs seconds (default 6) by external buffers (frames right, no
//      byte read back per present, every present an external commit), then
//      with KWVK_EXTERNAL=0 (readback into wl_shm) for comparison; frames/s
//      and bytes read back per frame are printed. Always: a relay without
//      the flag (no global): vkcube --c 150 must exit 0 over wl_shm with its
//      window right (the fallback)
//
//   node test/vk/unkernel-check.mjs [--worker] [--skip h,a,b,c,w] [--tests DIR] [--no-push] [--kernel FILE] [--apps] [--snapshot] [--lose] [--cpus N] [--capture-shaders] [--disk FILE]
//        [--relay FILE] [--wsizes WxH,...] [--wsecs S] [--device-re REGEX] [--cmd SHELL] [--out DIR] [--browser BIN] [--timeout S] [--no-build | --source]
//        [--mem MIB] [--nogpu] [--profile N]
//
// --lose adds step l: the renderer's WebGPU device destroyed (vm.vk.device)
// while vkcube runs: vkcube must end, vm.vk.status must say lost, and
// vk-compute and vulkaninfo must work again on a new device and renderer.
// --apps boots the second-stage disk (debian-disk.mjs --apps: vkmark, GTK 4,
// SDL, vkd3d) for --cmd runs. --snapshot adds step s: the Debian disk's
// overlay in the page's IndexedDB, a snapshot (with stop) taken while
// vkcube runs, restored in the same page: the restored vkcube must end (its
// link is gone), and vk-compute and vulkaninfo must work again. --cpus N
// boots the SMP kernel with N CPUs (the page is then cross-origin
// isolated). --capture-shaders (with --source) writes every SPIR-V module
// the translator refuses to --out (shader-fail-N.spv, .json: the options and
// the error). --disk FILE boots another prepared disk (made on the same
// Debian image). --mem MIB: the guest's memory (default 1024). --nogpu
// (debugging, timing): the renderer encodes every dispatch but runs none
// (vk-host.ts noGpu: wrong results; workgroups over the device's limits
// compile clamped), so a model's per-token overhead can be timed without
// SwiftShader's GPU time. --profile N: an instruction sample every N guest
// user instructions (js/core/profile.ts) while --cmd runs, written to
// profile.json in the out dir (symbolizeProfile reads it with a host copy of
// the guest's files). --kernel boots another bundle than dist's (e.g. one whose base carries
// the ICD: KW_BASE_OUT=DIR guest/build.sh base, then kernel/tools/bundle.mjs;
// with --no-push). --source runs the SDK from its sources instead of dist/ (no pnpm build):
// js/ served as JavaScript through Node's module.stripTypeScriptTypes, and
// /js/kwvk-naga.wasm from $KW_BUILD/vk.
//
// and reports the renderer's status (vm.vk.status: idle at boot, the
// renderer loaded on the guest's first Vulkan instance) and its stats.
// Builds first, each skipped when done: dist (pnpm build, unless
// --no-build or --source), the disk ($KW_BUILD/vk/debian-vk.img). Exit 0 when every
// step run passed, 1 on a failure, 2 when it could not run. Writes the
// steps' output, the page's log and the guest's console to --out (default
// a new /tmp/kwvk.* directory, printed). The browser: the Playwright
// Chromium (BIN or $CHROME), the only one with a WebGPU adapter here.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { inflateSync } from "node:zlib";
import { stripTypeScriptTypes } from "node:module";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const build = process.env.KW_BUILD ? resolve(process.env.KW_BUILD) : join(root, "vendor/build");
const args = process.argv.slice(2);
const opt = (name, dflt) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : dflt;
};
const has = (name) => args.includes(name);
const timeout = Number(opt("--timeout", "1800")) * 1000;
const browser = opt("--browser", process.env.CHROME || join(homedir(), ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome"));
process.removeAllListeners("warning"); // stripTypeScriptTypes is experimental
const WEBGPU_FLAGS = ["--headless", "--no-sandbox", "--disable-gpu-sandbox", "--enable-unsafe-webgpu",
	"--enable-features=Vulkan,WebGPU", "--use-vulkan=swiftshader", "--use-webgpu-adapter=swiftshader", "--ignore-gpu-blocklist", "--disable-dev-shm-usage",
	// a GL backend for WebGPU canvases (external present's pictures; without it Chrome destroys the device: vk.ts probeCanvas)
	"--use-angle=swiftshader", "--enable-unsafe-swiftshader"];
const out = resolve(opt("--out", "") || mkdtempSync("/tmp/kwvk."));
mkdirSync(out, { recursive: true });
const apps = has("--apps");
const disk = opt("--disk") ? resolve(opt("--disk")) : join(build, apps ? "vk/debian-vk-apps.img" : "vk/debian-vk.img");
const distro = join(build, "distro/debian.erofs");
const icd = join(build, "vk/libvulkan_kw.so");
const builtManifest = join(build, "vk/kw_icd.json"), manifest = existsSync(builtManifest) ? builtManifest : join(out, "kw_icd.json");
const testDir = resolve(opt("--tests", join(build, "vk")));
const skip = new Set((opt("--skip", "") || "").split(",").filter(Boolean));
let push = !has("--no-push");
const relay = opt("--relay") ? resolve(opt("--relay")) : "";
if (relay && !existsSync(relay)) {
	console.error(`no ${relay} (--relay)`);
	process.exit(2);
}

const step = (what, cmd, cmdArgs) => {
	console.log(`== ${what}`);
	const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: "inherit" });
	if (r.status !== 0) {
		console.error(`${what} failed`);
		process.exit(2);
	}
};
if (!existsSync(distro)) {
	console.error(`no ${distro} (kernel/build.sh distro debian)`);
	process.exit(2);
}
const source = has("--source");
if (!has("--no-build") && !source) step("pnpm build", "pnpm", ["build"]);
if (!source && (!existsSync(join(root, "dist/web.mjs")) || !existsSync(join(root, "dist/kwvk-naga.wasm")))) {
	console.error("no dist/web.mjs or dist/kwvk-naga.wasm (pnpm build; vk/naga)");
	process.exit(2);
}
if (!opt("--disk")) step("the prepared disk", process.execPath, [join(here, "debian-disk.mjs"), ...(apps ? ["--apps"] : []), "--out", disk]);
if (push && !existsSync(icd)) {
	console.log(`(no ${icd} (vk/icd): the guest gets the base's ICD, if it has one)`);
	push = false;
}
// The manifest vk/icd/build.sh writes (as the kw layer has it), or one like it.
if (manifest !== builtManifest) writeFileSync(manifest, JSON.stringify({ file_format_version: "1.0.0", ICD: { library_path: "/usr/lib/kw/libvulkan_kw.so", api_version: "1.0.0" } }, null, "\t") + "\n");
const tests = skip.has("b") || !existsSync(testDir) ? [] : readdirSync(testDir).filter((f) => {
	const st = statSync(join(testDir, f));
	return st.isFile() && st.mode & 0o111 && /^vk-[\w.-]+$/.test(f);
}).sort();
if (!skip.has("b") && !tests.length) console.log(`(no test programs in ${testDir}: step b runs nothing)`);

const types = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };
let resolveResult;
const result = new Promise((r) => (resolveResult = r));
const pageLog = join(out, "page.log"), consoleLog = join(out, "console.log");
writeFileSync(pageLog, "");
writeFileSync(consoleLog, "");
// A file with Range support (one range; HttpBase asks for nothing else).
function sendFile(req, res, file, type) {
	const st = statSync(file);
	const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
	const h = { "content-type": type, "accept-ranges": "bytes", etag, "cache-control": "no-cache", ...isolation };
	const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
	let start = 0, end = st.size - 1, status = 200;
	if (m && (m[1] || m[2])) {
		if (m[1]) {
			start = Number(m[1]);
			if (m[2]) end = Math.min(Number(m[2]), st.size - 1);
		} else start = Math.max(0, st.size - Number(m[2]));
		if (start >= st.size || start > end) {
			res.writeHead(416, { "content-range": `bytes */${st.size}`, etag });
			res.end();
			return;
		}
		status = 206;
		h["content-range"] = `bytes ${start}-${end}/${st.size}`;
	}
	h["content-length"] = String(end - start + 1);
	res.writeHead(status, h);
	if (req.method === "HEAD") res.end();
	else createReadStream(file, { start, end }).pipe(res);
}
const CAPTURE = `
export async function loadVkShader(wasm) {
	const t = await loadVkShaderInner(wasm);
	let n = 0;
	return { translate(spv, opts) {
		try { return t.translate(spv, opts); } catch (e) {
			const id = ++n;
			fetch("/file/shader-fail-" + id + ".spv", { method: "POST", body: spv });
			fetch("/file/shader-fail-" + id + ".json", { method: "POST", body: JSON.stringify({ opts, error: String(e && e.message) }) });
			throw e;
		}
	} };
}
`;
// --cpus: CPU threads need a cross-origin isolated page
const isolation = opt("--cpus") ? { "cross-origin-opener-policy": "same-origin", "cross-origin-embedder-policy": "require-corp" } : {};
const server = createServer(async (req, res) => {
	const url = new URL(req.url, "http://x");
	const p = decodeURIComponent(url.pathname);
	if (req.method === "POST") {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		const body = Buffer.concat(chunks);
		res.end("ok");
		if (p === "/log") {
			appendFileSync(pageLog, body + "\n");
			console.log(`page: ${body}`);
		} else if (p === "/console") appendFileSync(consoleLog, body);
		else if (p.startsWith("/file/") && /^[\w.-]+$/.test(p.slice(6))) writeFileSync(join(out, p.slice(6)), body);
		else if (p === "/result") resolveResult(body.toString());
		return;
	}
	if (p === "/img/debian.erofs") return sendFile(req, res, distro, "application/octet-stream");
	if (p === "/img/unkernel.wasm" && opt("--kernel")) return sendFile(req, res, resolve(opt("--kernel")), "application/wasm");
	if (p === "/img/debian-vk.img") return sendFile(req, res, disk, "application/octet-stream");
	if (p === "/files/libvulkan_kw.so" && push) return sendFile(req, res, icd, "application/octet-stream");
	if (p === "/files/kw_icd.json") return sendFile(req, res, manifest, "application/json");
	if (p === "/files/wlandr" && relay) return sendFile(req, res, relay, "application/octet-stream");
	if (p.startsWith("/files/test/") && tests.includes(p.slice(12))) return sendFile(req, res, join(testDir, p.slice(12)), "application/octet-stream");
	if (source && p === "/js/kwvk-naga.wasm") return sendFile(req, res, join(build, "vk/kwvk-naga.wasm"), "application/wasm");
	if (source && p.startsWith("/js/") && p.endsWith(".ts")) {
		const rel = normalize(p.slice(1));
		if (rel.startsWith("js/") && existsSync(join(root, rel))) {
			let code;
			try {
				code = stripTypeScriptTypes(readFileSync(join(root, rel), "utf8"), { mode: "strip", sourceUrl: rel });
				// --capture-shaders: every SPIR-V module the translator refuses, with its options and error,
				// goes to --out as shader-fail-N.spv and .json (for the translator's owner)
				if (has("--capture-shaders") && rel === "js/core/vk-shader.ts")
					code = code.replace("export async function loadVkShader(", "async function loadVkShaderInner(") + CAPTURE;
			} catch (e) {
				console.log(`cannot strip types of ${rel}: ${e.message}`);
				res.writeHead(500);
				res.end();
				return;
			}
			res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store", ...isolation });
			res.end(code);
			return;
		}
		console.log(`the page asked for ${rel}, which does not exist`);
	}
	for (const [prefix, dir] of [["/dist/", join(root, "dist")], ["/js/", join(root, "js")], ["/test/", here], ["/wland/", join(root, "web/node_modules/wland/dist")]]) {
		if (prefix === "/js/" && !source) continue;
		if (!p.startsWith(prefix)) continue;
		const rel = normalize(p.slice(prefix.length));
		if (rel.startsWith("..") || !existsSync(join(dir, rel))) break;
		return sendFile(req, res, join(dir, rel), types[rel.slice(rel.lastIndexOf("."))] || "application/octet-stream");
	}
	res.writeHead(404);
	res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const query = new URLSearchParams();
if (has("--worker")) query.set("worker", "1");
if (skip.size) query.set("skip", [...skip].join(","));
if (tests.length) query.set("tests", tests.join(","));
if (!push) query.set("push", "0");
if (opt("--cmd")) query.set("cmd", opt("--cmd"));
if (source) query.set("src", "1");
if (opt("--kernel")) query.set("kernel", "/img/unkernel.wasm");
if (has("--snapshot")) query.set("snap", "1");
if (has("--lose")) query.set("lose", "1");
if (opt("--cpus")) query.set("cpus", opt("--cpus"));
if (relay) query.set("relay", "1");
if (opt("--wsizes")) query.set("wsizes", opt("--wsizes"));
if (opt("--wsecs")) query.set("wsecs", opt("--wsecs"));
if (opt("--mem")) query.set("mem", opt("--mem"));
if (has("--nogpu")) query.set("nogpu", "1");
if (opt("--profile")) query.set("profile", opt("--profile"));
const pageUrl = `http://127.0.0.1:${server.address().port}/test/unkernel.html?${query}`;
console.log(`== ${pageUrl}\n   output in ${out}`);
const t0 = Date.now();
const chrome = spawn(browser, [...WEBGPU_FLAGS, "--no-first-run", `--user-data-dir=${join(out, "chromium-profile")}`, pageUrl],
	{ stdio: ["ignore", "ignore", "pipe"] });
let chromeErr = "";
chrome.stderr.on("data", (d) => (chromeErr += d));
chrome.on("error", (e) => {
	console.error(`cannot run ${browser}: ${e.message}`);
	process.exit(2);
});
const exited = new Promise((r) => chrome.on("exit", () => r(null)));
const body = await Promise.race([result, exited, new Promise((r) => setTimeout(() => r(null), timeout))]);
chrome.kill("SIGKILL");
server.close();
writeFileSync(join(out, "chromium.log"), chromeErr);
await exited;
rmSync(join(out, "chromium-profile"), { recursive: true, force: true });
if (body === null) {
	console.error(`no result from the page within ${timeout / 1000} s (or the browser exited); see ${out}`);
	process.exit(2);
}
writeFileSync(join(out, "result.json"), body);
const res = JSON.parse(body);
if (res.error) {
	console.log(`FAIL the page: ${res.error}`);
	process.exit(1);
}
for (const [name, s] of Object.entries(res.steps)) writeFileSync(join(out, `${name}.txt`), s.stdout + (s.stderr ? `\n--- stderr\n${s.stderr}` : ""));
let fails = 0;
const report = (name, ok, detail) => {
	console.log(`${ok === null ? "SKIP" : ok ? "PASS" : "FAIL"} ${name}  ${detail}`);
	if (ok === false) fails++;
};
console.log(`WebGPU: ${JSON.stringify(res.webgpu)}; ${res.worker ? "worker" : "inline"} mode; vk ready: ${res.ready}`);
const lazy = res.statusAtBoot?.state === "idle";
report("lazy", lazy, `renderer status at boot ${res.statusAtBoot?.state} (idle: nothing loaded before the guest's first Vulkan instance)`);
const h = res.steps.hello;
if (h) {
	let j = null;
	try {
		j = JSON.parse(h.stdout.slice(0, h.stdout.lastIndexOf("}") + 1));
	} catch {}
	report("hello", h.exitCode === 0 && j?.r === 1 && !!j.formats, j ? `version ${j.version}, adapter ${JSON.stringify(j.adapter)}, ${Object.keys(j.formats ?? {}).length} formats, ${j.features?.length} features; renderer ${res.statusAfterHello?.state} after it`
		: `exit ${h.exitCode}; ${(h.stdout + h.stderr).slice(0, 400)}`);
}
const a = res.steps.vulkaninfo;
if (a) {
	const names = [...a.stdout.matchAll(/deviceName\s*=\s*(.*)/g)].map((m) => m[1].trim());
	const re = new RegExp(opt("--device-re", "kw"), "i");
	const api = /apiVersion\s*=\s*(.*)/.exec(a.stdout)?.[1]?.trim() ?? "?";
	report("vulkaninfo", a.exitCode === 0 && names.some((n) => re.test(n)), `exit ${a.exitCode}; devices ${JSON.stringify(names)}; apiVersion ${api}; ${(a.ms / 1000).toFixed(1)} s`);
	if (a.exitCode !== 0 || !names.length) console.log(a.stdout.split("\n").slice(-25).join("\n"));
}
for (const [name, s] of Object.entries(res.steps).filter(([n]) => n.startsWith("test-"))) {
	report(name.slice(5), s.exitCode === 0, `exit ${s.exitCode ?? s.signal}; ${(s.ms / 1000).toFixed(1)} s; ${s.stdout.trim().split("\n").slice(-3).join(" | ")}`);
}
const c = res.steps.vkcube;
if (c) report("vkcube", c.exitCode === 77 ? null : c.exitCode === 0, `exit ${c.exitCode}; ${c.stdout.trim().split("\n").slice(-3).join(" | ")}`);
if (res.steps["vkcube-shot"]) {
	// weston's screenshot (640x480, vkcube's 300x300 window in it): the cube is there when the
	// window has many colours and the LunarG texture's teal (green and blue well above red; with
	// red and blue swapped it would be olive)
	const file = join(out, "vkcube.png");
	let detail = "no screenshot", ok = false;
	if (existsSync(file)) {
		const img = decodePng(readFileSync(file));
		const colours = new Set();
		let teal = 0, olive = 0;
		for (let i = 0; i < img.width * img.height; i++) {
			const r = img.rgb[i * 3], g = img.rgb[i * 3 + 1], b = img.rgb[i * 3 + 2];
			colours.add((r << 16) | (g << 8) | b);
			if (g > r + 30 && b > r + 30) teal++;
			if (g > b + 30 && r > b + 30) olive++;
		}
		ok = colours.size > 500 && teal > 500 && teal > 4 * olive;
		detail = `${img.width}x${img.height}, ${colours.size} colours, ${teal} teal and ${olive} olive pixels (${file})`;
	}
	report("vkcube frame", ok, detail);
}
if (res.wland) {
	const wl = res.wland, good = (f) => !!f && f.colours > 500 && f.teal > 200 && f.teal > 4 * f.olive;
	const fr = (f) => (f ? `${f.width}x${f.height} ${f.colours} colours, ${f.teal} teal, ${f.olive} olive` : "no frame");
	console.log(`wland: relay ${wl.relay?.path} (${(wl.relay?.version ?? "").replace(/\n/g, "; ")})${wl.error ? `; error ${wl.error}` : ""}${wl.errors?.length ? `; engine errors ${JSON.stringify(wl.errors)}` : ""}`);
	if (wl.noExternal) report("wland external buffers", null, wl.noExternal);
	for (const [name, p] of Object.entries(wl.phases ?? {})) {
		if (name === "warmup") continue;
		const ext = name.startsWith("ext");
		const line = `${p.fps?.toFixed(1)} frames/s (${p.msPerFrame?.toFixed(1)} ms/frame), ${p.bytesReadPerFrame?.toFixed(0)} bytes read back/frame, ${p.presents} presents, ` +
			`${p.externalPresents} external, ${p.externalCommits} external and ${p.shmCommits} shm commits, ${p.nullResolves} null resolves, resolve ${p.resolveMs?.toFixed(2)} ms; ` +
			`externalBuffers ${p.externalBuffers}; ref ${JSON.stringify(p.lastRef)}; frame ${fr(p.frame)}; ICD: ${p.icd?.replace(/\n/g, " | ")}`;
		const ok = ext
			? p.presents > 10 && p.externalPresents === p.presents && p.bytesReadPerFrame === 0 && p.externalCommits > 0 && p.nullResolves === 0 && p.externalBuffers === true &&
				p.lastRef?.width === p.width && p.lastRef?.height === p.height && good(p.frame)
			// (bytes are counted at the reply, presents at the request: the window's edges differ by a frame)
			: p.presents > 10 && p.externalPresents === 0 && p.bytesReadPerFrame >= 0.9 * p.width * p.height * 4 && p.shmCommits > 0 && good(p.frame);
		report(`wland ${name}`, ok, line);
	}
	const f = wl.fallback;
	if (f) report("wland fallback (no global: wl_shm)", f.exit === 0 && f.externalBuffers === false && f.shmCommits > 0 && f.externalCommits === 0 && f.bytesRead > 0 && good(f.frame),
		`exit ${f.exit}; externalBuffers ${f.externalBuffers}; ${f.presents} presents, ${f.shmCommits} shm and ${f.externalCommits} external commits, ${f.bytesRead} bytes read back; frame ${fr(f.frame)}; ${f.out}`);
	else if (!wl.error) report("wland fallback", false, "did not run");
	if (wl.error) report("wland", false, wl.error);
}
if (res.snapshot) {
	const sn = res.snapshot, v = res.steps["snap-vkcube"], cmp = res.steps["snap-compute"], vi = res.steps["snap-vulkaninfo"];
	report("snapshot", !sn.error && v?.exitCode === 0 && cmp?.exitCode === 0 && /kwvk/.test(vi?.stdout ?? ""),
		sn.error ?? `attempts ${JSON.stringify(sn.attempts)}, restored in ${sn.restoreMs} ms (renderer ${sn.statusAfterRestore?.state}); ${v?.stdout.trim().split("\n").join(" | ")}; vk-compute after: ${cmp?.stdout.trim().split("\n").pop()}; ${vi?.stdout.trim().split("\n").join(" ")}`);
}
if (res.lose) {
	const l = res.lose, v = res.steps["lose-vkcube"], cmp = res.steps["lose-compute"], vi = res.steps["lose-vulkaninfo"];
	report("lose", l.hadDevice && l.after?.status?.state === "lost" && l.after?.losses === 1 && v?.exitCode === 0 && cmp?.exitCode === 0 && /kwvk/.test(vi?.stdout ?? "") && l.end?.status?.state === "ready",
		`device ${l.hadDevice ? "destroyed" : "missing"}; status ${l.before?.status?.state} -> ${l.after?.status?.state} (losses ${l.after?.losses}) -> ${l.end?.status?.state}; ${v?.stdout.trim().split("\n").join(" | ")}; vk-compute after: ${cmp?.stdout.trim().split("\n").pop()}; ${vi?.stdout.trim().split("\n").join(" ")}`);
}
if (res.cpus !== undefined) console.log(`CPUs: ${JSON.stringify(res.cpus)}`);
if (res.steps.cmd) console.log(`--cmd (exit ${res.steps.cmd.exitCode}):\n${res.steps.cmd.stdout}${res.steps.cmd.stderr}`);
console.log(`renderer status: ${JSON.stringify(res.status)}; stats ${JSON.stringify(res.stats)}; ${((Date.now() - t0) / 1000).toFixed(0)} s in the browser; output in ${out}`);
process.exit(fails ? 1 : 0);

/** An 8-bit RGB or RGBA PNG (what weston-screenshooter writes) as packed RGB. */
function decodePng(buf) {
	let p = 8, width = 0, height = 0, type = 0;
	const idat = [];
	while (p < buf.length) {
		const len = buf.readUInt32BE(p), kind = buf.toString("latin1", p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
		if (kind === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			type = data[9];
			if (data[8] !== 8 || (type !== 2 && type !== 6)) throw new Error(`PNG: depth ${data[8]} type ${type}`);
		} else if (kind === "IDAT") idat.push(data);
		p += 12 + len;
	}
	const bpp = type === 6 ? 4 : 3, stride = width * bpp, raw = inflateSync(Buffer.concat(idat));
	const px = Buffer.alloc(stride * height), rgb = Buffer.alloc(width * height * 3);
	for (let y = 0; y < height; y++) {
		const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		for (let x = 0; x < stride; x++) {
			const a = x >= bpp ? px[y * stride + x - bpp] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
			const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
			const pred = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0;
			px[y * stride + x] = (line[x] + pred) & 255;
		}
	}
	for (let i = 0; i < width * height; i++) px.copy(rgb, i * 3, i * bpp, i * bpp + 3);
	return { width, height, rgb };
}
