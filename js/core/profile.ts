// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Guest PC sampling (CreateKernelOptions.profile): a histogram of where guest
// user time goes, by command, process and user pc, in two domains.
//
// The kernel (arch/wasm/kernel/prof.c, asm/kwprof.h) writes samples into a
// ring per CPU in its memory (the exported struct kw_prof); this host drains
// them on the kernel's thread (a timer, which runs at the kernel's 20 ms
// yields and while it idles, and at exit) and aggregates them.
//
// - Time samples: a sampler thread (Platform.spawnSampler) sets
//   WASM_IRQ_PROFILE in every CPU's word of pending interrupts `hz` times
//   a second, without a notify (an idle CPU is not
//   woken). kwemu sees the bit at its next block end, so a sample lands on
//   the pc where user code stopped, with the block that ran before it
//   (`prevBlockPc`: the stop pc is the next block's start, so the block
//   before is the code that used the time) and the tier that saw the bit.
//   The sampler needs the kernel's memory to be shared (the SMP kernel);
//   with an unshared memory there are instruction samples only. A tick
//   whose bit the CPU had not taken yet since the last one is "missed":
//   the CPU was idle or in one long stay in the kernel.
// - Instruction samples: the kernel takes one every `insns` user
//   instructions of each CPU, exactly (it lowers kwemu's budget to the end
//   of the period), at the next pc to retire.
//
// Each user sample also names the file that backs its address and the
// offset in it (the kernel looks the VMA up; anonymous memory, such as a
// guest JIT's code, has no file and keeps the raw address), so the report
// adds up the same code across processes whatever ASLR did: `sites` by
// (file, offset), `pages` by (file, 4 KiB page of the file), `files`. The
// per-process view stays in `rows` and `procPages`. symbolizeProfile() adds
// the nearest ELF symbol, given a way to read the guest's files.
//
// Comparing a range's share of time with its share of instructions shows
// where code is slow per instruction (`pages`, `symbols`, and the table
// formatProfile() prints).

/** CreateKernelOptions.profile. */
export interface ProfileOptions {
	/** Time samples per second and CPU (needs a shared memory: the SMP kernel). Default 1000; 0: none. */
	hz?: number;
	/** An instruction sample every this many user instructions of a CPU. Default 1000000; 0: none. */
	insns?: number;
}

/** One (command, process, pc) of the report. */
export interface ProfileRow {
	comm: string;
	/** The process (thread group) id. */
	pid: number;
	/** The user pc, hex: where a time sample stopped, or the next instruction of an instruction sample. */
	pc: string;
	/** Time samples in user code that stopped at `pc`. */
	timeSamples: number;
	/** Time samples in the kernel while the task's user pc was `pc` (a system call or fault from there). */
	kernelSamples: number;
	/** Instruction samples at `pc`. */
	insnSamples: number;
	/** The block that ran before most of the time samples here (hex), and their share. */
	prevBlockPc?: string;
	prevBlockShare?: number;
	/** The tier that saw most of the time samples here (ProfileTier), and the count per tier. */
	tier?: ProfileTier;
	tiers?: Partial<Record<ProfileTier, number>>;
}

/**
 * How kwemu saw a time sample's bit: pending when kw_run began (after a
 * stop for an instruction sample), after a single step or in the reference
 * loop, after decoded ops, after compiled code, or at the end of a slice.
 */
export type ProfileTier = "none" | "entry" | "reference" | "decoded" | "compiled" | "budget";
const TIERS: ProfileTier[] = ["none", "entry", "reference", "decoded", "compiled", "budget"];

/** Where a sample's code is: a file the guest names, or neither (FILE_ANON, FILE_UNKNOWN). */
export const PROFILE_ANON = "[anon]";
export const PROFILE_UNKNOWN = "[unknown]";

/**
 * Time and instruction samples of a 4 KiB page of user code in a file,
 * over every process (time at the block that ran: prevBlockPc). Anonymous
 * memory and samples whose file is unknown stay per process, by virtual
 * page (`pid` set).
 */
export interface ProfilePage {
	/** The file as the guest named it, or PROFILE_ANON / PROFILE_UNKNOWN. */
	path: string;
	/** The page's first file offset, hex (with `pid`: its first virtual address). */
	page: string;
	pid?: number;
	/** Processes with samples here, and the command with the most. */
	processes: number;
	comm: string;
	timeSamples: number;
	insnSamples: number;
	/** symbolizeProfile(): the symbol of the page's busiest site. */
	symbol?: string;
}

/** A 4 KiB virtual page of one process (the per-process view of `pages`). */
export interface ProfileProcPage {
	comm: string;
	pid: number;
	/** The page's first address, hex. */
	page: string;
	path: string;
	timeSamples: number;
	insnSamples: number;
}

/**
 * One (file, offset) over every process: for time samples the start of the
 * block that ran (prevBlockPc, or the stop pc without one), for instruction
 * samples the next pc. Anonymous memory and unknown files: per process, by
 * virtual address (`pid` set).
 */
