// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// unkernel host runtime (shared by Node and the browser).
//
// The kernel is one instance on one thread: wasm64 (vmlinux), or the same
// module lowered to a 32-bit memory and table (vmlinux32.wasm, which the
// page and the bundle use; see moduleIsMemory64). Each kernel task runs on
// its own Wasm stack; switching between them uses JSPI (JavaScript Promise
// Integration): the kernel calls the suspending import `wasm_switch_to`,
// which parks the current stack on a promise and resumes (or starts) the
// next task. Idle and periodic yields are suspending imports as well, which
// is when the host event loop gets to run (console input, timers).
//
// Imports: generic services (clocks, randomness, console, idle, yield, exit,
// command line, initrd) are a WASI preview 1 subset (wasi.ts); task
// switching, kwblk, kwnet, kwfb (display.ts), kwinput (input.ts), kwsnd
// (sound.ts), kwvsock (vsock.ts), kwshm (shm.ts), kwvirtio (virtio.ts: virtio-gpu,
// virtio-gpu.ts), the console window size, the host stack
// trace and kwemu's JIT tier (kw_host_jit_*, jit.ts) are module "unkernel".
// Every
// import except the suspending ones (wasm_switch_to, poll_oneoff,
// sched_yield, proc_exit) must return synchronously.
//
// An SMP kernel (CONFIG_SMP: it imports wasm_cpu_start, and its memory is
// shared) runs this instance as CPU 0, with every device, and asks for
// the other CPUs through wasm_cpu_start: each is another instance of the
// module on the same memory in its own thread (cpu.ts, started by
// KernelConfig.spawnCpu). Other CPUs set IPI bits in wasm_host_irqs, so
// the host sets its own bits there atomically, and an idle wait also ends
// on a change of that word (Atomics.waitAsync, the kernel's notify). Every
// CPU's console output, this one's too, goes into one shared ring
// (console-ring.ts), read by the owner in worker mode with the shared
// transport (KernelConfig.consoleRing) and by this host otherwise.

import { BlockHost, type BlockDevice, type DiskSnapshotState } from "./block.ts";
import { ConsoleRing, ConsoleRingReader, newConsoleRing, type ConsoleFull } from "./console-ring.ts";
import { ConsoleOrder, type CpuEndpoint, type CpuInit, type CpuMessage } from "./cpu.ts";
import { DisplayHost, type DisplayMode, type DisplayOption } from "./display.ts";
import { InputHost, type InputState } from "./input.ts";
import { Profiler, profileOff, type ProfileOptions, type SamplerHandle, type SamplerInit } from "./profile.ts";
import { JIT_MIRROR_WORDS, JitHost, jitBufFromMirror, jitStatsFromMirror, sumJitStats, type JitStats, type KwemuStats } from "./jit.ts";
import { SoundHost, type SoundOption } from "./sound.ts";
import { ShmDevice } from "./shm.ts";
import { HOLD_CLOCK_LAG_MS, SNAPSHOT_COMMIT_TIMEOUT_MS, SnapshotCommitError, awakeTimeout, copySnapshotMemory, restoreSnapshotMemory, snapshotCpuMismatch, snapshotDeviceMismatch, snapshotDiskMismatch, type DeviceSnapshots, type KernelSnapshot, type SnapshotOptions } from "./snapshot.ts";
import { VirtioHost } from "./virtio.ts";
import { VirtioGpu, type GpuBackend } from "./virtio-gpu.ts";
import { VsockDevice } from "./vsock.ts";
import { STACK_DROPPED, WasiHost, dropStack, never, stackDropped } from "./wasi.ts";
import { errorText } from "./output.ts";

const IRQ_CONSOLE = 1;
const IRQ_NET = 2;
/**
 * The host asks the kernel to sync (ksys_sync(): write back and flush every
 * file system; WASM_IRQ_SYNC). The kernel clears the bit when it takes the
 * request.
 */
export const IRQ_SYNC = 4;
/** kwinput events queued (input.ts). */
const IRQ_INPUT = 5;
/** kwvsock packets queued, or room again after a refused packet (vsock.ts). */
const IRQ_VSOCK = 6;
/** kwshm requests queued (shm.ts). */
const IRQ_SHM = 7;
/** Park every task and call wasm_snapshot_point (snapshot()). */
const IRQ_SNAPSHOT = 8;
/** kwvirtio: used buffers or a config change (virtio.ts). */
const IRQ_VIRTIO = 10;
/** With IRQ_SNAPSHOT: sync and drop the file caches before that snapshot (SnapshotOptions.dropCaches). */
const IRQ_DROP_CACHES = 11;
const EBUSY = 16;
const ENOSYS = 38;

const textDecoder = new TextDecoder();

/** A snapshot() waiting for the kernel's consistent point. */
interface SnapshotWaiter {
	resolve: (s: KernelSnapshot) => void;
	reject: (e: Error) => void;
	stop: boolean;
	commit?: SnapshotOptions["commit"];
	commitTimeoutMs: number;
	hold?: SnapshotOptions["hold"];
}

/**
 * How a kernel run ended: "halt" (orderly power-off/reboot: code 0 power
 * off, 1 halt, 2 restart), "panic" (code 253), "trap" (a wasm trap or JS
 * exception inside the kernel, code 254, `error` holds it), "fatal" (a host
 * runtime invariant broke, code 255) or "stopped" (Kernel.stop()).
 */
export type ExitKind = "halt" | "panic" | "trap" | "fatal" | "stopped";

export interface ExitResult {
	code: number;
	reason: string;
	kind: ExitKind;
	error?: unknown;
}

/**
 * The host side of the kwnet device, e.g. a NetStack (net.ts). Frames for
 * the guest go through Kernel.receiveFrame().
 */
export interface NetDevice {
	/** The guest's MAC address (6 bytes). */
	mac?: Uint8Array;
	/** Called once when the guest's driver initialises. */
	attach?(kernel: Kernel): void;
	/** An Ethernet frame from the guest. */
	send(frame: Uint8Array): void;
	/** Release host resources (connections, sockets). */
	close?(): void;
}

/** Detail of the "memory" boot stage. */
export interface MemoryStage {
	mib: number;
	requestedMiB: number;
	failures: string[];
	memory64: boolean;
}

export type BootStage = "memory" | "instantiate" | "start" | "exit";

export interface KernelStats {
	switches: number;
	idles: number;
	yields: number;
}

