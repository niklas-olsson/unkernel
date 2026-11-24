// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The live numbers of System's Overview (components/Overview.tsx), of the
// top bar's resource meters (components/TopBar.tsx) and of the Control
// Center's resources (components/Glance.tsx): one sampler that reads the guest's /proc,
// the SDK's host counters and guest GL's and guest Vulkan's counters, and
// keeps a short history of them for the charts.
//
// - One guest read per sample: a vm.exec() of STATS_SH, a POSIX sh snippet
//   (dash on Debian, busybox ash on Alpine and the base shell) of shell
//   builtins only (read, printf, case: no program is started, so nothing is
//   read from the distro image), which prints /proc/stat's CPU lines, part of
//   /proc/meminfo, /proc/loadavg, /proc/uptime, the kernel release,
//   /proc/net/dev, each interface's operstate and a line per user process
//   (kernel threads left out); every DF_EVERY full samples also `df -kP /
//   /data`, the one program it runs. A light sample (below) prints only the
//   CPU lines, memory, load, uptime and /proc/net/dev. It runs as the
//   guest's default user (`user`, or root on the base shell): everything it
//   reads is world-readable.
// - Host counters without the guest (vm.stats(): block I/O, the JIT's
//   compiles, task switches, kwemu's instruction count on a stats kernel),
//   taken with each sample, and guest GL's (vm.gl: the renderer's state and
//   WebGL2 implementation, its command buffers and the time it spent on
//   them, virtio-gpu's presents, fences and errors; the Wayland compositor's
//   GPU commits, wayland/buffers.ts stats), and guest Vulkan's (vm.vk: the
//   renderer's state and WebGPU adapter, the instances served, device losses,
//   and the renderer's counters: presents, external presents, draws,
//   dispatches, submits, bytes written and read back, pipelines, shader
//   translations, errors, live objects): a few property reads, no guest.
//   Neither ever starts a renderer's load: each loads on the guest's first
//   use, and before that (or with the option off: no vm.gl, no vm.vk) there
//   is nothing to read.
// - Users: useStats() (full: the Overview while System's window shows it,
//   the top bar's Resources while it is open) samples every INTERVAL ms with the
//   full snippet; useStats("lite") (the top bar, always mounted, and the desktop's widget) samples
//   every LITE_INTERVAL ms with the light one while no full user is
//   mounted. Either way it is one sampler: never two reads at once, one
//   history. A full user that arrives during a light read gets its full
//   sample right after it.
// - Only while the page is visible and the machine runs (not booting,
//   halted, paused, suspending or suspended): until then no read is made. A
//   read that fails (the guest's kwtty not up yet, a guest without it) is
//   not reported: the cards that need the guest say they wait for it, the
//   top bar's icons show nothing, and the next sample tries again.
// - History: the last RING samples (three minutes at INTERVAL, longer at
//   LITE_INTERVAL), kept in this module for the page's lifetime, so opening
//   the window or the popover shows what was gathered before, the top bar's
//   light samples too. A sample that could not read the guest has nulls for
//   the guest's fields (a gap in the charts). A light sample keeps the last
//   full one's kernel release and interface states; it has no processes or
//   df.
// - The parsing is pure functions of the snippet's text (parseSample(),
//   derive()), which work outside the browser too.
import { useEffect, useSyncExternalStore } from "react";
import { KW } from "./kw.ts";
import type { InstanceStats, KernelHandle } from "./sdk.ts";
import { createStore, phase, ui$, type Phase } from "./store.ts";
import { stats as wlStats } from "./wayland/buffers.ts";

/** How often a sample is taken, in ms, while a full user (the Overview) is mounted. */
export const INTERVAL = 2000;
/** How often a light sample is taken, in ms, while only light users (the top bar) are. */
export const LITE_INTERVAL = 5000;
/** Samples kept: three minutes. */
export const RING = 90;
/** df runs every this many samples (and on the first). */
const DF_EVERY = 15;
/** The guest's page size: the wasm kernel has 4 KiB pages only (arch/wasm Kconfig). */
const PAGE = 4096;
/** Two samples further apart than this (ms: the page was hidden, the window closed) give no rates. */
export const GAP = INTERVAL * 5;

