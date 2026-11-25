// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Differential tests of the A64 CPU: every guest in zig-out/guest/a64 runs
// under qemu-aarch64 (the reference) and under kwemu through the test
// harness (src/emu/harness.zig, C ABI only), native and wasm64; stdout and
// the exit status must be identical. A third run ("lockstep") runs kw_run's
// decoded-op tier and the reference interpreter side by side in the native
// harness and stops at the first event, register or memory difference. Without qemu-aarch64 on PATH (or
// $QEMU_AARCH64) the comparison is skipped with a note, and the kwemu runs
// must still exit with the status the guest expects.
// The JIT modes run zig-out/bin/kwemu-harness-jit.wasm with the JS host of
// test/kwemu-jit-host.mjs: eager (every block compiled on its first entry),
// at the default threshold, and lowered to memory32 as the kernel is (with
// Binaryen's wasm-opt: $WASM_OPT or vendor/toolchain/binaryen/bin/wasm-opt;
// skipped with a note without it). Each must retire exactly as many
// instructions as the wasm64 interpreter.
// Also checks that the wasm64 object imports nothing the kernel does not
// provide (compiler-rt helpers such as __multi3 for u128 arithmetic).
// usage: node test/a64-test.mjs <zig-out prefix>
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createJitHost } from "./kwemu-jit-host.mjs";

const prefix = resolve(process.argv[2] ?? "zig-out");
const guestDir = join(prefix, "guest", "a64");
const dec = new TextDecoder();
const env = { HOME: "/", PATH: "/bin", TERM: "dumb" }; // what the harness passes

// guest, args, expected exit status
const cases = [
  { guest: "hello", args: ["x", "y z"], status: 42 },
  { guest: "inttest", args: [], status: 0 },
  { guest: "simdmovetest", args: [], status: 0 },
  { guest: "cryptotest", args: [], status: 0 },
  { guest: "atomictest", args: [], status: 0 },
  { guest: "lsetest", args: [], status: 0 },
  { guest: "simdtest", args: [], status: 0 },
  { guest: "fptest", args: [], status: 0 },
  { guest: "simdfptest", args: [], status: 0 },
  { guest: "bench", args: ["200000", "2", "20"], status: 0 },
  { guest: "kbench", args: ["interp", "2"], status: 0 },
];

let failed = 0;

// ---- wasm64 object: only the imports the kernel link provides -----------------
// (kwemu.o as built, and kwemu-jit.o: the same with the JIT tier, which
// imports the JIT host and nothing else; a large struct copy there becomes
// a memcpy call the kernel does not link).
for (const name of ["kwemu.o", "kwemu-jit.o"]) {
  const obj = await WebAssembly.compile(await readFile(join(prefix, "lib", name)));
  const bad = WebAssembly.Module.imports(obj).filter((i) => i.kind === "function" && !i.name.startsWith("kw_host_jit_"));
  if (bad.length) {
    failed++;
    console.log(`FAIL a64 ${name} imports functions: ${bad.map((i) => i.name).join(", ")} (u128 shifts/multiplies, struct copies of 64 bytes or more? see src/a64/common.zig)`);
  } else console.log(`ok   a64 ${name} imports no functions`);
}

// ---- runners ------------------------------------------------------------------
const qemu = process.env.QEMU_AARCH64 ?? "qemu-aarch64";
const haveQemu = spawnSync(qemu, ["--version"], { encoding: "utf8" }).status === 0;

function runQemu(elf, args) {
  const p = spawnSync(qemu, [elf, ...args], { encoding: "utf8", env });
  return { status: p.status, out: p.stdout, err: p.stderr };
}

function runNative(elf, args) {
  const p = spawnSync(join(prefix, "bin", "kwemu-harness"), ["--stats", elf, ...args], { encoding: "utf8" });
  return { status: p.status, out: p.stdout, err: p.stderr };
}

function runLockstep(elf, args) {
  const p = spawnSync(join(prefix, "bin", "kwemu-harness"), ["--stats", "--lockstep", "1", elf, ...args], { encoding: "utf8" });
  return { status: p.status, out: p.stdout, err: p.stderr };
}

const wasmModule = await WebAssembly.compile(await readFile(join(prefix, "bin", "kwemu-harness.wasm")));
const jitPath = join(prefix, "bin", "kwemu-harness-jit.wasm");
const jitModule = await WebAssembly.compile(await readFile(jitPath));

// memory32 variant of the JIT harness (lowered like vmlinux32.wasm)
let jit32Module = null, jit32Note = "";
{
  const wasmOpt = process.env.WASM_OPT ?? fileURLToPath(new URL("../vendor/toolchain/binaryen/bin/wasm-opt", import.meta.url));
  if (!existsSync(wasmOpt)) jit32Note = `skipped a64 wasm32+jit: ${wasmOpt} not found (set WASM_OPT)`;
  else {
    const dir = await mkdtemp(join(tmpdir(), "kwemu-a64-jit32-"));
    const out = join(dir, "kwemu-harness-jit32.wasm");
    const p = spawnSync(wasmOpt, ["-g", "--enable-memory64", "--enable-bulk-memory", "--enable-sign-ext", "--enable-nontrapping-float-to-int", "--enable-mutable-globals", "--enable-threads", "--memory64-lowering", "--table64-lowering", jitPath, "-o", out], { encoding: "utf8" });
    if (p.status !== 0) jit32Note = `FAIL a64 wasm-opt lowering: ${p.stderr}`;
    else jit32Module = await WebAssembly.compile(await readFile(out));
    await rm(dir, { recursive: true, force: true });
  }
}