export interface ProfileSite {
	path: string;
	/** File offset, hex (with `pid`: the virtual address). */
	off: string;
	pid?: number;
	processes: number;
	comm: string;
	timeSamples: number;
	insnSamples: number;
	/** The tier that saw most of the time samples here, and the count per tier. */
	tier?: ProfileTier;
	tiers?: Partial<Record<ProfileTier, number>>;
	/** symbolizeProfile(): the nearest ELF symbol at or below `off`, as name+0xdelta. */
	symbol?: string;
}

/** Samples per file (PROFILE_ANON and PROFILE_UNKNOWN over every process). */
export interface ProfileFile {
	path: string;
	processes: number;
	timeSamples: number;
	insnSamples: number;
}

/** symbolizeProfile(): samples per (file, symbol). */
export interface ProfileSymbol {
	path: string;
	symbol: string;
	timeSamples: number;
	insnSamples: number;
}

export interface ProfileCpu {
	cpu: number;
	/** Sampler ticks for this CPU, and those that found its last bit not taken (idle, or in the kernel all along). */
	ticks: number;
	missed: number;
	user: number;
	kernel: number;
	idle: number;
	insns: number;
	/** Samples the kernel dropped (its ring was full). */
	dropped: number;
}

export interface ProfileReport {
	version: 2;
	/** Time samples requested per second and CPU (0: none). */
	hz: number;
	/** Whether the report includes a time sampler, including after an orderly stop or a failure after ticking. */
	timeSampling: boolean;
	/** A sampler startup or runtime failure. After a failure, any accumulated time samples are historical. */
	timeSamplingError?: string;
	/** The instruction period (0: none). */
	insnPeriod: number;
	/** Milliseconds from the start of sampling to this report. */
	durationMs: number;
	cpus: number;
	totals: { user: number; kernel: number; idle: number; insns: number; dropped: number; ticks: number; missed: number };
	/**
	 * User time and instruction samples by what backs their address: a file
	 * (`file`), anonymous memory (`anon`), a file without a name slot
	 * (`noName`: the kernel's table of `maxFiles` names is full) or unknown
	 * (`unknown`: no VMA, or the task's mmap_lock was busy). `named`: files
	 * the kernel has named.
	 */
	where: { file: number; anon: number; noName: number; unknown: number; named: number; maxFiles: number };
	perCpu: ProfileCpu[];
	/** Per command: time samples in user code, in the kernel and idle, and instruction samples. */
	comms: { comm: string; user: number; kernel: number; idle: number; insns: number }[];
	/** Most time first, then most instructions (also below). */
	files: ProfileFile[];
	pages: ProfilePage[];
	sites: ProfileSite[];
	/** After symbolizeProfile(). */
	symbols?: ProfileSymbol[];
	/** Per process: stop pcs, and virtual pages. */
	rows: ProfileRow[];
	procPages: ProfileProcPage[];
}

/** What a sampler thread gets (Platform.spawnSampler). */
export interface SamplerInit {
	/** The kernel's shared memory. */
	buffer: SharedArrayBuffer;
	/** Address of CPU 0's word (wasm_host_irqs), and of kw_prof.irq_word[] (the others' words, 0 until the kernel fills them). */
	irq0: number;
	words: number;
	cpus: number;
	bit: number;
	periodMs: number;
	/** Int32: [0] stop (set and notified to end it), [1 + cpu] ticks, [1 + cpus + cpu] missed. */
	ctl: SharedArrayBuffer;
}

export interface SamplerHandle {
	stop(): void;
}

/** Start the sampler. Report worker load or runtime failures after returning the handle. */
export type SamplerSpawner = (init: SamplerInit, onError: (error: Error) => void) => SamplerHandle;

/** What Profiler needs of the Kernel (kernel.ts). */
export interface ProfiledKernel {
	memory: WebAssembly.Memory;
	sharedMemory: boolean;
	exports: WebAssembly.Exports | undefined;
	irqAddr: number | undefined;
	cpus: number;
	log: (msg: string) => void;
}

// struct kw_prof (asm/kwprof.h).
const KW_PROF_VERSION = 2;
const P_FLAGS = 4, P_PERIOD = 8, P_NR = 16, P_RING = 20, P_REC = 24, P_STRIDE = 28, P_RINGS = 32, P_BIT = 36;
const P_FILES = 40, P_MAX_FILES = 44, P_PATH_SIZE = 48, P_NR_FILES = 52, P_WORDS = 56;
const R_HEAD = 0, R_DROPPED = 4, R_TAIL = 32, R_SAMPLES = 64;
const S_PC = 0, S_BLOCK = 8, S_PID = 24, S_TGID = 28, S_CPU = 32, S_KIND = 34, S_TIER = 35, S_FILE = 36, S_COMM = 40, S_OFF = 56;
const FLAG_TIME = 1, FLAG_INSNS = 2;
const KIND_USER = 1, KIND_KERNEL = 2, KIND_IDLE = 3, KIND_INSN = 4;
const FILE_ANON = 0, FILE_FULL = 0xfffffffe, FILE_UNKNOWN = 0xffffffff;
const DRAIN_MS = 20;

