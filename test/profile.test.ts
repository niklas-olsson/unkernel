// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Guest pc sampling (createKernel({ profile }), js/core/profile.ts and the
// kernel's arch/wasm/kernel/prof.c) on the bundled kernel's base shell: a
// busy awk is the dominant command in instruction samples (the UP kernel,
// inline) and in time samples (the SMP kernel on 2 CPUs, in a worker);
// samples name the file and offset of their code, the same in two processes
// of one binary, and code in anonymous memory keeps its raw address;
// without the option the kernel's rings stay untouched; a snapshot taken
// while sampling restores without it, sampling off.
//
//   node --test test/profile.test.ts
//   UNKERNEL_TEST_KERNEL=path ...    # another bundle instead of the bundled kernel
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Profiler, type SamplerSpawner } from "../js/core/profile.ts";
import { PROFILE_ANON, PROFILE_UNKNOWN, createKernel, bundledKernelUrl, symbolizeProfile, type KernelHandle, type KernelInstance, type ProfileReport } from "../js/node.ts";

const testKernel = process.env.UNKERNEL_TEST_KERNEL ? path.resolve(process.env.UNKERNEL_TEST_KERNEL) : undefined;
const kernelModule = await WebAssembly.compile(readFileSync(testKernel ?? fileURLToPath(bundledKernelUrl)));
const hasSmp = WebAssembly.Module.customSections(kernelModule, "unkernel.kernel.smp.kwpatch").length > 0;

/** About 1.6 G instructions of busybox awk (a second or two with the JIT). */
const BUSY = ["BEGIN{for(i=0;i<200000;i++)s+=i; print s}"];
const BUSY_OUT = "19999900000\n";

type BootOptions = NonNullable<Parameters<typeof createKernel>[0]>;
const boot = async (t: { after(fn: () => unknown): void }, opts: BootOptions) => {
	const logs: string[] = [];
	const vm = await createKernel({ kernel: testKernel, log: (m) => logs.push(m), ...opts });
	t.after(() => vm.stop({ reason: "test cleanup" }));
	return { vm, logs };
};

/** The kernel's struct kw_prof (asm/kwprof.h): flags, and each ring's head, tail and dropped count. */
function rings(vm: KernelHandle): { flags: number; rings: { head: number; tail: number; dropped: number }[] } {
	const k = (vm as KernelInstance).kernel; // inline instances only
	const g = k.exports!.kw_prof as WebAssembly.Global;
	const a = Number(g.value);
	const dv = new DataView(k.memory.buffer);
	const nr = dv.getUint32(a + 16, true), stride = dv.getUint32(a + 28, true), off = dv.getUint32(a + 32, true);
	return {
		flags: dv.getUint32(a + 4, true),
		rings: Array.from({ length: nr }, (_, c) => {
			const r = a + off + c * stride;
			return { head: dv.getUint32(r, true), tail: dv.getUint32(r + 32, true), dropped: dv.getUint32(r + 4, true) };
		}),
	};
}

test("profile off: the kernel's rings stay untouched, and profile() is undefined", async (t) => {
	const { vm } = await boot(t, {});
	assert.equal((await vm.exec("awk", BUSY)).stdout, BUSY_OUT);
	const r = rings(vm);
	assert.equal(r.flags, 0);
	assert.ok(r.rings.every((x) => x.head === 0 && x.tail === 0 && x.dropped === 0), JSON.stringify(r.rings));
	assert.equal(await vm.profile(), undefined);
});

test("profile on the UP kernel: instruction samples only, awk dominant", async (t) => {
	const { vm, logs } = await boot(t, { profile: { insns: 100000 } });
	assert.equal((await vm.exec("awk", BUSY)).stdout, BUSY_OUT);
	const p = (await vm.profile())!;
	assert.ok(logs.some((l) => l.includes("time samples need")), logs.join("\n"));
	assert.equal(p.timeSampling, false);
	assert.equal(p.insnPeriod, 100000);
	assert.equal(p.totals.user, 0);
	assert.ok(p.totals.insns > 5000, `${p.totals.insns} instruction samples`);
	assert.equal(p.totals.dropped, 0);
	const top = [...p.comms].sort((a, b) => b.insns - a.insns)[0]!;
	assert.equal(top.comm, "awk");
	assert.ok(top.insns > p.totals.insns * 0.8, JSON.stringify(p.comms.slice(0, 4)));
	assert.ok(p.rows.length > 10 && p.pages.length > 1);
	assert.equal(rings(vm).flags, 2);
});