export interface KernelConfig {
	/** Compiled vmlinux (wasm64) or vmlinux32.wasm (lowered), or a bundle of either. */
	module: WebAssembly.Module;
	/** Memory type to import; default: moduleIsMemory64(module). */
	memory64?: boolean;
	/** Default 2048. */
	memoryMiB?: number;
	/** Default: the module's bundled one (bundledBoot), else "". */
	cmdline?: string;
	/** Default (undefined): the module's bundled initramfs, if any; null boots without one. */
	initrd?: Uint8Array | null;
	/** Smaller sizes to try, in order, if allocating memoryMiB fails (e.g. a phone without the address space). */
	memoryFallbackMiB?: number[];
	/** Console output. */
	write: (bytes: Uint8Array) => void;
	/** Host diagnostics; default console.error. */
	log?: (msg: string) => void;
	/**
	 * Boot progress: "memory" (MemoryStage), "instantiate", "start" (kernel
	 * entry), "exit" (ExitResult).
	 */
	onStage?: (stage: BootStage, detail?: MemoryStage | ExitResult) => void;
	/** kwblk disks: /dev/wda, wdb, ... */
	disks?: BlockDevice[];
	/** kwnet device; without one the guest has no network interface. */
	net?: NetDevice;
	/**
	 * Offer a display (kwfb, /dev/fb0; display.ts): true (640x480), a size,
	 * or a function returning the size wanted when a program first opens
	 * it. Default false: the guest has no framebuffer device.
	 */
	display?: DisplayOption;
	/** A guest program opened the display (its mode), or the last one closed it (null). */
	onDisplay?: (mode: DisplayMode | null) => void;
	/**
	 * With a display, the guest also gets a keyboard and a mouse (kwinput,
	 * evdev). Called when some program opens or the last one closes them.
	 */
	onInput?: (state: InputState) => void;
	/** Offer a sound card (kwsnd: ALSA playback, sound.ts) and where its PCM goes. Default false: none. */
	sound?: SoundOption;
	/**
	 * Offer a vsock device (kwvsock: AF_VSOCK, guest CID 3, host CID 2;
	 * vsock.ts). Default false: the kernel registers no transport. The
	 * guest's packets go to onVsockPacket; Kernel.vsock.deliver() sends.
	 */
	vsock?: boolean;
	/** A packet from the guest's kwvsock (header and payload; a copy). */
	onVsockPacket?: (pkt: Uint8Array) => void;
	/** kwvsock started: the guest's CID and the largest packet it takes (header and payload). */
	onVsockInit?: (guestCid: number, rxMax: number) => void;
	/**
	 * Offer kwshm (shm.ts): the host reads and writes guest shmem files in
	 * place. Default false: the kernel registers nothing.
	 */
	shm?: boolean;
	/**
	 * Offer a virtio-gpu device (kwvirtio, virtio-gpu.ts): the guest's
	 * /dev/dri/card0 (driver virtio_gpu, 2D KMS), whose scanout the display
	 * shows instead of kwfb's pixels while one is set. Its size is the
	 * display option's. Default false: no virtio device.
	 */
	gpu?: boolean;
	/** The device's 3D side (gl-gpu.ts VirglGpuBackend), with `gpu`; without one it is 2D. */
	gpuBackend?: GpuBackend;
	/**
	 * Offer kwemu's JIT tier (hot guest code compiled to WebAssembly; see
	 * jit.ts). Default true; false makes kwemu interpret everything. A
	 * kernel built without the tier ignores it.
	 */
	jit?: boolean;
	/**
	 * Resume this snapshot (snapshot()) instead of booting: same kernel
	 * build, memory size and type, and as many CPUs (`cpus`, which an SMP
	 * snapshot needs the platform to start). initrd and cmdline are ignored.
	 * `disks` must be the snapshot's, unchanged (snapshotDiskMismatch);
	 * boot() rejects otherwise.
	 */
	restore?: KernelSnapshot;
	/**
	 * CPUs to offer an SMP kernel (CONFIG_SMP), each one more instance of
	 * the module in its own thread (spawnCpu). Default 1. A UP kernel
	 * ignores it (with a log line). Each CPU's kwemu has its own JIT
	 * tier (jit applies to all).
	 */
	cpus?: number;
	/** Start a secondary CPU's thread (Platform.spawnCpu); without it an SMP kernel gets one CPU. */
	spawnCpu?: (init: CpuInit) => CpuEndpoint;
	/** Why spawnCpu cannot work on this thread (Platform.whyNoCpus), checked once; a reason gives an SMP kernel one CPU. */
	whyNoCpus?: () => string | undefined;
	/**
	 * With more than one CPU: the console ring (console-ring.ts) another
	 * thread reads (worker mode's owner), so `write` is not called for
	 * console output. Without it this host reads a ring of its own and
	 * calls `write`.
	 */
	consoleRing?: SharedArrayBuffer;
	/**
	 * When this host reads the ring: called after console output was
	 * written from inside the kernel's clock import (the kernel runs on), so
	 * that a host which batches `write` until the kernel suspends can send it
	 * now (worker mode with the messages transport).
	 */
	flushOutput?: () => void;
	/** Sample guest pcs (profile.ts): time samples need spawnSampler and a shared memory. */
	profile?: ProfileOptions;
	/** Start the time sampler's thread (Platform.spawnSampler). */
	spawnSampler?: (init: SamplerInit) => SamplerHandle;
}

/**
 * Does this kernel module import a 64-bit (memory64) memory?
 *
 * The kernel comes in two builds of the same code: vmlinux (wasm64:
 * memory64 + table64) and vmlinux32.wasm, the same module after Binaryen's
 * --memory64-lowering. The lowered one keeps i64 pointers in code and at the
 * JS boundary but has a 32-bit memory and table, so it runs on engines
 * without memory64 (WebKit). The JS API does not reflect an import's memory
 * type, so this reads the linker's "target_features" section (Binaryen drops
 * "memory64" from it when lowering). Without that section it guesses wasm64;
 * boot() retries with the other memory type if instantiation fails.
 */
export function moduleIsMemory64(module: WebAssembly.Module): boolean {
	const secs = WebAssembly.Module.customSections(module, "target_features");
	if (!secs.length) return true;
	const b = new Uint8Array(secs[0]!);
	let p = 0;
	const leb = () => {
		let v = 0, s = 0, c;
		do { c = b[p++]!; v |= (c & 0x7f) << s; s += 7; } while (c & 0x80);
		return v;
	};
	for (let n = leb(); n > 0 && p < b.length; n--) {
		const prefix = String.fromCharCode(b[p++]!);
		const len = leb();
		const name = textDecoder.decode(b.subarray(p, p + len));
		p += len;
		if (name === "memory64") return prefix !== "-";
	}
	return false;
}

/**
 * The root file system, command line and data disk template bundled into
 * the module by kernel/tools/bundle.mjs (custom sections "unkernel.initrd",
 * "unkernel.cmdline" and "unkernel.datadisk"), or undefined for each that
 * is absent. datadisk is a gzipped kwsparse image (kwsparse.ts).
 */
export function bundledBoot(module: WebAssembly.Module): { initrd?: Uint8Array; cmdline?: string; datadisk?: Uint8Array } {
	const sec = (name: string) => WebAssembly.Module.customSections(module, name)[0];
	const initrd = sec("unkernel.initrd");
	const cmdline = sec("unkernel.cmdline");
	const datadisk = sec("unkernel.datadisk");
	return {
		initrd: initrd ? new Uint8Array(initrd) : undefined,
		cmdline: cmdline ? textDecoder.decode(cmdline) : undefined,
		datadisk: datadisk ? new Uint8Array(datadisk) : undefined,
	};
}

type Resolver = (task: bigint) => void;

/**
 * A host side that cannot get the event loop while the kernel runs (worker
 * mode's shared transport, worker-shared.ts) and looks for its events in
 * the WASI clock instead, which the kernel reads at the end of every slice
 * and before it reads wasm_host_irqs. None of these may suspend.
 */
export interface KernelPoller {
	/** Every monotonic clock_time_get: cheap when nothing is new. */
	poll(): void;
	/** poll_oneoff is about to wait: true if events arrived (handled; do not wait). */
	idle(): boolean;
	/** That wait ended. */
	awake(): void;
}

/**
 * One kernel instance. boot() resolves with an ExitResult when the kernel
 * halts, panics, traps, hits a host invariant or is stopped.
 */