interface Row {
	comm: string;
	pid: number;
	pc: bigint;
	time: number;
	kernel: number;
	insns: number;
	tiers: number[];
	blocks: Map<bigint, number>;
}

/** Samples of a site, page or file over processes. */
interface Agg {
	path: string;
	at: bigint;
	pid?: number;
	time: number;
	insns: number;
	tiers: number[];
	comms: Map<string, number>;
	pids: Set<number>;
}

/** Count a sample of process `pid` into map[key] (`proc`: the key's own process, for addresses without a file). */
function bump(map: Map<string, Agg>, key: string, path: string, at: bigint, proc: number | undefined, pid: number, comm: string, user: boolean, tier: number): void {
	let a = map.get(key);
	if (!a) map.set(key, a = { path, at, pid: proc, time: 0, insns: 0, tiers: [0, 0, 0, 0, 0, 0], comms: new Map(), pids: new Set() });
	if (user) {
		a.time++;
		a.tiers[tier]!++;
	} else a.insns++;
	a.comms.set(comm, (a.comms.get(comm) ?? 0) + 1);
	a.pids.add(pid);
}

function topComm(a: Agg): string {
	let best = "", n = 0;
	for (const [c, k] of a.comms) if (k > n) { best = c; n = k; }
	return best;
}

function tierFields(tiers: number[]): { tier?: ProfileTier; tiers?: Partial<Record<ProfileTier, number>> } {
	if (!tiers.some((n) => n)) return {};
	let best = 0;
	for (let i = 1; i < TIERS.length; i++) if (tiers[i]! > tiers[best]!) best = i;
	return { tier: TIERS[best], tiers: Object.fromEntries(TIERS.map((t, i) => [t, tiers[i]!]).filter(([, n]) => n)) as Partial<Record<ProfileTier, number>> };
}

const byTime = <T extends { timeSamples: number; insnSamples: number }>(a: T, b: T): number => b.timeSamples - a.timeSamples || b.insnSamples - a.insnSamples;

const hex = (v: bigint): string => `0x${v.toString(16)}`;
const decoder = new TextDecoder();

/** The kernel's struct kw_prof, if it has one. */
function profAddr(k: ProfiledKernel): number | undefined {
	const g = k.exports?.kw_prof;
	if (!(g instanceof WebAssembly.Global)) return undefined;
	const addr = Number(g.value);
	return new DataView(k.memory.buffer).getUint32(addr, true) === KW_PROF_VERSION ? addr : undefined;
}

/** Turn the kernel's sampling off (a restored snapshot that was taken while profiling, booted without it). */
export function profileOff(k: ProfiledKernel): void {
	const addr = profAddr(k);
	if (addr !== undefined) new DataView(k.memory.buffer).setUint32(addr + P_FLAGS, 0, true);
}

export class Profiler {
	hz: number;
	insns: number;
	#timeSamplingError?: string;
	k: ProfiledKernel | undefined;
	addr = 0;
	nr = 0;
	ringSize = 0;
	rec = 0;
	stride = 0;
	rings = 0;
	/** Each ring's dropped count when this host attached (a restored kernel's are older). */
	dropBase: number[] = [];
	sampler: SamplerHandle | null = null;
	ctl: Int32Array | null = null;
	timer: ReturnType<typeof setInterval> | undefined;
	t0 = 0;
	tEnd = 0;
	rowMap = new Map<string, Row>();
	procPageMap = new Map<string, ProfileProcPage>();
	siteMap = new Map<string, Agg>();
	pageMap = new Map<string, Agg>();
	fileMap = new Map<string, Agg>();
	where = { file: 0, anon: 0, noName: 0, unknown: 0 };
	/** File id n's path is paths[n - 1] (read as samples name new ids). */
	paths: string[] = [];
	maxFiles = 0;
	pathSize = 0;
	commMap = new Map<string, { comm: string; user: number; kernel: number; idle: number; insns: number }>();
	perCpu: ProfileCpu[] = [];

	constructor(opts: ProfileOptions) {
		this.hz = Math.max(0, Math.min(10000, Number(opts.hz ?? 1000) || 0));
		this.insns = Math.max(0, Math.floor(Number(opts.insns ?? 1_000_000) || 0));
		if (this.insns && this.insns < 1000) this.insns = 1000;
	}

