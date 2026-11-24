// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Translates every *.vert.spv / *.frag.spv / *.comp.spv under the given
// directories (corpus.sh makes a real-world set), compiles each WGSL in
// WebGPU (headless Chrome), and prints the pass rate per directory and the
// failures bucketed by cause.
//
//   node vk/naga/test/corpus.ts DIR... [--no-gpu] [--features shader-f16,...] [--list BUCKET-SUBSTRING]

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadVkShader } from "../../../js/core/vk-shader.ts";
import { inChrome } from "./chrome.ts";

const args = process.argv.slice(2);
const listAt = args.indexOf("--list");
const list = listAt >= 0 ? args.splice(listAt, 2)[1] : undefined;
const noGpu = args.includes("--no-gpu");
const featAt = args.indexOf("--features");
const features = featAt >= 0 ? args.splice(featAt, 2)[1].split(",") : [];
const dirs = args.filter((a) => !a.startsWith("--"));
const t = await loadVkShader(new URL("../../../vendor/build/vk/kwvk-naga.wasm", import.meta.url));

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
interface Item { file: string; group: string; wgsl?: string; error?: string }
const items: Item[] = [];
for (const d of dirs) {
	for (const file of walk(d)) {
		const stage = /\.vert\.spv$/.test(file) ? "vertex" : /\.frag\.spv$/.test(file) ? "fragment" : /\.comp\.spv$/.test(file) ? "compute" : undefined;
		if (!stage) continue;
		const group = file.slice(0, file.lastIndexOf("/"));
		// Descriptor arrays get bindings from 64 up, as a host would assign.
		const arrays: Record<string, { base: number; count: number }> = {};
		for (let tries = 0; ; tries++) {
			try {
				items.push({ file, group, wgsl: t.translate(readFileSync(file), { stage, entryPoint: "main", flipY: stage === "vertex", pushGroup: 4, arrays, features }).wgsl });
			} catch (e) {
				const m = /set (\d+) binding (\d+) \((\d+) elements\): the host must/.exec((e as Error).message);
				if (m && tries < 16) {
					arrays[`${m[1]}.${m[2]}`] = { base: 64 + 64 * tries, count: +m[3] };
					continue;
				}
				items.push({ file, group, error: `translate: ${(e as Error).message}` });
			}
			break;
		}
	}
}

if (!noGpu) {
	const ok = items.filter((i) => i.wgsl);
	const page = `<!doctype html><meta charset="utf-8"><script type="module">
const code = ${JSON.stringify(ok.map((i) => i.wgsl))};
const res = [];
const adapter = await navigator.gpu.requestAdapter();
const device = await adapter.requestDevice({ requiredFeatures: [...adapter.features].filter((f) => ["clip-distances", "shader-f16", "dual-source-blending", "subgroups"].includes(f)), requiredLimits: { maxBindGroups: adapter.limits.maxBindGroups } });
for (const c of code) {
	device.pushErrorScope("validation");
	const m = device.createShaderModule({ code: c });
	const info = await m.getCompilationInfo();
	const err = await device.popErrorScope();
	const msgs = info.messages.filter((x) => x.type === "error").map((x) => x.message);
	res.push(msgs.length ? msgs[0] : err ? err.message : "");
}
await fetch("/r", { method: "POST", body: JSON.stringify(res) });
</script>`;
	const res = await inChrome<string[]>(page, 600_000);
	ok.forEach((i, k) => {
		if (res[k]) i.error = `webgpu: ${res[k].split("\n")[0]}`;
	});
}

const groups = new Map<string, [number, number]>();
const buckets = new Map<string, string[]>();
for (const i of items) {
	const g = groups.get(i.group) ?? [0, 0];
	g[1]++;
	if (!i.error) g[0]++;
	groups.set(i.group, g);
	if (i.error) {
		const key = i.error.replace(/\[\d+\]|%\d+|\d+/g, "N").replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "'X'").slice(0, 160);
		buckets.set(key, [...(buckets.get(key) ?? []), i.file]);
	}
}
let pass = 0;
for (const [g, [p, n]] of groups) {
	pass += p;
	console.log(`${g}: ${p}/${n}`);
}
console.log(`total: ${pass}/${items.length} (${((100 * pass) / items.length).toFixed(1)}%)`);
for (const [k, files] of [...buckets].sort((a, b) => b[1].length - a[1].length)) {
	console.log(`${String(files.length).padStart(4)}  ${k}\n      e.g. ${files[0]}`);
	if (list && k.includes(list)) for (const f of files) console.log(`        ${f}  ${items.find((i) => i.file === f)?.error}`);
}