export class Kernel {
	opts: KernelConfig;
	log: (msg: string) => void;
	/** Pending console input chunks. */
	input: Uint8Array[];
	inputOffset: number;
	/** rows << 16 | cols, 0 = unknown (setConsoleSize). */
	consoleSize: number;
	/** resolve() of the current wasm_idle promise. */
	idleWake: (() => void) | null;
	/** task -> resolve(lastTask) */
	resumers: Map<bigint, Resolver>;
	onStage: (stage: BootStage, detail?: MemoryStage | ExitResult) => void;
	/** Settles with the first exit (halt, panic, trap, fatal, stop). */
	exited: Promise<ExitResult>;
	/** Record the exit (the first one wins). */
	exit!: (res: ExitResult) => void;
	/** The exit, once there is one. */
	result: ExitResult | undefined;
	stats: KernelStats;
	block: BlockHost;
	/** kwemu's JIT host (kw_host_jit_* imports); counters in jit.stats. */
	jit: JitHost;
	netRx: Uint8Array[];
	/** kwfb's host side: where the guest's pixels are, if anywhere. */
	display: DisplayHost;
	/** kwinput's host side (evdev keyboard and mouse): the event queue and whether a program reads it. */
	evdev: InputHost;
	/** kwsnd's host side (sound.ts): the playback state and the sink. */
	sound: SoundHost;
	/** kwvsock's host side (vsock.ts): the packet queues; the protocol is VsockHost's. */
	vsock: VsockDevice;
	/** kwshm's host side (shm.ts): requests, page lists and copies; the API is ShmClient's. */
	shm: ShmDevice;
	/** kwvirtio's host side (virtio.ts): the transport and its queues. */
	virtio: VirtioHost;
	/** The virtio-gpu device model (gpu option), else undefined. */
	gpu: VirtioGpu | undefined;
	memory!: WebAssembly.Memory;
	memory64 = false;
	/** The module imports a shared memory (a kernel linked with --shared-memory). */
	sharedMemory: boolean;
	wasi!: WasiHost;
	exports: WebAssembly.Exports | undefined;
	/** Address of wasm_host_irqs, once instantiated. */
	irqAddr: number | undefined;
	retFromFork!: (prev: bigint, next: bigint) => Promise<unknown>;
	/** performance.now() at kernel entry. */
	bootTime = 0;
	/** Polled from the clock import, if set (KernelPoller). */
	poller: KernelPoller | null = null;
	/** The kernel build: its linux_banner (compile time and build number), once instantiated. */
	fingerprint = "";
	/** The MAC kwnet got (wasm_driver_net_init), once the guest's driver started; null before or without a network. */
	netMac: Uint8Array | null = null;
	/** The snapshot() in progress, until its consistent point. */
	snapshotWaiter: SnapshotWaiter | null = null;
	/** snapshot({ commit }): the kernel waits at its consistent point for the commit (and a hold). */
	snapshotHeld = false;
	/** While snapshotHeld: settles once the sealed disks are durable (true) or failed (false); sync() answers with it. */
	heldDurable: Promise<boolean> | null = null;
	/**
	 * The guest's monotonic clock for the other CPUs' threads: [0] is
	 * CpuInit.epochMs (performance.timeOrigin - WasiHost.monoOffset), on a
	 * SharedArrayBuffer, so advanceClock() reaches them. Made with the first CPU thread.
	 */
	clockEpoch: Float64Array | null = null;
	/** The host's wall clock as holdForCommit() reads it (ms; a test may stand in a clock of its own). */
	wallClock: () => number = () => Date.now();
	/** Called with each snapshot at its consistent point, before commit or resolve: adds the host's own state (KernelInstance: `ttys`). */
	onSnapshot: ((snap: KernelSnapshot) => void) | undefined;
	/** CPUs offered to the kernel (1 unless an SMP kernel and KernelConfig.cpus > 1). */
	cpus = 1;
	/** The other CPUs' threads, once started. */
	secondaries: CpuEndpoint[] = [];
	/** Their JIT hosts' counters (CpuInit.jitMirror), in the order they started. */
	jitMirrors: Float64Array[] = [];
	/** With more than one CPU: the console ring every CPU writes (console-ring.ts). */
	conRing: ConsoleRing | null = null;
	/** What a full ring makes a CPU do: "wait" when another thread reads it, else this host reads it. */
	conFull: ConsoleFull = "wait";
	/** This host reads the ring (no KernelConfig.consoleRing): batches in order (cpu.ts). */
	conReader: ConsoleRingReader | null = null;
	consoleOrder: ConsoleOrder | null = null;
	/** Ring bytes dropped that were reported. */
	conDropped = 0;
	/** Guest pc sampling (KernelConfig.profile), once attached to the instance. */
	profiler: Profiler | null = null;

	constructor(opts: KernelConfig) {
		this.opts = opts;
		this.log = opts.log ?? ((m) => console.error(m));
		this.input = [];
		this.inputOffset = 0;
		this.consoleSize = 0;
		this.idleWake = null;
		this.resumers = new Map();
		this.onStage = opts.onStage ?? (() => {});
		this.result = undefined;
		this.exited = new Promise((r) => (this.exit = (res) => {
			if (this.result) return; // first exit wins
			this.consoleFlush(true);
			// Another thread reads the ring: what a CPU writes from now on is
			// dropped (after a snapshot with stop, the other CPUs run on until
			// their threads end; nothing they write may come out).
			this.conRing?.close();
			this.profiler?.stop();
			this.result = res;
			// A snapshot asked for that never reached its consistent point.
			const w = this.snapshotWaiter;
			this.snapshotWaiter = null;
			w?.reject(new Error(`snapshot: the kernel ended before its consistent point (${res.reason})`));
			try { this.onStage("exit", res); } catch {}
			r(res);
		}));
		this.stats = { switches: 0, idles: 0, yields: 0 };
		this.block = new BlockHost(this, opts.disks ?? []);
		const smp = WebAssembly.Module.imports(opts.module).some((i) => i.module === "unkernel" && i.name === "wasm_cpu_start");
		// The SMP module needs shared RAM even on one CPU. Allocating unshared
		// RAM first can leave too little address space for the real allocation.
		this.sharedMemory = smp;
		const cpus = Math.max(1, Math.floor(opts.cpus ?? 1));
		if (cpus > 1 && !smp) this.log(`[host] this kernel is not SMP: ${cpus} CPUs asked, it runs on one`);
		else if (cpus > 1 && !opts.spawnCpu) this.log("[host] this platform cannot start CPU threads: the SMP kernel runs on one CPU");
		else if (smp) {
			const why = cpus > 1 ? opts.whyNoCpus?.() : undefined;
			if (why) this.log(`[host] cannot start CPU threads here (${why}): the SMP kernel runs on one CPU`);
			else this.cpus = cpus;
		}
		if (this.cpus > 1) this.initConsoleRing();
		// Memory and its type are read at call time: boot() may retry with
		// the other memory type. Another CPU's host has a JitHost of its own
		// (cpu.ts), which mirrors its counters (jitMirrors).
		this.jit = new JitHost({ enabled: opts.jit, memory: () => this.memory, memory64: () => this.memory64, log: this.log });
		this.netRx = [];
		this.display = new DisplayHost({ enabled: opts.display, memory: () => this.memory, onChange: opts.onDisplay, log: this.log });
		this.evdev = new InputHost({ enabled: !!opts.display, memory: () => this.memory, raise: () => this.raiseIrq(IRQ_INPUT), onChange: opts.onInput });
		this.sound = new SoundHost({ enabled: opts.sound, memory: () => this.memory, log: this.log });
		this.vsock = new VsockDevice({ enabled: opts.vsock, memory: () => this.memory, raise: () => this.raiseIrq(IRQ_VSOCK), onPacket: opts.onVsockPacket, onInit: opts.onVsockInit });
		this.shm = new ShmDevice({
			enabled: opts.shm, memory: () => this.memory, raise: () => this.raiseIrq(IRQ_SHM),
			driver: WebAssembly.Module.imports(opts.module).some((i) => i.module === "unkernel" && i.name === "wasm_driver_shm_init"),
		});
		this.virtio = new VirtioHost({ memory: () => this.memory, raise: () => this.raiseIrq(IRQ_VIRTIO), log: this.log });
		if (opts.gpu) {
			const gpu = new VirtioGpu({ memory: () => this.memory, display: this.display, backend: opts.gpuBackend, log: this.log });
			this.virtio.add(gpu);
			gpu.configNotifier = () => this.virtio.configChanged(gpu);
			this.gpu = gpu;
		}
		void this.exited.then(() => {
			this.vsock.close();
			this.shm.close();
			for (const c of this.secondaries) c.terminate();
		});
		this.exports = undefined;
		this.irqAddr = undefined;
	}

