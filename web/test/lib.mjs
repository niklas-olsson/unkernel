// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Shared parts of the browser tests: the page's server (the built Nitro
// output by default, the Vite dev server with --dev) and headless Chromium
// driven over the DevTools protocol. No npm dependencies: Node's built-in
// WebSocket and fetch, and Playwright's cached Chromium if there is one
// (--chrome PATH or CHROME= otherwise).
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const args = process.argv.slice(2);
export const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
export const flag = (n) => args.includes(`--${n}`);
export const verbose = flag("verbose");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChrome({ cli = true, headlessShell = true } = {}) {
	const explicit = cli ? opt("chrome", process.env.CHROME) : process.env.CHROME;
	if (explicit) return explicit;
	const base = path.join(homedir(), ".cache/ms-playwright");
	if (existsSync(base)) {
		for (const d of readdirSync(base).sort().reverse()) {
			const bins = headlessShell ? ["chrome-headless-shell-linux64/chrome-headless-shell", "chrome-linux64/chrome"] : ["chrome-linux64/chrome"];
			for (const rel of bins) {
				const p = path.join(base, d, rel);
				if (existsSync(p)) return p;
			}
		}
	}
	return "chromium";
}

/**
 * Start the page's server on `port`: the built output (web/.output, `pnpm
 * build:web`, or the `output` directory), or with `dev` the Vite dev
 * server. `env` adds variables. Resolves once it answers; kill() stops it.
 */
export async function startServer({ port, host, dev = flag("dev"), env = {}, output = path.join(webDir, ".output"), log = verbose }) {
	const entry = path.join(output, "server/index.mjs");
	let child;
	const stdio = ["ignore", log ? "inherit" : "ignore", "inherit"];
	const allEnv = { ...process.env, ...env };
	if (dev) {
		const vite = path.join(webDir, "node_modules/vite/bin/vite.js");
		child = spawn(process.execPath, [vite, "--port", String(port), "--strictPort", ...(host ? ["--host", host] : [])], { cwd: webDir, stdio, env: allEnv });
	} else {
		if (!existsSync(entry)) throw new Error(`${path.relative(process.cwd(), entry)} is missing: run pnpm build:web first (or pass --dev)`);
		child = spawn(process.execPath, [entry], { cwd: webDir, stdio, env: { ...allEnv, PORT: String(port), ...(host ? { NITRO_HOST: host } : {}) } });
	}
	const exited = new Promise((r) => child.once("exit", r));
	for (let i = 0; i < 300; i++) {
		try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break; } catch {}
		if (child.exitCode !== null) throw new Error(`the ${dev ? "dev" : "built"} server exited with code ${child.exitCode}`);
		await sleep(100);
	}
	return {
		kind: dev ? "vite dev server" : "built Nitro server (web/.output)",
		async kill() { child.kill(); await Promise.race([exited, sleep(2000)]); },
	};
}

/**
 * A page in a fresh headless Chromium (own profile, removed on close()).
 * page.newTab(name) opens another tab in the same browser (same profile);
 * closing the first page ends the browser. Set sandboxed for regular Chromium
 * with its sandbox and default graphics; the test defaults remain software-only.
 */