async function runWasm(elf, args, module = wasmModule, jit = null) {
  let out = "", err = "", mem;
  // a library built with -Dkwemu-jit=true: its plain harness imports the host too
  if (!jit && WebAssembly.Module.imports(module).some((i) => i.module === "unkernel")) jit = createJitHost({ available: false });
  const imports = {
    env: {
      host_write: (fd, ptr, len) => {
        const s = dec.decode(new Uint8Array(mem.buffer, Number(ptr), Number(len)));
        if (fd === 2) err += s; else out += s;
      },
      host_now_ns: () => Number(process.hrtime.bigint()),
    },
  };
  if (jit) imports.unkernel = jit.imports;
  const inst = await WebAssembly.instantiate(module, imports);
  const ex = inst.exports;
  mem = ex.memory;
  jit?.attach(ex);
  const image = await readFile(elf);
  const argBytes = new TextEncoder().encode([elf, ...args].join("\0") + "\0");
  const total = image.length + argBytes.length;
  const ptr = Number(ex.kwh_buf(BigInt(total)));
  if (!ptr) throw new Error("image too large");
  new Uint8Array(mem.buffer, ptr, total).set(image);
  new Uint8Array(mem.buffer, ptr + image.length, argBytes.length).set(argBytes);
  const status = ex.kwh_run(BigInt(image.length), BigInt(argBytes.length), 1);
  if (jit) {
    const s = jit.stats;
    if (s.errors.length) {
      err += s.errors.map((e) => `jit host: ${e}\n`).join("");
      return { status: -1, out, err };
    }
    if (s.compiles) return { status, out, err, jit: `${s.compiles} compiled, ${(s.bytes / 1024).toFixed(0)} KiB, ${(Number(s.compileNs) / 1e6).toFixed(0)} ms` };
  }
  return { status, out, err };
}

function stats(r) {
  const m = /instret=(\d+).*MIPS=([\d.]+)/.exec(r.err);
  return (m ? `${(Number(m[1]) / 1e6).toFixed(2)}M insns, ${m[2]} MIPS` : "") + (r.jit ? `; jit: ${r.jit}` : "");
}

/** First differing line of two outputs, for the failure message. */
function firstDiff(a, b) {
  const x = a.split("\n"), y = b.split("\n");
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if (x[i] !== y[i]) return `line ${i + 1}: qemu ${JSON.stringify(x[i])}, kwemu ${JSON.stringify(y[i])}`;
  return "";
}

const modes = [
  ["native", runNative],
  ["wasm64", (elf, args) => runWasm(elf, args)],
  ["wasm64+jit", (elf, args) => runWasm(elf, args, jitModule, createJitHost({ eager: true }))],
  ["wasm64+jit/thr", (elf, args) => runWasm(elf, args, jitModule, createJitHost())],
  ["wasm64+jit/nosimd", (elf, args) => runWasm(elf, args, jitModule, createJitHost({ eager: true, simd: false }))],
  ["lockstep", runLockstep],
];
if (jit32Module) modes.splice(4, 0, ["wasm32+jit", (elf, args) => runWasm(elf, args, jit32Module, createJitHost({ eager: true, mem32: true }))]);
const width = Math.max(...modes.map(([m]) => m.length));

if (!haveQemu) console.log(`skipped a64 qemu comparison: ${qemu} not found (only the exit statuses are checked)`);
for (const c of cases) {
  const elf = join(guestDir, `${c.guest}.elf`);
  const ref = haveQemu ? runQemu(elf, c.args) : null;
  if (ref && ref.status !== c.status) {
    failed++;
    console.log(`FAIL a64 qemu ${c.guest}: status ${ref.status}, want ${c.status}\n${ref.err}`);
    continue;
  }
  let instret = null; // the wasm64 interpreter's: the JIT modes must retire exactly as many
  for (const [mode, run] of modes) {
    const r = await run(elf, c.args);
    const n = /instret=(\d+)/.exec(r.err)?.[1];
    if (mode === "wasm64") instret = n;
    let why = "";
    if (r.status !== c.status) why = `status ${r.status}, want ${c.status}`;
    else if (ref && r.out !== ref.out) why = `stdout differs from qemu-aarch64 (${firstDiff(ref.out, r.out)})`;
    else if (mode.includes("jit") && n !== instret) why = `instret ${n}, the wasm64 interpreter retired ${instret}`;
    if (why) {
      failed++;
      console.log(`FAIL a64 ${mode} ${c.guest}: ${why}\n--- stdout ---\n${r.out}--- stderr ---\n${r.err}`);
    } else console.log(`ok   a64 ${mode.padEnd(width)} ${c.guest.padEnd(12)} ${ref ? "= qemu" : ""} (${stats(r)})`);
  }
}
if (jit32Note) {
  console.log(jit32Note);
  if (jit32Note.startsWith("FAIL")) failed++;
}

if (failed) {
  console.log(`${failed} a64 test(s) failed`);
  process.exit(1);
}
