#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Builds the SPIR-V -> WGSL translator (src/lib.rs) for wasm32 into
# $KW_BUILD/vk/kwvk-naga.wasm (default vendor/build), loaded by
# js/core/vk-shader.ts; the cargo target dir is next to it.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="${KW_BUILD:-$root/vendor/build}/vk"
mkdir -p "$out"
export PATH="$HOME/.cargo/bin:$PATH"
CARGO_TARGET_DIR="$out/naga-target" cargo build --release --locked \
	--manifest-path "$here/Cargo.toml" --target wasm32-unknown-unknown
wasm="$out/naga-target/wasm32-unknown-unknown/release/kwvk_naga.wasm"
if command -v wasm-opt >/dev/null; then
	wasm-opt -Os --enable-bulk-memory --enable-sign-ext --enable-nontrapping-float-to-int \
		--enable-mutable-globals --enable-multivalue --enable-reference-types \
		"$wasm" -o "$out/kwvk-naga.wasm"
else
	cp "$wasm" "$out/kwvk-naga.wasm"
fi
echo "$out/kwvk-naga.wasm: $(stat -c %s "$out/kwvk-naga.wasm") bytes"
