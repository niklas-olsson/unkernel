// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Ladybird: the independent web browser, in alpha (its description says
// so: the launcher has no badge for it), from its official apt repository
// (apt.ladybird.org), as a window on the page's Wayland desktop
// (wayland.ts). Its Qt 6 is bundled under /opt/ladybird and speaks Wayland;
// its window's app id, org.ladybird.Ladybird, ends in this app's id.
// The repository is set up as its instructions do, the same two files at
// the same paths, written here (with sudo) rather than fetched with wget:
// the signing key (ed25519, 4F3D 5DFE 64EB D9BB 35D5 8FBD CF9E F732 4C4B
// 27AE, no expiry) and the deb822 source for Ubuntu 24.04 (noble), which
// runs on Debian 13 (there is no Debian suite). The image's package lists
// do not know the package, so the installer's first apt-get install fails
// and its retry after apt-get update installs it (launcher.ts
// installScript()). About 68 MiB to download and 397 MiB installed (the
// repository's index, 2026-11-23), besides the Debian libraries it needs.
// GPU painting and WebGL need Vulkan, and without a Vulkan device it
// paints on the CPU (it says so in a bar). The device is guest Vulkan
// (the page's option, on by default: this browser's WebGPU, .agents/vk.md)
// once the loader is there (libvulkan1, left to the user: the line it
// prints; Ladybird on guest Vulkan is untested). Mesa's lavapipe, Vulkan
// in software on the emulated CPU that pulls in LLVM, is the other way,
// for a page without guest Vulkan: with both, guest Vulkan is the first
// device. Its sandbox denies its GPU process a few reads
// (/proc/cpuinfo, Mesa's shader cache): warnings, left as they are. No
// sound: it speaks only PulseAudio, which the guest does not run.
import type { TerminalApp } from "../types.ts";

/** https://apt.ladybird.org/ladybird.asc */
const KEY = `-----BEGIN PGP PUBLIC KEY BLOCK-----

mDMEauxrwhYJKwYBBAHaRw8BAQdAkkJ/Oge0qteCJrKRBi6LwGyvEQ1o+pll0Mq2
ppgtWBG0F0xhZHliaXJkIEFQVCByZXBvc2l0b3J5iK8EExYKAFcWIQRPPV3+ZOvZ
uzXVj73PnvcyTEsnrgUCauxsVBsUgAAAAAAEAA5tYW51MiwyLjUrMS4xMiwwLDMC
GwMFCwkIBwICIgIGFQoJCAsCBBYCAwECHgcCF4AACgkQz573MkxLJ64GtAD/cy4W
DaW5EkVxHxoT672gnwDJKb5In3N4Gn1sZzFC6zwA/0562Xq+ixRUqZYDQKC5ChxY
rAjURvwzxJLB/nSvi7sE
=WgFB
-----END PGP PUBLIC KEY BLOCK-----
`;

/**
 * https://apt.ladybird.org/ladybird-noble.sources, over plain HTTP: the page
 * answers that from its mirror (config.ts DEFAULT_ROUTES), and elsewhere the
 * host redirects to https. The key signs the repository either way.
 */
const SOURCES = `Types: deb
URIs: http://apt.ladybird.org/
Suites: noble
Components: main
Signed-By: /etc/apt/keyrings/ladybird.asc
`;

export default {
	id: "ladybird",
	title: "Ladybird",
	desc: "The independent web browser (alpha), from its own apt repository, in a window on the page (a large install)",
	// Ladybird's mark: the stroke of its app icon (org.ladybird.Ladybird.svg
	// in its package; not in Simple Icons), without the tile.
	icon: { svg: '<path fill="none" stroke="currentColor" stroke-width="40" stroke-linejoin="round" d="M512 512 L543.25 549.77 L574.05 585.96 L603.5 619.01 L631.15 647.34 L656.55 669.82 L679.04 685.11 L698.37 693.2 L714.11 693.2 L725.8 685.11 L733.44 669.82 L736.59 647.34 L735.69 619.01 L730.07 585.96 L720.41 549.77 L706.69 512 L689.16 474.23 L668.24 438.04 L644.19 404.99 L617.44 376.66 L588.89 354.18 L558.76 338.89 L527.74 330.8 L496.26 330.8 L465.24 338.89 L435.11 354.18 L406.56 376.66 L379.81 404.99 L355.76 438.04 L334.84 474.23 L317.31 512 L303.59 549.77 L293.93 585.96 L288.31 619.01 L287.41 647.34 L290.56 669.82 L298.2 685.11 L309.89 693.2 L325.63 693.2 L344.96 685.11 L367.45 669.82 L392.85 647.34 L420.5 619.01 L449.95 585.96 L480.75 549.77 L512 512 L543.25 474.23 L574.05 438.04 L603.5 404.99 L631.15 376.66 L656.55 354.18 L679.04 338.89 L698.37 330.8 L714.11 330.8 L725.8 338.89 L733.44 354.18 L736.59 376.66 L735.69 404.99 L730.07 438.04 L720.41 474.23 L706.69 512 L689.16 549.77 L668.24 585.96 L644.19 619.01 L617.44 647.34 L588.89 669.82 L558.76 685.11 L527.74 693.2 L496.26 693.2 L465.24 685.11 L435.11 669.82 L406.56 647.34 L379.81 619.01 L355.76 585.96 L334.84 549.77 L317.31 512 L303.59 474.23 L293.93 438.04 L288.31 404.99 L287.41 376.66 L290.56 354.18 L298.2 338.89 L309.89 330.8 L325.63 330.8 L344.96 338.89 L367.45 354.18 L392.85 376.66 L420.5 404.99 L449.95 438.04 L480.75 474.23Z"/>', viewBox: "232 232 560 560" },
	colors: ["#8b5cf6", "#2e1065"],
	needs: { net: true, wayland: true },
	packages: { debian: ["ladybird"] },
	files: {
		"/etc/apt/keyrings/ladybird.asc": KEY,
		"/etc/apt/sources.list.d/ladybird.sources": SOURCES,
	},
	commands: [
		"echo 'Without a Vulkan device it paints on the CPU (a bar says so). GPU painting and WebGL on guest Vulkan (the WebGPU of this browser; on in Settings by default; untested with Ladybird): sudo apt-get install libvulkan1 libgles2. Where the page has no guest Vulkan, lavapipe (Vulkan in software, a large install): sudo apt-get install mesa-vulkan-drivers libgles2'",
		"ladybird",
	],
} satisfies TerminalApp;