	/** Queue an Ethernet frame for the guest's kwnet device. */
	receiveFrame(frame: Uint8Array): void {
		this.netRx.push(frame);
		this.setIrqBits(1 << IRQ_NET);
		this.wake();
	}

	/** Set a host IRQ bit in wasm_host_irqs (once instantiated) and wake the kernel. */
	raiseIrq(bit: number): void {
		if (!this.result) this.setIrqBits(1 << bit);
		this.wake();
	}

	/**
	 * OR `bits` into wasm_host_irqs (once instantiated); with a shared
	 * memory atomically, since other CPUs set IPI bits there too.
	 */
	setIrqBits(bits: number): void {
		if (this.irqAddr === undefined) return;
		if (this.sharedMemory) Atomics.or(new Int32Array(this.memory.buffer), this.irqAddr >> 2, bits);
		else {
			const dv = this.dv();
			dv.setUint32(this.irqAddr, dv.getUint32(this.irqAddr, true) | bits, true);
		}
	}

	/** Clear `bits` in wasm_host_irqs, as setIrqBits() sets them. */
	clearIrqBits(bits: number): void {
		if (this.irqAddr === undefined) return;
		if (this.sharedMemory) Atomics.and(new Int32Array(this.memory.buffer), this.irqAddr >> 2, ~bits);
		else {
			const dv = this.dv();
			dv.setUint32(this.irqAddr, dv.getUint32(this.irqAddr, true) & ~bits, true);
		}
	}

	/**
	 * With other CPUs running, an idle wait also ends when wasm_host_irqs
	 * changes from 0 (an IPI: the sender notifies). Calls `done` once that
	 * happens, at once if it already did, or after `timeoutMs`.
	 */
	watchIrqWord(done: () => void, timeoutMs: number): void {
		if (!this.secondaries.length || this.irqAddr === undefined) return;
		const r = Atomics.waitAsync(new Int32Array(this.memory.buffer), this.irqAddr >> 2, 0, timeoutMs);
		if (r.async) void r.value.then(done);
		else if (r.value === "not-equal") queueMicrotask(done);
	}

	/** JIT counters per CPU (CPU 0 first; the others as their hosts last mirrored them). */
	jitStatsPerCpu(): JitStats[] {
		return [{ ...this.jit.stats }, ...this.jitMirrors.map(jitStatsFromMirror)];
	}

	/** All CPUs' JIT counters together. */
	jitStatsAll(): JitStats {
		return sumJitStats(this.jit.stats, this.jitMirrors.map(jitStatsFromMirror));
	}

	/** kwemu's counters per CPU (-Dkwemu-stats kernels; undefined for a CPU that has compiled nothing). */
	kwemuStatsPerCpu(): (KwemuStats | undefined)[] {
		return [this.jit.kwemuStats(), ...this.jitMirrors.map((m) => this.jit.kwemuStats(jitBufFromMirror(m)))];
	}

	/** clockEpoch, made on first use (a CPU thread). */
	sharedClock(): Float64Array {
		if (!this.clockEpoch) {
			this.clockEpoch = new Float64Array(new SharedArrayBuffer(8));
			this.clockEpoch[0] = performance.timeOrigin - this.wasi.monoOffset;
		}
		return this.clockEpoch;
	}

	/**
	 * Move the guest's monotonic clock forward by `ms` on every CPU (never
	 * back: the guest's clocks must not run backwards). Only while the guest
	 * cannot read it mid-change: at a snapshot point, where every task is
	 * parked and every other CPU held (holdForCommit()).
	 */
	advanceClock(ms: number): void {
		if (!(ms > 0)) return;
		this.wasi.monoOffset += ms;
		if (this.clockEpoch) this.clockEpoch[0] = performance.timeOrigin - this.wasi.monoOffset;
	}

	/** wasm_cpu_start(cpu, idle): start a secondary CPU's thread. */
	startCpu(cpu: number, idle: bigint): number {
		const spawn = this.opts.spawnCpu;
		if (!spawn || cpu < 1 || cpu >= this.cpus || this.result) return -ENOSYS;
		const flag = this.exports?.__wasm_init_memory_flag;
		const jitMirror = new Float64Array(new SharedArrayBuffer(JIT_MIRROR_WORDS * 8));
		let ep: CpuEndpoint;
		try {
			ep = spawn({
				cpu, idle, module: this.opts.module, memory: this.memory, cpus: this.cpus,
				initFlag: flag instanceof WebAssembly.Global ? Number(flag.value) : 0,
				irqWord0: this.irqAddr ?? 0,
				epochMs: performance.timeOrigin - this.wasi.monoOffset, clock: this.sharedClock(),
				// A restored kernel starts its CPUs only to resume them (__kw_resume).
				resume: !!this.opts.restore,
				jit: this.jit.stats.enabled, memory64: this.memory64, jitMirror,
				console: this.conRing!.buffer, consoleFull: this.conReader ? "post" : "wait",
			});
		} catch (e) {
			this.log(`[host] cannot start CPU ${cpu}: ${(e as Error)?.message ?? e}`);
			return -ENOSYS;
		}
		this.secondaries.push(ep);
		this.jitMirrors.push(jitMirror);
		ep.listen({
			message: (m) => this.onCpuMessage(m),
			error: (e) => this.fatal(`CPU ${cpu}: ${errorText(e)}`),
		});
		return 0;
	}

	/**
	 * Console output of CPU 0 (fd_write 1): mem[p, p + len). With other
	 * CPUs, into the ring, behind what they wrote before. Where this host
	 * reads the ring, its write goes out at once as on one CPU: directly
	 * when nothing another CPU wrote waits (the ring is empty and no batch
	 * is on its way: a write that reserves after this look overlaps this
	 * one), else through the ring, which it then empties.
	 */
	consoleWrite(mem: Uint8Array, p: number, len: number): void {
		const r = this.conRing;
		if (r === null || (this.conReader !== null && r.quiet && this.consoleOrder!.empty)) {
			this.opts.write(mem.slice(p, p + len));
			return;
		}
		r.write(mem, p, len, this.conFull, this.conDeliver);
		this.conReader?.take();
	}

	/**
	 * More than one CPU: set up the console ring. Read by another thread
	 * (KernelConfig.consoleRing): CPU 0 waits like the others when it is
	 * full. Read here: a reader loop for the idle times, a take after each
	 * of CPU 0's writes, and one in every clock read (the poller) at most
	 * every POLL_MS unless the ring fills; CPU 0 also takes the records out
	 * itself when it is full.
	 */
	initConsoleRing(): void {
		const theirs = this.opts.consoleRing;
		this.conRing = new ConsoleRing(theirs ?? newConsoleRing());
		if (theirs) return;
		const ring = this.conRing;
		this.conFull = "take";
		this.consoleOrder = new ConsoleOrder((bytes) => this.opts.write(bytes));
		const reader = (this.conReader = new ConsoleRingReader(ring, this.conDeliver));
		const POLL_MS = 1, POLL_BYTES = 1 << 14;
		let last = 0;
		this.poller ??= {
			poll: () => {
				if (!ring.pending) return;
				const now = performance.now();
				if (now - last < POLL_MS && ring.used < POLL_BYTES) return;
				last = now;
				if (reader.take()) this.opts.flushOutput?.();
			},
			idle: () => {
				reader.take();
				return false;
			},
			awake: () => {},
		};
		reader.start();
	}

	/** A batch this host took out of the ring (or one another CPU posted, "out"): in order. */
	conDeliver = (b: { seq: number; bytes: Uint8Array }): void => {
		if (this.result) return;
		this.consoleOrder?.put(b.seq, b.bytes);
		const d = this.conRing?.dropped ?? 0;
		if (d !== this.conDropped) {
			this.log(`[host] console: ${d - this.conDropped} bytes from other CPUs dropped (CPU 0 did not read them)`);
			this.conDropped = d;
		}
	};

