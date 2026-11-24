// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The page of `unkernel-check.mjs --drm`: boots unkernel from the built
// package (/dist/web.mjs) with a kernel that has kwvirtio (/img/unkernel.wasm),
// the Debian image and the prepared data disk, and createKernel({ gl: true,
// gpu: true }): the guest's virtio-gpu has 3D on the page's renderer. It
// shows the display as the page does (a canvas the size of the mode,
// repainted per animation frame: GlHost.gpu.drawFrame() while a GL client
// has the scanout, frame() otherwise), runs the steps in the guest with no
// GL environment variables and posts what they printed; the harness judges.
// Query: size=WxH (the display), resize=WxH (step r's size, default 960x540; not 800x600: DRM_GLMARK),
// scenes= (glmark2 -b list), skip=a,b,c,d,e,g,h,m,t,r,
// cmd= (a command run first, as root; for debugging), eager (gl: { eager:
// true }: the renderer loads before the boot; by default it loads on the
// guest's first GL use), glmodule=URL (another virgl.mjs: the harness's
// late one), glfail=module (a module URL that does not exist:
// the renderer fails to load at first use), fail (step f: what the guest
// sees without a renderer, and a dumb-buffer KMS client). The result has
// the renderer's status (vm.gl.status) at boot, at gl.ready and at the end,
// and when the page fetched virgl.mjs and virgl.wasm (resource timing).
import { createKernel } from "/dist/web.mjs";

const q = new URLSearchParams(location.search);
const skip = new Set((q.get("skip") || "").split(",").filter(Boolean));
const size = q.get("size") || "640x480";
const [W, H] = size.split("x").map(Number);
const scenes = (q.get("scenes") || "build:duration=5,texture:duration=5,shading:shading=phong:duration=5").split(",");
const t0 = performance.now();
// Every request is kept (the disk's Range requests fill the default 250 entries early).
performance.setResourceTimingBufferSize(1 << 20);
const secs = () => ((performance.now() - t0) / 1000).toFixed(1);

const post = (path, body) => fetch(path, { method: "POST", body }).catch(() => {});
function log(s) {
	const line = `[${secs()}] ${s}`;
	document.getElementById("log").append(line + "\n");
	post("/log", line);
}
let consoleBuf = "";
setInterval(() => {
	if (consoleBuf) post("/console", consoleBuf), (consoleBuf = "");
}, 500);
addEventListener("error", (e) => log(`error: ${e.message}`));
addEventListener("unhandledrejection", (e) => log(`error: ${e.reason?.stack || e.reason}`));

const VIRPIPE = "GALLIUM_DRIVER=virpipe LIBGL_ALWAYS_SOFTWARE=1";
const VARIANTS = "tex stencil raster plain query mip dual";
// kmscube and glmark2-drm stop at the first byte (or EOF) on stdin: give them
// a FIFO this shell holds open, fd 3 (no /dev/fd here for <(...))
const HOLD = "rm -f /tmp/hold.$$ && mkfifo /tmp/hold.$$ && exec 3<>/tmp/hold.$$ &&";
// glmark2-es2-drm (2023.01) always draws at the mode's size, and with -s of
// that very size (or --fullscreen) it never makes its window (a size check
// in CanvasGeneric::resize_no_viewport()): give it none, so the default
// 800x600 differs from the mode and it makes the mode's. And an XRGB8888
// config: its first pick is RGB565, which drmModeAddFB(24, 32) refuses.
const DRM_GLMARK = "--visual-config red=8:green=8:blue=8:alpha=0";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The display as the page shows it: the scanout's frames drawn from the renderer (no readback), else frame(). */
function display(vm) {
	const canvas = document.getElementById("fb");
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	const st = { painted: 0, glPainted: 0 };
	const paint = () => {
		const m = vm.display?.mode;
		if (m && (canvas.width !== m.width || canvas.height !== m.height)) {
			canvas.width = m.width;
			canvas.height = m.height;
		}
		const drew = vm.gl?.gpu?.drawFrame(ctx, false);
		if (drew) st.glPainted++;
		else if (drew === null && m) {
			const f = vm.frame();
			if (f) {
				ctx.putImageData(new ImageData(f.data, f.width), 0, 0);
				st.painted++;
			}
		}
		requestAnimationFrame(paint);
	};
	requestAnimationFrame(paint);
	return { canvas, ctx, st };
}

/** A checksum of RGBA pixels and how many distinct colours (of the first 4096 seen). */
function summary(data) {
	let sum = 0;
	const colours = new Set();
	for (let i = 0; i < data.length; i += 4) {
		const p = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
		sum = (Math.imul(sum, 31) + p) >>> 0;
		if (colours.size < 4096) colours.add(p);
	}
	return { checksum: sum.toString(16), colours: colours.size };
}

/** When this page fetched the renderer's files (s after the page started), from resource timing. */
const virglFetches = () => performance.getEntriesByType("resource").filter((e) => /virgl[^/]*\.(mjs|wasm)/.test(e.name))
	.map((e) => ({ file: e.name.split("/").pop(), startS: Number((e.startTime / 1000).toFixed(2)), endS: Number((e.responseEnd / 1000).toFixed(2)), startMs: e.startTime }));

