// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Tests kwvk-naga.wasm through js/core/vk-shader.ts: translates the SPIR-V
// in shaders/ (compiled from the GLSL next to it by compile.sh), checks the
// WGSL and the reflection, then validates every output in a real WebGPU
// (headless Chrome on SwiftShader): createShaderModule, getCompilationInfo
// and pipelines with explicit layouts built from the reflected bindings.
//
//   node vk/naga/test/run.ts [--no-gpu]      exit 0 on success, 1 on failure

import { readdirSync, readFileSync } from "node:fs";
import { inChrome } from "./chrome.ts";
import { loadVkShader, type VkShaderOpts, type VkShaderResult } from "../../../js/core/vk-shader.ts";

const here = new URL("./shaders/", import.meta.url);
const wasm = new URL("../../../vendor/build/vk/kwvk-naga.wasm", import.meta.url);
const t = await loadVkShader(wasm);

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
	if (!ok) failed++;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail && !ok ? `: ${detail}` : ""}`);
};

const out: Record<string, VkShaderResult> = {};
const run = (name: string, file: string, opts: VkShaderOpts) => {
	try {
		out[name] = t.translate(readFileSync(new URL(file, here)), opts);
		return out[name];
	} catch (e) {
		check(`${name} translates`, false, (e as Error).message);
		return undefined;
	}
};
const has = (r: VkShaderResult | undefined, re: RegExp) => !!r && re.test(r.wgsl);

const cv = run("cube.vert", "cube.vert.spv", { stage: "vertex", entryPoint: "main", flipY: true });
check("cube.vert: UBO at @binding(0)", has(cv, /@group\(0\) @binding\(0\)\s*var<uniform>/));
check("cube.vert: flipY negates position.y", has(cv, /gl_Position\.y = -\(/));
check("cube.vert: reflection", JSON.stringify(cv?.bindings) === JSON.stringify([{ set: 0, binding: 0, group: 0, wgslBinding: 0, kind: "uniform" }]), JSON.stringify(cv?.bindings));
const cvn = run("cube.vert.noflip", "cube.vert.spv", { stage: "vertex", entryPoint: "main", flipY: false });
check("cube.vert: no flip without flipY", !!cvn && !has(cvn, /\.y = -\(/));

const cf = run("cube.frag", "cube.frag.spv", { stage: "fragment", entryPoint: "main" });
check("cube.frag: derivative_uniformity off", has(cf, /^diagnostic\(off, derivative_uniformity\);/));
check("cube.frag: texture at 2, sampler at 3", has(cf, /@binding\(2\)\s*var tex: texture_2d<f32>/) && has(cf, /@binding\(3\)\s*var tex_sampler: sampler;/));
check("cube.frag: reflection", cf?.bindings.length === 2 && cf.bindings[0].kind === "texture" && cf.bindings[0].binding === 1 && cf.bindings[0].sampleType === "float" && cf.bindings[1].kind === "sampler" && cf.bindings[1].wgslBinding === 3, JSON.stringify(cf?.bindings));

const pv = run("push.vert", "push.vert.spv", { stage: "vertex", entryPoint: "main", flipY: true, pushGroup: 1 });
check("push.vert: push constants at @group(1) @binding(0)", has(pv, /@group\(1\) @binding\(0\)\s*var<uniform> pc/));
check("push.vert: pushConstantSize 80", pv?.pushConstantSize === 80, String(pv?.pushConstantSize));
check("push.vert: gl_PointSize dropped from outputs", !!pv && !/point_size/.test(pv.wgsl));
check("push.vert: no bindings", pv?.bindings.length === 0, JSON.stringify(pv?.bindings));

const sf = run("spec.frag", "spec.frag.spv", { stage: "fragment", entryPoint: "main", spec: { 0: 2.5, 2: true, 99: 1 } });
check("spec.frag: no override left", !!sf && !/override/.test(sf.wgsl));
check("spec.frag: values baked", has(sf, /scale: f32 = 2\.5f/) && has(sf, /invert: bool = true/) && has(sf, /count: i32 = 2i/));
check("spec.frag: set 1 binding 2 -> @group(1) @binding(4)", has(sf, /@group\(1\) @binding\(4\)/));
const sd = run("spec.frag.default", "spec.frag.spv", { stage: "fragment", entryPoint: "main" });
check("spec.frag: defaults baked", has(sd, /scale: f32 = 1f/) && has(sd, /invert: bool = false/));

const bc = run("buffer.comp", "buffer.comp.spv", { stage: "compute", entryPoint: "main" });
check("buffer.comp: storage kinds", bc?.bindings.map((b) => `${b.wgslBinding}:${b.kind}`).join() === "0:read-only-storage,2:storage", JSON.stringify(bc?.bindings));
check("buffer.comp: runtime array", has(bc, /array<f32>/) && has(bc, /arrayLength/));
// Older glslang (llama.cpp's release builds) marks `readonly buffer` only on the block's members:
// the same module without the variables' NonWritable must still be read-only.
{
	const w = new Uint32Array(Uint8Array.from(readFileSync(new URL("buffer.comp.spv", here))).buffer);
	const kept: number[] = [...w.subarray(0, 5)];
	for (let i = 5; i < w.length; i += w[i] >>> 16) {
		const n = w[i] >>> 16;
		if (!((w[i] & 0xffff) === 71 && n === 3 && w[i + 2] === 24)) kept.push(...w.subarray(i, i + n)); // OpDecorate %var NonWritable
	}
	let mo: VkShaderResult | undefined;
	try { mo = t.translate(new Uint8Array(new Uint32Array(kept).buffer), { stage: "compute", entryPoint: "main" }); } catch (e) { check("buffer.comp, member-only NonWritable: translates", false, (e as Error).message); }
	check("buffer.comp, member-only NonWritable: still read-only", kept.length < w.length && mo?.bindings.map((b) => `${b.wgslBinding}:${b.kind}`).join() === "0:read-only-storage,2:storage", `${w.length - kept.length} words dropped; ${JSON.stringify(mo?.bindings)}`);
}

const ic = run("image.comp", "image.comp.spv", { stage: "compute", entryPoint: "main" });
const ib = ic?.bindings[0];
check("image.comp: storage texture", ib?.kind === "storage-texture" && ib.format === "rgba8unorm" && ib.access === "write-only" && ib.wgslBinding === 6 && ib.viewDimension === "2d", JSON.stringify(ic?.bindings));

const sh = run("shadow.frag", "shadow.frag.spv", { stage: "fragment", entryPoint: "main" });
check("shadow.frag: depth texture + comparison sampler", has(sh, /texture_depth_2d/) && has(sh, /sampler_comparison/) && has(sh, /textureSampleCompare/));
check("shadow.frag: reflection", sh?.bindings.map((b) => `${b.wgslBinding}:${b.kind}:${b.sampleType ?? ""}`).join() === "0:texture:depth,1:comparison-sampler:,2:texture:float,3:sampler:", JSON.stringify(sh?.bindings));

const mv = run("mrt.vert", "mrt.vert.spv", { stage: "vertex", entryPoint: "main", flipY: true });
check("mrt.vert: flipY with a vertex output block", has(mv, /\.y = -\(/));
const mf = run("mrt.frag", "mrt.frag.spv", { stage: "fragment", entryPoint: "main" });
check("mrt.frag: two outputs", has(mf, /@location\(1\)/));

const fp = run("funcparam.frag", "funcparam.frag.spv", { stage: "fragment", entryPoint: "main" });
check("funcparam.frag: sampler2D parameter split", has(fp, /s: texture_2d<f32>, s_sampler: sampler/) && has(fp, /\(a, a_sampler,/));
check("funcparam.frag: reflection", fp?.bindings.map((b) => `${b.binding}/${b.wgslBinding}:${b.kind}`).join() === "0/0:texture,0/1:sampler,1/2:texture,1/3:sampler", JSON.stringify(fp?.bindings));
const lv = run("lit.vert", "lit.vert.spv", { stage: "vertex", entryPoint: "main", flipY: true });
check("lit.vert: mat3 UBO, flat int output", has(lv, /mat3x3<f32>/) && has(lv, /@interpolate\(flat\) member_1: i32/));
run("lit.frag", "lit.frag.spv", { stage: "fragment", entryPoint: "main" });
const s1 = run("std140.frag", "std140.frag.spv", { stage: "fragment", entryPoint: "main", pushGroup: 1 });
check("std140.frag: float[4] stride 16 wrapped", has(s1, /weights: array<type_\d+, 4>/) && has(s1, /w\.weights\[\w+\]\.member;/));
check("std140.frag: push block size 16", s1?.pushConstantSize === 16, String(s1?.pushConstantSize));
const of = run("offset.frag", "offset.frag.spv", { stage: "fragment", entryPoint: "main", pushGroup: 1 });
check("offset.frag: push range at offset 64 padded", has(of, /_kwvk_pad: array<vec4<u32>, 4>,\s*@size\(32\) color: vec4<f32>,\s*k: f32,/));
check("offset.frag: UBO explicit offsets", has(of, /@size\(48\) a: vec4<f32>,\s*@size\(32\) b: vec4<f32>,\s*c: f32,/));
check("offset.frag: pushConstantSize covers offset 96", of?.pushConstantSize === 112, String(of?.pushConstantSize));
const sw = run("specwg.comp", "specwg.comp.spv", { stage: "compute", entryPoint: "main", spec: { 0: 64, 1: 8 } });
check("specwg.comp: workgroup size from a spec constant", has(sw, /@workgroup_size\(64, 1, 1\)/));
check("specwg.comp: shared array sized by a spec constant expression", has(sw, /var<workgroup> tmp: array<f32, 17>;/));
const tx = run("textures.frag", "textures.frag.spv", { stage: "fragment", entryPoint: "main" });
check("textures.frag: kinds", tx?.bindings.map((b) => `${b.wgslBinding}:${b.kind}:${b.viewDimension ?? ""}:${b.sampleType ?? ""}`).join() === "0:texture:2d:float,2:sampler::,4:texture:cube:float,5:sampler::,6:texture:3d:float,7:sampler::,8:texture:2d-array:float,9:sampler::,10:texture:2d:uint,11:sampler::,12:texture:2d:sint,13:sampler::,0:storage::", JSON.stringify(tx?.bindings));
const cl = run("clip.vert", "clip.vert.spv", { stage: "vertex", entryPoint: "main", flipY: true });
check("clip.vert: clip_distances enabled", has(cl, /^enable clip_distances;/));
const ly = run("layout.frag", "layout.frag.spv", { stage: "fragment", entryPoint: "main" });
check("layout.frag: std140 struct array padded to stride 16", has(ly, /struct (\w+) \{\s*@size\(16\) a: f32,\s*\}/) && has(ly, /@size\(16\) f: f32,\s*s: array<\w+, 3>,/));
check("layout.frag: row-major matrix transposed on load", has(ly, /transpose\(/));

const arraysAll = { "0.0": { base: 0, count: 3 }, "0.1": { base: 6, count: 2 }, "0.2": { base: 10, count: 2 }, "1.0": { base: 0, count: 2 } };
const ar = run("arrays.frag", "arrays.frag.spv", { stage: "fragment", entryPoint: "main", arrays: arraysAll });
check("arrays.frag: reflection with arrayIndex", ar?.bindings.map((b) => `${b.set}.${b.binding}[${b.arrayIndex}]@${b.wgslBinding}:${b.kind}`).join() === "0.0[0]@0:texture,0.0[0]@1:sampler,0.0[1]@2:texture,0.0[1]@3:sampler,0.0[2]@4:texture,0.0[2]@5:sampler,0.1[0]@6:texture,0.1[1]@8:texture,0.2[0]@10:sampler,0.2[1]@12:sampler,1.0[0]@0:uniform,1.0[1]@2:uniform", JSON.stringify(ar?.bindings));
check("arrays.frag: constant index resolved", has(ar, /textureSample\(tex_1_, tex_1_sampler, _e\d+\)/) && has(ar, /textureSample\(images_0_, samplers_1_,/));
check("arrays.frag: dynamic index switches", has(ar, /case 2: \{\s*let _e\d+ = textureSample\(tex_2_, tex_2_sampler/) && has(ar, /default: \{\s*let _e\d+ = ubos_0_\.color;/) && !!ar && !/enable wgpu_binding_array/.test(ar.wgsl));
try {
	t.translate(readFileSync(new URL("arrays.frag.spv", here)), { stage: "fragment", entryPoint: "main" });
	check("arrays.frag: without opts.arrays throws", false);
} catch (e) {
	check("arrays.frag: without opts.arrays throws", /opts\.arrays/.test((e as Error).message), (e as Error).message);
}

const gv = run("gtkish.vert", "gtkish.vert.spv", { stage: "vertex", entryPoint: "main", flipY: true, spec: { 0: 1 } });
check("gtkish.vert: array varyings flattened to consecutive locations", [1, 2, 3, 4].every((l) => has(gv, new RegExp(`@location\\(${l}\\) @interpolate\\(flat\\) \\w+: vec4<f32>,`))));
const gf = run("gtkish.frag", "gtkish.frag.spv", { stage: "fragment", entryPoint: "main", spec: { 1: 2 }, arrays: { "0.0": { base: 0, count: 3 } } });
check("gtkish.frag: array element through a spec-constant if chain", has(gf, /textureSample\(TEX_1_, TEX_1_sampler/));
const sp = run("subpass.frag", "subpass.frag.spv", { stage: "fragment", entryPoint: "main" });
check("subpass.frag: input attachment as textureLoad at the fragment position", has(sp, /var inColor: texture_2d<f32>;/) && has(sp, /textureLoad\(inColor, /) && sp?.bindings[0].kind === "texture");
check("subpass.frag: gl_PointCoord is vec2(0.5), write-only buffer readable", has(sp, /vec2<f32>\(0\.5f, 0\.5f\)/) && has(sp, /var<storage, read_write> outBuf/));
const dm = run("demote.v13.frag", "demote.v13.frag.spv", { stage: "fragment", entryPoint: "main" });
check("demote.v13.frag: SPIR-V 1.6 demote and OpCopyLogical", has(dm, /discard;/) && has(dm, /var copy: L;/));

const pr = run("paired.frag", "paired.frag.spv", { stage: "fragment", entryPoint: "main" });
check("paired.frag: texture and sampler sharing a binding -> 2b, 2b+1", pr?.bindings.map((b) => `${b.binding}@${b.wgslBinding}:${b.kind}`).join() === "0@0:texture,0@1:sampler", JSON.stringify(pr?.bindings));

const nf = run("noformat.comp", "noformat.comp.spv", { stage: "compute", entryPoint: "main" });
check("noformat.comp: default formats by sampled type", has(nf, /texture_storage_2d<rgba8unorm,write>/) && has(nf, /texture_storage_2d<rgba32uint,write>/));
const nf2 = run("noformat.comp.rgba16f", "noformat.comp.spv", { stage: "compute", entryPoint: "main", storageFormats: { "0.0": "rgba16float" } });
check("noformat.comp: opts.storageFormats", has(nf2, /var img: texture_storage_2d<rgba16float,write>/) && nf2?.bindings[0].format === "rgba16float", JSON.stringify(nf2?.bindings));
{
	// Interpolation linked to the vertex stage: lit.frag's flat int stays,
	// its perspective vec4 input becomes flat when the vertex side says so.
	const lf = run("lit.frag.linked", "lit.frag.spv", { stage: "fragment", entryPoint: "main", link: [{ location: 0, interpolation: "flat", sampling: "" }] });
	check("opts.link matches interpolation", has(lf, /@location\(0\) @interpolate\(flat\) vVaryingColor: vec4<f32>/));
	check("vertex result lists varyings", JSON.stringify(lv?.varyings) === JSON.stringify([{ location: 0, interpolation: "perspective", sampling: "center" }, { location: 1, interpolation: "flat", sampling: "" }]), JSON.stringify(lv?.varyings));
}

const dv = run("dynvary.vert", "dynvary.vert.spv", { stage: "vertex", entryPoint: "main", flipY: true });
check("dynvary.vert: dynamic array varying via a private shadow, struct varyings at their locations", [0, 1, 2, 3, 4].every((l) => has(dv, new RegExp(`@location\\(${l}\\) @interpolate\\(flat\\)`))));
run("dynvary.frag", "dynvary.frag.spv", { stage: "fragment", entryPoint: "main", link: dv?.varyings });

const dp = run("drawparams.vert", "drawparams.vert.spv", { stage: "vertex", entryPoint: "main", flipY: true });
check("drawparams.vert: BaseVertex/BaseInstance/DrawIndex read as 0", !!dp && !/builtin\((base|draw)/.test(dp.wgsl));

const fd = run("fastdiv.comp", "fastdiv.comp.spv", { stage: "compute", entryPoint: "main", pushGroup: 1, spec: { 0: 128 } });
check("fastdiv.comp: umulExtended lowered, std430 push array repacked, no inf, spec-sized shared array", !!fd && !/inf/i.test(fd.wgsl) && has(fd, /var<uniform> \w+: kw_words;/) && has(fd, /array<f32, 64>/) && has(fd, /@workgroup_size\(128, 1, 1\)/) && JSON.stringify(fd.requires) === "[]", fd?.wgsl.slice(0, 0));

// A std430 push block WGSL's uniform address space cannot lay out
// (Firefox and Safari refuse arrays of stride 4 there): vec4<u32> words,
// run below with known bytes. A block that fits keeps its struct.
const pk = run("pushpack.comp", "pushpack.comp.spv", { stage: "compute", entryPoint: "main", pushGroup: 1 });
check("pushpack.comp: push block repacked into vec4<u32> words", has(pk, /var<uniform> p: kw_words;/) && has(pk, /w: array<vec4<u32>, 8>,/) && pk?.pushConstantSize === 128, String(pk?.pushConstantSize));
check("push.vert: a push block that fits keeps its struct", !!pv && !/kw_words/.test(pv.wgsl));
const pushpack = (() => {
	const buf = new ArrayBuffer(128);
	const f = new Float32Array(buf), u = new Uint32Array(buf), s = new Int32Array(buf);
	u[0] = 7;
	[f[1], f[2]] = [1.5, -2.25];
	s.set([10, -20, 30, -40], 3);
	f.set([0.5, 0.25, 0.125, 3, 100], 8);
	u.set([1, 2, 3], 13);
	f.set([5, 6, 7, 8, 1, 2, 3, 4], 16);
	for (let c = 0; c < 2; c++) for (let r = 0; r < 3; r++) f[(96 + 8 * r + 4 * c) / 4] = 10 * c + r + 0.5; // row-major mat2x3: rm[c][r]
	const want: number[] = [];
	const rm = (c: number, r: number) => 10 * c + r + 0.5;
	for (let i = 0; i < 4; i++) {
		const m = [[1, 2], [3, 4]];
		want.push(7, [1.5, -2.25][i % 2], [10, -20, 30, -40][i], [0.5, 0.25, 0.125][i % 3], 3, 100 + [1, 2, 3][i % 3], [6, 8][i % 2], m[i % 2][1 - (i % 2)], 7, 10, -0.75, rm(i % 2, i % 3), rm(0, 0) + rm(1, 0), rm(0, 1) + rm(1, 1), rm(0, 2) + rm(1, 2), [10, -20, 30, -40][3 - i]);
	}
	return { push: [...u], want };
})();

// Division by a constant zero in a branch dead for the specialization
// (llama.cpp's mul_mm with TK = 1): allowed by Vulkan, refused by naga and
// Tint, so no zero divisor may reach the WGSL (compiled below).
const zd = run("zerodiv.comp", "zerodiv.comp.spv", { stage: "compute", entryPoint: "main" });
check("zerodiv.comp: no constant zero divisor left", !!zd && !/[/%] *\(?(0[iu]|w)\b/.test(zd.wgsl), zd?.wgsl.match(/.*[/%] *\(?(0[iu]|w)\b.*/)?.[0]);
const zd4 = run("zerodiv.comp.tk4", "zerodiv.comp.spv", { stage: "compute", entryPoint: "main", spec: { 0: 4, 1: true } });
check("zerodiv.comp with TK = 4: divisions kept", has(zd4, /\/ w\b/) && has(zd4, /% w\b/));

const sm = run("small.comp", "small.comp.spv", { stage: "compute", entryPoint: "main" });
check("small.comp: 8/16-bit buffers as u32 words (one per binding), f16 via unpack2x16float, 16-bit stores atomic", has(sm, /unpack2x16float/) && has(sm, /atomicAnd\(/) && has(sm, /atomicOr\(/) && !!sm && !/enable f16/.test(sm.wgsl) && sm.bindings.filter((b) => b.wgslBinding === 0).length === 1 && sm.bindings.find((b) => b.wgslBinding === 0)?.kind === "read-only-storage", JSON.stringify(sm?.bindings));
const smf = run("small.comp.f16", "small.comp.spv", { stage: "compute", entryPoint: "main", features: ["shader-f16"] });
check("small.comp with shader-f16: f16 kept, f16-only buffer native", has(smf, /enable f16;/) && has(smf, /array<f16>/) && JSON.stringify(smf?.requires) === JSON.stringify(["shader-f16"]), JSON.stringify(smf?.requires));
if (smf) delete out["small.comp.f16"]; // SwiftShader has no shader-f16

{
	const lim = { maxComputeWorkgroupSizeX: 256, maxComputeWorkgroupSizeY: 256, maxComputeWorkgroupSizeZ: 64, maxComputeInvocationsPerWorkgroup: 256 };
	const wd = run("wide.comp", "wide.comp.spv", { stage: "compute", entryPoint: "main", limits: lim });
	check("wide.comp: 512-wide workgroup shrunk to 256, dispatchScale [2,1,1]", has(wd, /@workgroup_size\(256, 1, 1\)/) && JSON.stringify(wd?.dispatchScale) === "[2,1,1]", JSON.stringify(wd?.dispatchScale));
	const wb = run("widebi.comp", "widebi.comp.spv", { stage: "compute", entryPoint: "main", limits: lim });
	check("widebi.comp: local/workgroup ids, local index, workgroup count derived from the global id", has(wb, /let gl_LocalInvocationID = gl_GlobalInvocationID % vec3<u32>\(512u, 1u, 1u\);/) && has(wb, /kwvk_nwg \/ vec3<u32>\(2u, 1u, 1u\)/) && JSON.stringify(wb?.dispatchScale) === "[2,1,1]");
	try {
		t.translate(readFileSync(new URL("specwg.comp.spv", here)), { stage: "compute", entryPoint: "main", spec: { 0: 512, 1: 8 }, limits: lim });
		check("workgroup memory + too wide: clear error", false);
	} catch (e) {
		check("workgroup memory + too wide: clear error", /exceeds the device.s limits.*cannot split/.test((e as Error).message), (e as Error).message);
	}
}

// Every shader again as spirv-opt -O output: translates and (below) compiles.
for (const f of readdirSync(here).filter((f) => f.endsWith(".opt.spv"))) {
	const stage = f.includes(".vert.") ? "vertex" : f.includes(".frag.") ? "fragment" : "compute";
	const spec: Record<number, number> = f.startsWith("specwg") ? { 0: 64, 1: 8 } : f.startsWith("fastdiv") ? { 0: 128 } : {};
	const arrays = f.startsWith("gtkish") ? { "0.0": { base: 0, count: 3 } } : arraysAll;
	if (run(f, f, { stage, entryPoint: "main", flipY: true, pushGroup: 2, spec, arrays })) check(`${f} translates`, true);
}

try {
	t.translate(new Uint8Array(40), { stage: "vertex", entryPoint: "main" });
	check("garbage throws", false);
} catch (e) {
	check("garbage throws", (e as Error).message.length > 0);
}
{
	// Truncated and corrupted input: an Error each time (a naga panic
	// included), and the translator still works afterwards.
	const good = readFileSync(new URL("cube.frag.spv", here));
	let threw = 0;
	let n = 0;
	for (let len = 20; len < good.length; len += 52) {
		n++;
		try {
			t.translate(good.subarray(0, len), { stage: "fragment", entryPoint: "main" });
		} catch (e) {
			if (e instanceof Error) threw++;
		}
		const bad = new Uint8Array(good);
		bad[len] ^= 0x5a;
		try {
			t.translate(bad, { stage: "fragment", entryPoint: "main" });
		} catch {}
	}
	let after = false;
	try {
		after = t.translate(good, { stage: "fragment", entryPoint: "main" }).bindings.length === 2;
	} catch {}
	check("truncated input throws, translator survives corruption", threw === n && after, `${threw}/${n} threw, after=${after}`);
}
try {
	t.translate(readFileSync(new URL("cube.vert.spv", here)), { stage: "fragment", entryPoint: "main" });
	check("wrong stage throws", false);
} catch (e) {
	check("wrong stage throws", /entry point/.test((e as Error).message), (e as Error).message);
}

// Real WebGPU. Pipelines: [name, vertex, fragment | undefined, push group].
const pipelines: [string, string, string | undefined][] = [
	["cube", "cube.vert", "cube.frag"],
	["push+spec", "push.vert", "spec.frag"],
	["mrt", "mrt.vert", "mrt.frag"],
	["lit", "lit.vert", "lit.frag"],
	["gtkish", "gtkish.vert", "gtkish.frag"],
	["dynvary", "dynvary.vert", "dynvary.frag"],
	["buffer", "buffer.comp", undefined],
	["image", "image.comp", undefined],
	["specwg", "specwg.comp", undefined],
	["fastdiv", "fastdiv.comp", undefined],
	["small", "small.comp", undefined],
	["zerodiv", "zerodiv.comp", undefined],
];
const page = `<!doctype html><meta charset="utf-8"><title>vk-shader</title><script type="module">
const out = ${JSON.stringify(out)};
const pipelines = ${JSON.stringify(pipelines)};
const pushpack = ${JSON.stringify(pushpack)};
const res = [];
function layout(device, results, pushGroup) {
	const groups = [];
	for (const [r, vis] of results) {
		for (const b of r.bindings) {
			const e = { binding: b.wgslBinding, visibility: vis };
			if (b.kind === "uniform" || b.kind === "storage" || b.kind === "read-only-storage") e.buffer = { type: b.kind };
			else if (b.kind === "sampler") e.sampler = { type: "filtering" };
			else if (b.kind === "comparison-sampler") e.sampler = { type: "comparison" };
			else if (b.kind === "texture") e.texture = { sampleType: b.sampleType, viewDimension: b.viewDimension, multisampled: b.multisampled };
			else e.storageTexture = { access: b.access, format: b.format, viewDimension: b.viewDimension };
			const g = (groups[b.group] ??= new Map());
			const old = g.get(b.wgslBinding);
			if (old) old.visibility |= vis; else g.set(b.wgslBinding, e);
		}
		if (r.pushConstantSize) {
			const g = (groups[pushGroup] ??= new Map());
			const old = g.get(0);
			if (old) old.visibility |= vis; else g.set(0, { binding: 0, visibility: vis, buffer: { type: "uniform" } });
		}
	}
	for (let i = 0; i < groups.length; i++) groups[i] ??= new Map();
	return device.createPipelineLayout({ bindGroupLayouts: groups.map((g) => device.createBindGroupLayout({ entries: [...g.values()] })) });
}
try {
	const adapter = await navigator.gpu.requestAdapter();
	const device = await adapter.requestDevice({ requiredFeatures: adapter.features.has("clip-distances") ? ["clip-distances"] : [] });
	if (!adapter.features.has("clip-distances")) for (const k of Object.keys(out)) if (k.startsWith("clip.vert")) delete out[k];
	const mods = {};
	for (const [name, r] of Object.entries(out)) {
		device.pushErrorScope("validation");
		const m = device.createShaderModule({ code: r.wgsl });
		const info = await m.getCompilationInfo();
		const err = await device.popErrorScope();
		const msgs = info.messages.filter((x) => x.type === "error").map((x) => x.lineNum + ":" + x.message);
		res.push({ name: "WebGPU module " + name, ok: !msgs.length && !err, detail: msgs.join("; ") + (err ? err.message : "") });
		mods[name] = m;
	}
	for (const [name, vs, fs] of pipelines) {
		device.pushErrorScope("validation");
		const S = GPUShaderStage;
		try {
			if (!fs) {
				await device.createComputePipelineAsync({ layout: layout(device, [[out[vs], S.COMPUTE]], 1), compute: { module: mods[vs], entryPoint: out[vs].entryPoint } });
				await device.createComputePipelineAsync({ layout: "auto", compute: { module: mods[vs], entryPoint: out[vs].entryPoint } });
			} else {
				const vsr = out[vs], fsr = out[fs];
				const sig = vsr.wgsl.slice(vsr.wgsl.indexOf("fn " + vsr.entryPoint + "("));
				const attrs = (sig.slice(0, sig.indexOf("->")).match(/@location\\(\\d+\\)/g) ?? []).map((_, i) => ({ shaderLocation: i, offset: 0, format: "float32x3" }));
				const desc = {
					vertex: { module: mods[vs], entryPoint: vsr.entryPoint, buffers: attrs.length ? [{ arrayStride: 12, attributes: attrs }] : [] },
					fragment: { module: mods[fs], entryPoint: fsr.entryPoint, targets: Array.from({ length: Math.max(1, name === "mrt" ? 2 : 1) }, () => ({ format: "rgba8unorm" })) },
					primitive: { topology: "triangle-list" },
				};
				await device.createRenderPipelineAsync({ ...desc, layout: layout(device, [[vsr, S.VERTEX], [fsr, S.FRAGMENT]], 1) });
				await device.createRenderPipelineAsync({ ...desc, layout: "auto" });
			}
			const err = await device.popErrorScope();
			res.push({ name: "WebGPU pipeline " + name, ok: !err, detail: err ? err.message : "" });
		} catch (e) {
			await device.popErrorScope();
			res.push({ name: "WebGPU pipeline " + name, ok: false, detail: String(e.message ?? e) });
		}
	}
	// Run the repacked push block (plain and spirv-opt -O SPIR-V) and compare every output.
	for (const [name, pushGroup] of [["pushpack.comp", 1], ["pushpack.comp.opt.spv", 2]]) {
		const r = out[name];
		if (!r) continue;
		const bgls = [];
		for (let g = 0; g <= pushGroup; g++) {
			const entries = g === 0 ? [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }] : g === pushGroup ? [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } }] : [];
			bgls.push(device.createBindGroupLayout({ entries }));
		}
		const pl = await device.createComputePipelineAsync({ layout: device.createPipelineLayout({ bindGroupLayouts: bgls }), compute: { module: mods[name], entryPoint: r.entryPoint } });
		const o = device.createBuffer({ size: 256, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
		const pc = device.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
		const rb = device.createBuffer({ size: 256, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
		device.queue.writeBuffer(pc, 0, new Uint32Array(pushpack.push));
		const enc = device.createCommandEncoder();
		const pass = enc.beginComputePass();
		pass.setPipeline(pl);
		bgls.forEach((l, g) => pass.setBindGroup(g, device.createBindGroup({ layout: l, entries: g === 0 ? [{ binding: 0, resource: { buffer: o } }] : g === pushGroup ? [{ binding: 0, resource: { buffer: pc } }] : [] })));
		pass.dispatchWorkgroups(1);
		pass.end();
		enc.copyBufferToBuffer(o, 0, rb, 0, 256);
		device.queue.submit([enc.finish()]);
		await rb.mapAsync(GPUMapMode.READ);
		const got = [...new Float32Array(rb.getMappedRange())];
		const bad = pushpack.want.map((w, i) => (got[i] === w ? "" : "o[" + i + "] " + got[i] + " != " + w)).filter(Boolean);
		res.push({ name: "WebGPU run " + name + ": every value at its Vulkan offset", ok: !bad.length, detail: bad.slice(0, 6).join(", ") });
	}
	res.push({ name: "WebGPU adapter " + (adapter.info?.description || adapter.info?.vendor || "?"), ok: true });
} catch (e) {
	res.push({ name: "WebGPU", ok: false, detail: String(e.message ?? e) });
}
await fetch("/result", { method: "POST", body: JSON.stringify(res) });
</script>`;

if (!process.argv.includes("--no-gpu")) {
	let results: { name: string; ok: boolean; detail?: string }[];
	try {
		results = await inChrome(page, 60_000);
	} catch (e) {
		results = [{ name: "chrome", ok: false, detail: (e as Error).message }];
	}
	for (const r of results) check(r.name, r.ok, r.detail);
}

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