	/**
	 * After instantiation (and after a snapshot's memory is in): find
	 * kw_prof, start from what the rings hold now, and set what to sample.
	 * False if the kernel has no profiler.
	 */
	attach(k: ProfiledKernel, spawnSampler?: SamplerSpawner): boolean {
		const addr = profAddr(k);
		if (addr === undefined) {
			k.log("[host] profile: this kernel has no profiler (kw_prof); nothing is sampled");
			return false;
		}
		this.k = k;
		this.addr = addr;
		const dv = new DataView(k.memory.buffer);
		this.nr = dv.getUint32(addr + P_NR, true);
		this.ringSize = dv.getUint32(addr + P_RING, true);
		this.rec = dv.getUint32(addr + P_REC, true);
		this.stride = dv.getUint32(addr + P_STRIDE, true);
		this.rings = addr + dv.getUint32(addr + P_RINGS, true);
		this.maxFiles = dv.getUint32(addr + P_MAX_FILES, true);
		this.pathSize = dv.getUint32(addr + P_PATH_SIZE, true);
		const cpus = Math.min(k.cpus, this.nr);
		for (let c = 0; c < this.nr; c++) {
			const r = this.rings + c * this.stride;
			dv.setUint32(r + R_TAIL, dv.getUint32(r + R_HEAD, true), true);
			this.dropBase[c] = dv.getUint32(r + R_DROPPED, true);
		}
		this.perCpu = Array.from({ length: cpus }, (_, cpu) => ({ cpu, ticks: 0, missed: 0, user: 0, kernel: 0, idle: 0, insns: 0, dropped: 0 }));
		let flags = this.insns ? FLAG_INSNS : 0;
		if (this.hz && !k.sharedMemory) {
			k.log("[host] profile: time samples need the kernel's memory shared (the SMP kernel: --cpus 2 or more); instruction samples only");
			this.hz = 0;
		} else if (this.hz && !spawnSampler) {
			k.log("[host] profile: this platform starts no sampler thread; instruction samples only");
			this.hz = 0;
		}
		if (this.hz) {
			const ctl = new SharedArrayBuffer(4 * (1 + 2 * cpus));
			this.ctl = new Int32Array(ctl);
			try {
				this.sampler = spawnSampler!({
					buffer: k.memory.buffer as unknown as SharedArrayBuffer, irq0: k.irqAddr ?? 0, words: addr + P_WORDS,
					cpus, bit: dv.getUint32(addr + P_BIT, true), periodMs: 1000 / this.hz, ctl,
				}, (error) => {
					if (!this.sampler) return; // The kernel has already ended.
					this.sampler.stop();
					this.sampler = null;
					const view = new DataView(k.memory.buffer);
					view.setUint32(addr + P_FLAGS, view.getUint32(addr + P_FLAGS, true) & ~FLAG_TIME, true);
					// Keep historical tick counts if the worker failed after it started.
					const counters = this.ctl!;
					if (!this.perCpu.some(({ cpu }) => Atomics.load(counters, 1 + cpu) !== 0)) {
						this.hz = 0;
						this.ctl = null;
					}
					this.#timeSamplingError = error.message || String(error);
					k.log(`[host] profile: the sampler stopped (${this.#timeSamplingError}); instruction samples only from now on`);
				});
				flags |= FLAG_TIME;
			} catch (e) {
				this.#timeSamplingError = (e as Error)?.message || String(e);
				k.log(`[host] profile: cannot start the sampler (${this.#timeSamplingError}); instruction samples only`);
				this.hz = 0;
				this.ctl = null;
			}
		}
		dv.setBigUint64(addr + P_PERIOD, BigInt(this.insns), true);
		dv.setUint32(addr + P_FLAGS, flags, true);
		this.t0 = performance.now();
		this.timer = setInterval(() => this.drain(), DRAIN_MS);
		(this.timer as { unref?: () => void }).unref?.();
		return true;
	}

	/** The kernel has ended: take the rest and stop the sampler. */
	stop(): void {
		if (!this.k || this.tEnd) return;
		this.drain();
		this.tEnd = performance.now();
		clearInterval(this.timer);
		this.timer = undefined;
		this.sampler?.stop();
		this.sampler = null;
	}

	/** Take every sample the rings hold. */
	drain(): void {
		const k = this.k;
		if (!k || this.tEnd) return;
		const buf = k.memory.buffer;
		const dv = new DataView(buf);
		const i32 = k.sharedMemory ? new Int32Array(buf) : null;
		const u8 = new Uint8Array(buf);
		for (let c = 0; c < this.perCpu.length; c++) {
			const r = this.rings + c * this.stride;
			const head = (i32 ? Atomics.load(i32, (r + R_HEAD) >> 2) : dv.getUint32(r + R_HEAD, true)) >>> 0;
			let tail = dv.getUint32(r + R_TAIL, true);
			if (head === tail) continue;
			for (; tail !== head; tail = (tail + 1) >>> 0) {
				const s = r + R_SAMPLES + (tail % this.ringSize) * this.rec;
				this.add(dv, u8, s);
			}
			if (i32) Atomics.store(i32, (r + R_TAIL) >> 2, tail | 0);
			else dv.setUint32(r + R_TAIL, tail, true);
		}
	}