	/** At exit (`end`) or before a suspension: take what the ring holds (when this host reads it). */
	consoleFlush(end = false): void {
		const reader = this.conReader;
		if (!reader) return;
		const b = reader.ring.take(true);
		if (b) this.conDeliver(b);
		if (!end) return;
		this.consoleOrder?.flush();
		reader.stop();
		reader.ring.close();
	}

	onCpuMessage(m: CpuMessage): void {
		switch (m.t) {
			case "out":
				this.conRing?.batchTaken();
				this.conDeliver(m);
				break;
			case "log":
				this.log(m.msg);
				break;
			case "err":
				this.wasi.stderr = (this.wasi.stderr + textDecoder.decode(m.bytes)).slice(-4096);
				break;
			case "exit":
				this.wasi.exit(m.code);
				this.wake();
				break;
			case "fatal":
				this.fatal(m.msg);
				this.wake();
				break;
			case "trap":
				this.log(`[host] wasm trap: ${m.error}`);
				this.exit({ code: 254, reason: m.error, kind: "trap", error: m.error });
				this.wake();
				break;
		}
	}

	netImports(): Record<string, unknown> {
		const k = this;
		return {
			wasm_driver_net_init(mac: bigint): bigint {
				const net = k.opts.net;
				if (!net) return -1n;
				k.netMac = (net.mac ?? new Uint8Array(6)).slice(0, 6);
				k.u8().set(k.netMac, Number(mac));
				net.attach?.(k);
				return 0n;
			},
			wasm_driver_net_send(buf: bigint, len: bigint): bigint {
				const p = Number(buf);
				k.opts.net?.send(k.u8().slice(p, p + Number(len)));
				return len;
			},
			wasm_driver_net_rx_len: (): bigint => BigInt(k.netRx.length ? k.netRx[0]!.length : 0),
			wasm_driver_net_recv(buf: bigint, max: bigint): bigint {
				const f = k.netRx.shift();
				if (!f) return 0n;
				if (buf) k.u8().set(f.subarray(0, Number(max)), Number(buf));
				return BigInt(f.length);
			},
		};
	}

	u8(): Uint8Array {
		return new Uint8Array(this.memory.buffer);
	}

	dv(): DataView {
		return new DataView(this.memory.buffer);
	}

	cstr(ptr: number | bigint, max = 4096): string {
		const u8 = this.u8();
		const p = Number(ptr);
		let end = p;
		while (end < p + max && u8[end] !== 0) end++;
		return textDecoder.decode(u8.slice(p, end)); // a copy: TextDecoder may refuse a shared memory's view
	}

	fatal(msg: string): void {
		this.log(`[host] fatal: ${msg}`);
		this.exit({ code: 255, reason: msg, kind: "fatal" });
	}

	/**
	 * Stop the kernel for good. The exit is recorded at once (exited
	 * settles with it); the kernel itself parks at its next suspension
	 * point (an idle wait, a periodic yield or a task switch, at most about
	 * 20 ms of guest work away) and never runs again. There is no clean
	 * shutdown: the guest is not told, so unflushed disk writes are lost.
	 */
	stop(res: Partial<ExitResult> = {}): void {
		this.exit({ code: res.code ?? 0, reason: res.reason ?? "stopped by the host", kind: res.kind ?? "stopped", error: res.error });
		this.wake(); // an idle wait sees the exit and stays parked
	}

	/** Feed console input (bytes or string). */
	sendInput(data: Uint8Array | string): void {
		const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
		if (!bytes.length) return;
		this.input.push(bytes);
		this.setIrqBits(1 << IRQ_CONSOLE);
		this.wake();
	}

	/**
	 * Set the console window size (the guest tty's rows and columns). hvc_wasm
	 * picks it up on its next input poll, which the console IRQ triggers;
	 * the foreground process gets SIGWINCH.
	 */
	setConsoleSize(cols: number, rows: number): void {
		const size = ((Math.min(rows, 0xffff) << 16) | Math.min(cols, 0xffff)) >>> 0;
		if (!cols || !rows || size === this.consoleSize) return;
		this.consoleSize = size;
		this.setIrqBits(1 << IRQ_CONSOLE);
		this.wake();
	}