export async function openPage(name, { shots, profile, sandboxed = false, log = verbose } = {}) {
	let dport = sandboxed ? 0 : 30000 + Math.floor(Math.random() * 20000);
	profile ??= path.join(tmpdir(), `kw-chrome-${process.pid}-${name}`);
	const binary = findChrome({ cli: !sandboxed, headlessShell: !sandboxed });
	if (sandboxed && path.basename(binary) === "chrome-headless-shell") throw Error("sandboxed mode needs regular Chromium; set CHROME to its executable");
	const chrome = spawn(binary, [
		"--headless=new", ...(sandboxed ? ["--remote-debugging-address=127.0.0.1"] : ["--no-sandbox", "--disable-gpu"]),
		"--hide-scrollbars", `--remote-debugging-port=${dport}`,
		`--user-data-dir=${profile}`, "about:blank",
	], { stdio: ["ignore", "ignore", "pipe"] });
	let spawnError, diagnostics = "";
	const exited = new Promise(resolve => {
		chrome.once("exit", resolve);
		chrome.once("error", error => { spawnError = error; resolve(); });
	});
	chrome.stderr.on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-4000); });
	const closeChrome = async () => {
		chrome.kill();
		await Promise.race([exited, sleep(2000)]);
		try { rmSync(profile, { recursive: true, force: true }); } catch {}
	};
	let target;
	for (let i = 0; i < 100 && !target && !spawnError && chrome.exitCode === null && chrome.signalCode === null; i++) {
		await sleep(100);
		try {
			if (!dport) dport = Number(readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
			if (dport) target = (await (await fetch(`http://127.0.0.1:${dport}/json/list`, { signal: AbortSignal.timeout(500) })).json()).find((t) => t.type === "page");
		} catch {}
	}
	if (!target) {
		await closeChrome();
		const detail = spawnError?.message ?? diagnostics.trim();
		throw new Error(`${sandboxed ? "sandboxed Chromium" : "Chromium"} did not start (${binary})${detail ? ":\n" + detail : ""}`);
	}
	let page;
	try {
		page = await attachTarget(target, name, { shots, log });
	} catch (error) {
		await closeChrome();
		throw error;
	}
	page.newTab = async (tabName) => {
		const t = await (await fetch(`http://127.0.0.1:${dport}/json/new?about:blank`, { method: "PUT" })).json();
		const tab = await attachTarget(t, tabName, { shots, log });
		tab.close = async () => {
			await tab.send("Page.close").catch(() => {});
			try { tab.ws.close(); } catch {}
		};
		return tab;
	};
	page.close = async () => {
		try { page.ws.close(); } catch {}
		await closeChrome();
	};
	return page;
}