/**
 * A static aarch64 program (ELF built here) that copies a two-instruction
 * loop into an anonymous RWX page and calls it with x0 = 0x2fa0000: about
 * 100 M instructions in memory no file backs (a guest JIT's code).
 */
function anonLoopElf(): Uint8Array {
	const base = 0x400000, code = 120;
	const words = [
		0xd2800000, 0xd2820001, 0xd28000e2, 0xd2800443, // x0 = 0, x1 = 4096, x2 = RWX, x3 = MAP_PRIVATE | MAP_ANONYMOUS
		0x92800004, 0xd2800005, 0xd2801bc8, 0xd4000001, // x4 = -1, x5 = 0, x8 = mmap; svc
		0xaa0003f3, 0, // x19 = the page; adr x1, body (below)
		0xf9400022, 0xf9000262, 0xb9400822, 0xb9000a62, // copy body's 3 words
		0xd5033fdf, 0xd2a05f40, 0xd63f0260, // isb; x0 = 0x2fa0000; blr x19
		0xd2800000, 0xd2800ba8, 0xd4000001, // exit(0)
		0xf1000400, 0x54ffffe1, 0xd65f03c0, // body: subs x0, x0, #1; b.ne body; ret
	];
	const adr = 9, body = 20;
	const imm = (body - adr) * 4;
	words[adr] = 0x10000000 | ((imm & 3) << 29) | ((imm >> 2) << 5) | 1;
	const size = code + words.length * 4;
	const b = new Uint8Array(size);
	const dv = new DataView(b.buffer);
	b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
	dv.setUint16(16, 2, true); // ET_EXEC
	dv.setUint16(18, 183, true); // EM_AARCH64
	dv.setUint32(20, 1, true);
	dv.setBigUint64(24, BigInt(base + code), true); // e_entry
	dv.setBigUint64(32, 64n, true); // e_phoff
	dv.setUint16(52, 64, true);
	dv.setUint16(54, 56, true);
	dv.setUint16(56, 1, true);
	dv.setUint16(58, 64, true);
	dv.setUint32(64, 1, true); // PT_LOAD
	dv.setUint32(68, 5, true); // R | X
	dv.setBigUint64(80, BigInt(base), true);
	dv.setBigUint64(88, BigInt(base), true);
	dv.setBigUint64(96, BigInt(size), true);
	dv.setBigUint64(104, BigInt(size), true);
	dv.setBigUint64(112, 0x1000n, true);
	words.forEach((w, i) => dv.setUint32(code + 4 * i, w, true));
	return b;
}

/** File offset ranges of an ELF file's executable PT_LOAD segments. */
function execRanges(b: Uint8Array): [number, number][] {
	const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
	const phoff = Number(dv.getBigUint64(32, true)), n = dv.getUint16(56, true), sz = dv.getUint16(54, true);
	const out: [number, number][] = [];
	for (let i = 0; i < n; i++) {
		const p = phoff + i * sz;
		if (dv.getUint32(p, true) === 1 && dv.getUint32(p + 4, true) & 1) {
			const off = Number(dv.getBigUint64(p + 8, true));
			out.push([off, off + Number(dv.getBigUint64(p + 32, true))]);
		}
	}
	return out;
}