	/**
	 * Ask the kernel to sync (IRQ_SYNC) and wait until every persistent disk
	 * (BlockDevice.persistent, with flushSeq and whenFlushed) has completed a
	 * flush issued after this call, i.e. one whose save started after it.
	 * Resolves true then, or false after `timeout` ms; on a timeout the bit
	 * is cleared here, since a kernel without IRQ_SYNC support never clears
	 * it. Resolves true at once when no disk is persistent.
	 */
	requestSync({ timeout = 3000 }: { timeout?: number } = {}): Promise<boolean> {
		const disks = this.block.disks.filter((d) => d.persistent && typeof d.whenFlushed === "function");
		if (!disks.length) return Promise.resolve(true);
		if (this.irqAddr === undefined || this.result) {
			// Not running: nothing can become dirty; wait for saves in flight.
			return Promise.all(disks.map((d) => d.saving?.catch(() => {}))).then(() => true);
		}
		// Held at a snapshot point: the disks were sealed there and nothing has run since.
		if (this.snapshotHeld && this.heldDurable) return this.heldDurable;
		const marks = disks.map((d) => d.flushSeq ?? 0);
		this.setIrqBits(1 << IRQ_SYNC);
		this.wake();
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				if (!this.result) this.clearIrqBits(1 << IRQ_SYNC);
				resolve(false);
			}, timeout);
			void Promise.all(disks.map((d, i) => d.whenFlushed!(marks[i]!))).then(() => {
				clearTimeout(timer);
				resolve(true);
			});
		});
	}

	/**
	 * Save the machine: the kernel parks every task (arch/wasm/kernel/
	 * park.c) and, at the point where all its state is in memory, the host
	 * copies the memory and seals the disks (BlockDevice.snapshotSeal: their
	 * content becomes durable and the snapshot records their identity and
	 * write generation; disks are not copied). Resolves once the disks are
	 * durable. Without `stop` the guest keeps running, and its next write
	 * to a disk makes the snapshot unrestorable with that disk (a restore
	 * refuses it); with `stop: true` the kernel never runs again after the
	 * copy (exit kind "stopped"), so the disks stay as saved. Rejects if a
	 * task does not park within 2 s (the error names it), if I/O is in
	 * flight, if a disk cannot be part of a snapshot (one without
	 * snapshotSeal, or an overlay kept only in memory that was written), or
	 * if shm requests are waiting for the kernel. The other devices keep
	 * their host side's state (DeviceSnapshots); vsock connections and the
	 * network's TCP connections do not survive a restore (the guest's get
	 * reset), except the 9p sessions of host file systems, which the vsock
	 * device saves (VsockDevice.onSave; a request in flight on one makes
	 * the snapshot point busy, VsockDevice.blocker()). An SMP kernel's
	 * snapshot records its CPU count (KernelSnapshot.cpus); a restore needs
	 * as many, each task resuming on the CPU it ran on. With `commit`
	 * (SnapshotOptions) the kernel waits at the consistent point until the
	 * caller has stored the snapshot, and stops only then (with `hold`, or
	 * waits on for the caller's decision); a failed commit lets it go on
	 * (SnapshotCommitError).
	 */
	snapshot({ stop = false, commit, commitTimeoutMs = SNAPSHOT_COMMIT_TIMEOUT_MS, hold, dropCaches = stop || !!commit }: SnapshotOptions = {}): Promise<KernelSnapshot> {
		if (this.irqAddr === undefined || this.result) return Promise.reject(new Error("snapshot: the kernel is not running"));
		if (this.snapshotWaiter || this.snapshotHeld) return Promise.reject(new Error("snapshot: one is in progress"));
		if (commit !== undefined && typeof commit !== "function") return Promise.reject(new TypeError("snapshot: commit must be a function"));
		if (hold !== undefined && (typeof hold !== "function" || !commit)) return Promise.reject(new TypeError("snapshot: hold must be a function, and needs commit"));
		if (!this.exports?.kw_resume) return Promise.reject(new Error("snapshot: this kernel cannot resume one (no kw_resume)"));
		// State only a device's host holds (virtio-gpu resources and 3D contexts) while a guest program
		// runs: refused at once, as the snapshot point would, instead of after parking the guest (whose
		// tasks waiting on that device may not park within the time given).
		const held = this.virtio.held();
		if (held) return Promise.reject(new Error(`snapshot: ${held} in flight (a program holds them)`));
		for (const [i, d] of this.block.disks.entries()) {
			const why = typeof d.snapshotSeal !== "function" ? "it does not support snapshots" : (() => {
				try { d.snapshotState!(); return ""; } catch (e) { return (e as Error).message; }
			})();
			if (why) return Promise.reject(new Error(`snapshot: disk wd${String.fromCharCode(97 + i)}: ${why}`));
		}
		const p = new Promise<KernelSnapshot>((resolve, reject) => (this.snapshotWaiter = {
			resolve, reject, stop: stop || !!commit, commit, commitTimeoutMs: Math.max(0, Number(commitTimeoutMs) || 0), hold,
		}));
		// Both bits at once: the kernel takes them together (one it does not know is ignored).
		this.setIrqBits(1 << IRQ_SNAPSHOT | (dropCaches ? 1 << IRQ_DROP_CACHES : 0));
		this.wake();
		return p;
	}

	/** Put a snapshot into the fresh instance's memory (boot(), KernelConfig.restore). */
	loadSnapshot(s: KernelSnapshot): void {
		if (s.version !== 1) throw new Error(`snapshot: unsupported version ${s.version}`);
		if (!this.exports?.kw_resume) throw new Error("snapshot: this kernel cannot resume one (no kw_resume)");
		if (s.fingerprint !== this.fingerprint)
			throw new Error(`snapshot: saved by another kernel build ("${s.fingerprint}", this one is "${this.fingerprint}")`);
		// Overwrites the data segments that instantiation applied; the
		// kernel then enters at kw_resume, never at _start.
		const end = this.exports._end;
		restoreSnapshotMemory(this.u8(), s.memory, end instanceof WebAssembly.Global ? Number(end.value) : undefined);
		// Requests raised before the snapshot are gone; a console of another
		// size makes hvc_wasm read the new one.
		const resized = !!this.consoleSize && this.consoleSize !== s.consoleSize;
		this.dv().setUint32(this.irqAddr!, resized ? 1 << IRQ_CONSOLE : 0, true);
		if (!this.consoleSize) this.consoleSize = s.consoleSize;
		this.wasi.monoOffset = s.monotonicMs - performance.now();
		this.restoreDevices(s.devices ?? {});
	}

	/** Which devices this machine has, as a snapshot records them (DeviceSnapshots keys). */
	devicesPresent(): Record<"display" | "sound" | "vsock" | "shm" | "network" | "gpu", boolean> {
		return { display: this.display.enabled, sound: this.sound.enabled, vsock: this.vsock.enabled, shm: this.shm.enabled, network: !!this.opts.net, gpu: !!this.gpu };
	}

	/** The host side of each configured device, at the snapshot point (null: its driver had not started). */
	saveDevices(): DeviceSnapshots {
		const d: DeviceSnapshots = {};
		if (this.display.enabled) d.display = this.display.probed ? this.display.saveState() : null;
		if (this.evdev.enabled) d.input = this.evdev.probed ? this.evdev.saveState() : null;
		if (this.sound.enabled) d.sound = this.sound.probed ? this.sound.saveState() : null;
		if (this.vsock.enabled) d.vsock = this.vsock.probed ? this.vsock.saveState() : null;
		if (this.shm.enabled) d.shm = this.shm.probed ? this.shm.saveState() : null;
		if (this.opts.net) d.network = this.netMac ? { mac: [...this.netMac] } : null;
		if (this.gpu) d.gpu = this.virtio.probed ? { transport: this.virtio.saveState() } : null;
		return d;
	}

	/**
	 * Give each device's host side the state the kernel told the old one
	 * (loadSnapshot, after the memory is in and the IRQ bits are cleared);
	 * the restored kernel does not tell it again.
	 */
	restoreDevices(d: DeviceSnapshots): void {
		if (d.display) this.display.restoreState(d.display);
		if (d.input) this.evdev.restoreState(d.input);
		if (d.sound) this.sound.restoreState(d.sound);
		if (d.vsock) this.vsock.restoreState(d.vsock);
		if (d.shm) this.shm.restoreState(d.shm);
		if (d.gpu) this.virtio.restoreState(d.gpu.transport);
		if (d.network && this.opts.net) {
			this.netMac = Uint8Array.from(d.network.mac);
			this.opts.net.attach?.(this);
		}
	}

	/**
	 * wasm_snapshot_point: the end of a snapshot cycle (see snapshot()). A
	 * JSPI suspending import: a promise (snapshot({ commit })) keeps the
	 * kernel at its consistent point until it settles.
	 */
	snapshotPoint(result: number, blocker: bigint, freeMap?: bigint, freeBits?: bigint): number | Promise<number> {
		const w = this.snapshotWaiter;
		this.snapshotWaiter = null;
		if (!w) return -EBUSY;
		const who = this.cstr(blocker, 64);
		if (result) {
			w.reject(new Error(`snapshot: errno ${-result}${who && who !== "-" ? `, ${who} did not park` : ""}`));
			return 0;
		}
		const busy = [this.block.inflight || this.block.done.length ? "block requests" : "",
			this.netRx.length ? "network frames" : "", this.vsock.blocker(),
			this.shm.busy ? "shm requests" : "", this.virtio.blocker()].filter(Boolean);
		if (busy.length) {
			w.reject(new Error(`snapshot: ${busy.join(", ")} in flight`));
			return -EBUSY;
		}
		// The disks' content at this point (no request in flight) becomes
		// durable; their next writes start a new generation.
		const sealed: Array<{ state: DiskSnapshotState; done: Promise<void> }> = [];
		try {
			for (const d of this.block.disks) sealed.push(d.snapshotSeal!());
		} catch (e) {
			w.reject(new Error(`snapshot: disk wd${String.fromCharCode(97 + sealed.length)}: ${(e as Error).message}`));
			return -EBUSY;
		}
		const pending = this.input.map((c, i) => (i ? c : c.subarray(this.inputOffset)));
		const input = new Uint8Array(pending.reduce((n, c) => n + c.length, 0));
		pending.reduce((off, c) => (input.set(c, off), off + c.length), 0);
		const snap: KernelSnapshot = {
			version: 1, fingerprint: this.fingerprint, cpus: this.cpus, memory64: this.memory64,
			...copySnapshotMemory(this.u8(), freeBits ? this.u8().subarray(Number(freeMap), Number(freeMap) + Math.ceil(Number(freeBits) / 8)) : null, Number(freeBits ?? 0)),
			monotonicMs: this.wasi.monotonicMs(),
			consoleSize: this.consoleSize, input, disks: sealed.map((s) => s.state),
			devices: this.saveDevices(),
		};
		try {
			this.onSnapshot?.(snap);
		} catch {}
		if (w.commit) return this.holdForCommit(w, snap, sealed.map((s) => s.done));
		// The kernel parks for good at its next suspension point, before any task runs.
		if (w.stop) this.stop({ reason: "stopped after a snapshot" });
		Promise.all(sealed.map((s) => s.done)).then(() => w.resolve(snap),
			(e) => w.reject(new Error(`snapshot: saving a disk failed: ${(e as Error)?.message ?? e}`)));
		return 0;
	}

	/**
	 * snapshot({ commit }) at the consistent point: wait (the import's
	 * promise) for the disks to become durable and then for the commit.
	 * Committed: stop here for good (the promise never settles, so nothing
	 * runs after the copy, and on SMP the held CPUs stay held until their
	 * threads end), or with `hold` wait on for its decision and stop or go
	 * on then. Not committed (it rejected, timed out, or a disk failed):
	 * answer 0, and the kernel resumes every task as after a snapshot without
	 * stop. Host events meanwhile (frames, input, vsock packets, sync
	 * requests) only queue or set IRQ bits, as while the kernel is busy.
	 */
	async holdForCommit(w: SnapshotWaiter, snap: KernelSnapshot, durable: Promise<void>[]): Promise<number> {
		this.snapshotHeld = true;
		const heldAt = { wall: this.wallClock(), mono: performance.now() };
		const sealed = Promise.all(durable);
		this.heldDurable = sealed.then(() => true, () => false);
		const ac = new AbortController();
		let timedOut = false;
		const cancel = awakeTimeout(() => {
			timedOut = true;
			ac.abort(new Error(`the commit did not finish within ${w.commitTimeoutMs} ms`));
		}, w.commitTimeoutMs);
		const given = new Promise<never>((_, reject) => ac.signal.addEventListener("abort", () => reject(ac.signal.reason as Error), { once: true }));
		given.catch(() => {});
		try {
			await Promise.race([sealed.catch((e: unknown) => {
				throw new Error(`saving a disk failed: ${(e as Error)?.message ?? e}`);
			}), given]);
			await Promise.race([Promise.resolve().then(() => w.commit!(snap, ac.signal)), given]);
		} catch (e) {
			cancel();
			if (!ac.signal.aborted) ac.abort(e);
			this.#leaveHold(heldAt);
			const why = (e as Error)?.message ?? String(e);
			w.reject(new SnapshotCommitError(`snapshot: not committed (${why}); ${this.result ? `the kernel has ended (${this.result.reason})` : "the kernel runs on"}`, { timedOut, cause: e }));
			return 0;
		}
		cancel();
		if (w.hold && !this.result) {
			// Stored: no timeout from here on; the hold's own decision, or the kernel's end.
			const ended = new AbortController();
			void this.exited.then((r) => ended.abort(new Error(`the kernel has ended (${r.reason})`)));
			const exited = this.exited.then(() => "ended" as const);
			let how: string;
			try {
				how = String(await Promise.race([Promise.resolve().then(() => w.hold!(snap, ended.signal)), exited]));
			} catch (e) {
				this.log(`[host] snapshot: the hold failed (${(e as Error)?.message ?? e}); stopping at the snapshot`);
				how = "stop";
			}
			if (how === "continue" && !this.result) {
				this.#leaveHold(heldAt);
				w.resolve(snap);
				return 0;
			}
		}
		this.snapshotHeld = false;
		this.heldDurable = null;
		this.stop({ reason: "stopped after a snapshot" });
		w.resolve(snap);
		return never();
	}

	/**
	 * The kernel goes on from a snapshot point where it waited (a failed
	 * commit, a hold's "continue"): its clocks have advanced by the wait
	 * (SnapshotOptions, Time), and by however much more the host's wall
	 * clock moved than its monotonic one, so the guest's wall clock, which
	 * its monotonic clock carries on from the boot or restore, stays right.
	 */
	#leaveHold(heldAt: { wall: number; mono: number }): void {
		this.snapshotHeld = false;
		this.heldDurable = null;
		const lag = (this.wallClock() - heldAt.wall) - (performance.now() - heldAt.mono);
		if (lag > HOLD_CLOCK_LAG_MS && !this.result) {
			this.advanceClock(lag);
			this.log(`[host] snapshot: the host's monotonic clock fell ${(lag / 1000).toFixed(1)} s behind its wall clock while the kernel waited; the guest's moves on by that`);
		}
	}

	wake(): void {
		const w = this.idleWake;
		this.idleWake = null;
		if (w) w();
	}

	imports(): WebAssembly.Imports {
		const k = this;
		const unkernel: Record<string, unknown> = {
			wasm_dump_stacktrace(buf: bigint, max: bigint): void {
				const s = new TextEncoder().encode(new Error().stack ?? "");
				const n = Math.min(s.length, Number(max) - 1);
				k.u8().set(s.subarray(0, n), Number(buf));
				k.u8()[Number(buf) + n] = 0;
			},
			wasm_driver_console_size: (): number => k.consoleSize,
			// SMP (CONFIG_SMP kernels import these).
			wasm_init_flag(): bigint {
				const flag = k.exports?.__wasm_init_memory_flag;
				return flag instanceof WebAssembly.Global ? BigInt(flag.value) : 0n;
			},
			wasm_cpu_count: (): number => k.cpus,
			wasm_cpu_start: (cpu: number, idle: bigint): number => k.startCpu(cpu, idle),
			// The task started on a fresh stack on another CPU: its old one
			// here never runs again (kernel process.c, kw_stack_drain()).
			wasm_stack_drop(task: bigint): void {
				dropStack(k.resumers, task);
			},
			// (JSPI) Suspends only for snapshot({ commit }), which holds the kernel at its consistent point.
			wasm_snapshot_point: new WebAssembly.Suspending((result: number, blocker: bigint, freeMap: bigint, freeBits: bigint) => k.snapshotPoint(result, blocker, freeMap, freeBits)),

			// (JSPI) Park prev, run next. Resolves with the task that later
			// switches back to prev.
			wasm_switch_to: new WebAssembly.Suspending((prev: bigint, next: bigint, isNew: unknown, prevDead: unknown) => {
				if (k.result) return never(); // exited or stopped: park for good
				k.stats.switches++;
				const parked = prevDead
					? stackDropped()
					: new Promise<bigint>((r) => k.resumers.set(prev, r));
				if (isNew) {
					// A parked task resumes on a fresh stack too (park.c): drop
					// its old one, which never runs again.
					dropStack(k.resumers, next);
					queueMicrotask(() => {
						k.retFromFork(prev, next).then(
							() => k.fatal("task returned from ret_from_fork"),
							(e) => k.onTrap(e));
					});
				} else {
					const resume = k.resumers.get(next);
					if (!resume) {
						k.fatal(`switch to unknown task 0x${next.toString(16)}`);
					} else {
						k.resumers.delete(next);
						resume(prev);
					}
				}
				return parked;
			}),
		};

		Object.assign(unkernel, this.block.imports());
		Object.assign(unkernel, this.netImports());
		Object.assign(unkernel, this.display.imports());
		Object.assign(unkernel, this.evdev.imports());
		Object.assign(unkernel, this.sound.imports());
		Object.assign(unkernel, this.vsock.imports());
		Object.assign(unkernel, this.shm.imports());
		Object.assign(unkernel, this.virtio.imports());
		Object.assign(unkernel, this.jit.imports());

		const imports: Record<string, Record<string, unknown>> = {
			env: { memory: this.memory },
			unkernel,
			wasi_snapshot_preview1: this.wasi.imports(),
		};

		// Any other import is a kernel bug (undefined symbol); fail loudly.
		const missing: string[] = [];
		for (const imp of WebAssembly.Module.imports(this.opts.module)) {
			const mod = (imports[imp.module] ??= {});
			if (!(imp.name in mod)) {
				missing.push(`${imp.module}.${imp.name}`);
				mod[imp.name] = () => {
					throw new Error(`unresolved kernel import ${imp.module}.${imp.name} called`);
				};
			}
		}
		if (missing.length) this.log(`[host] warning: unresolved imports: ${missing.join(", ")}`);
		return imports as WebAssembly.Imports;
	}

	onTrap(e: unknown): void {
		if (e === STACK_DROPPED) return; // a dropped stack unwound (wasi.ts, stackDropped)
		this.log(`[host] wasm trap: ${errorText(e)}`);
		this.exit({ code: 254, reason: String(e), kind: "trap", error: e });
	}

	/** A fixed-size memory of `pages` 64 KiB pages, 64-bit (BigInt sizes) or 32-bit, shared or not. */
	static newMemory(pages: number, memory64: boolean, shared = false): WebAssembly.Memory {
		return memory64
			? new WebAssembly.Memory({ initial: BigInt(pages), maximum: BigInt(pages), address: "i64", shared } as unknown as WebAssembly.MemoryDescriptor)
			: new WebAssembly.Memory({ initial: pages, maximum: pages, shared });
	}

	/**
	 * Allocate the kernel's memory (fixed size: the kernel sizes RAM from it
	 * once at boot). Tries memoryMiB, then each of opts.memoryFallbackMiB.
	 * The maximum equals the initial size so engines reserve no more address
	 * space than needed.
	 */
	allocateMemory(memoryMiB: number, initrdBytes: number): WebAssembly.Memory {
		const want = [memoryMiB, ...(this.opts.memoryFallbackMiB ?? []).filter((m) => m < memoryMiB)];
		const failures: string[] = [];
		for (const mib of want) {
			const pages = Math.ceil((mib * 1024 * 1024) / 65536);
			try {
				if (!this.memory64 && pages > 65536) throw new RangeError("more than 4 GiB needs the wasm64 (memory64) kernel");
				const memory = Kernel.newMemory(pages, this.memory64, this.sharedMemory);
				if (failures.length) this.log(`[host] allocated ${mib} MiB after failing: ${failures.join("; ")}`);
				this.onStage("memory", { mib, requestedMiB: memoryMiB, failures, memory64: this.memory64 });
				return memory;
			} catch (e) {
				failures.push(`${mib} MiB: ${(e as Error).message}`);
				if (initrdBytes && mib * 1048576 < initrdBytes + 40 * 1048576) break;
			}
		}
		const err = new Error(`cannot allocate the kernel's memory (WebAssembly.Memory, ${this.memory64 ? "memory64" : "32-bit"}): ${failures.join("; ")}`);
		err.name = "MemoryAllocationError";
		throw err;
	}

	/**
	 * Instantiate and boot. Resolves with the ExitResult when the kernel
	 * halts; rejects if it cannot start (memory, instantiation, initrd size).
	 */
	async boot(): Promise<ExitResult> {
		const { module, restore } = this.opts;
		if (restore) {
			// A disk that changed since the snapshot would not match the restored caches.
			const why = snapshotCpuMismatch(restore, this.cpus)
				?? snapshotDiskMismatch(restore.disks ?? [], this.block.disks)
				?? snapshotDeviceMismatch(restore.devices ?? {}, this.devicesPresent(), this.opts.net?.mac);
			if (why) throw new Error(`snapshot: ${why}`);
		}
		const memoryMiB = restore ? restore.memory.byteLength / 1048576 : this.opts.memoryMiB ?? 2048;
		const bundled = bundledBoot(module);
		const initrd = restore ? null : this.opts.initrd === undefined ? bundled.initrd : this.opts.initrd;
		const cmdline = this.opts.cmdline ?? bundled.cmdline ?? "";
		const memImport = WebAssembly.Module.imports(module).find((i) => i.kind === "memory");
		if (!memImport) throw new Error("vmlinux must import its memory");
		const guessed = this.opts.memory64 === undefined && !restore;
		this.memory64 = restore ? restore.memory64 : guessed ? moduleIsMemory64(module) : !!this.opts.memory64;
		if (restore) {
			// No fallback sizes: the kernel sized RAM from this memory at boot.
			this.memory = Kernel.newMemory(restore.memory.byteLength / 65536, this.memory64, this.sharedMemory);
			this.onStage("memory", { mib: memoryMiB, requestedMiB: memoryMiB, failures: [], memory64: this.memory64 });
		} else {
			this.memory = this.allocateMemory(memoryMiB, initrd?.length ?? 0);
		}
		// The kernel reads its command line (argv[1]) and initrd (/initrd in
		// the preopened "/") through WASI (arch/wasm/kernel/wasi.c).
		this.wasi = new WasiHost(this, {
			args: cmdline ? ["vmlinux", cmdline] : ["vmlinux"],
			files: initrd?.length ? { initrd } : {},
		});

		this.onStage("instantiate");
		// A custom module can import different sharing than its CPU imports
		// suggest. Retry once if the engine reports that mismatch, and, for a
		// guessed memory type (a module without target_features), once with
		// the other type.
		let instance: WebAssembly.Instance | undefined;
		let flippedShared = false, flippedType = !guessed;
		while (!instance) {
			try {
				instance = await WebAssembly.instantiate(module, this.imports());
			} catch (e) {
				if (!(e instanceof WebAssembly.LinkError)) throw e;
				const pages = this.memory.buffer.byteLength / 65536;
				let memory64 = this.memory64, shared = this.sharedMemory;
				if (!flippedShared && /\bshared\b/i.test(e.message)) {
					flippedShared = true;
					shared = !shared;
				} else if (!flippedType) {
					flippedType = true;
					memory64 = !memory64;
				} else throw e;
				try {
					this.memory = Kernel.newMemory(pages, memory64, shared);
				} catch {
					throw e;
				}
				if (memory64 !== this.memory64) this.log(`[host] memory type guess was wrong (${e.message}); using a ${memory64 ? "64" : "32"}-bit memory`);
				this.memory64 = memory64;
				this.sharedMemory = shared;
			}
		}
		const ex = (this.exports = instance.exports);
		const addr = (name: string) => {
			const g = ex[name];
			if (!(g instanceof WebAssembly.Global)) throw new Error(`missing export ${name}`);
			return Number(g.value);
		};

		this.irqAddr = addr("wasm_host_irqs");
		this.fingerprint = ex.linux_banner instanceof WebAssembly.Global ? this.cstr(addr("linux_banner"), 512).trim() : "";
		// kwemu asks for the JIT in kw_cpu_init, early in _start (and in
		// kw_host_reset after a restore).
		this.jit.attach(ex);

		// The kernel copies the initrd into memory it allocates (top-down);
		// refuse to boot early if that cannot leave the kernel 32 MiB.
		if (initrd?.length) {
			const memSize = this.memory.buffer.byteLength;
			const start = Math.floor((memSize - initrd.length) / 4096) * 4096;
			const kernelEnd = addr("_end");
			if (start < kernelEnd + 32 * 1024 * 1024)
				throw new Error(`not enough memory for the ${(initrd.length / 1048576).toFixed(1)} MiB initrd ` +
					`(have ${memSize / 1048576} MiB, need at least ${Math.ceil((kernelEnd + 32 * 1048576 + initrd.length) / 1048576) + 1} MiB)`);
		}

		this.retFromFork = WebAssembly.promising(ex.ret_from_fork as (...args: unknown[]) => unknown) as Kernel["retFromFork"];
		if (restore) this.loadSnapshot(restore);
		// After a snapshot's memory: a saved kernel may have been sampling.
		if (this.opts.profile) {
			const p = new Profiler(this.opts.profile);
			if (p.attach(this, this.opts.spawnSampler)) this.profiler = p;
		} else if (restore) profileOff(this);
		const entry = restore ? "kw_resume" : "_start";
		const start = WebAssembly.promising(ex[entry] as () => unknown);
		this.bootTime = performance.now();
		this.onStage("start");
		start().then(() => this.fatal(`${entry} returned`), (e) => this.onTrap(e));
		if (restore?.input.length) this.sendInput(restore.input.slice());
		return this.exited;
	}
}
