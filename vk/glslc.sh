#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# glslc for this host, a host tool for test/vk/guest/build-llama.sh
# (ggml-vulkan's shaders), built from pinned sources (shaderc and the
# glslang, SPIRV-Tools and SPIRV-Headers commits of its DEPS: versions and
# SHA-256 in vk/pins.sh, downloaded into vendor/downloads) with cmake, ninja,
# python3 and the host's C++ compiler into vendor/toolchain/glslc:
# bin/glslc (shaderc, glslang and SPIRV-Tools linked in statically; no HLSL
# front end, no tests, no other tools), and the SPIR-V headers with their
# CMake package (include/spirv, share/cmake/SPIRV-Headers), which
# ggml-vulkan's find_package(SPIRV-Headers) needs.
#
#   vk/glslc.sh           builds unless the stamp is current (this script
#                         without its comments, the pins), prints the
#                         directory
#   vk/glslc.sh headers   installs the SPIR-V headers only (no build),
#                         prints the directory
set -euo pipefail

. "$(cd "$(dirname "$0")/.." && pwd)/kernel/tools/env.sh"   # root, vendor, fetch_verified
. "$root/vk/pins.sh"                                         # SHADERC_*, GLSLANG_*, SPIRV_*
dest="$vendor/toolchain/glslc"
dl="${KW_VK_DOWNLOADS:-$vendor/downloads}"
stamp="$dest/.stamp"
want="$(grep -v '^[[:space:]]*#' "${BASH_SOURCE[0]}" | sha256sum | cut -c1-16) $SHADERC_VERSION $GLSLANG_COMMIT $SPIRV_TOOLS_COMMIT $SPIRV_HEADERS_COMMIT"

for t in cmake ninja python3; do
	command -v "$t" >/dev/null || { echo "vk/glslc.sh: $t not found (needed to build glslc)" >&2; exit 1; }
done

spirv_headers_tgz="$dl/spirv-headers-$SPIRV_HEADERS_COMMIT.tar.gz"
headers() {
	[ "$(cat "$dest/.stamp-headers" 2>/dev/null)" = "$SPIRV_HEADERS_COMMIT" ] && return 0
	fetch_verified "$SPIRV_HEADERS_URL" "$spirv_headers_tgz" "$SPIRV_HEADERS_SHA256" >&2
	local w="$dest/headers-src"
	rm -rf "$w" "$dest/include/spirv" "$dest/share/cmake/SPIRV-Headers"
	mkdir -p "$w"
	tar -xzf "$spirv_headers_tgz" -C "$w" --strip-components=1
	cmake -G Ninja -S "$w" -B "$w/obj" -DCMAKE_INSTALL_PREFIX="$dest" -DCMAKE_INSTALL_DATAROOTDIR=share \
		-DSPIRV_HEADERS_ENABLE_TESTS=OFF -DSPIRV_HEADERS_ENABLE_INSTALL=ON >&2
	cmake --install "$w/obj" >&2
	rm -rf "$w"
	echo "$SPIRV_HEADERS_COMMIT" >"$dest/.stamp-headers"
}

if [ "${1:-}" = headers ]; then
	headers
	echo "$dest"
	exit 0
fi
if [ -x "$dest/bin/glslc" ] && [ "$(cat "$stamp" 2>/dev/null)" = "$want" ]; then
	headers
	echo "$dest"
	exit 0
fi

fetch_verified "$SHADERC_URL" "$dl/shaderc-$SHADERC_VERSION.tar.gz" "$SHADERC_SHA256" >&2
fetch_verified "$GLSLANG_URL" "$dl/glslang-$GLSLANG_COMMIT.tar.gz" "$GLSLANG_SHA256" >&2
fetch_verified "$SPIRV_TOOLS_URL" "$dl/spirv-tools-$SPIRV_TOOLS_COMMIT.tar.gz" "$SPIRV_TOOLS_SHA256" >&2
fetch_verified "$SPIRV_HEADERS_URL" "$spirv_headers_tgz" "$SPIRV_HEADERS_SHA256" >&2

rm -rf "$dest"
src="$dest/src" obj="$dest/obj"
mkdir -p "$src/third_party/glslang" "$src/third_party/spirv-tools" "$src/third_party/spirv-headers" "$dest/bin"
tar -xzf "$dl/shaderc-$SHADERC_VERSION.tar.gz" -C "$src" --strip-components=1
tar -xzf "$dl/glslang-$GLSLANG_COMMIT.tar.gz" -C "$src/third_party/glslang" --strip-components=1
tar -xzf "$dl/spirv-tools-$SPIRV_TOOLS_COMMIT.tar.gz" -C "$src/third_party/spirv-tools" --strip-components=1
tar -xzf "$spirv_headers_tgz" -C "$src/third_party/spirv-headers" --strip-components=1

# glslc's --version runs `git describe` in the source directories: keep git
# below vendor/toolchain/glslc so that it does not describe the enclosing
# repository (the sources are not git trees: "unknown hash").
export GIT_CEILING_DIRECTORIES="$dest"
cmake -G Ninja -S "$src" -B "$obj" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
	-DSHADERC_SKIP_TESTS=ON -DSHADERC_SKIP_EXAMPLES=ON \
	-DSHADERC_SKIP_COPYRIGHT_CHECK=ON -DSHADERC_ENABLE_HLSL=OFF -DSHADERC_ENABLE_WERROR_COMPILE=OFF \
	-DSPIRV_SKIP_EXECUTABLES=ON -DSPIRV_WERROR=OFF -DENABLE_GLSLANG_BINARIES=OFF >&2
ninja -C "$obj" glslc_exe >&2
install -m 755 "$obj/glslc/glslc" "$dest/bin/glslc"
"$dest/bin/glslc" --version >/dev/null
rm -rf "$src" "$obj"
headers
echo "$want" >"$stamp"
echo "$dest"