test("profile: samples name the file and offset, roll up across processes; anonymous code stays per process", async (t) => {
	const { vm } = await boot(t, { profile: { insns: 100000 } });
	const busybox = (await vm.exec("cat", ["/bin/busybox"], { encoding: "buffer" })).stdout;
	assert.equal((await vm.exec("awk", BUSY)).stdout, BUSY_OUT);
	assert.equal((await vm.exec("awk", BUSY)).stdout, BUSY_OUT);
	const put = await vm.exec("sh", ["-c", "cat > /tmp/anonloop && chmod +x /tmp/anonloop && /tmp/anonloop"], { input: anonLoopElf() });
	assert.equal(put.exitCode, 0, put.stderr);
	const p = (await vm.profile())!;
	assert.equal(p.version, 2);
	assert.ok(p.where.file > 5000 && p.where.named >= 1, JSON.stringify(p.where));
	assert.equal(p.where.noName, 0);
	// awk's code: /bin/busybox, at offsets in its executable segments.
	const ranges = execRanges(busybox);
	const awk = p.sites.filter((x) => x.comm === "awk" && x.path === "/bin/busybox");
	assert.ok(awk.length > 10, JSON.stringify(p.sites.slice(0, 4)));
	for (const x of awk) {
		const off = Number(x.off);
		assert.ok(ranges.some(([a, b]) => off >= a && off < b), `${x.off} outside ${JSON.stringify(ranges)}`);
	}
	// Both awk processes ran the same loop: one site, two processes.
	const top = [...awk].sort((a, b) => b.insnSamples - a.insnSamples)[0]!;
	assert.ok(top.processes >= 2 && top.pid === undefined, JSON.stringify(top));
	const awkPids = new Set(p.procPages.filter((x) => x.comm === "awk").map((x) => x.pid));
	assert.ok(awkPids.size >= 2, `awk pids ${[...awkPids]}`);
	assert.ok(p.files.some((f) => f.path === "/bin/busybox" && f.processes >= 3));
	// The loop in an anonymous page: no file (id 0), its own process, the raw address.
	const anon = p.sites.filter((x) => x.path === PROFILE_ANON && x.comm === "anonloop");
	assert.ok(p.where.anon > 500 && anon.reduce((a, x) => a + x.insnSamples, 0) > 500, JSON.stringify(p.where));
	assert.ok(anon.every((x) => x.pid !== undefined && x.processes === 1 && BigInt(x.off) >= 0x1000n));
	assert.ok(!p.sites.some((x) => x.comm === "anonloop" && x.path === PROFILE_UNKNOWN && x.insnSamples > 10));
});

test("profile on 2 CPUs (SMP kernel, worker): time and instruction samples, awk dominant, tiers named", { skip: !hasSmp && "the bundle has no SMP kernel (kernel/build.sh smp)" }, async (t) => {
	const { vm } = await boot(t, { worker: true, cpus: 2, profile: { hz: 1000, insns: 1000000 } });
	assert.equal((await vm.exec("awk", BUSY)).stdout, BUSY_OUT);
	const p = (await vm.profile())!;
	assert.equal(p.timeSampling, true);
	assert.equal(p.cpus, 2);
	assert.ok(p.totals.ticks > 1000, `${p.totals.ticks} ticks`);
	assert.ok(p.totals.user > 500, `${p.totals.user} user samples`);
	assert.ok(p.totals.insns > 500, `${p.totals.insns} instruction samples`);
	const top = p.comms[0]!;
	assert.equal(top.comm, "awk", JSON.stringify(p.comms.slice(0, 4)));
	assert.ok(top.user > p.totals.user * 0.6);
	const awkRows = p.rows.filter((r) => r.comm === "awk" && r.timeSamples);
	assert.ok(awkRows.some((r) => r.tier === "compiled" || r.tier === "decoded"), JSON.stringify(awkRows.slice(0, 4)));
	assert.ok(awkRows.some((r) => r.prevBlockPc), "time samples name the block that ran before");
	// Time samples name their file too (recorded after the interrupt, in task context).
	const awkTime = p.sites.filter((x) => x.comm === "awk" && x.path === "/bin/busybox").reduce((a, x) => a + x.timeSamples, 0);
	assert.ok(awkTime > top.user * 0.9, `${awkTime} of ${top.user} awk time samples in /bin/busybox; ${JSON.stringify(p.where)}`);
	const res = await vm.stop();
	assert.equal(res.kind, "stopped");
	const last = (await vm.profile())!;
	assert.ok(last.totals.user >= p.totals.user);
});