	/** The path of file id `id` (1-based), reading the names the kernel wrote since the last call. */
	pathOf(dv: DataView, u8: Uint8Array, id: number): string {
		if (id > this.paths.length) {
			const k = this.k!;
			const nrAt = this.addr + P_NR_FILES;
			const n = Math.min(this.maxFiles, k.sharedMemory ? Atomics.load(new Int32Array(dv.buffer), nrAt >> 2) >>> 0 : dv.getUint32(nrAt, true));
			// The kernel fills the address at boot, after attach().
			const files = dv.getUint32(this.addr + P_FILES, true);
			for (let i = this.paths.length; i < n && files; i++) {
				const at = files + i * this.pathSize;
				let end = at;
				while (end < at + this.pathSize && u8[end] !== 0) end++;
				this.paths.push(decoder.decode(u8.slice(at, end)));
			}
		}
		return this.paths[id - 1] ?? `[file ${id}]`;
	}

	add(dv: DataView, u8: Uint8Array, s: number): void {
		const kind = dv.getUint8(s + S_KIND);
		const cpu = this.perCpu[dv.getUint16(s + S_CPU, true)];
		let end = s + S_COMM;
		while (end < s + S_COMM + 16 && u8[end] !== 0) end++;
		const comm = decoder.decode(u8.slice(s + S_COMM, end));
		const pid = dv.getUint32(s + S_TGID, true) || dv.getUint32(s + S_PID, true);
		const pc = dv.getBigUint64(s + S_PC, true);
		let c = this.commMap.get(comm);
		if (!c) this.commMap.set(comm, c = { comm, user: 0, kernel: 0, idle: 0, insns: 0 });
		if (kind === KIND_IDLE) {
			c.idle++;
			if (cpu) cpu.idle++;
			return;
		}
		const key = `${comm}\0${pid}\0${pc}`;
		let row = this.rowMap.get(key);
		if (!row) this.rowMap.set(key, row = { comm, pid, pc, time: 0, kernel: 0, insns: 0, tiers: [0, 0, 0, 0, 0, 0], blocks: new Map() });
		let at = pc;
		if (kind === KIND_USER) {
			row.time++;
			c.user++;
			if (cpu) cpu.user++;
			const tier = dv.getUint8(s + S_TIER);
			row.tiers[tier < TIERS.length ? tier : 0]!++;
			const block = dv.getBigUint64(s + S_BLOCK, true);
			if (block) {
				row.blocks.set(block, (row.blocks.get(block) ?? 0) + 1);
				at = block;
			}
		} else if (kind === KIND_KERNEL) {
			row.kernel++;
			c.kernel++;
			if (cpu) cpu.kernel++;
			return;
		} else if (kind === KIND_INSN) {
			row.insns++;
			c.insns++;
			if (cpu) cpu.insns++;
		} else return;
		const user = kind === KIND_USER;
		const tier = user ? Math.min(dv.getUint8(s + S_TIER), TIERS.length - 1) : 0;
		// What backs `at` (the kernel looked up block if set, else pc: the same address).
		const file = dv.getUint32(s + S_FILE, true);
		let path: string, off: bigint, proc: number | undefined;
		if (file === FILE_ANON || file === FILE_FULL || file === FILE_UNKNOWN) {
			path = file === FILE_ANON ? PROFILE_ANON : PROFILE_UNKNOWN;
			off = at;
			proc = pid;
			if (file === FILE_ANON) this.where.anon++;
			else if (file === FILE_FULL) this.where.noName++;
			else this.where.unknown++;
		} else {
			path = this.pathOf(dv, u8, file);
			off = dv.getBigUint64(s + S_OFF, true);
			this.where.file++;
		}
		const where = proc === undefined ? path : `${path}\0${proc}`;
		bump(this.siteMap, `${where}\0${off}`, path, off, proc, pid, comm, user, tier);
		bump(this.pageMap, `${where}\0${off >> 12n}`, path, off & ~0xfffn, proc, pid, comm, user, tier);
		bump(this.fileMap, path, path, 0n, undefined, pid, comm, user, tier);
		const page = at & ~0xfffn;
		const pkey = `${comm}\0${pid}\0${page}`;
		let p = this.procPageMap.get(pkey);
		if (!p) this.procPageMap.set(pkey, p = { comm, pid, page: hex(page), path, timeSamples: 0, insnSamples: 0 });
		if (user) p.timeSamples++;
		else p.insnSamples++;
	}