async function main() {
	const result = { size, scenes, steps: {}, frames: [] };
	const glOpt = q.get("glfail") === "module" ? { module: new URL("/dist/no-such-virgl.mjs", location.href).href }
		: q.get("glmodule") ? { module: new URL(q.get("glmodule"), location.href).href, ...(q.has("eager") ? { eager: true } : {}) }
		: q.has("eager") ? { eager: true } : true;
	result.glOption = glOpt;
	const vmOpts = {
		kernel: "/img/unkernel.wasm",
		distro: "/img/debian.erofs",
		// snap: the overlay in IndexedDB (this run's own browser profile), so the machine can be snapshotted
		disks: [{ kind: "http", url: "/img/debian-gl.img", ...(q.has("snap") ? { persist: "kwtest-drm-snapshot" } : {}) }],
		gl: glOpt,
		gpu: true,
		display: { width: W, height: H, dpi: 96 },
		worker: q.has("worker"),
		memoryMiB: 1024,
		log,
	};
	const vm = await createKernel(vmOpts);
	vm.onOutput((b) => (consoleBuf += new TextDecoder().decode(b)));
	const shown = display(vm);
	log(`booted (transport ${vm.transport})`);
	result.bootS = Number(secs());
	result.bootMs = Math.round(performance.now() - t0);
	result.statusAtBoot = vm.gl?.status;
	// the first load's status (a new renderer after a loss, step l, starts another)
	vm.gl?.loaded.then(() => (result.statusAtLoad = vm.gl.status), () => {});
	result.fetchesAtBoot = virglFetches();
	try {
		result.renderer = await vm.gl.ready;
	} catch (e) {
		result.renderer = null;
		result.readyError = String(e?.message || e);
	}
	result.readyS = Number(secs());
	result.readyMs = Math.round(performance.now() - t0);
	// User space answering a command (the first exec through kwtty)
	await vm.exec("true", []);
	result.execMs = Math.round(performance.now() - t0);
	result.statusAtReady = vm.gl?.status;
	result.fetchesAtReady = virglFetches();
	result.hasGpu3d = !!vm.gl?.gpu;
	log(`gl ready: ${result.renderer ?? `rejected: ${result.readyError}`}; status ${JSON.stringify(result.statusAtReady)}; virgl fetches so far ${JSON.stringify(result.fetchesAtReady)}`);

	const run = async (name, cmd, opts = {}) => {
		log(`run ${name}: ${cmd}`);
		const t = performance.now();
		const r = await vm.exec("bash", ["-c", cmd], { timeout: 1800_000, user: "root", ...opts });
		const s = { exitCode: r.exitCode, signal: r.signal, stdout: r.stdout, stderr: r.stderr, ms: Math.round(performance.now() - t) };
		log(`${name}: exit ${r.exitCode ?? r.signal} after ${(s.ms / 1000).toFixed(1)} s`);
		result.steps[name] = s;
		return s;
	};

	// the test programs, in /tmp
	for (const name of ["kwgl-state", "prime", "kms-dumb", "kms-hotplug", "window-image", "int-attrib", "msaa", "feedback"]) {
		const r = await fetch(`/files/${name}`);
		if (!r.ok) continue;
		const bin = new Uint8Array(await r.arrayBuffer());
		await vm.exec("sh", ["-c", `cat >/tmp/${name} && chmod 755 /tmp/${name}`], { input: bin });
	}

	// cmd=: a command of the caller's first (debugging), its output as the step "cmd"
	if (q.get("cmd")) await run("cmd", q.get("cmd"));

	// (a) what Mesa finds on /dev/dri with no GL variables
	if (!skip.has("a")) {
		await run("drm", "ls -l /dev/dri; cat /sys/kernel/debug/dri/0/name 2>/dev/null; readlink -f /sys/class/drm/renderD128/device; cat /sys/class/drm/renderD128/device/uevent");
		await run("eglinfo-gbm", "eglinfo -B -p gbm 2>&1");
		await run("eglinfo-surfaceless", "eglinfo -B -p surfaceless 2>&1");
		// libdrm's drmGetDevices2(), which Mesa's loader and EGL's device enumeration use
		await run("drmdevice", "command -v drmdevice >/dev/null && drmdevice 2>&1 | head -60");
	}

	// (b) a KMS client page-flipping GBM buffers: its frames on this page's canvas
	if (!skip.has("b")) {
		const gpu = vm.gl.gpu;
		const before = { ...gpu.stats };
		const kms = run("kmscube", `${HOLD} timeout 300 kmscube -D /dev/dri/card0 -c 600 2>&1 <&3`);
		// Sample the canvas while it runs: the presented frame (drawn from the
		// renderer's ImageBitmap) against the scanout read back in the same task.
		for (let i = 0; i < 600 && result.frames.length < 3; i++) {
			await sleep(100);
			const s = gpu.scanout;
			if (!s || s.seq < 30 + result.frames.length * 60) continue;
			const drew = gpu.drawFrame(shown.ctx, true);
			const img = shown.ctx.getImageData(0, 0, s.width, s.height);
			const back = vm.frame();
			let diff = 0;
			for (let p = 0; back && p < img.data.length; p += 4)
				if (img.data[p] !== back.data[p] || img.data[p + 1] !== back.data[p + 1] || img.data[p + 2] !== back.data[p + 2]) diff++;
			const px = (x, y) => Array.from(img.data.slice((y * s.width + x) * 4, (y * s.width + x) * 4 + 3));
			result.frames.push({ seq: s.seq, size: `${s.width}x${s.height}`, drew, canvas: `${shown.canvas.width}x${shown.canvas.height}`,
				...summary(img.data), readback: back ? summary(back.data).checksum : null, differFromReadback: back ? diff : -1,
				center: px(s.width >> 1, s.height >> 1), corner: px(2, 2) });
			if (result.frames.length === 1) {
				// the frame as PPM, for a look
				const ppm = new Uint8Array(img.data.length / 4 * 3);
				for (let p = 0, o = 0; p < img.data.length; p += 4) ppm[o++] = img.data[p], ppm[o++] = img.data[p + 1], ppm[o++] = img.data[p + 2];
				const head = new TextEncoder().encode(`P6\n${s.width} ${s.height}\n255\n`);
				await post("/file/kmscube.ppm", new Blob([head, ppm]));
			}
		}
		await kms;
		const after = gpu.stats;
		result.kmsStats = { presents: after.presents - before.presents, fenced: after.fenced - before.fenced, parks: after.parks - before.parks,
			parkedMs: Math.round(after.parkedMs - before.parkedMs), pagePainted: shown.st.glPainted };
	}

	// (c) glmark2-es2 on KMS (the DRM path) against glmark2-es2 under Xvfb on
	// virpipe (the vtest path), the same scenes at the display's size: on
	// screen (DRM: page flips, paced by virtio-gpu's 60 Hz vblank timer;
	// vtest: each frame read back and put to Xvfb) and off screen (the
	// renderer's rate through each transport, nothing presented)
	if (!skip.has("c")) {
		const bs = scenes.map((s) => `-b ${s}`).join(" ");
		const xvfb = (args) => `${VIRPIPE} timeout 1500 xvfb-run -a -s "-screen 0 ${W}x${H}x24" glmark2-es2 -s ${size} ${args} ${bs} 2>&1`;
		await run("glmark2-drm", `${HOLD} timeout 1500 glmark2-es2-drm ${DRM_GLMARK} ${bs} 2>&1 <&3`);
		await run("glmark2-vtest", xvfb(""));
		await run("glmark2-drm-offscreen", `${HOLD} timeout 1500 glmark2-es2-drm --off-screen ${DRM_GLMARK} ${bs} 2>&1 <&3`);
		await run("glmark2-vtest-offscreen", xvfb("--off-screen"));
	}

	// (d) kwgl-state's clients interleaved on the DRM path against each alone,
	// and against the same clients on the vtest path (the same renderer)
	if (!skip.has("d")) {
		await run("state-alone", `for v in ${VARIANTS}; do timeout 600 /tmp/kwgl-state -t 8 $v; done | sort`);
		await run("state", `timeout 900 /tmp/kwgl-state -t 8 ${VARIANTS} | sort`);
		await run("state-vtest", `${VIRPIPE} timeout 900 /tmp/kwgl-state -t 8 ${VARIANTS} | sort`);
	}

	// (e) PRIME: a resource exported as a dmabuf by one opener and imported
	// by another names the same host resource, whose texture host code finds
	if (!skip.has("e")) {
		const p = await vm.spawn("/tmp/prime", ["/dev/dri/renderD128", "4"], { user: "user", pty: false });
		const errText = new Response(p.stderr).text();
		let text = "";
		const dec = new TextDecoder();
		const reader = p.stdout.getReader();
		let res = 0;
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			text += dec.decode(value);
			const m = /^res (\d+)$/m.exec(text);
			if (m && !res) {
				res = Number(m[1]);
				const t = vm.gl.gpu.texture(res);
				let pixel = null;
				if (t?.texture) {
					// read the texture in the renderer's context (a check only; host code would sample it)
					const gl = t.gl, fb = gl.createFramebuffer();
					gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
					gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.texture, 0);
					const out = new Uint8Array(4);
					// pixel (40, 8) of the picture: x 40 * 4 = 160 red, y 8 * 4 = 32 green, blue 0xc0;
					// the texture's row k is the picture's row k, or with yTop its row height - 1 - k
					gl.readPixels(40, t.yTop ? t.height - 1 - 8 : 8, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
					gl.bindFramebuffer(gl.FRAMEBUFFER, null);
					gl.deleteFramebuffer(fb);
					pixel = Array.from(out.slice(0, 3));
				}
				result.prime = { res, texture: !!t?.texture, width: t?.width, height: t?.height, format: t?.format, yTop: t?.yTop, pixel };
			}
		}
		const r = await p.ended;
		result.steps.prime = { exitCode: r.type === "exit" ? r.code : null, end: r, stdout: text, stderr: await errText, ms: 0 };
		log(`prime: ${JSON.stringify(r)}, ${JSON.stringify(result.prime)}`);
	}

	// (g) window images: GL-rendered GBM window buffers of each format as
	// ImageBitmaps (GlHost.gpu.image()), their pixels, the cost per image,
	// and the scanout's presentation while images are taken in between
	if (!skip.has("g")) await windowImages(vm, shown, result, run);

	// (h) integer vertex attributes and colour buffers (Firefox's WebRender):
	// right pixels, and no virtio-gpu command failed in the guest's kernel
	if (!skip.has("h"))
		await run("int-attrib", "dmesg -C; /tmp/int-attrib /dev/dri/renderD128; e=$?; echo \"kernel errors $(dmesg | grep -c 'response 0x')\"; exit $e");

	// (m) multisampling (renderbuffers on WebGL 2: what Chromium's ANGLE needs
	// for OpenGL ES 3.0): 4 samples per format, an antialiased draw resolved
	if (!skip.has("m"))
		await run("msaa", "dmesg -C; /tmp/msaa /dev/dri/renderD128; e=$?; echo \"kernel errors $(dmesg | grep -c 'response 0x')\"; exit $e");

	// (t) textures left on used sampler units that the draws never sample
	// (Firefox's WebRender): one attached to the draw framebuffer, integer
	// and float ones on samplers of the other type; right pixels, and no
	// virtio-gpu command failed in the guest's kernel
	if (!skip.has("t"))
		await run("feedback", "dmesg -C; /tmp/feedback /dev/dri/renderD128; e=$?; echo \"kernel errors $(dmesg | grep -c 'response 0x')\"; exit $e");

	// (r) a display size change on the running machine (vm.updateDisplaySize()):
	// a KMS client reading uevents hears the hotplug and probes the new
	// preferred mode; kmscube and glmark2-es2-drm started afterwards take it,
	// and the display (its mode, the canvas, the scanout) follows them
	if (!skip.has("r")) await resize(vm, shown, result, run);

	// (l) lose=1: glmark2-es2-drm twice (the second run gets the first's
	// context id again), then the renderer's WebGL2 context lost
	// (WEBGL_lose_context, as a GPU reset or iOS drops contexts) four times
	// (gl.md, The DRM path, Context loss):
	//   1  during glmark2-es2-drm, restored while it still runs: it must end;
	//      then a new kmscube must render (its frames on the page's canvas
	//      equal the scanout read back, not flat), a dumb-buffer KMS client
	//      must show its picture, and a vtest client must get virgl
	//   2  while kmscube and glmark2-es2 on the vtest link (Xvfb) run,
	//      restored: both must end; a new kmscube must render
	//   3  during glmark2-es2-drm, not restored: a new kmscube must render (a
	//      new renderer on a new WebGL2 context)
	//   4  during kmscube while the page gives no new WebGL2 context
	//      (getContext patched to null): a glmark2-es2-drm run must end (its
	//      commands fail); with WebGL2 back, a new kmscube must render
	if (q.has("lose")) await loseContext(vm, shown, result, run);

	// (f) without a renderer (glfail=module, or no WebGL2): what Mesa does, and the 2D KMS path
	if (q.has("fail")) {
		await run("fail-eglinfo-gbm", "eglinfo -B -p gbm 2>&1 | head -40");
		await run("fail-eglinfo-surfaceless", "eglinfo -B -p surfaceless 2>&1 | head -40");
		await run("fail-kmscube", `${HOLD} timeout 120 kmscube -D /dev/dri/card0 -c 60 2>&1 <&3 | tail -15`);
		await run("fail-kms-dumb", "/tmp/kms-dumb /dev/dri/card0 3 2>&1");
		await run("fail-dmesg", "dmesg | grep -i -E 'virtio|drm|virgl' | sed 's/^\\[[ 0-9.]*\\] //' | sort | uniq -c | sort -rn | head -20");
	}

	result.status = vm.gl?.status;
	result.fetches = virglFetches();
	result.gl = vm.gl?.stats;
	result.display = { painted: shown.st.painted, glPainted: shown.st.glPainted };

	// (s) snap: a snapshot while a DRM file holds a 3D context that never
	// submitted and has no resources (prime.c's importer between clients,
	// as a Wayland relay idles), its restore, and the importer's context
	// used again there (the restored device makes it again)
	let vm2 = null;
	if (q.has("snap")) vm2 = await snapshotIdleContext(vm, vmOpts, result, run);

	result.totalS = Number(secs());
	await post("/result", JSON.stringify(result));
	log("done");
	await (vm2 ?? vm).stop().catch(() => {});
}

