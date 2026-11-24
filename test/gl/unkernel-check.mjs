#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Guest GL end to end in headless Chromium: unkernel (the built package,
// dist/) boots Debian with the prepared data disk (debian-disk.mjs: Mesa
// from apt, made once) and createKernel({ gl: true }), whose wasm renderer
// runs on the page's WebGL2 (ANGLE on SwiftShader here, software: the virgl
// numbers are a floor) and whose forwarder the SDK starts in the guest. The
// page (unkernel-page.js) runs, in the guest:
//
//   a  eglinfo -B -p surfaceless on virpipe: the renderer must be virgl
//   b  kwgl-state.c (built for the guest by build-guest-state.sh): seven
//      clients with different GL state interleaved on the page's renderer,
//      whose 60 frame checksums must equal those of each client run alone
//      (as vtest-check.sh state); with --state-ref FILE (a state.txt of
//      `test/gl/bridge-check.sh --wasm --keep state` on this host) they
//      must also equal the host's; the same clients on llvmpipe are
//      reported, not judged (another rasterizer rounds differently)
//   c  glmark2-es2 under Xvfb, the same scenes at the same size, on
//      llvmpipe and on virgl: FPS of each (default 640x480; build, texture,
//      shading=phong, jellyfish and desktop, 10 s each; --scenes takes a
//      comma-separated list of glmark2 -b values)
//
//   node test/gl/unkernel-check.mjs [--worker] [--size WxH] [--scenes LIST] [--skip a,b,c]
//        [--state-ref FILE] [--out DIR] [--browser BIN] [--gl-flags FLAGS] [--timeout S] [--no-build]
//   node test/gl/unkernel-check.mjs --drm [--resize WxH] [--eager | --fail [--glfail module]] ...
//
// --drm checks the virtio-gpu path instead (drm-page.js): a kernel with
// kwvirtio (--kernel, default $KW_BUILD/bundle/unkernel.wasm) and
// createKernel({ gl: true, gpu: true }), and in the guest, with no GL
// environment variables:
//
//   a  eglinfo -B on the gbm and surfaceless platforms: the renderer must
//      be virgl, through /dev/dri; libdrm's drmdevice (drmGetDevices2, as
//      Mesa's loader enumerates) must list the card
//   b  kmscube (GBM buffers page-flipped with KMS): its frames must reach
//      the page's canvas (drawn from the renderer's texture, no readback)
//      and equal the scanout read back in the same task, and not be flat
//   c  glmark2-es2-drm against glmark2-es2 under Xvfb on virpipe (the vtest
//      path), the same scenes (default build, texture, shading=phong, 5 s
//      each) at the display's size (--size), on screen (DRM page flips are
//      paced by virtio-gpu's 60 Hz vblank timer; vtest reads each frame
//      back for Xvfb) and with --off-screen: FPS of each, reported
//   d  kwgl-state on the DRM path: interleaved against each client alone,
//      and against the same clients on the vtest path (the same renderer)
//   e  test/gpu/prime.c as the default user: a resource exported as a dmabuf
//      and imported by a second opener names the same host resource
//      (DRM_IOCTL_VIRTGPU_RESOURCE_INFO), and the host finds its texture
//      (GlHost.gpu.texture()) with the pattern the importer uploaded
//   g  window images: test/gpu/window-image.c (built for the guest as
//      kwgl-state is) draws a picture with translucent quadrants into GBM
//      window surfaces (EGL, Mesa's virgl) of ARGB8888, XRGB8888 and, where
//      Mesa has the configs, ABGR8888 and XBGR8888; the page takes each
//      front buffer's resource as an ImageBitmap (GlHost.gpu.image()) and
//      composites it over black and over white: alpha premultiplied, the
//      top row at the top (flipY: at the bottom), X formats opaque, a
//      cropped rectangle; null for unknown ids; the cost per image at
//      800x600 and 1920x1080 (and against readPixels, reported); then
//      kmscube's frames on the page's canvas, drawn plain and over white,
//      must equal the scanout read back while images are taken between
//      its presents (skip=b2 leaves that part out)
//   h  test/gpu/int-attrib.c (built as kwgl-state is): a GLES 3 draw with
//      integer vertex attributes (instanced, as Firefox's WebRender draws)
//      into an RGBA8 and an RGBA8UI colour buffer, read back: the pixels
//      must be right and the guest's kernel must log no failed virtio-gpu
//      command (WebGL refuses a draw whose shader input types differ from
//      the attributes', which put the renderer's context in error)
//   m  test/gpu/msaa.c (built as kwgl-state is): 4 samples for each colour
//      and depth format OpenGL ES 3.0 requires (what Chromium's ANGLE needs
//      before it offers ES 3.0), and a 4-sample draw with a depth test
//      resolved by glBlitFramebuffer: right colours, partly covered pixels
//      on the triangle's edge, no failed virtio-gpu command
//   t  test/gpu/feedback.c (built as kwgl-state is): draws with textures
//      that the shaders never sample left on used units (as Firefox's
//      WebRender leaves them): one attached to the draw framebuffer (a
//      feedback loop), an integer one on a float sampler and a float one
//      on an integer sampler, then draws that sample the units again (the
//      real textures back once legal), each read back: the colours must
//      be right and no virtio-gpu command may fail (WebGL refuses such a
//      draw)
//   r  a display size change on the running machine (vm.updateDisplaySize()
//      to --resize WxH, default 960x540): test/gpu/kms-hotplug.c (built
//      here) reads the drm uevent with HOTPLUG=1 from netlink and probes
//      the new preferred mode; kmscube started afterwards puts that mode on
//      the scanout, and the display's mode and the page's canvas follow;
//      glmark2-es2-drm's surface has that size; modetest -c is reported
//
// --lose adds step l: glmark2-es2-drm twice (both without a failed
// virtio-gpu command), then the renderer's WebGL2 context lost
// (WEBGL_lose_context) four times: during glmark2-es2-drm and restored;
// during kmscube and a vtest glmark2-es2 and restored; during
// glmark2-es2-drm and not restored; during kmscube with getContext giving
// no WebGL2 for a while. Each time the programs running at the loss must
// end and a kmscube started after it must render (its frames on the
// canvas equal the scanout read back, no failed command in the guest's
// kernel); after the first, a dumb-buffer KMS client (test/gpu/kms-dumb.c)
// must show its picture and a vtest client must get virgl.
//
// --snapshot adds step s (the Debian disk's overlay then lives in the
// page's IndexedDB, so that the machine can be snapshotted): prime.c leaves
// its importer's DRM file with a 3D context that has no resource and never
// submitted (a Wayland relay between clients); the snapshot must be taken
// (with stop) and restored in the same page, where the importer imports
// and uploads a new buffer through that context: its picture must reach
// GlHost.gpu.image() with no renderer error
//
// and reports the renderer's status (vm.gl.status) and when the page
// fetched virgl.mjs and virgl.wasm: by default the renderer loads on the
// guest's first GL use, so neither is fetched by the time gl.ready
// resolves (judged as "lazy"); --eager loads it before the boot
// (createKernel({ gl: { eager: true } })). --fail checks the guest without
// a renderer instead (step f; skips a to e unless --skip says otherwise):
// with --glfail module the module URL does not exist, so the renderer
// fails at the guest's first GL use (the device offered 3D); with
// --gl-flags "--disable-webgl" (or another browser without WebGL2) the
// probe before the boot finds no WebGL2 context and the device is 2D.
// Either way it reports eglinfo on gbm and surfaceless, kmscube and the
// kernel's messages, and judges test/gpu/kms-dumb.c (a dumb-buffer KMS
// client, built here) and that GL programs did not get virgl.
// --gl-delay S serves virgl.mjs S seconds late (a slow network), so the
// first GL program's capset request waits that long for the renderer.
//
// Builds first, each skipped when done: dist (pnpm build, unless
// --no-build), the disk ($KW_BUILD/gl/debian-gl.img), kwgl-state for the
// guest. Exit 0 when every step run passed, 1 on a failure, 2 when it could
// not run. Writes the steps' output, the frames (PPM), the page's log and
// the guest's console to --out (default a new /tmp/kwgl.* directory,
// printed). The images are served read-only with Range support; the
// guest's writes stay in the page's memory.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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
const timeout = Number(opt("--timeout", "3600")) * 1000;
const browser = opt("--browser", process.env.CHROMIUM || "chromium-headless");
const out = resolve(opt("--out", "") || mkdtempSync("/tmp/kwgl."));
mkdirSync(out, { recursive: true });
const drm = has("--drm");
const kernelFile = resolve(opt("--kernel", join(build, "bundle/unkernel.wasm")));
const disk = join(build, "gl/debian-gl.img");
const distro = join(build, "distro/debian.erofs");
const stateBin = join(build, "gl/kwgl-state-aarch64");
const primeBin = join(out, "prime");
const windowBin = join(out, "window-image");
const kmsDumbBin = join(out, "kms-dumb");
const intAttribBin = join(out, "int-attrib");
const msaaBin = join(out, "msaa");
const feedbackBin = join(out, "feedback");

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
if (!has("--no-build")) step("pnpm build", "pnpm", ["build"]);
if (!existsSync(join(root, "dist/web.mjs")) || !existsSync(join(root, "dist/virgl.wasm"))) {
	console.error("no dist/web.mjs or dist/virgl.wasm (pnpm build)");
	process.exit(2);
}
step("the prepared disk", process.execPath, [join(here, "debian-disk.mjs"), "--out", disk]);
if (!existsSync(stateBin)) step("kwgl-state for the guest", join(here, "build-guest-state.sh"), [stateBin]);
if (drm && !existsSync(kernelFile)) {
	console.error(`no ${kernelFile} (a bundle with kwvirtio; --kernel)`);
	process.exit(2);
}
if (drm) step("test/gpu/prime.c for the guest", process.env.ZIG ?? "zig", ["cc", "-target", "aarch64-linux-musl", "-mcpu=generic", "-static", "-O2", "-s", "-o", primeBin, join(root, "test/gpu/prime.c")]);
if (drm) step("test/gpu/window-image.c for the guest", join(here, "build-guest-state.sh"), [windowBin, join(root, "test/gpu/window-image.c")]);
if (drm) step("test/gpu/int-attrib.c for the guest", join(here, "build-guest-state.sh"), [intAttribBin, join(root, "test/gpu/int-attrib.c")]);
if (drm) step("test/gpu/msaa.c for the guest", join(here, "build-guest-state.sh"), [msaaBin, join(root, "test/gpu/msaa.c")]);
if (drm) step("test/gpu/feedback.c for the guest", join(here, "build-guest-state.sh"), [feedbackBin, join(root, "test/gpu/feedback.c")]);
if (drm) step("test/gpu/kms-hotplug.c for the guest", process.env.ZIG ?? "zig", ["cc", "-target", "aarch64-linux-musl", "-mcpu=generic", "-static", "-O2", "-s", "-o", join(out, "kms-hotplug"), join(root, "test/gpu/kms-hotplug.c")]);
if (drm && (has("--fail") || has("--lose"))) step("test/gpu/kms-dumb.c for the guest", process.env.ZIG ?? "zig", ["cc", "-target", "aarch64-linux-musl", "-mcpu=generic", "-static", "-O2", "-s", "-o", kmsDumbBin, join(root, "test/gpu/kms-dumb.c")]);