test("profile and snapshots: a snapshot taken while sampling restores without the option, sampling off", async (t) => {
	const { vm } = await boot(t, { profile: { insns: 100000 } });
	assert.equal((await vm.exec("awk", BUSY)).stdout, BUSY_OUT);
	const snap = await vm.snapshot({ stop: true });
	await vm.exited;
	const before = rings(vm).rings[0]!;
	const { vm: vm2 } = await boot(t, { restore: snap });
	assert.equal(rings(vm2).flags, 0);
	assert.equal((await vm2.exec("awk", BUSY)).stdout, BUSY_OUT);
	const after = rings(vm2).rings[0]!;
	assert.equal(after.head, before.head);
	assert.equal(await vm2.profile(), undefined);
	// And with the option again: it starts from what the rings hold.
	const snap2 = await vm2.snapshot({ stop: true });
	await vm2.exited;
	const { vm: vm3 } = await boot(t, { restore: snap2, profile: { insns: 100000 } });
	assert.equal((await vm3.exec("awk", BUSY)).stdout, BUSY_OUT);
	const p = (await vm3.profile())!;
	assert.equal(p.comms[0]!.comm, "awk"); // by instructions, without time samples
	assert.ok(p.totals.insns > 5000 && p.totals.insns < 40000, `${p.totals.insns} instruction samples (only this boot's)`);
});

test("symbolizeProfile: a separate debug file (code segment with a truncated p_filesz) names the code by p_memsz", async () => {
	// ELF header, one PT_LOAD (R | X, offset 0 at 0x10000, p_filesz 0x100 as
	// objcopy --only-keep-debug leaves it, p_memsz 0x20000), .strtab, .symtab
	// with fn at 0x18000 (size 0x100), and the section headers.
	const b = new Uint8Array(376);
	const dv = new DataView(b.buffer);
	b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
	dv.setUint16(16, 3, true); // ET_DYN
	dv.setUint16(18, 183, true);
	dv.setBigUint64(32, 64n, true); // e_phoff
	dv.setBigUint64(40, 184n, true); // e_shoff
	dv.setUint16(54, 56, true);
	dv.setUint16(56, 1, true);
	dv.setUint16(58, 64, true);
	dv.setUint16(60, 3, true);
	dv.setUint32(64, 1, true); // PT_LOAD
	dv.setUint32(68, 5, true); // R | X
	dv.setBigUint64(80, 0x10000n, true);
	dv.setBigUint64(88, 0x10000n, true);
	dv.setBigUint64(96, 0x100n, true); // p_filesz
	dv.setBigUint64(104, 0x20000n, true); // p_memsz
	b.set(new TextEncoder().encode("\0fn\0"), 128);
	dv.setUint32(160, 1, true); // symbol 1: "fn", STT_FUNC, section 1
	b[164] = 0x12;
	dv.setUint16(166, 1, true);
	dv.setBigUint64(168, 0x18000n, true);
	dv.setBigUint64(176, 0x100n, true);
	const sh = (i: number, type: number, off: number, size: number, link: number, entsize: number) => {
		const h = 184 + 64 * i;
		dv.setUint32(h + 4, type, true);
		dv.setBigUint64(h + 24, BigInt(off), true);
		dv.setBigUint64(h + 32, BigInt(size), true);
		dv.setUint32(h + 40, link, true);
		dv.setBigUint64(h + 56, BigInt(entsize), true);
	};
	sh(1, 2, 136, 48, 2, 24); // .symtab
	sh(2, 3, 128, 4, 0, 0); // .strtab
	const site = { path: "/lib/x.so", off: "0x8010", processes: 1, comm: "x", timeSamples: 0, insnSamples: 3 };
	const page = { path: "/lib/x.so", page: "0x8000", processes: 1, comm: "x", timeSamples: 0, insnSamples: 3 };
	const r = { sites: [site], pages: [page] } as unknown as ProfileReport;
	await symbolizeProfile(r, (p) => (p === "/lib/x.so" ? b : undefined));
	assert.equal(r.sites[0]!.symbol, "fn+0x10");
	assert.equal(r.pages[0]!.symbol, "fn");
	assert.deepEqual(r.symbols!.map((y) => [y.symbol, y.insnSamples]), [["fn", 3]]);
});