async function resize(vm, shown, result, run) {
	const size = q.get("resize") || "960x540";
	const [RW, RH] = size.split("x").map(Number);
	const out = (result.resize = { size });
	const p = await vm.spawn("/tmp/kms-hotplug", ["/dev/dri/card0", "120", "r"], { user: "root", pty: false });
	const errText = new Response(p.stderr).text();
	const reader = p.stdout.getReader(), dec = new TextDecoder();
	let text = "";
	const until = async (re) => {
		for (;;) {
			const m = re.exec(text);
			if (m) return m;
			const { value, done } = await reader.read();
			if (done) return null;
			text += dec.decode(value, { stream: true });
		}
	};
	if (await until(/ready \d+x\d+|FAILED/)) {
		vm.updateDisplaySize({ width: RW, height: RH, dpi: 96 });
		await until(/done\n|FAILED/);
	}
	await until(/(?!)/); // to the end
	out.hotplug = { end: await p.ended, stdout: text, stderr: await errText };
	log(`resize: kms-hotplug ${JSON.stringify(out.hotplug)}`);
	// kmscube on its next start: the new mode on the scanout, the display and the page's canvas
	const kms = run("resize-kmscube", `${HOLD} timeout 300 kmscube -D /dev/dri/card0 -c 300 2>&1 <&3 | tail -5`);
	for (let i = 0; i < 1200 && !out.kmscube; i++) {
		await sleep(100);
		const s = vm.gl.gpu.scanout, m = vm.display?.mode;
		if (s && s.seq > 30) {
			await sleep(100); // a paint of the page's canvas
			out.kmscube = { scanout: `${s.width}x${s.height}`, mode: m && `${m.width}x${m.height}`, canvas: `${shown.canvas.width}x${shown.canvas.height}` };
		}
	}
	await kms;
	await run("resize-glmark2", `${HOLD} timeout 300 glmark2-es2-drm ${DRM_GLMARK} -b build:duration=2 2>&1 <&3 | grep -E 'Surface|Score|rror'`);
	await run("resize-modetest", "modetest -M virtio_gpu -c 2>&1 | head -12");
	vm.updateDisplaySize({ width: W, height: H, dpi: 96 });
}