/**
 * Prints the sections the parsers read, each after a line `@name`. $1 = df:
 * df too; $2 = lite: only stat, mem, load, up and net. Builtins only, so it is cheap in the guest and reads nothing from
 * the distro image; a file that cannot be read leaves its section empty.
 */
export const STATS_SH = [
	"w=$1 l=$2",
	"p() { while IFS= read -r l; do printf '%s\\n' \"$l\"; done; }",
	"echo @stat",
	"while IFS= read -r l; do case $l in cpu*|ctxt*|procs_r*) printf '%s\\n' \"$l\";; esac; done 2>/dev/null </proc/stat",
	"echo @mem",
	"while IFS= read -r l; do case $l in Mem*|Buffers:*|Cached:*|Swap[TF]*|Shmem:*|SReclaimable:*) printf '%s\\n' \"$l\";; esac; done 2>/dev/null </proc/meminfo",
	"echo @load",
	"p 2>/dev/null </proc/loadavg",
	"echo @up",
	"p 2>/dev/null </proc/uptime",
	"echo @net",
	"p 2>/dev/null </proc/net/dev",
	"[ \"$l\" = lite ] && exit 0",
	"echo @rel",
	"p 2>/dev/null </proc/sys/kernel/osrelease",
	"echo @if",
	"for f in /sys/class/net/*/operstate; do read -r s 2>/dev/null <\"$f\" && { f=${f%/operstate}; printf '%s %s\\n' \"${f##*/}\" \"$s\"; }; done",
	"echo @ps",
	// pid, utime+stime (ticks), rss (pages), comm; not kernel threads (kthreadd, pid 2, and its children), nor this shell.
	"for d in /proc/[0-9]*; do i=${d#/proc/}; [ \"$i\" = \"$$\" ] && continue; read -r s 2>/dev/null <\"$d/stat\" || continue; " +
		"c=${s#*\\(}; c=${c%\\)*}; set -- ${s##*\\) }; { [ \"$i\" = 2 ] || [ \"$2\" = 2 ]; } && continue; " +
		"printf '%s %s %s %s\\n' \"$i\" \"$(( ${12} + ${13} ))\" \"${22}\" \"$c\"; done",
	"if [ \"$w\" = df ]; then echo @df; df -kP / /data 2>/dev/null; fi",
	":",
].join("\n");

// ---- parsing (pure) ----------------------------------------------------------

export interface CpuTimes { busy: number; total: number }
export interface ProcStat { all: CpuTimes; cpus: CpuTimes[]; ctxt: number | null; running: number | null }
/** /proc/meminfo, in bytes (null: not listed). */
export interface MemInfo {
	total: number; free: number; available: number; buffers: number; cached: number;
	shmem: number; reclaimable: number; swapTotal: number; swapFree: number;
}
export interface LoadAvg { one: number; five: number; fifteen: number; running: number; tasks: number }
export interface NetDev { name: string; rx: number; tx: number }
export interface Proc { pid: number; ticks: number; rss: number; comm: string }
export interface DfRow { fs: string; size: number; used: number; avail: number; mount: string }

/** What one run of STATS_SH printed. */
export interface Raw {
	stat: ProcStat | null;
	mem: MemInfo | null;
	load: LoadAvg | null;
	/** Seconds since the guest booted. */
	uptime: number | null;
	release: string;
	net: NetDev[];
	/** Interface name: operstate (up, down, unknown). */
	ifs: Record<string, string>;
	procs: Proc[];
	/** null: df did not run this time. */
	df: DfRow[] | null;
}

/** The snippet's output by section. */
export function sections(text: string): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	let cur: string[] | null = null;
	for (const line of text.split("\n")) {
		if (/^@[a-z]+$/.test(line)) { cur = out[line.slice(1)] = []; continue; }
		if (cur && line.trim()) cur.push(line);
	}
	return out;
}