/** A DevTools session on one page target. */
async function attachTarget(target, name, { shots, log = verbose } = {}) {
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
	let id = 0;
	const pending = new Map();
	const exceptions = [], consoleLines = [], listeners = [];
	ws.onmessage = (m) => {
		const msg = JSON.parse(m.data);
		for (const l of listeners) l(msg);
		if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
		if (msg.method === "Runtime.consoleAPICalled") {
			const line = msg.params.args.map((a) => a.value ?? a.description).join(" ");
			consoleLines.push(line);
			if (log) console.error(`  [${name} console]`, line);
		}
		if (msg.method === "Runtime.exceptionThrown") {
			const d = msg.params.exceptionDetails;
			exceptions.push(d.exception?.description ?? d.text);
			if (log) console.error(`  [${name} exception]`, d.exception?.description ?? d.text);
		}
	};
	const send = (method, params = {}) => new Promise((r) => {
		pending.set(++id, r);
		ws.send(JSON.stringify({ id, method, params }));
	});
	const evaluate = async (expr) => {
		const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
		if (r.result?.exceptionDetails) throw new Error(`evaluate failed: ${r.result.exceptionDetails.exception?.description ?? expr}`);
		return r.result?.result?.value;
	};
	await send("Runtime.enable");
	await send("Page.enable");
	let n = 0;
	const page = {
		name, ws, send, evaluate, exceptions, consoleLines, on: (fn) => listeners.push(fn),
		async emulate(m, { touch = false, ua } = {}) {
			await send("Emulation.setDeviceMetricsOverride", m);
			await send("Emulation.setTouchEmulationEnabled", { enabled: touch, maxTouchPoints: touch ? 5 : 0 });
			if (touch) await send("Emulation.setEmitTouchEventsForMouse", { enabled: true, configuration: "mobile" });
			if (ua) await send("Emulation.setUserAgentOverride", { userAgent: ua });
		},
		// The page's thread on one CPU unless the URL says otherwise: the tests type
		// through globalThis.kernel, which worker mode (the page's default) has not.
		goto: (url) => {
			const u = new URL(url);
			if (!u.searchParams.has("worker")) u.searchParams.set("worker", "0");
			if (!u.searchParams.has("cpus")) u.searchParams.set("cpus", "1");
			// The console stays up: the page would minimize an unused one a few seconds after boot (autohide.ts).
			if (!u.searchParams.has("autohide")) u.searchParams.set("autohide", "0");
			return send("Page.navigate", { url: u.href });
		},
		async waitFor(expr, what, ms = 90000) {
			const end = performance.now() + ms;
			let v;
			while (performance.now() < end) {
				try { v = await evaluate(expr); } catch { v = null; }
				if (v) return v;
				await sleep(200);
			}
			throw new Error(`timeout waiting for ${what}\n  state: ${await evaluate("document.getElementById('app')?.dataset.state")}\n  screen:\n${await page.screen()}`);
		},
		screen: () => evaluate("globalThis.KW?.screenText ? KW.screenText().replace(/\\n+$/, '') : (document.body?.innerText ?? '')"),
		state: () => evaluate("document.getElementById('app').dataset.state"),
		async waitScreen(re, what = String(re), ms = 120000) {
			await page.waitFor(`(() => { const s = globalThis.KW?.screenText ? KW.screenText() : ''; return ${re}.test(s); })()`, what, ms);
			return page.screen();
		},
		/** Type into the guest's console. */
		type: (s) => evaluate(`globalThis.kernel.sendInput(${JSON.stringify(s)})`),
		/** Run a shell command; resolves with the text between its markers, its exit code and the time it took. */
		async run(cmd, ms = 120000) {
			const tag = `KW${++n}`;
			const t0 = performance.now();
			await page.type(`clear; echo ${tag}-BEGIN; ${cmd}; echo ${tag}-END-$?\r`);
			const s = await page.waitScreen(new RegExp(`^${tag}-END-\\d+`, "m"), `${tag} (${cmd})`, ms);
			const out = s.slice(s.lastIndexOf(`${tag}-BEGIN`) + tag.length + 7, s.search(new RegExp(`^${tag}-END`, "m"))).trim();
			const rc = Number(s.match(new RegExp(`^${tag}-END-(\\d+)`, "m"))[1]);
			return { out, rc, secs: (performance.now() - t0) / 1000 };
		},
		async shot(file) {
			if (!shots) return;
			await sleep(350); // let transitions settle
			// Chromium sometimes answers with an error (no frame yet, e.g. right
			// after an emulation change): try again.
			let r;
			for (let i = 0; i < 5 && !(r = await send("Page.captureScreenshot", { format: "png" })).result?.data; i++) await sleep(200);
			if (!r.result?.data) throw new Error(`screenshot ${file} failed: ${JSON.stringify(r.error ?? r)}`);
			const p = path.join(shots, file);
			writeFileSync(p, Buffer.from(r.result.data, "base64"));
			console.log(`  screenshot ${p}`);
		},
		async center(sel) {
			const r = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: "nearest", inline: "nearest" }); const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
			if (!r) throw new Error(`no element ${sel}`);
			return r;
		},
		async tap(sel) {
			const [x, y] = await page.center(sel);
			await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
			await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
			await sleep(80);
		},
		/** A quick one-finger drag by dy pixels (positive: finger moves down) from the centre of sel. */
		async swipe(sel, dy, steps = 6) {
			const [x, y] = await page.center(sel);
			await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
			for (let i = 1; i <= steps; i++) {
				await sleep(8);
				await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + (dy * i) / steps }] });
			}
			await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
		},
		async click(sel) {
			const [x, y] = await page.center(sel);
			for (const type of ["mousePressed", "mouseReleased"])
				await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
			await sleep(80);
		},
		typeText: (text) => send("Input.insertText", { text }),
		async enter() {
			for (const type of ["keyDown", "keyUp"])
				await send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) });
		},
		/** Replaced by openPage() and newTab(). */
		async close() { try { ws.close(); } catch {} },
	};
	return page;
}

/** The prompt is "~ ⇒ " (each distro's rootfs/etc/profile.d/kw-prompt.sh under guest/distro/), or a plain one ending in :~# or :~$. */
export const PROMPT = /(:~[#$]|⇒)\s*$/m;