async function loseContext(vm, shown, result, run) {
	const gpu = vm.gl.gpu;
	const out = (result.lose = { phases: [] });
	const errs = "echo \"kernel errors $(dmesg | grep -c 'response 0x')\"";
	const gm = (name, secs = 2) => run(name, `${HOLD} timeout 300 glmark2-es2-drm ${DRM_GLMARK} -b build:duration=${secs} 2>&1 <&3 | tail -3; ${errs}`);
	const brief = (r) => ({ exitCode: r.exitCode, signal: r.signal, ms: r.ms, tail: r.stdout.trim().split("\n").slice(-4).join(" | ") });
	const stats = () => {
		const s = gpu.stats, st = vm.gl.status;
		return { contextLost: s.contextLost, losses: s.losses, renewals: s.renewals, errors: s.errors, lastError: s.lastError, state: st.state, statusLosses: st.losses, statusRenewals: st.renewals, error: st.error };
	};
	// The renderer's context lost (from a resource on the scanout: a KMS client runs); its WEBGL_lose_context, to restore it.
	const lose = async () => {
		for (let i = 0; i < 600 && !(gpu.scanout?.seq > 10); i++) await sleep(100);
		const sc = gpu.scanout, t = sc && gpu.texture(sc.resource);
		const ext = t?.gl.getExtension("WEBGL_lose_context");
		if (!ext) return null;
		const losses = gpu.stats.losses;
		ext.loseContext();
		for (let i = 0; i < 100 && gpu.stats.losses === losses; i++) await sleep(50);
		log(`lost the renderer's WebGL2 context: ${JSON.stringify(stats())}`);
		return ext;
	};
	// A new kmscube: one frame from the page's canvas against the scanout read back, and no failed command in the guest's kernel.
	const kms = async (name) => {
		const before = { ...gpu.stats };
		const p = run(name, `dmesg -C; ${HOLD} timeout 300 kmscube -D /dev/dri/card0 -c 240 2>&1 <&3 | tail -2; ${errs}`);
		let frame = null;
		for (let i = 0; i < 1200 && !frame; i++) {
			await sleep(100);
			const s = gpu.scanout;
			if (!s || s.seq < 30) continue;
			gpu.drawFrame(shown.ctx, true);
			const img = shown.ctx.getImageData(0, 0, s.width, s.height);
			const back = vm.frame();
			let diff = 0;
			for (let k = 0; back && k < img.data.length; k += 4)
				if (img.data[k] !== back.data[k] || img.data[k + 1] !== back.data[k + 1] || img.data[k + 2] !== back.data[k + 2]) diff++;
			frame = { seq: s.seq, size: `${s.width}x${s.height}`, ...summary(img.data), differFromReadback: back ? diff : -1 };
		}
		const r = await p;
		return { ...brief(r), frame, presents: gpu.stats.presents - before.presents, rendererErrors: gpu.stats.errors - before.errors, after: stats() };
	};
	// A dumb-buffer KMS client: its picture (glimmer's pattern, a white square at (16, 16)) read from the 2D scanout.
	const dumb = async (name) => {
		const p = run(name, "/tmp/kms-dumb /dev/dri/card0 4 2>&1 | tail -2");
		let pic = null;
		for (let i = 0; i < 150 && !pic; i++) {
			await sleep(100);
			if (gpu.scanout || !vm.display?.mode) continue;
			const f = vm.frame();
			if (!f) continue;
			const at = (x, y) => Array.from(f.data.slice((y * f.width + x) * 4, (y * f.width + x) * 4 + 3));
			const sum = summary(f.data);
			if (at(40, 40).join() !== "255,255,255" || sum.colours <= 16) continue;
			pic = { size: `${f.width}x${f.height}`, ...sum, square: at(40, 40) };
		}
		return { ...brief(await p), pic };
	};

	await run("lose-clear", "dmesg -C");
	await gm("lose-run1");
	await gm("lose-run2");
	out.before = stats();

	// 1: during glmark2-es2-drm, restored while it runs
	{
		const ph = { n: 1 };
		const g = gm("lose-1-glmark2", 8);
		const ext = await lose();
		ph.lost = !!ext;
		ph.whileLost = stats();
		await sleep(1000);
		ext?.restoreContext();
		await sleep(500);
		ph.restored = stats();
		ph.running = brief(await g);
		ph.kms = await kms("lose-1-kmscube");
		ph.dumb = await dumb("lose-1-kms-dumb");
		ph.vtest = brief(await run("lose-1-vtest", `${VIRPIPE} eglinfo -B -p surfaceless 2>&1 | grep -i 'renderer' | head -3`));
		out.phases.push(ph);
	}

	// 2: kmscube and a vtest client (glmark2-es2 under Xvfb) running, restored
	{
		const ph = { n: 2 };
		const v = run("lose-2-vtest-glmark2", `${VIRPIPE} timeout 300 xvfb-run -a -s "-screen 0 ${W}x${H}x24" glmark2-es2 -s 320x240 -b build:duration=30 2>&1 | tail -4`);
		const k = run("lose-2-kmscube-running", `${HOLD} timeout 300 kmscube -D /dev/dri/card0 -c 900 2>&1 <&3 | tail -2`);
		for (let i = 0; i < 1200 && !(vm.gl.stats.clients > 0 && gpu.scanout?.seq > 10); i++) await sleep(100);
		await sleep(3000);
		ph.vtestClients = vm.gl.stats.clients;
		const ext = await lose();
		ph.lost = !!ext;
		await sleep(1000);
		ext?.restoreContext();
		ph.vtestRunning = brief(await v);
		ph.kmsRunning = brief(await k);
		ph.kms = await kms("lose-2-kmscube");
		out.phases.push(ph);
	}

	// 3: during glmark2-es2-drm, not restored
	{
		const ph = { n: 3 };
		const g = gm("lose-3-glmark2", 8);
		ph.lost = !!(await lose());
		ph.running = brief(await g);
		ph.kms = await kms("lose-3-kmscube");
		out.phases.push(ph);
	}

	// 4: during kmscube, with no WebGL2 context to be had for a while
	{
		const ph = { n: 4 };
		const k = run("lose-4-kmscube-running", `${HOLD} timeout 300 kmscube -D /dev/dri/card0 -c 300 2>&1 <&3 | tail -2`);
		const getContext = OffscreenCanvas.prototype.getContext;
		ph.lost = !!(await lose());
		OffscreenCanvas.prototype.getContext = function (type, ...rest) {
			return type === "webgl2" ? null : getContext.call(this, type, ...rest);
		};
		try {
			ph.kmsRunning = brief(await k);
			ph.refused = brief(await gm("lose-4-glmark2-refused"));
			ph.whileRefused = stats();
		} finally {
			OffscreenCanvas.prototype.getContext = getContext;
		}
		await sleep(1200);
		ph.kms = await kms("lose-4-kmscube");
		out.phases.push(ph);
	}
	out.after = stats();
}