	/** The histogram so far (drains first while the kernel runs). */
	report(): ProfileReport {
		this.drain();
		const k = this.k;
		if (k && this.ctl) {
			const n = this.perCpu.length;
			for (const c of this.perCpu) {
				c.ticks = Atomics.load(this.ctl, 1 + c.cpu);
				c.missed = Atomics.load(this.ctl, 1 + n + c.cpu);
			}
		}
		if (k) {
			const dv = new DataView(k.memory.buffer);
			for (const c of this.perCpu) c.dropped = (dv.getUint32(this.rings + c.cpu * this.stride + R_DROPPED, true) - (this.dropBase[c.cpu] ?? 0)) >>> 0;
		}
		const sum = (f: keyof ProfileCpu) => this.perCpu.reduce((a, c) => a + c[f], 0);
		const rows: ProfileRow[] = [...this.rowMap.values()].map((r) => {
			const out: ProfileRow = { comm: r.comm, pid: r.pid, pc: hex(r.pc), timeSamples: r.time, kernelSamples: r.kernel, insnSamples: r.insns };
			if (r.time) {
				Object.assign(out, tierFields(r.tiers));
				let bb = 0n, bn = 0;
				for (const [b, n] of r.blocks) if (n > bn) { bb = b; bn = n; }
				if (bn) {
					out.prevBlockPc = hex(bb);
					out.prevBlockShare = Math.round((bn / r.time) * 1000) / 1000;
				}
			}
			return out;
		}).sort((a, b) => b.timeSamples - a.timeSamples || b.insnSamples - a.insnSamples || b.kernelSamples - a.kernelSamples);
		const procs = (a: Agg): number => a.pids.size;
		const sites: ProfileSite[] = [...this.siteMap.values()].map((a) => ({
			path: a.path, off: hex(a.at), ...(a.pid !== undefined ? { pid: a.pid } : {}), processes: procs(a), comm: topComm(a),
			timeSamples: a.time, insnSamples: a.insns, ...tierFields(a.tiers),
		})).sort(byTime);
		const pages: ProfilePage[] = [...this.pageMap.values()].map((a) => ({
			path: a.path, page: hex(a.at), ...(a.pid !== undefined ? { pid: a.pid } : {}), processes: procs(a), comm: topComm(a),
			timeSamples: a.time, insnSamples: a.insns,
		})).sort(byTime);
		const files: ProfileFile[] = [...this.fileMap.values()].map((a) => ({ path: a.path, processes: procs(a), timeSamples: a.time, insnSamples: a.insns })).sort(byTime);
		let named = this.paths.length;
		if (k) {
			const dv = new DataView(k.memory.buffer);
			named = Math.min(this.maxFiles, dv.getUint32(this.addr + P_NR_FILES, true));
		}
		return {
			version: 2,
			hz: this.hz,
			timeSampling: !!this.ctl,
			...(this.#timeSamplingError !== undefined ? { timeSamplingError: this.#timeSamplingError } : {}),
			insnPeriod: this.insns,
			durationMs: Math.round((this.tEnd || performance.now()) - this.t0),
			cpus: this.perCpu.length,
			totals: { user: sum("user"), kernel: sum("kernel"), idle: sum("idle"), insns: sum("insns"), dropped: sum("dropped"), ticks: sum("ticks"), missed: sum("missed") },
			perCpu: this.perCpu.map((c) => ({ ...c })),
			comms: [...this.commMap.values()].map((c) => ({ ...c })).sort((a, b) => b.user + b.kernel - (a.user + a.kernel) || b.insns - a.insns),
			where: { ...this.where, named, maxFiles: this.maxFiles },
			files,
			pages,
			sites,
			rows,
			procPages: [...this.procPageMap.values()].map((p) => ({ ...p })).sort(byTime),
		};
	}
}

const pct = (n: number, d: number): string => (d ? `${((n * 100) / d).toFixed(1)}%` : "-");
const ratio = (t: number, tt: number, i: number, it: number): string => {
	if (!tt || !it) return "-";
	if (!i) return t ? "inf" : "-";
	return ((t / tt) / (i / it)).toFixed(2);
};

/** "path+0xoff", or "path!symbol" when symbolized; long paths keep their tail. */
function place(path: string, off: string, pid: number | undefined, symbol: string | undefined, width = 60): string {
	const p = pid !== undefined ? `${path}[${pid}]` : path;
	const tail = symbol ? `!${symbol}` : `+${off}`;
	const room = width - tail.length;
	return (p.length > room && room > 4 ? `...${p.slice(p.length - room + 3)}` : p) + tail;
}

/**
 * A short text summary of a report: the split, the commands, the files,
 * then the top `top` pages of files (over every process) by time share,
 * with their instruction share and the ratio of the two (>1: slower per
 * instruction than the average), the top symbols (if symbolized) the same
 * way, and the top sites by time with the tier that saw them.
 */
export function formatProfile(r: ProfileReport, top = 15): string {
	const t = r.totals;
	const time = t.user + t.kernel;
	const w = r.where;
	const lines: string[] = [];
	const row = (tm: number, ins: number): string =>
		`${pct(tm, t.user).padStart(6)} ${pct(ins, t.insns).padStart(6)} ${ratio(tm, t.user, ins, t.insns).padStart(6)}`;
	lines.push(`[profile] ${(r.durationMs / 1000).toFixed(1)} s, ${r.cpus} CPU${r.cpus > 1 ? "s" : ""}; ` +
		(r.timeSampling ? `time ${r.hz} Hz: ${t.user} user, ${t.kernel} kernel, ${t.idle} idle samples, ${t.missed} of ${t.ticks} ticks missed (idle or in the kernel)` : "no time samples") +
		`; instructions every ${r.insnPeriod || "-"}: ${t.insns} samples; ${t.dropped} dropped`);
	lines.push(`[profile] user samples by what backs them: ${w.file} a file (${w.named} named), ${w.anon} anonymous, ${w.unknown} unknown` +
		(w.noName ? `, ${w.noName} in files beyond the ${w.maxFiles} names` : ""));
	lines.push("[profile] command            user%  kernel%  insn%");
	for (const c of r.comms.slice(0, 6))
		lines.push(`[profile] ${c.comm.padEnd(16)} ${pct(c.user, time).padStart(7)} ${pct(c.kernel, time).padStart(8)} ${pct(c.insns, t.insns).padStart(6)}`);
	const order = <T extends { timeSamples: number; insnSamples: number }>(a: T[]): T[] =>
		r.timeSampling ? a : [...a].sort((x, y) => y.insnSamples - x.insnSamples);
	lines.push("[profile]  time%  insn%  ratio  procs  file");
	for (const f of order(r.files).slice(0, 8))
		lines.push(`[profile] ${row(f.timeSamples, f.insnSamples)}  ${String(f.processes).padStart(5)}  ${f.path}`);
	lines.push("[profile]  time%  insn%  ratio  procs  page of file (over processes)");
	for (const p of order(r.pages).slice(0, top))
		lines.push(`[profile] ${row(p.timeSamples, p.insnSamples)}  ${String(p.processes).padStart(5)}  ${place(p.path, p.page, p.pid, undefined)}${p.symbol ? `  ${p.symbol}` : ""}`);
	if (r.symbols) {
		lines.push("[profile]  time%  insn%  ratio  symbol");
		for (const y of order(r.symbols).slice(0, top))
			lines.push(`[profile] ${row(y.timeSamples, y.insnSamples)}  ${place(y.path, "", undefined, y.symbol, 80)}`);
	}
	if (r.timeSampling) {
		lines.push("[profile]  time%  procs  block that ran (file+offset)                                     tier");
		for (const x of r.sites.slice(0, Math.min(top, 10))) {
			if (!x.timeSamples) break;
			lines.push(`[profile] ${pct(x.timeSamples, t.user).padStart(6)}  ${String(x.processes).padStart(5)}  ${place(x.path, x.off, x.pid, x.symbol, 64).padEnd(64)}  ${x.tier ?? "-"}`);
		}
	}
	return lines.join("\n");
}

// ---- symbols ------------------------------------------------------------------------

/** Reads a guest file by the path a report names (undefined: not available). */
export type ProfileFileReader = (path: string) => Uint8Array | undefined | Promise<Uint8Array | undefined>;

/** An ELF file's code as symbolizeProfile() needs it. */
interface ElfSyms {
	/** PT_LOAD segments: file offset range and its virtual address. */
	loads: { off: number; size: number; vaddr: number }[];
	/** Function symbols by address. */
	addrs: number[];
	names: string[];
	sizes: number[];
}

/** The function symbols (.symtab, else .dynsym) and PT_LOAD segments of a 64-bit little-endian ELF file, or undefined. */
function readElfSymbols(b: Uint8Array): ElfSyms | undefined {
	if (b.length < 64 || b[0] !== 0x7f || b[1] !== 0x45 || b[2] !== 0x4c || b[3] !== 0x46 || b[4] !== 2 || b[5] !== 1) return undefined;
	const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
	const n64 = (o: number): number => Number(dv.getBigUint64(o, true));
	const phoff = n64(32), shoff = n64(40);
	const phentsize = dv.getUint16(54, true), phnum = dv.getUint16(56, true);
	const shentsize = dv.getUint16(58, true), shnum = dv.getUint16(60, true);
	const loads: ElfSyms["loads"] = [];
	for (let i = 0; i < phnum; i++) {
		const p = phoff + i * phentsize;
		if (p + 56 > b.length) break;
		// An executable segment by p_memsz: a separate debug file keeps the
		// segments but truncates their p_filesz (its code is NOBITS).
		if (dv.getUint32(p, true) === 1) loads.push({ off: n64(p + 8), size: n64(p + (dv.getUint32(p + 4, true) & 1 ? 40 : 32)), vaddr: n64(p + 16) });
	}
	const secs: { type: number; off: number; size: number; link: number; entsize: number }[] = [];
	for (let i = 0; i < shnum; i++) {
		const h = shoff + i * shentsize;
		if (h + 64 > b.length) break;
		secs.push({ type: dv.getUint32(h + 4, true), off: n64(h + 24), size: n64(h + 32), link: dv.getUint32(h + 40, true), entsize: n64(h + 56) });
	}
	let syms: { addr: number; size: number; name: string }[] = [];
	for (const type of [2, 11]) { // SHT_SYMTAB, then SHT_DYNSYM
		for (const sec of secs) {
			if (sec.type !== type || sec.entsize < 24) continue;
			const str = secs[sec.link];
			if (!str) continue;
			for (let o = sec.off; o + 24 <= Math.min(sec.off + sec.size, b.length); o += sec.entsize) {
				const info = b[o + 4]!, shndx = dv.getUint16(o + 6, true), value = n64(o + 8);
				const st = info & 0xf;
				if ((st !== 2 && st !== 10) || !shndx || !value) continue; // STT_FUNC, STT_GNU_IFUNC; defined
				let e = str.off + dv.getUint32(o, true);
				const s0 = e;
				while (e < b.length && b[e] !== 0) e++;
				syms.push({ addr: value, size: n64(o + 16), name: decoder.decode(b.subarray(s0, e)) });
			}
		}
		if (syms.length) break;
	}
	syms.sort((x, y) => x.addr - y.addr || y.size - x.size);
	syms = syms.filter((x, i) => i === 0 || x.addr !== syms[i - 1]!.addr);
	return { loads, addrs: syms.map((x) => x.addr), names: syms.map((x) => x.name), sizes: syms.map((x) => x.size) };
}

/** The symbol at file offset `off` of an ELF file, as name+0xdelta ("?" beyond a sized symbol's end). */
function symbolAt(e: ElfSyms, off: number): string | undefined {
	const seg = e.loads.find((l) => off >= l.off && off < l.off + l.size);
	if (!seg) return undefined;
	const va = off - seg.off + seg.vaddr;
	let lo = 0, hi = e.addrs.length - 1, at = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (e.addrs[mid]! <= va) { at = mid; lo = mid + 1; } else hi = mid - 1;
	}
	if (at < 0) return undefined;
	const delta = va - e.addrs[at]!;
	const size = e.sizes[at]!;
	// Far past a sized symbol (a stripped file's local code): no name.
	if (size && delta - size > 0x10000) return undefined;
	return `${e.names[at]}+0x${delta.toString(16)}${size && delta >= size ? "?" : ""}`;
}

