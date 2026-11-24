#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The host renderer of guest Vulkan (vk/PROTOCOL.md) on this host, for the
// ICD's native build: starts headless Chrome with WebGPU (SwiftShader's
// Vulkan here), serves it a page that creates a GPUDevice, the SPIR-V
// translator (js/core/vk-shader.ts, loadVkShader on
// $KW_BUILD/vk/kwvk-naga.wasm) and a VkRenderer (js/core/vk-host.ts), and
// carries each connection to a TCP port (and a unix socket with --unix) to
// its own VkConnection in the page and back, over one WebSocket between
// Node and the page. Prints the renderer's log lines ("vk: ...") and the
// page's errors.
//
//   node test/vk/relay.mjs [--port N] [--unix PATH] [--browser BIN] [--log FILE] [--quiet]
//        [-- CMD ARGS...]
//
// Default port 10210 (0 picks one; the line "relay: listening on
// tcp:127.0.0.1:PORT" names it). With `-- CMD ARGS...` it runs the command
// once the page has its device, with KWVK_LINK=tcp:127.0.0.1:PORT and, when
// neither is set, VK_DRIVER_FILES and VK_ICD_FILENAMES naming
// $KW_BUILD/vk/native/kw_icd.json (the native ICD), then exits with the
// command's status. Without a command it serves until killed:
//
//   node test/vk/relay.mjs &
//   KWVK_LINK=tcp:127.0.0.1:10210 VK_DRIVER_FILES=vendor/build/vk/native/kw_icd.json vulkaninfo --summary
//   node test/vk/relay.mjs -- vulkaninfo --summary
//
// The TypeScript sources are served to the page as JavaScript through
// Node's module.stripTypeScriptTypes (erasable syntax only, as the SDK's
// sources are), with their `.ts` import specifiers intact. Each connection
// imports vk-host.ts and vk-shader.ts afresh when a js/core/vk*.ts file or
// the wasm changed since the last one, so the relay needs no restart while
// they are being worked on. The browser: the Playwright Chromium (BIN or
// $CHROME, default ~/.cache/ms-playwright/chromium-1234/...): dnf's
// chromium-headless has no WebGPU adapter. Exit 2 when the page found no
// WebGPU device within 60 s.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acceptWebSocket } from "../ws-server.ts";