async function snapshotIdleContext(vm, vmOpts, result, run) {
	const out = (result.snapshot = { attempts: [] });
	await run("snap-prime", "rm -f /tmp/go /tmp/prime.log; setsid nohup /tmp/prime /dev/dri/renderD128 60 /tmp/go </dev/null >/tmp/prime.log 2>&1 & echo started", { user: "user" });
	const logOf = async (v) => (await v.exec("cat", ["/tmp/prime.log"])).stdout;
	for (let i = 0; i < 100 && !/^idle/m.test(out.before ?? ""); i++) {
		await sleep(200);
		out.before = await logOf(vm);
	}
	if (!/^idle/m.test(out.before)) return (out.error = `prime did not get idle: ${out.before}`), null;
	let snap = null;
	for (let i = 0; i < 20 && !snap; i++) {
		try {
			snap = await vm.snapshot({ stop: true });
			out.attempts.push("taken");
		} catch (e) {
			out.attempts.push(String(e?.message || e));
			await sleep(250);
		}
	}
	if (!snap) return (out.error = "no snapshot"), null;
	const t = performance.now();
	const vm2 = await createKernel({ ...vmOpts, restore: snap, log: (m) => {
		if (/from before a restore/.test(m)) out.adopted = m;
		log(m);
	} });
	out.restoreMs = Math.round(performance.now() - t);
	await vm2.exec("touch", ["/tmp/go"]);
	for (let i = 0; i < 150 && !/^res \d+$/m.test(out.after ?? ""); i++) {
		await sleep(200);
		out.after = await logOf(vm2);
	}
	const res = Number(/^res (\d+)$/m.exec(out.after ?? "")?.[1] ?? 0);
	if (!res) return (out.error = `prime did not go on after the restore: ${out.after}`), vm2;
	const img = await vm2.gl.gpu.image(res);
	if (img) {
		const c = new OffscreenCanvas(img.width, img.height).getContext("2d", { willReadFrequently: true });
		c.drawImage(img, 0, 0);
		out.pixel = Array.from(c.getImageData(40, 8, 1, 1).data);
		out.size = `${img.width}x${img.height}`;
		img.close();
	}
	out.gpu = vm2.gl.gpu.stats;
	return vm2;
}