/**
 * Name the code of a report: read the files of its top `top` sites and
 * pages (by time, then instructions) through `read`, and set `symbol` on
 * every site and page of a file that is an ELF file with symbols (the
 * nearest function symbol at or below the offset: .symtab, else the
 * exported ones in .dynsym; "?" after it when the offset is beyond that
 * symbol's size, which in a stripped file means a local function, and
 * none when it is more than 64 KiB beyond), and
 * `symbols`, the samples per (file, symbol; those past a symbol's end add
 * up as "name?"). Returns the report.
 */
export async function symbolizeProfile(r: ProfileReport, read: ProfileFileReader, top = 200): Promise<ProfileReport> {
	const want = new Set<string>();
	const byIns = <T extends { timeSamples: number; insnSamples: number }>(a: T[]): T[] => [...a].sort((x, y) => y.insnSamples - x.insnSamples);
	for (const list of [r.sites.slice(0, top), byIns(r.sites).slice(0, top), r.pages.slice(0, top), byIns(r.pages).slice(0, top)])
		for (const x of list) if (x.pid === undefined) want.add(x.path);
	const elf = new Map<string, ElfSyms>();
	for (const p of want) {
		try {
			const bytes = await read(p);
			const e = bytes && readElfSymbols(bytes);
			if (e && e.addrs.length) elf.set(p, e);
		} catch {
			// not readable: no symbols for it
		}
	}
	const syms = new Map<string, ProfileSymbol>();
	const best = new Map<string, { n: number; symbol: string }>();
	for (const x of r.sites) {
		const e = x.pid === undefined ? elf.get(x.path) : undefined;
		const name = e && symbolAt(e, Number(BigInt(x.off)));
		if (!name) continue;
		x.symbol = name;
		// "name?": past the end of `name`, a function without a symbol of its own
		const fn = name.replace(/\+0x[0-9a-f]+(\??)$/, "$1");
		const key = `${x.path}\0${fn}`;
		let y = syms.get(key);
		if (!y) syms.set(key, y = { path: x.path, symbol: fn, timeSamples: 0, insnSamples: 0 });
		y.timeSamples += x.timeSamples;
		y.insnSamples += x.insnSamples;
		const pk = `${x.path}\0${BigInt(x.off) >> 12n}`;
		const n = x.timeSamples + x.insnSamples;
		if (n > (best.get(pk)?.n ?? 0)) best.set(pk, { n, symbol: fn });
	}
	for (const p of r.pages) {
		const b = p.pid === undefined ? best.get(`${p.path}\0${BigInt(p.page) >> 12n}`) : undefined;
		if (b) p.symbol = b.symbol;
	}
	r.symbols = [...syms.values()].sort(byTime);
	return r;
}