const types = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm" };
let resolveResult;
const result = new Promise((r) => (resolveResult = r));
const pageLog = join(out, "page.log"), consoleLog = join(out, "console.log");
writeFileSync(pageLog, "");
writeFileSync(consoleLog, "");

// A file with Range support (one range; HttpBase asks for nothing else).
function sendFile(req, res, file, type) {
	const st = statSync(file);
	const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
	const h = { "content-type": type, "accept-ranges": "bytes", etag, "cache-control": "no-cache" };
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
	if (p === "/img/debian-gl.img") return sendFile(req, res, disk, "application/octet-stream");
	if (p === "/img/unkernel.wasm" && drm) return sendFile(req, res, kernelFile, "application/wasm");
	if (p === "/files/kwgl-state") return sendFile(req, res, stateBin, "application/octet-stream");
	if (p === "/files/prime" && drm) return sendFile(req, res, primeBin, "application/octet-stream");
	if (p === "/files/window-image" && drm) return sendFile(req, res, windowBin, "application/octet-stream");
	if (p === "/files/int-attrib" && drm) return sendFile(req, res, intAttribBin, "application/octet-stream");
	if (p === "/files/msaa" && drm) return sendFile(req, res, msaaBin, "application/octet-stream");
	if (p === "/files/feedback" && drm) return sendFile(req, res, feedbackBin, "application/octet-stream");
	if (p === "/files/kms-dumb" && drm && existsSync(kmsDumbBin)) return sendFile(req, res, kmsDumbBin, "application/octet-stream");
	if (p === "/files/kms-hotplug" && drm) return sendFile(req, res, join(out, "kms-hotplug"), "application/octet-stream");
	// --gl-delay: the renderer's module, late (/slow/virgl.mjs; virgl.wasm next to it on time)
	if (p === "/slow/virgl.mjs" || p === "/slow/virgl.wasm") {
		if (p.endsWith(".mjs")) await new Promise((r) => setTimeout(r, Number(opt("--gl-delay", "0")) * 1000));
		return sendFile(req, res, join(root, "dist", p.slice(6)), types[p.slice(p.lastIndexOf("."))]);
	}
	for (const [prefix, dir] of [["/dist/", join(root, "dist")], ["/test/", here]]) {
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
for (const k of ["size", "resize", "scenes", "skip", "cmd", "glfail"]) if (opt(`--${k}`)) query.set(k, opt(`--${k}`));
if (has("--eager")) query.set("eager", "1");
if (has("--snapshot")) query.set("snap", "1");
if (has("--lose")) query.set("lose", "1");
if (opt("--gl-delay")) query.set("glmodule", "/slow/virgl.mjs");
if (has("--fail")) {
	query.set("fail", "1");
	if (!opt("--skip")) query.set("skip", "a,b,c,d,e,g,h,t");
}
const url = `http://127.0.0.1:${server.address().port}/test/${drm ? "drm" : "unkernel"}.html?${query}`;
console.log(`== ${url}\n   output in ${out}`);

const t0 = Date.now();
// The WebGL2 here: ANGLE on SwiftShader; --gl-flags replaces these (e.g. "--use-angle=vulkan" or "" on a host with a GPU).
const glFlags = opt("--gl-flags", "--use-angle=swiftshader --enable-unsafe-swiftshader").split(" ").filter(Boolean);
const chrome = spawn(browser, [
	"--no-sandbox", "--headless", ...glFlags,
	"--no-first-run", "--disable-gpu-sandbox", `--user-data-dir=${join(out, "chromium-profile")}`,
	url,
], { stdio: ["ignore", "ignore", "pipe"] });
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
	console.log(`${ok ? "PASS" : "FAIL"} ${name}  ${detail}`);
	if (!ok) fails++;
};
if (drm) {
	judgeDrm(res);
	console.log(`stats: ${JSON.stringify(res.gl)}; display ${JSON.stringify(res.display)}; ${((Date.now() - t0) / 1000).toFixed(0)} s in the browser; output in ${out}`);
	process.exit(fails ? 1 : 0);
}
console.log(`renderer: ${res.renderer} (gl ready ${res.readyS} s after the page started; ${res.worker ? "worker" : "inline"} mode)`);

const e = res.steps.eglinfo;
if (e) {
	const es = /OpenGL ES profile renderer: (.*)/.exec(e.stdout)?.[1] ?? "?";
	const ver = /OpenGL ES profile version: (.*)/.exec(e.stdout)?.[1] ?? "?";
	report("eglinfo", e.exitCode === 0 && /^virgl \(/.test(es), `GLES renderer "${es}", version "${ver}" (${(e.ms / 1000).toFixed(1)} s)`);
}

function lines(s) {
	return s.stdout.split("\n").filter((l) => /^[a-z.0-9]+ \d+ [0-9a-f]{16}$/.test(l) || /samples-passed/.test(l)).sort();
}
if (res.steps.state) {
	const alone = lines(res.steps["state-alone"]), mixed = lines(res.steps.state);
	const sums = alone.filter((l) => / [0-9a-f]{16}$/.test(l));
	const per = new Map();
	for (const l of sums) {
		const [v, , sum] = l.split(" ");
		if (!per.has(v)) per.set(v, new Set());
		per.get(v).add(sum);
	}
	const flat = [...per].filter(([, s]) => s.size < 2).map(([v]) => v);
	const bad = mixed.filter((l, i) => l !== alone[i]).length + Math.max(0, alone.length - mixed.length);
	const samples = mixed.some((l) => /samples-passed=[^0]/.test(l));
	let detail = `${bad} of ${sums.length} frames differ from the clients alone`;
	let ok = sums.length === 60 && !flat.length && bad === 0 && alone.length === mixed.length && !samples && res.steps.state.exitCode === 0;
	if (flat.length) detail += `; frames that do not change: ${flat.join(" ")}`;
	const refFile = opt("--state-ref");
	if (refFile) {
		const ref = readFileSync(refFile, "utf8").split("\n").filter((l) => / [0-9a-f]{16}$/.test(l)).sort();
		const diff = ref.filter((l, i) => l !== sums[i]).length;
		detail += `; ${diff} of ${ref.length} differ from the host's (${refFile})`;
		ok &&= diff === 0 && ref.length === sums.length;
	}
	const llvm = lines(res.steps["state-llvmpipe"]).filter((l) => / [0-9a-f]{16}$/.test(l));
	const llvmDiff = llvm.filter((l, i) => l !== sums[i]).length;
	detail += `; llvmpipe in the guest: ${llvmDiff} of ${llvm.length} differ (rounding; not judged); ${(res.steps.state.ms / 1000).toFixed(1)} s virgl, ${(res.steps["state-llvmpipe"].ms / 1000).toFixed(1)} s llvmpipe`;
	report("state", ok, detail);
}

/** The --drm steps (drm-page.js). */
function judgeDrm(res) {
	console.log(`renderer: ${res.renderer ?? `none (gl.ready rejected: ${res.readyError})`} (booted ${res.bootS} s, gl ready ${res.readyS} s after the page started; option ${JSON.stringify(res.glOption)})`);
	const st = res.status, first = res.fetches?.[0];
	console.log(`renderer status: at boot ${res.statusAtBoot?.state}, at gl.ready ${res.statusAtReady?.state}, at the end ${st?.state}` +
		`${st?.startedAt != null ? `; load started ${(st.startedAt / 1000).toFixed(2)} s after the page started, took ${(st.loadMs / 1000).toFixed(2)} s` : ""}` +
		`${st?.error ? `; error: ${st.error}` : ""}; virgl fetches: at boot ${res.fetchesAtBoot?.length ?? "?"}, at gl.ready ${res.fetchesAtReady?.length ?? "?"}, in all ${JSON.stringify(res.fetches)}`);
	const load = res.statusAtLoad ?? st;
	if (res.glOption === true && !has("--fail"))
		report("lazy", res.statusAtBoot?.state === "idle" && res.statusAtReady?.state === "idle" && !res.fetchesAtReady?.length && (!first || first.startMs >= load.startedAt),
			`no renderer fetch before the guest's first GL use (first fetch ${first ? `${first.startS} s, the load started ${(load.startedAt / 1000).toFixed(2)} s` : "never"})`);
	if (res.glOption?.eager) report("eager", res.statusAtReady?.state === "ready" && !!res.fetchesAtBoot?.length, `renderer ready at gl.ready, ${(st.loadMs / 1000).toFixed(2)} s to load, fetched at ${res.fetches?.map((f) => `${f.file} ${f.startS} s`).join(", ")}`);
	if (res.steps["fail-kms-dumb"]) {
		const kd = res.steps["fail-kms-dumb"];
		report("fail: kms-dumb (2D KMS)", kd.exitCode === 0 && /kms-dumb: ready \d+x\d+/.test(kd.stdout), kd.stdout.trim().split("\n").slice(-3).join("; "));
		for (const n of ["fail-eglinfo-gbm", "fail-eglinfo-surfaceless"]) {
			const e = res.steps[n];
			const r = /OpenGL ES profile renderer: (.*)/.exec(e.stdout)?.[1] ?? "?";
			report(n.replace("fail-", "fail: "), !/^virgl/.test(r), `exit ${e.exitCode}, GLES renderer "${r}"`);
			console.log(`--- ${n}:\n${e.stdout.trim()}`);
		}
		console.log(`--- fail-kmscube (exit ${res.steps["fail-kmscube"].exitCode}):\n${res.steps["fail-kmscube"].stdout.trim()}`);
		console.log(`--- fail-dmesg:\n${res.steps["fail-dmesg"].stdout.trim()}`);
		console.log(`3D on the device: ${res.hasGpu3d}`);
	}
	if (res.steps.cmd) console.log(`--cmd (exit ${res.steps.cmd.exitCode}):\n${res.steps.cmd.stdout}${res.steps.cmd.stderr}`);
	const dd = res.steps.drmdevice;
	if (dd) report("drmdevice", dd.exitCode === 0 && /renderD128/.test(dd.stdout) && /platform/i.test(dd.stdout),
		dd.stdout.split("\n").filter((l) => /bustype|platform|fullname|compatible|available_nodes|nodes\[|\/dev\/dri/i.test(l)).map((l) => l.trim()).slice(0, 12).join("; ") || dd.stdout.slice(0, 300));
	for (const p of ["gbm", "surfaceless"]) {
		const e = res.steps[`eglinfo-${p}`];
		if (!e) continue;
		const r = /OpenGL ES profile renderer: (.*)/.exec(e.stdout)?.[1] ?? "?";
		const v = /OpenGL ES profile version: (.*)/.exec(e.stdout)?.[1] ?? "?";
		report(`eglinfo -p ${p}`, e.exitCode === 0 && /^virgl \(/.test(r), `GLES renderer "${r}", version "${v}" (${(e.ms / 1000).toFixed(1)} s)`);
	}
	const k = res.steps.kmscube;
	if (k) {
		const frames = res.frames ?? [];
		const fpsLine = /Rendered.*|[\d.]+ fps.*/i.exec(k.stdout)?.[0] ?? "";
		const good = frames.filter((f) => f.drew && f.differFromReadback === 0 && f.colours > 16);
		const moving = new Set(frames.map((f) => f.checksum)).size === frames.length;
		report("kmscube", k.exitCode === 0 && frames.length >= 2 && good.length === frames.length && moving,
			`${frames.map((f) => `frame ${f.seq} ${f.size}: canvas checksum ${f.checksum} (${f.colours} colours, centre ${f.center}, corner ${f.corner}), ${f.differFromReadback} pixels differ from the readback`).join("; ") || "no frames on the canvas"}; ` +
			`${fpsLine || k.stdout.trim().split("\n").slice(-2).join(" | ")}; host: ${JSON.stringify(res.kmsStats)} (${(k.ms / 1000).toFixed(1)} s)`);
	}
	for (const suffix of ["", "-offscreen"]) {
		const gd = res.steps[`glmark2-drm${suffix}`], gv = res.steps[`glmark2-vtest${suffix}`];
		if (!gd && !gv) continue;
		const d = fps(gd), v = fps(gv);
		const f = (x) => (x ? `${(1000 / x.ms).toFixed(1)} FPS (${x.ms} ms)` : "?");
		const rows = d.map((x, i) => `${x.scene} ${x.opts}: DRM ${f(x)}, vtest ${f(v[i])}`);
		const renderers = [gd, gv].map((s) => /GL_RENDERER:\s*(.*)/.exec(s?.stdout ?? "")?.[1]?.trim() ?? "?");
		report(`glmark2${suffix ? " off screen" : " on screen"}`, d.length > 0 && d.length === v.length && d.every((x) => x.fps > 0) && renderers.every((r) => /^virgl/.test(r)),
			`${rows.join("; ") || "no FPS lines"} (renderers: ${renderers.join(" | ")})`);
	}
	const pr = res.steps.prime;
	if (pr) {
		const p = res.prime;
		// 40 * 4 red, 8 * 4 green, 0xc0 blue (prime.c's pattern)
		const ok = pr.exitCode === 0 && p?.texture && p.width === 64 && p.height === 64 && p.pixel?.join() === "160,32,192";
		report("prime", ok, `${pr.stdout.trim().split("\n").join("; ")}; host: ${JSON.stringify(p)}`);
	}
	const sn = res.snapshot;
	if (sn) {
		// prime.c's pattern at (40, 8): 160 red, 32 green, 0xc0 blue, opaque
		const ok = !sn.error && sn.attempts.at(-1) === "taken" && sn.pixel?.join() === "160,32,192,255" && sn.gpu?.errors === 0 && !!sn.adopted;
		report("snapshot with an idle 3D context", ok, `${sn.error ?? ""} attempts ${JSON.stringify(sn.attempts)}; restored in ${sn.restoreMs} ms; ` +
			`${JSON.stringify(sn.adopted)}; image ${sn.size} pixel (40, 8) ${JSON.stringify(sn.pixel)}; renderer after the restore ${JSON.stringify(sn.gpu)}; ` +
			`prime: ${(sn.before ?? "").trim().split("\n").join(" | ")} || ${(sn.after ?? "").trim().split("\n").join(" | ")}`);
	}
	if (res.resize) {
		const r = res.resize, hp = r.hotplug?.stdout ?? "";
		const m = /hotplug 1: preferred (\d+)x(\d+)/.exec(hp);
		report("resize: hotplug", !!m && `${m[1]}x${m[2]}` === r.size && r.hotplug?.end?.code === 0, hp.trim().split("\n").join("; "));
		const k = r.kmscube ?? {};
		report("resize: kmscube", k.scanout === r.size && k.mode === r.size && k.canvas === r.size, `${JSON.stringify(k)}, want ${r.size}`);
		const g = res.steps["resize-glmark2"];
		report("resize: glmark2-es2-drm", g?.exitCode === 0 && new RegExp(`Surface Size:\\s+${r.size}`).test(g.stdout), (g?.stdout ?? "").trim().split("\n").join("; "));
		console.log(`--- resize-modetest:\n${res.steps["resize-modetest"]?.stdout.trim()}`);
	}
	if (res.lose) {
		const runs = [1, 2].map((i) => res.steps[`lose-run${i}`]);
		for (const [i, r] of runs.entries()) console.log(`--- lose-run${i + 1} (exit ${r?.exitCode}, ${((r?.ms ?? 0) / 1000).toFixed(1)} s):\n${r?.stdout.trim()}`);
		const errs = (s) => Number(/kernel errors (\d+)/.exec(s ?? "")?.[1] ?? -1);
		report("second run", errs(runs[0]?.stdout) === 0 && errs(runs[1]?.stdout) === 0 && /Score/.test(runs[1]?.stdout ?? ""), `kernel errors after run 1: ${errs(runs[0]?.stdout)}, after run 2: ${errs(runs[1]?.stdout)}`);
		// a program running at a loss ends (whatever its exit) instead of hanging
		const ended = (r) => !!r && r.ms < 120_000;
		const secs = (r) => (r ? `${(r.ms / 1000).toFixed(1)} s, exit ${r.exitCode ?? r.signal}: ${r.tail}` : "?");
		// a program started after it renders: its frame on the page's canvas, as read back, not flat, no failed command
		const kmsOk = (k) => !!k?.frame && k.frame.colours > 16 && k.frame.differFromReadback === 0 && errs(k.tail) === 0 && k.after?.contextLost === false;
		const kmsSay = (k) => `new kmscube: ${k?.frame ? `seq ${k.frame.seq} ${k.frame.size} ${k.frame.colours} colours, ${k.frame.differFromReadback} pixels differ from the readback` : "no frame"}, ` +
			`${k?.presents} presents, ${k?.rendererErrors} renderer errors, ${k?.tail}`;
		const [p1, p2, p3, p4] = res.lose.phases ?? [];
		report("loss 1 (restored), running glmark2-es2-drm", p1?.lost && p1.whileLost?.contextLost && p1.whileLost.state === "lost" && ended(p1.running) && kmsOk(p1.kms),
			`while lost ${JSON.stringify(p1?.whileLost)}; after the restore ${JSON.stringify(p1?.restored)}; the run at the loss: ${secs(p1?.running)}; ${kmsSay(p1?.kms)}`);
		report("loss 1: dumb-buffer KMS and a vtest client after it", !!p1?.dumb?.pic && p1.dumb.exitCode === 0 && /virgl/.test(p1?.vtest?.tail ?? ""),
			`kms-dumb: ${JSON.stringify(p1?.dumb?.pic)} (${p1?.dumb?.tail}); vtest: ${p1?.vtest?.tail}`);
		report("loss 2 (restored), running kmscube and a vtest glmark2-es2", p2?.lost && p2.vtestClients > 0 && ended(p2.vtestRunning) && ended(p2.kmsRunning) && kmsOk(p2.kms),
			`${p2?.vtestClients} vtest clients at the loss; vtest glmark2: ${secs(p2?.vtestRunning)}; kmscube: ${secs(p2?.kmsRunning)}; ${kmsSay(p2?.kms)}`);
		report("loss 3 (not restored)", p3?.lost && ended(p3.running) && kmsOk(p3.kms), `the run at the loss: ${secs(p3?.running)}; ${kmsSay(p3?.kms)}`);
		report("loss 4 (no new WebGL2 context for a while)", p4?.lost && ended(p4.kmsRunning) && ended(p4.refused) && p4.whileRefused?.contextLost === true && /no new renderer|no WebGL2/.test(p4.whileRefused?.lastError ?? "") && kmsOk(p4.kms),
			`kmscube at the loss: ${secs(p4?.kmsRunning)}; glmark2 without WebGL2: ${secs(p4?.refused)}, ${JSON.stringify(p4?.whileRefused)}; then ${kmsSay(p4?.kms)}`);
		console.log(`   renderer before ${JSON.stringify(res.lose.before)}; after ${JSON.stringify(res.lose.after)}`);
	}
	const ia = res.steps["int-attrib"];
	if (ia) report("integer attributes", ia.exitCode === 0 && /^ok int$/m.test(ia.stdout) && /^ok uint$/m.test(ia.stdout) && /^kernel errors 0$/m.test(ia.stdout),
		ia.stdout.trim().split("\n").join("; ") + (ia.stderr.trim() ? ` (stderr: ${ia.stderr.trim()})` : ""));
	const ms = res.steps.msaa;
	if (ms) report("multisampling", ms.exitCode === 0 && /^ok samples/m.test(ms.stdout) && /^ok draw/m.test(ms.stdout) && /^kernel errors 0$/m.test(ms.stdout),
		ms.stdout.trim().split("\n").join("; ") + (ms.stderr.trim() ? ` (stderr: ${ms.stderr.trim()})` : ""));
	const fb = res.steps.feedback;
	if (fb) report("texture units", fb.exitCode === 0 && ["into-b-a-bound", "into-a-a-bound", "sampled-a", "into-b-unbound", "types", "sampled-types"].every((n) => new RegExp(`^ok ${n}:`, "m").test(fb.stdout)) && /^kernel errors 0$/m.test(fb.stdout),
		fb.stdout.trim().split("\n").join("; ") + (fb.stderr.trim() ? ` (stderr: ${fb.stderr.trim()})` : ""));
	// A WebGL error drops one call and the guest's context goes on (gl.md, Patches, 19): none is expected.
	// A lost context may raise one (CONTEXT_LOST_WEBGL), so not after --lose.
	const glErrors = res.gl?.gpu?.glErrors;
	if (glErrors !== undefined && !res.lose) report("WebGL errors", glErrors === 0, `${glErrors} calls dropped by WebGL (the [gl] virgl: GL error lines of the log)`);
	const wi = res.windowImages;
	if (wi) {
		const named = Object.entries(wi.bufs).map(([n, b]) => `${n} res ${b.res}${b.texture ? ` (virgl format ${b.texture.format}, yTop ${b.texture.yTop}, alpha ${b.texture.alpha})` : ""}`);
		const checks = wi.checks ?? [];
		const bad = checks.filter((c) => c.bad !== 0);
		const sc = wi.scanout ?? [];
		const scBad = sc.filter((f) => f.differFromReadback !== 0 || f.overWhiteDifferFromReadback !== 0 || f.translucent !== 0 || f.colours <= 16);
		const ok = !wi.error && wi.bufs.argb && wi.bufs.xrgb && checks.length >= 8 && !bad.length && wi.nulls?.unknown && wi.nulls?.empty &&
			(skipped("b2") || (sc.length >= 2 && !scBad.length && !wi.scanoutImages?.bad));
		report("window images", ok, `${wi.error ?? ""}${named.join(", ")}; ${checks.length} images, ${bad.length} wrong` +
			`${bad.length ? ` (${bad.map((c) => `${c.name}: ${c.size}, ${c.bad} pixels off, over black ${JSON.stringify(c.overBlack)}, over white ${JSON.stringify(c.overWhite)}`).join("; ")})` : ""}; ` +
			`nulls ${JSON.stringify(wi.nulls)}; scanout frames while taking images: ${sc.map((f) => `seq ${f.seq} ${f.size} ${f.colours} colours, ${f.differFromReadback} / ${f.overWhiteDifferFromReadback} pixels differ from the readback (plain / over white), ${f.translucent} translucent`).join("; ") || "none"}; ` +
			`images then ${JSON.stringify(wi.scanoutImages)}`);
		for (const c of checks) console.log(`   ${c.name}: ${c.size}, ${c.bad} off; over black ${JSON.stringify(c.overBlack)}, over white ${JSON.stringify(c.overWhite)}`);
		console.log(`   per image (image() + drawImage() + close(); total waits for the GPU): ${JSON.stringify(wi.timing)}`);
	}
	if (res.steps.state) {
		const alone = lines(res.steps["state-alone"]), mixed = lines(res.steps.state), vt = lines(res.steps["state-vtest"]);
		const sums = alone.filter((l) => / [0-9a-f]{16}$/.test(l));
		const bad = mixed.filter((l, i) => l !== alone[i]).length + Math.max(0, alone.length - mixed.length);
		const vbad = vt.filter((l, i) => l !== mixed[i]).length + Math.max(0, mixed.length - vt.length);
		const samples = mixed.some((l) => /samples-passed=[^0]/.test(l));
		report("state", sums.length === 60 && bad === 0 && alone.length === mixed.length && !samples && res.steps.state.exitCode === 0,
			`${bad} of ${sums.length} frames differ from the clients alone; ${vbad} differ from the same clients on the vtest path; ` +
			`${(res.steps.state.ms / 1000).toFixed(1)} s DRM, ${(res.steps["state-vtest"].ms / 1000).toFixed(1)} s vtest`);
	}
}

function skipped(step) {
	return (opt("--skip") ?? "").split(",").includes(step);
}

function fps(s) {
	return [...(s?.stdout ?? "").matchAll(/^\[(\S+)\] (.*?): FPS: (\d+) FrameTime: ([\d.]+) ms/gm)].map((m) => ({ scene: m[1], opts: m[2], fps: Number(m[3]), ms: Number(m[4]) }));
}
const gv = res.steps["glmark2-virgl"], gl = res.steps["glmark2-llvmpipe"];
if (gv || gl) {
	const v = fps(gv), l = fps(gl);
	const ok = v.length > 0 && v.length === l.length && v.every((x) => x.fps > 0) && l.every((x) => x.fps > 0) && /virgl/.test(gv.stdout) && /llvmpipe/.test(gl.stdout);
	// glmark2 rounds FPS to an integer; its mean frame time is exact
	const f = (x) => (x ? `${(1000 / x.ms).toFixed(x.ms > 100 ? 2 : 1)} FPS (${x.ms} ms)` : "?");
	const rows = v.map((x, i) => `${x.scene} ${x.opts}: virgl ${f(x)}, llvmpipe ${f(l[i])}`);
	const renderers = [gv, gl].map((s) => /GL_RENDERER:\s*(.*)/.exec(s?.stdout ?? "")?.[1]?.trim() ?? "?");
	report("glmark2", ok, `${res.size}, ${rows.join("; ") || "no FPS lines"} (renderers: ${renderers.join(" | ")})`);
}
console.log(`stats: ${JSON.stringify(res.gl)}; ${((Date.now() - t0) / 1000).toFixed(0)} s in the browser; output in ${out}`);
process.exit(fails ? 1 : 0);