// test/gpu/window-image.c's picture, 64x48, by quadrant (TL, TR, BL, BR) as
// premultiplied RGBA
const WIN = { w: 64, h: 48, quads: [[255, 0, 0, 255], [0, 128, 0, 128], [0, 0, 0, 0], [0, 0, 64, 64]] };
const XFORMATS = new Set([0x34325258, 0x34324258]); // XR24, XB24

/** Pixels of `data` (w x h RGBA) more than 2 off what the picture composited over `bg` gives, per quadrant. */
function judgePicture(data, w, h, { bg, opaque, flipY, crop }) {
	const bad = [0, 0, 0, 0], got = [null, null, null, null];
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			// where this pixel is in the picture
			let px = x + (crop?.x ?? 0), py = y + (crop?.y ?? 0);
			if (flipY) py = (crop?.height ?? WIN.h) - 1 - y + (crop?.y ?? 0);
			const q = (py >= WIN.h / 2 ? 2 : 0) + (px >= WIN.w / 2 ? 1 : 0);
			const [r, g, b, a] = WIN.quads[q];
			const k = opaque ? 0 : 255 - a;
			const want = [r + (bg * k) / 255, g + (bg * k) / 255, b + (bg * k) / 255];
			const o = (y * w + x) * 4;
			if (!got[q] && x % (WIN.w / 2) === 8 && y % (WIN.h / 2) === 8) got[q] = Array.from(data.slice(o, o + 3));
			if (want.some((v, i) => Math.abs(data[o + i] - v) > 2) || data[o + 3] !== 255) bad[q]++;
		}
	return { bad: bad.reduce((a, b) => a + b, 0), perQuadrant: bad, samples: got };
}

