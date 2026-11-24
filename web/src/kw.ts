// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// window.KW: state shared by the inline bootstrap (index.html), the shell
// (ui.ts, main.ts) and the boot module (boot.ts), and the hooks the browser
// tests (web/test/*.mjs) read: KW.config, KW.ui.state()/stageState(),
// KW.errors, KW.screenText(), KW.memActualMiB, KW.term, KW.vm (the SDK's KernelInstance, or with
// ?worker=1 a WorkerKernel, which has no low-level kernel; KW.vm.stats(), KW.vm.evdev,
// KW.vm.frame() in both),
// KW.jitStats() (kwemu's JIT counters), the data disk (KW.dataDisk, KW.sync(),
// KW.exportData(), KW.importData(), KW.resetData()), KW.suspend() (session.ts), the terminals (KW.windows, named so
// for the tests: list(), open(), select(), close(), text(), send(); wterms.ts), the guest preview (KW.preview: open(), close(), url();
// preview.ts), the Wayland desktop (KW.wayland: windows(), container(); wayland.ts), the window manager (KW.wm: wm.ts,
// open(), focus(), list()…); KW.kernel and globalThis.kernel (the
// low-level Kernel, with sendInput(); not in worker mode) and globalThis.term (the wterm WTerm).
import type { Config } from "./config.ts";
import type { CowDisk, JitStats, KernelHandle } from "./sdk.ts";
import type { Ui } from "./ui.ts";

export interface KWError {
	t: number;
	kind: string;
	message: string;
	detail: string;
	fatal: boolean;
	hint?: string;
	title?: string;
}

export interface TermApi {
	focus(): void;
	paste(text: string): void;
	send(data: string | Uint8Array): void;
	setFontSize(px: number): void;
	appCursor(): boolean;
	notice(msg: string): void;
}

/** A terminal as KW.windows.list() gives it. */
export interface TerminalInfo {
	/** 0: the console (hvc0); 1 to 9: a terminal session over vsock. */
	n: number;
	name: string;
	/** Terminal 0 is always "open". */
	state: "opening" | "open" | "ended";
	current: boolean;
	/** The shell's pid and pty number in the guest, once open (not for terminal 0). */
	pid?: number;
	pts?: number;
	/** Why it ended, or what it waits for. */
	note?: string;
	/** The Terminal window it is a tab of (its WM id, termtabs.ts). */
	window?: string;
}

/** The terminals (wterms.ts), for the shortcuts, the launcher and the browser tests. */
export interface TerminalsApi {
	list(): TerminalInfo[];
	/**
	 * Open a terminal (the lowest free number) as a tab of Terminal window
	 * `window` (its id; "new": a new window; default: the one that last had
	 * the focus) and switch to it unless select is false; name labels its
	 * tab (default "tty N"),
	 * and file and args run in place of the login shell. Resolves once its shell runs; rejects with why it
	 * could not (the tab then stays, showing that, until closed).
	 */
	open(opts?: { select?: boolean; name?: string; file?: string; args?: string[]; window?: string }): Promise<TerminalInfo>;
	/** Show terminal n and give it the keyboard focus (false: there is no such terminal). */
	select(n: number): boolean;
	/** Close terminal n (1 to 9): its shell is hung up. Resolves once it is gone. */
	close(n: number): Promise<void>;
	/** Terminal n's history and screen as text, a line per row. */
	text(n: number): string;
	/** Type into terminal n (as its terminal does: no Ctrl-key latching). */
	send(n: number, data: string | Uint8Array): void;
}

export interface KWGlobal {
	t0: number;
	errors: KWError[];
	ui: Ui | null;
	started: boolean;
	early(e: KWError): void;
	report(kind: string, message: string, detail?: string, fatal?: boolean): KWError;
	config: Config;
	term?: TermApi;
	screenText?: () => string;
	memActualMiB?: number;
	jitStats?: () => JitStats;
	/** Available with ?trace=1 once the guest starts. */
	trace?: ReturnType<typeof import("./desktop-trace.ts").createDesktopTrace>["api"];
	/** The data disk, once attached (null: none). */
	dataDisk?: CowDisk | null;
	/** Ask the guest to sync its file systems to the persistent disks; true once confirmed. */
	sync?: (opts?: { timeout?: number }) => Promise<boolean>;
	/** Run by Reboot before the page reloads (a sync, at most 3 s). */
	beforeReboot?: () => Promise<unknown>;
	exportData?: () => Promise<{ name: string; blocks: number; bytes: number }>;
	importData?: (file: Blob | Uint8Array) => Promise<{ size: number; blocks: number }>;
	resetData?: () => Promise<void>;
	/**
	 * Save the running machine in this browser and stop it (session.ts); the next load resumes it.
	 * `hold`: saved, then held at its snapshot point instead of stopped (a suspend in the background; boot.ts).
	 */
	suspend?: (opts?: { hold?: boolean }) => Promise<{ bytes: number; ms: number; held?: boolean }>;
	/** Pause by hand (boot.ts, autosuspend.ts Pause): save and hold until continuePaused(); a failure is a toast (the system runs on). */
	pause?: () => void;
	/** End a pause by hand: the machine goes on where it was, and its saved session is deleted. */
	continuePaused?: () => void;
	/** The running showcase (showcase.ts): skip the current step, pause and resume between steps. */
	showcase?: { skip(): void; pause(): void; resume(): void };
	/** The kernel once user space runs (rejects if it never does), once the boot module runs. */
	ready?: () => Promise<KernelHandle>;
	/** The terminals, once the boot module runs ("windows": the name the browser tests use). */
	windows?: TerminalsApi;
	/** The window manager (wm.ts): the desktop's windows, from the start. */
	wm?: import("./wm.ts").Wm;
	/** The Wayland desktop (wayland.ts), once the kernel runs: its windows, its container, whether wland is loaded. */
	wayland?: typeof import("./wayland.ts").waylandApi;
	/** The guest preview's Browser window (preview.ts): open(port) opens or focuses it there (false: not a port), close(), and the /vm/ URL of a guest port. */
	preview?: { open(port?: number | string): boolean; close(): void; url(port: number, path?: string): string };
	[key: string]: unknown;
}

declare global {
	interface Window {
		KW: KWGlobal;
	}
}

export const KW: KWGlobal = window.KW;
