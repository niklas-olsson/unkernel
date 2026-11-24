#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Builds guest Vulkan's pieces (.agents/vk.md), as gl/wasm/build.sh builds
# guest GL's renderer:
#
#   vk/build.sh [all|naga|icd]   (default: all)
#
#   naga   the SPIR-V -> WGSL translator, $KW_BUILD/vk/kwvk-naga.wasm
#          (vk/naga/build.sh; needs cargo and the wasm32-unknown-unknown
#          target), which `pnpm build` copies to dist/kwvk-naga.wasm
#   icd    the guest's ICD and its test programs for aarch64,
#          $KW_BUILD/vk/libvulkan_kw.so, kw_icd.json, vk-* (vk/icd/build.sh;
#          zig and the pinned Vulkan headers, vk/pins.sh), which the base
#          build (guest/base/build.sh) also runs for the kw layer
#
# `all` builds the translator only where cargo can target wasm32 (else it
# says so and goes on: the SDK then has no guest Vulkan).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export PATH="$PATH:$HOME/.cargo/bin"

# vk_can_build_naga: cargo and rustc's wasm32-unknown-unknown standard library
vk_can_build_naga() {
	command -v cargo >/dev/null && command -v rustc >/dev/null &&
		[ -d "$(rustc --print sysroot 2>/dev/null)/lib/rustlib/wasm32-unknown-unknown" ]
}

naga() {
	if ! vk_can_build_naga; then
		echo "vk: no cargo with the wasm32-unknown-unknown target (rustup target add wasm32-unknown-unknown):" \
			"the SPIR-V translator is not built, so the SDK has no guest Vulkan" >&2
		return 1
	fi
	"$here/naga/build.sh"
}

case "${1:-all}" in
naga) naga ;;
icd) "$here/icd/build.sh" guest ;;
all)
	"$here/icd/build.sh" guest
	naga || true
	;;
*) echo "usage: $0 [all|naga|icd]" >&2; exit 2 ;;
esac