/** Draw an image over a background of grey `bg` and read it back. */
function composite(img, bg) {
	const c = new OffscreenCanvas(img.width, img.height);
	const ctx = c.getContext("2d", { willReadFrequently: true });
	ctx.fillStyle = `rgb(${bg},${bg},${bg})`;
	ctx.fillRect(0, 0, c.width, c.height);
	ctx.drawImage(img, 0, 0);
	return ctx.getImageData(0, 0, c.width, c.height).data;
}

async function windowImages(vm, shown, result, run) {
	const gpu = vm.gl.gpu;
	const out = (result.windowImages = { bufs: {}, checks: [], timing: {}, scanout: [] });
	const p = await vm.spawn("/tmp/window-image", ["/dev/dri/renderD128", "600"], { user: "user", pty: false });
	const errText = new Response(p.stderr).text();
	const reader = p.stdout.getReader();
	const dec = new TextDecoder();
	let text = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		text += dec.decode(value);
		if (/^ready$/m.test(text)) break;
	}
	out.stdout = text;
	for (const m of text.matchAll(/^buf (\S+) res (\d+) fourcc 0x([0-9a-f]+) (\d+)x(\d+)$/gm))
		out.bufs[m[1]] = { res: Number(m[2]), fourcc: parseInt(m[3], 16), width: Number(m[4]), height: Number(m[5]) };
	if (!/^ready$/m.test(text)) {
		out.error = `window-image did not get ready: ${text} ${await errText}`;
		return;
	}
	const check = async (name, buf, opts, how) => {
		const img = await gpu.image(buf.res, opts);
		const c = { name, opts, size: img ? `${img.width}x${img.height}` : null };
		if (img) {
			const w = img.width, h = img.height;
			const black = judgePicture(composite(img, 0), w, h, { ...how, bg: 0 });
			const white = judgePicture(composite(img, 255), w, h, { ...how, bg: 255 });
			c.bad = black.bad + white.bad;
			c.overBlack = black.samples;
			c.overWhite = white.samples;
			c.perQuadrant = [black.perQuadrant, white.perQuadrant];
			img.close();
		}
		out.checks.push(c);
		return c;
	};
	for (const name of ["argb", "xrgb", "abgr", "xbgr"]) {
		const b = out.bufs[name];
		if (!b) continue;
		const t = gpu.texture(b.res);
		b.texture = t && { format: t.format, yTop: t.yTop, alpha: t.alpha, width: t.width, height: t.height };
		const opaque = XFORMATS.has(b.fourcc);
		b.want = opaque ? "opaque" : "alpha";
		// as the page's resolver would pass it, and with the defaults (the resource's format decides)
		await check(name, b, { opaque }, { opaque });
		await check(`${name} default`, b, {}, { opaque });
		await check(`${name} flipY`, b, { opaque, flipY: true }, { opaque, flipY: true });
		// the top right quadrant alone
		const crop = { x: 32, y: 0, width: 32, height: 24 };
		await check(`${name} crop`, b, { opaque, ...crop }, { opaque, crop });
	}
	// null for an id the guest has not made, and for an empty rectangle
	out.nulls = { unknown: gpu.image(0x3fffffff) === null, empty: gpu.image(out.bufs.argb.res, { width: 0 }) === null };

	// The cost of an image: image() + drawImage() into a 2D canvas + close(),
	// N times; then a 1x1 getImageData waits for the GPU (so "total" counts
	// the GPU's work too)
	const sink = new OffscreenCanvas(1920, 1080).getContext("2d", { willReadFrequently: true });
	// (`draw` false: image() + close() alone, the last image drawn to wait)
	const timeIt = (resList, n, draw = true) => {
		for (let i = 0; i < 3; i++) for (const r of resList) gpu.image(r).close();
		sink.getImageData(0, 0, 1, 1);
		const t0 = performance.now();
		let issue = 0;
		for (let i = 0; i < n; i++) {
			const r = resList[i % resList.length];
			const t = performance.now();
			const img = gpu.image(r);
			if (draw || i === n - 1) sink.drawImage(img, 0, 0);
			img.close();
			issue += performance.now() - t;
		}
		sink.getImageData(0, 0, 1, 1);
		const total = performance.now() - t0;
		return { n, issueMs: +(issue / n).toFixed(3), totalMs: +(total / n).toFixed(3) };
	};
	const r800 = out.bufs["argb-800x600"].res, r1080 = out.bufs["argb-1920x1080"].res;
	out.timing["800x600"] = timeIt([r800], 100);
	out.timing["1920x1080"] = timeIt([r1080], 100);
	out.timing["800x600, no drawImage"] = timeIt([r800], 100, false);
	out.timing["1920x1080, no drawImage"] = timeIt([r1080], 100, false);
	out.timing["alternating 800x600 / 1920x1080 (canvas resized each time)"] = timeIt([r800, r1080], 100);
	// what a readback would cost instead: readPixels of the texture
	const readback = (res, n) => {
		const t = gpu.texture(res), gl = t.gl, fb = gl.createFramebuffer(), buf = new Uint8Array(t.width * t.height * 4);
		gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.texture, 0);
		gl.readPixels(0, 0, t.width, t.height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
		const t0 = performance.now();
		for (let i = 0; i < n; i++) gl.readPixels(0, 0, t.width, t.height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
		const ms = (performance.now() - t0) / n;
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.deleteFramebuffer(fb);
		return +ms.toFixed(3);
	};
	out.timing.readPixels = { "800x600": readback(r800, 20), "1920x1080": readback(r1080, 20) };
	// the same on a plain WebGL2 OffscreenCanvas (no virgl): a clear and a
	// blit of a texture of that size into the drawing buffer, then
	// transferToImageBitmap(), which waits for them
	for (const [w, h] of [[800, 600], [1920, 1080]]) {
		const c = new OffscreenCanvas(w, h), g2 = c.getContext("webgl2", { alpha: true, depth: false, antialias: false });
		const tex = g2.createTexture(), fb = g2.createFramebuffer();
		g2.bindTexture(g2.TEXTURE_2D, tex);
		g2.texStorage2D(g2.TEXTURE_2D, 1, g2.RGBA8, w, h);
		g2.bindFramebuffer(g2.READ_FRAMEBUFFER, fb);
		g2.framebufferTexture2D(g2.READ_FRAMEBUFFER, g2.COLOR_ATTACHMENT0, g2.TEXTURE_2D, tex, 0);
		let ms = 0;
		for (let i = 0; i < 53; i++) {
			const t = performance.now();
			g2.clear(g2.COLOR_BUFFER_BIT);
			g2.blitFramebuffer(0, 0, w, h, 0, h, w, 0, g2.COLOR_BUFFER_BIT, g2.NEAREST);
			c.transferToImageBitmap().close();
			if (i >= 3) ms += performance.now() - t;
		}
		out.timing[`plain WebGL2 ${w}x${h}: clear, blit, transferToImageBitmap`] = +(ms / 50).toFixed(3);
		g2.getExtension("WEBGL_lose_context")?.loseContext();
	}

	// The scanout while images are taken: kmscube's frames on the page's
	// canvas against the scanout read back, drawn over white too (opaque),
	// with images of the window buffers taken between presents
	if (!skip.has("b2")) {
		const kms = run("window-image-kmscube", `${HOLD} timeout 300 kmscube -D /dev/dri/card0 -c 400 2>&1 <&3`);
		const white = new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true });
		let images = 0, imageMs = 0, imagesBad = 0;
		for (let i = 0; i < 600 && out.scanout.length < 4; i++) {
			await sleep(50);
			const s = gpu.scanout;
			if (!s || s.seq < 20) continue;
			// images between presents (the drawing buffer resized to them and back)
			for (const r of [out.bufs.argb.res, r1080, out.bufs.xrgb.res]) {
				const t = performance.now();
				const img = gpu.image(r, { opaque: r === out.bufs.xrgb.res });
				imageMs += performance.now() - t;
				images++;
				if (r !== r1080 && judgePicture(composite(img, 255), img.width, img.height, { bg: 255, opaque: r === out.bufs.xrgb.res }).bad) imagesBad++;
				img.close();
			}
			const seq = s.seq;
			for (let k = 0; k < 40 && gpu.scanout?.seq === seq; k++) await sleep(10);
			const s2 = gpu.scanout;
			if (!s2 || s2.seq === seq) continue;
			gpu.drawFrame(shown.ctx, true);
			const img = shown.ctx.getImageData(0, 0, s2.width, s2.height);
			white.canvas.width = s2.width;
			white.canvas.height = s2.height;
			white.fillStyle = "#fff";
			white.fillRect(0, 0, s2.width, s2.height);
			gpu.drawFrame(white, true);
			const onWhite = white.getImageData(0, 0, s2.width, s2.height);
			const back = vm.frame();
			let diff = 0, diffWhite = 0, translucent = 0;
			for (let q = 0; back && q < img.data.length; q += 4) {
				if (img.data[q] !== back.data[q] || img.data[q + 1] !== back.data[q + 1] || img.data[q + 2] !== back.data[q + 2]) diff++;
				if (onWhite.data[q] !== back.data[q] || onWhite.data[q + 1] !== back.data[q + 1] || onWhite.data[q + 2] !== back.data[q + 2]) diffWhite++;
				if (img.data[q + 3] !== 255) translucent++;
			}
			out.scanout.push({ seq: s2.seq, size: `${s2.width}x${s2.height}`, ...summary(img.data), differFromReadback: back ? diff : -1,
				overWhiteDifferFromReadback: back ? diffWhite : -1, translucent });
		}
		await kms;
		out.scanoutImages = { images, bad: imagesBad, msPerImage: images ? +(imageMs / images).toFixed(3) : null };
	}
	p.kill("SIGTERM");
	const end = await p.ended;
	out.ended = end;
	out.stderr = await errText;
	result.steps["window-image"] = { exitCode: 0, stdout: text, stderr: out.stderr, ms: 0 };
	log(`window images: ${JSON.stringify(out)}`);
}

main().catch(async (e) => {
	log(`error: ${e?.stack || e}`);
	await post("/result", JSON.stringify({ error: String(e?.stack || e) }));
});