const nums = (s: string): number[] => s.trim().split(/\s+/).map(Number);

/** /proc/stat's cpu lines: busy and total jiffies (user..steal; guest time is already in user and nice). */
export function parseStat(lines: string[]): ProcStat | null {
	let all: CpuTimes | null = null, ctxt: number | null = null, running: number | null = null;
	const cpus: CpuTimes[] = [];
	for (const l of lines) {
		const m = /^(cpu\d*)\s+(.*)$/.exec(l);
		if (m) {
			const f = nums(m[2]!).slice(0, 8).map((n) => (Number.isFinite(n) ? n : 0));
			const total = f.reduce((a, b) => a + b, 0), idle = (f[3] ?? 0) + (f[4] ?? 0);
			const t = { busy: total - idle, total };
			if (m[1] === "cpu") all = t;
			else cpus[Number(m[1]!.slice(3))] = t;
			continue;
		}
		const k = /^(ctxt|procs_running)\s+(\d+)/.exec(l);
		if (k) (k[1] === "ctxt" ? (ctxt = Number(k[2])) : (running = Number(k[2])));
	}
	return all ? { all, cpus: cpus.filter(Boolean), ctxt, running } : null;
}

export function parseMeminfo(lines: string[]): MemInfo | null {
	const kv: Record<string, number> = {};
	for (const l of lines) {
		const m = /^(\w+):\s+(\d+)(?:\s+kB)?/.exec(l);
		if (m) kv[m[1]!] = Number(m[2]) * 1024;
	}
	if (!kv.MemTotal) return null;
	const free = kv.MemFree ?? 0, buffers = kv.Buffers ?? 0, cached = kv.Cached ?? 0, reclaimable = kv.SReclaimable ?? 0;
	return {
		total: kv.MemTotal, free, buffers, cached, reclaimable, shmem: kv.Shmem ?? 0,
		// Kernels since 3.14 list MemAvailable; the estimate free + cache stands in for an older one.
		available: kv.MemAvailable ?? free + buffers + cached + reclaimable,
		swapTotal: kv.SwapTotal ?? 0, swapFree: kv.SwapFree ?? 0,
	};
}

