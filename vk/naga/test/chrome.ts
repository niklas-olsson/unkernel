// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Runs a page in headless Chrome with WebGPU on SwiftShader (the only setup
// with a WebGPU adapter on the dev host) and returns what the page POSTs
// back as JSON, or throws on exit or timeout. CHROME overrides the binary.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export function inChrome<T>(page: string, timeoutMs = 120_000): Promise<T> {
	const chrome = process.env.CHROME ?? `${homedir()}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`;
	const profile = mkdtempSync(join(tmpdir(), "kwvk-naga-chrome-"));
	return new Promise<T>((resolve, reject) => {
		let proc: ReturnType<typeof spawn> | undefined;
		const server = createServer((req, res) => {
			if (req.method === "POST") {
				const chunks: Buffer[] = [];
				req.on("data", (c: Buffer) => chunks.push(c));
				req.on("end", () => {
					res.end();
					server.close();
					proc?.kill();
					resolve(JSON.parse(Buffer.concat(chunks).toString()) as T);
				});
			} else res.end(page);
		});
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as { port: number }).port;
			proc = spawn(chrome, ["--headless", "--no-sandbox", "--disable-gpu-sandbox", "--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU", "--use-vulkan=swiftshader", "--use-webgpu-adapter=swiftshader", "--ignore-gpu-blocklist", "--disable-dev-shm-usage", `--user-data-dir=${profile}`, `http://127.0.0.1:${port}/`], { stdio: process.env.KWVK_CHROME_LOG ? "inherit" : "ignore" });
			proc.on("error", (e) => reject(e));
			proc.on("exit", (code, sig) => {
				try {
					rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
				} catch {}
				reject(new Error(`chrome exited before reporting (${code ?? sig})`));
			});
			setTimeout(() => {
				proc?.kill();
				server.close();
				reject(new Error("chrome: timeout"));
			}, timeoutMs).unref();
		});
	});
}