process.removeAllListeners("warning"); // stripTypeScriptTypes is experimental: no warning per run

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const build = process.env.KW_BUILD ? resolve(process.env.KW_BUILD) : join(root, "vendor/build");
const argv = process.argv.slice(2);
const dash = argv.indexOf("--");
const args = dash >= 0 ? argv.slice(0, dash) : argv;
const cmd = dash >= 0 ? argv.slice(dash + 1) : [];
const opt = (name, dflt) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : dflt;
};
const quiet = args.includes("--quiet");
const port = Number(opt("--port", "10210"));
const unixPath = opt("--unix");
const logFile = opt("--log");
const CHROME_DEFAULT = join(homedir(), ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome");
/** The flags under which headless Chrome has a WebGPU adapter on this host (SwiftShader's Vulkan). */
const WEBGPU_FLAGS = ["--headless", "--no-sandbox", "--disable-gpu-sandbox", "--enable-unsafe-webgpu",
	"--enable-features=Vulkan,WebGPU", "--use-vulkan=swiftshader", "--use-webgpu-adapter=swiftshader", "--ignore-gpu-blocklist", "--disable-dev-shm-usage"];
const browser = opt("--browser", process.env.CHROME || CHROME_DEFAULT);
const wasmFile = join(build, "vk/kwvk-naga.wasm");

const say = (s) => {
	if (logFile) appendFileSync(logFile, s + "\n");
	if (!quiet || !s.startsWith("vk: ")) console.error(s);
};
if (logFile) writeFileSync(logFile, "");

// The generation of the renderer's sources: changes when any of them does.
function generation() {
	let h = createHash("sha1");
	for (const f of readdirSync(join(root, "js/core")).filter((f) => /^vk.*\.ts$/.test(f)).sort()) {
		const st = statSync(join(root, "js/core", f));
		h.update(`${f}:${st.mtimeMs}:${st.size};`);
	}
	if (existsSync(wasmFile)) h.update(`wasm:${statSync(wasmFile).mtimeMs}`);
	return h.digest("hex").slice(0, 10);
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>kwvk relay</title><script type="module">
const ws = new WebSocket("ws://" + location.host + "/ws");
ws.binaryType = "arraybuffer";
const enc = new TextEncoder(), dec = new TextDecoder();
function msg(id, kind, payload) {
	const b = new Uint8Array(5 + payload.length);
	new DataView(b.buffer).setUint32(0, id, true);
	b[4] = kind;
	b.set(payload, 5);
	ws.send(b);
}
const log = (line) => { console.log(line); if (ws.readyState === 1) msg(0, 3, enc.encode(String(line))); };
addEventListener("error", (e) => log("page error: " + (e.error?.stack ?? e.message)));
addEventListener("unhandledrejection", (e) => log("page rejection: " + (e.reason?.stack ?? e.reason)));
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let adapter, device;
try {
	if (!navigator.gpu) throw new Error("no navigator.gpu");
	adapter = await navigator.gpu.requestAdapter();
	if (!adapter) throw new Error("no WebGPU adapter");
	const requiredLimits = {};
	for (const k in adapter.limits) if (typeof adapter.limits[k] === "number") requiredLimits[k] = adapter.limits[k];
	device = await adapter.requestDevice({ requiredFeatures: [...adapter.features], requiredLimits });
	device.lost.then((i) => log("device lost: " + i.reason + " " + i.message));
	device.addEventListener("uncapturederror", (e) => log("vk: WebGPU uncaptured error: " + e.error.message));
	const info = adapter.info ?? {};
	msg(0, 4, enc.encode(JSON.stringify({ vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description,
		features: [...device.features].sort() })));
} catch (e) {
	msg(0, 5, enc.encode(String(e?.message ?? e)));
	throw e;
}
const conns = new Map();
let loaded = { gen: null, renderer: null, error: null };
async function renderer(gen) {
	if (loaded.gen === gen && (loaded.renderer || loaded.error)) return loaded;
	loaded = { gen, renderer: null, error: null };
	try {
		let hostMod, shaderMod;
		try { hostMod = await import("/g" + gen + "/js/core/vk-host.ts"); } catch (e) { throw new Error("cannot load js/core/vk-host.ts: " + (e?.message ?? e)); }
		try { shaderMod = await import("/g" + gen + "/js/core/vk-shader.ts"); } catch (e) { throw new Error("cannot load js/core/vk-shader.ts: " + (e?.message ?? e)); }
		let shaders;
		try { shaders = await shaderMod.loadVkShader(new URL("/kwvk-naga.wasm?g=" + gen, location.href)); }
		catch (e) { throw new Error("loadVkShader(kwvk-naga.wasm): " + (e?.message ?? e)); }
		loaded.renderer = new hostMod.VkRenderer({ device, adapter, shaders, log: (l) => log("vk: " + l) });
		log("relay: renderer loaded (generation " + gen + ")");
	} catch (e) {
		loaded.error = e?.message ?? String(e);
	}
	return loaded;
}
// Connections are opened in order; data waits for its connection's open.
const pending = new Map();
let chain = Promise.resolve();
ws.addEventListener("message", (ev) => {
	const b = new Uint8Array(ev.data);
	const id = new DataView(b.buffer).getUint32(0, true), kind = b[4], payload = b.subarray(5);
	chain = chain.then(async () => {
		if (kind === 0) {
			const r = await renderer(dec.decode(payload));
			if (!r.renderer) { log("relay: connection " + id + " refused: " + r.error); msg(id, 2, new Uint8Array(0)); return; }
			try {
				// the renderer ends a stream itself (a lost device): close the socket after what it sent
				conns.set(id, r.renderer.connect((bytes) => msg(id, 1, bytes), () => { conns.delete(id); msg(id, 2, new Uint8Array(0)); }));
			} catch (e) { log("relay: connect threw: " + (e?.stack ?? e)); msg(id, 2, new Uint8Array(0)); }
		} else if (kind === 1) {
			const c = conns.get(id);
			if (!c) return;
			try { c.feed(payload.slice()); } catch (e) { log("relay: feed threw on connection " + id + ": " + (e?.stack ?? e)); }
		} else if (kind === 2) {
			const c = conns.get(id);
			conns.delete(id);
			try { c?.close(); } catch (e) { log("relay: close threw: " + (e?.stack ?? e)); }
		}
	});
});
</script>`;

const types = { ".js": "text/javascript", ".mjs": "text/javascript", ".ts": "text/javascript", ".wasm": "application/wasm" };
const tsCache = new Map();
function serveSource(res, rel) {
	const file = join(root, rel);
	if (rel.startsWith("..") || !/^(js|test\/vk|vk)\//.test(rel) || !existsSync(file) || !statSync(file).isFile()) {
		say(`relay: the page asked for ${rel}, which does not exist`);
		res.writeHead(404);
		res.end();
		return;
	}
	const ext = rel.slice(rel.lastIndexOf("."));
	let body = readFileSync(file);
	if (ext === ".ts") {
		const key = `${file}:${statSync(file).mtimeMs}`;
		if (!tsCache.has(key)) {
			try {
				tsCache.set(key, stripTypeScriptTypes(body.toString(), { mode: "strip", sourceUrl: rel }));
			} catch (e) {
				say(`relay: cannot strip types of ${rel}: ${e.message}`);
				res.writeHead(500);
				res.end(String(e.message));
				return;
			}
		}
		body = tsCache.get(key);
	}
	res.writeHead(200, { "content-type": types[ext] ?? "application/octet-stream", "cache-control": "no-store" });
	res.end(body);
}

// One WebSocket, many connections: [u32 id][u8 kind][payload]. Kinds: 0
// open (payload: the generation), 1 data, 2 close, 3 log (page to Node), 4
// ready (the device, JSON), 5 no device.
let page = null;
const toPage = [];
let resolveReady, rejectReady;
const ready = new Promise((r, j) => ((resolveReady = r), (rejectReady = j)));
const sockets = new Map();
let nextId = 1;
function sendPage(id, kind, payload) {
	const b = Buffer.alloc(5 + payload.length);
	b.writeUInt32LE(id, 0);
	b[4] = kind;
	b.set(payload, 5);
	if (page) page.send(b);
	else toPage.push(b);
}

const server = createServer((req, res) => {
	const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
	if (p === "/") {
		res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
		res.end(PAGE);
		return;
	}
	if (p === "/kwvk-naga.wasm") {
		if (!existsSync(wasmFile)) {
			res.writeHead(404);
			res.end();
			return;
		}
		res.writeHead(200, { "content-type": "application/wasm", "cache-control": "no-store" });
		res.end(readFileSync(wasmFile));
		return;
	}
	const m = /^\/g[0-9a-f]+\/(.*)$/.exec(p);
	if (m) return serveSource(res, normalize(m[1]));
	res.writeHead(404);
	res.end();
});
server.on("upgrade", (req, socket, head) => {
	page = acceptWebSocket(req, socket, head, (b) => {
		const id = b.readUInt32LE(0), kind = b[4], payload = b.subarray(5);
		if (kind === 1) sockets.get(id)?.write(payload);
		else if (kind === 2) {
			sockets.get(id)?.end();
			sockets.delete(id);
		} else if (kind === 3) say(payload.toString());
		else if (kind === 4) resolveReady(JSON.parse(payload.toString()));
		else if (kind === 5) rejectReady(new Error(payload.toString()));
	}, () => {
		say("relay: the page went away");
		page = null;
	});
	for (const b of toPage.splice(0)) page.send(b);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const profile = mkdtempSync(join(tmpdir(), "kwvk-relay."));
const chrome = spawn(browser, [...WEBGPU_FLAGS, "--no-first-run", `--user-data-dir=${profile}`, pageUrl], { stdio: ["ignore", "ignore", "pipe"] });
let chromeErr = "";
chrome.stderr.on("data", (d) => (chromeErr = (chromeErr + d).slice(-20000)));
chrome.on("error", (e) => {
	console.error(`relay: cannot run ${browser}: ${e.message}`);
	process.exit(2);
});
chrome.on("exit", (c) => {
	say(`relay: the browser exited (${c}); its last output:\n${chromeErr.slice(-3000)}`);
	cleanup(2);
});
function cleanup(code) {
	try {
		chrome.kill("SIGKILL");
	} catch {}
	rmSync(profile, { recursive: true, force: true });
	if (unixPath) try {
		unlinkSync(unixPath);
	} catch {}
	process.exit(code);
}
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => cleanup(0));

let dev;
try {
	dev = await Promise.race([ready, new Promise((_, j) => setTimeout(() => j(new Error("no answer from the page within 60 s")), 60_000))]);
} catch (e) {
	say(`relay: no WebGPU device: ${e.message}\n${chromeErr.slice(-3000)}`);
	cleanup(2);
}
say(`relay: WebGPU adapter "${dev.vendor}" "${dev.architecture}" "${dev.device}" "${dev.description}"; ${dev.features.length} features`);
for (const f of ["vk-host.ts", "vk-shader.ts"]) if (!existsSync(join(root, "js/core", f))) say(`relay: js/core/${f} does not exist yet: connections are refused until it does`);
if (!existsSync(wasmFile)) say(`relay: ${wasmFile} does not exist yet: connections are refused until it does`);

function onSocket(sock) {
	const id = nextId++;
	sockets.set(id, sock);
	sock.setNoDelay?.(true);
	sendPage(id, 0, Buffer.from(generation()));
	sock.on("data", (d) => sendPage(id, 1, d));
	const end = () => {
		if (!sockets.has(id)) return;
		sockets.delete(id);
		sendPage(id, 2, Buffer.alloc(0));
	};
	sock.on("end", end);
	sock.on("close", end);
	sock.on("error", () => {});
}
const tcp = net.createServer(onSocket);
await new Promise((r, j) => tcp.listen(port, "127.0.0.1", r).on("error", j));
const link = `tcp:127.0.0.1:${tcp.address().port}`;
say(`relay: listening on ${link}`);
if (unixPath) {
	try {
		unlinkSync(unixPath);
	} catch {}
	net.createServer(onSocket).listen(unixPath, () => say(`relay: listening on unix:${unixPath}`));
}
if (cmd.length) {
	const env = { ...process.env, KWVK_LINK: link };
	const manifest = join(build, "vk/native/kw_icd.json");
	if (!env.VK_DRIVER_FILES && !env.VK_ICD_FILENAMES) {
		if (existsSync(manifest)) env.VK_DRIVER_FILES = env.VK_ICD_FILENAMES = manifest;
		else say(`relay: no ${manifest}; the loader picks its own drivers`);
	}
	const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit", env });
	child.on("error", (e) => {
		say(`relay: cannot run ${cmd[0]}: ${e.message}`);
		cleanup(2);
	});
	child.on("exit", (code, sig) => {
		// let the page's last log lines arrive
		setTimeout(() => cleanup(code ?? (sig ? 128 : 1)), 300);
	});
}