function attachSamplerFixture(throwsOnStart = false) {
	const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
	const header = 64, view = new DataView(memory.buffer);
	// A version 2 kw_prof header with one empty sample ring.
	view.setUint32(header, 2, true);
	view.setUint32(header + 16, 1, true); // CPU count
	view.setUint32(header + 20, 1, true); // Record count per ring
	view.setUint32(header + 24, 64, true); // Record bytes
	view.setUint32(header + 28, 128, true); // Ring stride
	view.setUint32(header + 32, 128, true); // Ring offset
	const logs: string[] = [];
	let fail: (error: Error) => void;
	let ctl: Int32Array;
	let stops = 0;
	const spawn: SamplerSpawner = (init, onError) => {
		if (throwsOnStart) throw new Error("cannot create sampler");
		fail = onError;
		ctl = new Int32Array(init.ctl);
		return { stop: () => { stops++; } };
	};
	const p = new Profiler({ hz: 200, insns: 1000 });
	assert.equal(p.attach({
		memory, sharedMemory: true, cpus: 1, irqAddr: 32,
		exports: { kw_prof: new WebAssembly.Global({ value: "i32" }, header) },
		log: (msg) => logs.push(msg),
	}, spawn), true);
	return {
		p, logs,
		flags: () => view.getUint32(header + 4, true), stopCount: () => stops,
		count: (ticks: number, missed: number) => {
			Atomics.store(ctl, 1, ticks);
			Atomics.store(ctl, 2, missed);
		},
		fail: (message: string) => fail(new Error(message)),
	};
}

test("sampler construction and asynchronous load failures leave instruction sampling on", async (t) => {
	const startup = attachSamplerFixture(true);
	const load = attachSamplerFixture();
	t.after(() => { startup.p.stop(); load.p.stop(); });
	await setImmediate();
	load.fail("cannot load sampler");
	for (const [run, message] of [[startup, "cannot create sampler"], [load, "cannot load sampler"]] as const) {
		const report = run.p.report();
		assert.equal(run.flags(), 2);
		assert.equal(report.timeSampling, false);
		assert.equal(report.hz, 0);
		assert.equal(report.timeSamplingError, message);
		assert.ok(run.logs[0]?.includes(message));
	}
	assert.equal(load.stopCount(), 1);
});

test("sampler runtime failure preserves historical counts through stop", async (t) => {
	const run = attachSamplerFixture();
	t.after(() => run.p.stop());
	run.count(3, 1);
	await setImmediate();
	run.fail("sampler crashed");
	assert.equal(run.flags(), 2);
	run.p.stop();
	const report = run.p.report();
	assert.equal(run.stopCount(), 1);
	assert.equal(report.timeSampling, true);
	assert.equal(report.timeSamplingError, "sampler crashed");
	assert.equal(report.hz, 200);
	assert.equal(report.totals.ticks, 3);
	assert.equal(report.totals.missed, 1);
});

test("orderly stop retains counts without reporting a sampler error", (t) => {
	const run = attachSamplerFixture();
	t.after(() => run.p.stop());
	run.count(4, 2);
	run.p.stop();
	run.fail("late worker event");
	const report = run.p.report();
	assert.equal(run.stopCount(), 1);
	assert.equal(report.timeSampling, true);
	assert.equal("timeSamplingError" in report, false);
	assert.equal(report.totals.ticks, 4);
	assert.equal(report.totals.missed, 2);
	assert.deepEqual(run.logs, []);
});