export function parseLoadavg(line: string | undefined): LoadAvg | null {
	const m = /^([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\/(\d+)/.exec(line?.trim() ?? "");
	return m ? { one: +m[1]!, five: +m[2]!, fifteen: +m[3]!, running: +m[4]!, tasks: +m[5]! } : null;
}

export function parseUptime(line: string | undefined): number | null {
	const n = Number.parseFloat(line ?? "");
	return Number.isFinite(n) ? n : null;
}

/** /proc/net/dev: bytes received and sent per interface (its two header lines have a |). */
export function parseNetDev(lines: string[]): NetDev[] {
	const out: NetDev[] = [];
	for (const l of lines) {
		const i = l.indexOf(":");
		if (i < 0 || l.includes("|")) continue;
		const f = nums(l.slice(i + 1));
		if (f.length >= 9 && Number.isFinite(f[0]) && Number.isFinite(f[8])) out.push({ name: l.slice(0, i).trim(), rx: f[0]!, tx: f[8]! });
	}
	return out;
}

export function parseIfs(lines: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const l of lines) {
		const [name, state] = l.trim().split(/\s+/);
		if (name && state) out[name] = state;
	}
	return out;
}

/** The snippet's process lines: pid, ticks, rss in pages, comm (which may hold spaces). */
export function parsePs(lines: string[]): Proc[] {
	const out: Proc[] = [];
	for (const l of lines) {
		const m = /^(\d+) (\d+) (\d+) (.*)$/.exec(l);
		if (m) out.push({ pid: +m[1]!, ticks: +m[2]!, rss: +m[3]! * PAGE, comm: m[4]! });
	}
	return out;
}

/** df -kP: size, used and available in bytes per file system (repeats of one mount once). */
export function parseDf(lines: string[]): DfRow[] {
	const out: DfRow[] = [];
	for (const l of lines) {
		const m = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+(\/.*)$/.exec(l);
		if (!m || out.some((r) => r.mount === m[5])) continue;
		out.push({ fs: m[1]!, size: +m[2]! * 1024, used: +m[3]! * 1024, avail: +m[4]! * 1024, mount: m[5]! });
	}
	return out;
}

export function parseSample(text: string): Raw {
	const s = sections(text);
	return {
		stat: parseStat(s.stat ?? []),
		mem: parseMeminfo(s.mem ?? []),
		load: parseLoadavg(s.load?.[0]),
		uptime: parseUptime(s.up?.[0]),
		release: s.rel?.[0]?.trim() ?? "",
		net: parseNetDev(s.net ?? []),
		ifs: parseIfs(s.if ?? []),
		procs: parsePs(s.ps ?? []),
		df: s.df ? parseDf(s.df) : null,
	};
}

/** A process with its share of one CPU since the last sample (0 to 1 per CPU, null on the first sample it is in). */
export interface TopProc { pid: number; comm: string; cpu: number | null; rss: number }

/** What two reads in a row give: shares of the CPUs and rates. */
export interface Derived {
	/** Share of all CPUs busy, 0 to 1. */
	cpu: number | null;
	cpus: number[] | null;
	/** Bytes per second, all interfaces but lo. */
	rx: number | null;
	tx: number | null;
	/** Guest context switches per second. */
	ctxt: number | null;
	/** Every user process of a full read, the busiest first (then by memory); empty for a light read. */
	procs: TopProc[];
}

const share = (a: CpuTimes, b: CpuTimes) => (b.total > a.total ? Math.min(1, Math.max(0, (b.busy - a.busy) / (b.total - a.total))) : null);
const netSum = (r: Raw) => r.net.filter((n) => n.name !== "lo").reduce((a, n) => ({ rx: a.rx + n.rx, tx: a.tx + n.tx }), { rx: 0, tx: 0 });

/**
 * Deltas between two reads; `dt` is the wall time between them in seconds,
 * used where the guest's own uptime does not say (it is the better clock:
 * the read's latency does not skew it).
 */
export function derive(prev: Raw | null, cur: Raw, dt: number): Derived {
	const d: Derived = { cpu: null, cpus: null, rx: null, tx: null, ctxt: null, procs: [] };
	const secs = prev?.uptime != null && cur.uptime != null && cur.uptime > prev.uptime ? cur.uptime - prev.uptime : dt;
	const ps = prev?.stat, cs = cur.stat;
	if (ps && cs) {
		d.cpu = share(ps.all, cs.all);
		if (cs.cpus.length > 1 && ps.cpus.length === cs.cpus.length) d.cpus = cs.cpus.map((c, i) => share(ps.cpus[i]!, c) ?? 0);
		if (ps.ctxt != null && cs.ctxt != null && secs > 0) d.ctxt = Math.max(0, (cs.ctxt - ps.ctxt) / secs);
	}
	if (prev && secs > 0 && cur.net.length && prev.net.length) {
		const a = netSum(prev), b = netSum(cur);
		if (b.rx >= a.rx && b.tx >= a.tx) { d.rx = (b.rx - a.rx) / secs; d.tx = (b.tx - a.tx) / secs; }
	}
	// A process's ticks against one CPU's jiffies over the same span (the cpu line sums every CPU's).
	const n = Math.max(1, cs?.cpus.length ?? 1);
	const span = ps && cs ? (cs.all.total - ps.all.total) / n : 0;
	const before = new Map(prev?.procs.map((p) => [p.pid, p.ticks]));
	const top = cur.procs.map((p): TopProc => {
		const was = before.get(p.pid);
		return { pid: p.pid, comm: p.comm, rss: p.rss, cpu: was != null && span > 0 ? Math.max(0, (p.ticks - was) / span) : null };
	});
	top.sort((a, b) => (b.cpu ?? -1) - (a.cpu ?? -1) || b.rss - a.rss);
	d.procs = top;
	return d;
}

// ---- the sampler ---------------------------------------------------------------

/** One sample in the history; null: not known for it (the guest could not be read, or the first read). */
export interface Point {
	/** Date.now() when it was taken. */
	t: number;
	cpu: number | null;
	cpus: number[] | null;
	/** Guest memory in use (MemTotal - MemAvailable) and its total, bytes. */
	mem: number | null;
	memTotal: number | null;
	/** Network bytes per second. */
	rx: number | null;
	tx: number | null;
	/** Host block I/O, bytes per second (every kwblk disk: the data disk, the distro image). */
	rd: number | null;
	wr: number | null;
	/** JIT compiles per second (host). */
	jit: number | null;
	/** Host task switches per second (each one a JSPI stack switch). */
	sw: number | null;
	/** Millions of guest instructions per second (a -Dkwemu-stats kernel only). */
	mips: number | null;
	/**
	 * Guest GL (null without it): frames per second the GPU path showed
	 * (virtio-gpu presents of the scanout plus the Wayland compositor's GPU
	 * commits), command buffers per second the renderer ran (vtest and
	 * virtio-gpu alike), and the share of the page's time, 0 to 1, the
	 * renderer spent running them (decoding, issuing WebGL calls, reads that
	 * wait for the GPU): its load on the page, not the GPU's utilisation,
	 * which WebGL does not tell.
	 */
	fps: number | null;
	glCmd: number | null;
	glBusy: number | null;
	/**
	 * Guest Vulkan (null without its renderer, or across a new one): presents
	 * per second (all of them, and those by external buffer: zero-copy, no
	 * readback; the rest were read back), draws, compute dispatches and
	 * submits per second, buffer bytes written to the GPU and bytes read back
	 * per second, and the share of the page's time, 0 to 1, the renderer
	 * spent parsing the guest's frames, translating shaders and encoding
	 * submits (its load on the page; WebGPU does not tell the GPU's).
	 */
	vkFps: number | null;
	vkExt: number | null;
	vkDraws: number | null;
	vkDispatch: number | null;
	vkSubmits: number | null;
	vkUp: number | null;
	vkDown: number | null;
	vkBusy: number | null;
}

/** Guest GL's state at the last sample (vm.gl), or null without guest GL. */
export interface GpuInfo {
	/** The renderer: idle (loads on the guest's first GL use), loading, ready, lost (its WebGL2 context), failed. */
	state: "idle" | "loading" | "ready" | "lost" | "failed";
	/** The WebGL2 implementation it draws on (WEBGL_debug_renderer_info), once loaded. */
	webgl: string | null;
	/** How long its load took, ms, or null. */
	loadMs: number | null;
	/** vtest GL clients open now, and since the start. */
	clients: number;
	opened: number;
	/** The renderer's command buffers since it loaded (null before). */
	submits: number | null;
	/** The virtio-gpu device's side (null without one: ?gpu=0, GL over vtest only). */
	device: {
		commands: number; presents: number; fenced: number; parks: number; errors: number; lastError: string; contextLost: boolean;
		/** The scanout's size, or null while no KMS client shows one. */
		scanout: { width: number; height: number } | null;
	} | null;
	/** Wayland commits of GPU buffers (wland's dmabuf windows) since the page loaded. */
	wlGpu: number;
}

/** Guest Vulkan's state at the last sample (vm.vk), or null without it (the option off, no WebGPU). */
export interface VkInfo {
	/** The renderer: idle (loads on the guest's first VkInstance), loading, ready, lost (its WebGPU device), failed. */
	state: "idle" | "loading" | "ready" | "lost" | "failed";
	/** The WebGPU adapter it runs on, once loaded. */
	adapter: string | null;
	/** How long its load took, ms, or null. */
	loadMs: number | null;
	/** Why it failed or was lost, or null. */
	error: string | null;
	/** Guest VkInstances served now, and since the start. */
	connections: number;
	opened: number;
	/** WebGPU devices lost. */
	losses: number;
	/** The current renderer's counters (vm.vk.stats.renderer; they start again with each new renderer), or null before the first program and after a loss. */
	renderer: {
		presents: number; externalPresents: number; draws: number; dispatches: number; submits: number;
		bytesWritten: number; bytesRead: number; pipelines: number; translations: number; translateMs: number;
		errors: number; lost: number; liveObjects: number; liveGpu: number;
	} | null;
}

export interface StatsState {
	points: Point[];
	/** The last guest read and what it gave, or null before the first one. */
	guest: { t: number; raw: Raw; derived: Derived } | null;
	/** The last df (it runs now and then). */
	df: DfRow[] | null;
	/** The last host counters, or null before the machine ran. */
	host: { t: number; stats: InstanceStats } | null;
	/** Guest GL at the last sample, or null without it. */
	gpu: GpuInfo | null;
	/** Guest Vulkan at the last sample, or null without it. */
	vk: VkInfo | null;
	/** The last guest read failed, or none has been made: the cards that need the guest wait. */
	waiting: boolean;
	/** Why no sample is being taken now ("" while sampling). */
	idle: string;
}

const $ = createStore<StatsState>({ points: [], guest: null, df: null, host: null, gpu: null, vk: null, waiting: true, idle: "" });
export const stats$ = $;

/** Mounted users: full (the Overview) and light (the top bar). */
let full = 0, lite = 0;
const users = () => full + lite;
const interval = () => (full > 0 ? INTERVAL : LITE_INTERVAL);
let timer: ReturnType<typeof setTimeout> | undefined;
let inflight = false;
/** A full user arrived during a read: the next sample comes right after it. */
let soon = false;
/** Full reads made (df runs every DF_EVERY of them). */
let fullReads = 0;
let prevHost: { t: number; s: InstanceStats } | null = null;
/** Guest GL's counters at the last sample: frames shown, command buffers, ms in the renderer. */
let prevGpu: { t: number; frames: number; submits: number | null; busyMs: number | null } | null = null;
/** Guest Vulkan's renderer counters at the last sample (with the device losses then: a new renderer counts from 0). */
let prevVk: { t: number; losses: number; r: NonNullable<VkInfo["renderer"]>; busyMs: number } | null = null;

/** Why sampling does not run in each phase of the machine (store.ts phase()); "": it may. */
const PHASE_WHY: Record<Phase, string> = {
	starting: "booting", running: "", suspending: "suspending", held: "paused", suspended: "suspended", halted: "halted", error: "stopped",
};

/** Why sampling should not run now, or "". */
function blocked(): string {
	if (document.hidden) return "the page is hidden";
	let s;
	try { s = ui$().get(); } catch { return "starting"; }
	const why = PHASE_WHY[phase(s)];
	if (why) return why;
	if (!KW.vm) return "starting";
	return "";
}

function schedule(ms = interval()): void {
	clearTimeout(timer);
	timer = users() > 0 ? setTimeout(tick, ms) : undefined;
}

async function tick(): Promise<void> {
	timer = undefined;
	if (!users() || inflight) return;
	const why = blocked();
	if ($.get().idle !== why) $.set({ idle: why });
	if (why) { prevHost = prevGpu = prevVk = null; schedule(); return; }
	inflight = true;
	const t0 = Date.now();
	try {
		await sample(KW.vm as KernelHandle);
	} finally {
		inflight = false;
		schedule(soon ? 0 : Math.max(250, interval() - (Date.now() - t0)));
		soon = false;
	}
}

async function sample(vm: KernelHandle): Promise<void> {
	const t = Date.now();
	const pt: Point = { t, cpu: null, cpus: null, mem: null, memTotal: null, rx: null, tx: null, rd: null, wr: null, jit: null, sw: null, mips: null, fps: null, glCmd: null, glBusy: null,
		vkFps: null, vkExt: null, vkDraws: null, vkDispatch: null, vkSubmits: null, vkUp: null, vkDown: null, vkBusy: null };
	// Host counters: no guest involved.
	let host: StatsState["host"] = $.get().host;
	try {
		const s = vm.stats();
		const p = prevHost, dt = p ? (t - p.t) / 1000 : 0;
		if (p && dt > 0 && dt < GAP / 1000) {
			pt.rd = Math.max(0, (s.block.bytesRead - p.s.block.bytesRead) / dt);
			pt.wr = Math.max(0, (s.block.bytesWritten - p.s.block.bytesWritten) / dt);
			if (s.jit.enabled) pt.jit = Math.max(0, (s.jit.compiled - p.s.jit.compiled) / dt);
			pt.sw = Math.max(0, (s.switches - p.s.switches) / dt);
			if (s.kwemu && p.s.kwemu) pt.mips = Math.max(0, (s.kwemu.icount - p.s.kwemu.icount) / dt / 1e6);
		}
		prevHost = { t, s };
		host = { t, stats: s };
	} catch { /* the kernel is gone: the guest read fails too */ }
	const gpu = sampleGpu(vm, pt);
	const vk = sampleVk(vm, pt);
	// The guest: one exec of the snippet.
	const st = $.get();
	let guest = st.guest, df = st.df, waiting = false;
	const isFull = full > 0;
	try {
		const withDf = isFull && (df === null || fullReads % DF_EVERY === 0);
		const r = await vm.exec("/bin/sh", ["-c", STATS_SH, "sh", withDf ? "df" : "", isFull ? "" : "lite"], { timeout: 4000, signal: AbortSignal.timeout(8000) });
		const raw = parseSample(r.stdout);
		if (!raw.stat && !raw.mem) throw new Error("nothing read");
		if (isFull) fullReads++;
		else if (guest) { raw.release ||= guest.raw.release; raw.ifs = guest.raw.ifs; }
		const prev = guest && t - guest.t < GAP ? guest.raw : null;
		const derived = derive(prev, raw, guest ? (t - guest.t) / 1000 : 0);
		guest = { t, raw, derived };
		if (raw.df) df = raw.df;
		Object.assign(pt, { cpu: derived.cpu, cpus: derived.cpus, rx: derived.rx, tx: derived.tx });
		if (raw.mem) { pt.mem = raw.mem.total - raw.mem.available; pt.memTotal = raw.mem.total; }
	} catch {
		waiting = true; // not reported: the guest may not run its kwtty yet, or the kernel stopped
	}
	const points = [...$.get().points, pt];
	if (points.length > RING) points.splice(0, points.length - RING);
	$.set({ points, guest, df, host, gpu, vk, waiting });
}

/** Guest GL's state and rates (into pt) from vm.gl, or null without it; property reads only. */
function sampleGpu(vm: KernelHandle, pt: Point): GpuInfo | null {
	let gl;
	try { gl = vm.gl; } catch { return null; }
	if (!gl) { prevGpu = null; return null; }
	try {
		const s = gl.stats, st = gl.status, g = s.gpu, r = s.renderer;
		const busyMs = r ? r.submitMs + r.readMs + r.writeMs + r.otherMs : null;
		const frames = (g?.presents ?? 0) + wlStats.gpuCommits;
		const p = prevGpu, dt = p ? (pt.t - p.t) / 1000 : 0;
		if (p && dt > 0 && dt < GAP / 1000) {
			// A new renderer (after a lost context) counts from 0 again: no rate across it.
			if (frames >= p.frames) pt.fps = (frames - p.frames) / dt;
			if (r && p.submits != null && r.submits >= p.submits) pt.glCmd = (r.submits - p.submits) / dt;
			else if (r && p.submits == null) pt.glCmd = r.submits / dt;
			if (busyMs != null && p.busyMs != null && busyMs >= p.busyMs) pt.glBusy = Math.min(1, (busyMs - p.busyMs) / (dt * 1000));
		}
		prevGpu = { t: pt.t, frames, submits: r?.submits ?? null, busyMs };
		const sc = gl.gpu?.scanout;
		return {
			state: st.state, webgl: st.webgl, loadMs: st.loadMs, clients: s.clients, opened: s.opened, submits: r?.submits ?? null,
			device: g ? {
				commands: g.commands, presents: g.presents, fenced: g.fenced, parks: g.parks, errors: g.errors, lastError: g.lastError, contextLost: g.contextLost,
				scanout: sc ? { width: sc.width, height: sc.height } : null,
			} : null,
			wlGpu: wlStats.gpuCommits,
		};
	} catch {
		return null;
	}
}

/** Guest Vulkan's state and rates (into pt) from vm.vk, or null without it; property reads only (never vm.vk.load()). */
function sampleVk(vm: KernelHandle, pt: Point): VkInfo | null {
	let vk;
	try { vk = vm.vk; } catch { return null; }
	if (!vk) { prevVk = null; return null; }
	try {
		const s = vk.status, st = vk.stats, x = st.renderer;
		const n = (k: string) => x?.[k] ?? 0;
		const r: VkInfo["renderer"] = x ? {
			presents: n("presents"), externalPresents: n("externalPresents"), draws: n("draws"), dispatches: n("dispatches"), submits: n("submits"),
			bytesWritten: n("bytesWritten"), bytesRead: n("bytesRead"), pipelines: n("pipelines"), translations: n("translations"), translateMs: n("translateMs"),
			errors: n("errors"), lost: n("lost"), liveObjects: n("liveObjects"), liveGpu: n("liveGpu"),
		} : null;
		const busyMs = n("encodeMs") + n("parseMs") + n("translateMs");
		const p = prevVk, dt = p ? (pt.t - p.t) / 1000 : 0;
		// No rates across a new renderer (after a device loss its counters start again).
		if (r && p && p.losses === st.losses && r.submits >= p.r.submits && dt > 0 && dt < GAP / 1000) {
			const rate = (k: keyof typeof r) => Math.max(0, (r[k] - p.r[k]) / dt);
			pt.vkFps = rate("presents");
			pt.vkExt = rate("externalPresents");
			pt.vkDraws = rate("draws");
			pt.vkDispatch = rate("dispatches");
			pt.vkSubmits = rate("submits");
			pt.vkUp = rate("bytesWritten");
			pt.vkDown = rate("bytesRead");
			pt.vkBusy = Math.min(1, Math.max(0, (busyMs - p.busyMs) / (dt * 1000)));
		}
		prevVk = r ? { t: pt.t, losses: st.losses, r, busyMs } : null;
		return { state: s.state, adapter: s.adapter, loadMs: s.loadMs, error: s.error, connections: st.connections, opened: st.opened, losses: st.losses, renderer: r };
	} catch {
		return null;
	}
}

function onVisibility(): void {
	if (!document.hidden && users() > 0 && !inflight) schedule(0);
}

/**
 * The sampler's state; sampling runs while a component that calls this is
 * mounted: "full" (the default: the Overview, the top bar's Resources) at
 * INTERVAL with the full snippet, "lite" (the top bar) at LITE_INTERVAL with
 * the light one while no full user is mounted.
 */
export function useStats(kind: "full" | "lite" = "full"): StatsState {
	useEffect(() => {
		const first = users() === 0;
		if (kind === "full") full++;
		else lite++;
		if (first) document.addEventListener("visibilitychange", onVisibility);
		// A first user, or a full one joining light sampling: sample now (after a read in flight).
		if (first || (kind === "full" && full === 1)) {
			if (inflight) soon = true;
			else schedule(0);
		}
		return () => {
			if (kind === "full") full--;
			else lite--;
			if (users() > 0) { if (!inflight) schedule(); return; }
			document.removeEventListener("visibilitychange", onVisibility);
			clearTimeout(timer);
			timer = undefined;
		};
	}, [kind]);
	return useSyncExternalStore($.subscribe, $.get);
}
