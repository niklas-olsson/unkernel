// SPDX-License-Identifier: MIT
// Copyright 2026 the unkernel contributors
import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { posix } from "node:path";
import { parseArgs } from "node:util";
import { openPage, startServer } from "../web/test/lib.mjs";

const usage = "Usage: node test/desktop-trace.mjs [--url BASE] [--out FILE] [--cpus N] [--timeout-ms N] [-- /absolute/guest/program arg ...]";
const help = usage + "\n\n" +
	"Record one command in a fresh headless Debian desktop. With no command,\n" +
	"the guest hashes 128 MiB of zeroes. The guest has no persistent disk or network.\n\n" +
	"  --url BASE  Use an existing HTTP(S) desktop with the trace API. By default,\n" +
	"              serve web/.output on a free loopback port (pnpm build:web first).\n" +
	"  --out FILE  Write the JSON trace to FILE instead of stdout.\n" +
	"  --cpus N    Request 1–16 guest CPUs (default 2; needs a supported SMP build).\n" +
	"  --timeout-ms N  Abort the guest command after N milliseconds (default 120000).\n" +
	"  --help      Show this help. Set CHROME to a regular Chromium executable.\n\n" +
	"Chromium runs headless with its sandbox and default graphics. Multiple\n" +
	"guest CPUs require cross-origin isolation on a secure origin (HTTPS or\n" +
	"loopback), with the desktop's COOP and COEP response headers.\n\n" +
	"The command result is stored under command in the trace, including its guest\n" +
	"exit status and output. A failed command still produces a trace and exits nonzero.\n";
const defaultCommand = ["/bin/sh", "-ec", "head -c 134217728 /dev/zero | sha256sum"];

function options() {
	const args = process.argv.slice(2);
	const separator = args.indexOf("--");
	const flags = separator === -1 ? args : args.slice(0, separator);
	const { values } = parseArgs({ args: flags, options: {
		url: { type: "string" },
		out: { type: "string" },
		cpus: { type: "string", default: "2" },
		"timeout-ms": { type: "string", default: "120000" },
		help: { type: "boolean", short: "h" },
	} });
	if (values.help) return { help: true };
	const cpus = Number(values.cpus);
	if (!/^[0-9]+$/.test(values.cpus) || cpus < 1 || cpus > 16) throw Error("--cpus must be an integer from 1 to 16");
	const commandTimeout = Number(values["timeout-ms"]);
	if (!Number.isSafeInteger(commandTimeout) || commandTimeout <= 0 || commandTimeout > 2147483647 - 5000)
		throw Error("--timeout-ms must be a positive millisecond timeout within the timer range");
	if (values.out === "") throw Error("--out needs a file path");
	const url = values.url === undefined ? null : new URL(values.url);
	if (url && (!["http:", "https:"].includes(url.protocol) || url.username || url.password)) {
		throw Error("--url must be an HTTP(S) desktop URL without credentials");
	}
	const argv = separator === -1 ? [] : args.slice(separator + 1);
	if (argv.length && !argv[0].startsWith("/")) throw Error("the guest program must use an absolute path");
	return { url, cpus, commandTimeout, out: values.out, argv: argv.length ? argv : defaultCommand };
}

async function freePort() {
	const probe = createServer();
	const port = await new Promise((resolve, reject) => {
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => resolve(probe.address().port));
	});
	await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
	return port;
}

async function bounded(promise, ms, label) {
	let timer;
	try {
		return await Promise.race([promise, new Promise((_, reject) => {
			timer = setTimeout(() => reject(Error("timed out waiting for " + label)), ms);
		})]);
	} finally {
		clearTimeout(timer);
	}
}

async function record({ url, cpus, argv, commandTimeout }) {
	let server, page;
	try {
		if (!url) {
			const port = await freePort();
			server = await startServer({ port, host: "127.0.0.1", dev: false, log: false });
			url = new URL("http://127.0.0.1:" + port);
		}
		const settings = { trace: 1, distro: "debian", worker: 1, cpus, data: 0, wisp: 0, autosuspend: 0, askleave: 0 };
		for (const [name, value] of Object.entries(settings)) url.searchParams.set(name, String(value));
		page = await openPage("desktop-trace", { sandboxed: true, log: false });
		const nav = await bounded(page.goto(url), 15000, "desktop navigation");
		if (nav.error || nav.result?.errorText) throw Error("desktop navigation failed: " + (nav.result?.errorText ?? nav.error.message));
		await bounded(page.waitFor("typeof globalThis.KW?.ready === 'function'", "the desktop boot API", 50000), 55000, "the desktop boot API");
		const ready = await bounded(page.evaluate("KW.ready().then(vm => ({ cpus: vm.stats().cpus, worker: KW.config.worker, guest: KW.config.guest, data: KW.config.data, isolated: crossOriginIsolated, reason: KW.config.smpWhy, trace: typeof KW.trace?.start === 'function' && typeof KW.trace?.stop === 'function' }))"), 120000, "Debian guest readiness");
		if (!ready?.trace) throw Error("the page does not expose KW.trace.start/stop");
		if (ready.cpus !== cpus || !ready.worker || ready.guest !== "debian" || ready.data !== false) {
			throw Error("unexpected desktop configuration: " + JSON.stringify(ready));
		}

		const label = ("desktop-trace " + posix.basename(argv[0])).slice(0, 128).replace(/[\uD800-\uDBFF]$/, "");
		await bounded(page.evaluate("(async () => { await KW.trace.start(" + JSON.stringify(label) + "); return true; })()"), 30000, "trace startup");
		const [program, ...args] = argv;
		let command;
		try {
			const exec = "KW.vm.exec(" + JSON.stringify(program) + "," + JSON.stringify(args) +
				",{ signal: AbortSignal.timeout(" + commandTimeout + "), maxBuffer: 1024 * 1024 })";
			const result = await bounded(page.evaluate(exec), commandTimeout + 5000, "the guest command");
			if (!result || !(result.exitCode === null || Number.isInteger(result.exitCode))) {
				throw Error("invalid guest command result");
			}
			command = { argv, ...result };
		} catch (error) {
			command = { argv, exitCode: null, signal: null, error: error.message };
		}
		const trace = await bounded(page.evaluate("KW.trace.stop()"), 120000, "trace export");
		if (!trace || !Array.isArray(trace.traceEvents)) throw Error("the page returned no traceEvents array");
		return { ...trace, command };
	} finally {
		await Promise.allSettled([page?.close(), server?.kill()]);
	}
}

try {
	const config = options();
	if (config.help) {
		process.stdout.write(help);
	} else {
		const trace = await record(config);
		const output = JSON.stringify(trace) + "\n";
		if (config.out) await writeFile(config.out, output);
		else process.stdout.write(output);
		const { exitCode, signal, error } = trace.command;
		if (error || signal !== null || exitCode !== 0) {
			console.error("desktop-trace: " + (error ?? (signal === null ? "guest exited with status " + exitCode : "guest ended with signal " + signal)));
			process.exitCode = typeof exitCode === "number" && exitCode > 0 && exitCode <= 255 ? exitCode : 1;
		}
	}
} catch (error) {
	console.error("desktop-trace: " + error.message);
	process.exitCode = 1;
}
