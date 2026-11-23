// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Build-time constants from vite.config.ts (define).

/** Build details for the boot screen and About dialog. Empty strings where unknown. */
declare const __KW_BUILD__: {
	/** Linux release from the base bundle's banner (7.3.4+). */
	linux: string;
	/** The kernel's GitHub release tag (web/scripts/kernel.ts pageSource()), or "local" (a local build: KW_KERNEL, KW_DISTROS or auto-detected). */
	kernel: string;
	/** Canonical GitHub URL of the checkout used to build the page. */
	repo: string;
	/** The page's commit hash, local changes and commit date (ISO 8601). */
	commit: string;
	dirty: boolean;
	date: string;
};

/**
 * The page's kernel and distro images (vite.config.ts, web/scripts/kernel.ts
 * pageSource()): the base bundle's UP kernel and its SMP one (null without
 * an SMP patch), the guest GL renderer's virgl.mjs (null without one; fetched
 * only with the GL option), and the images, debian first.
 */
declare module "virtual:unkernel-kernel" {
	export const kernelUrl: URL;
	export const kernelSmpUrl: URL | null;
	export const glUrl: URL | null;
	export const distros: { name: string; url: string; size: number; imageId?: string }[];
}
