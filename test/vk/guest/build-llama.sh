#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Builds llama.cpp's llama-simple with its Vulkan backend (ggml-vulkan) for
# the Debian guest (aarch64 glibc, zig, libc++ static, linked against a
# stand-in libvulkan.so.1 so the guest's loader serves it) and packs it
# with a tiny model into $build/vk/llama/guest-test/vk-llama, a
# self-extracting test program that runs the model on kwvk (-ngl 99) and on
# the CPU and prints both texts:
#
#   test/vk/guest/build-llama.sh [native]
#   node test/vk/unkernel-check.mjs --source --skip a,c --tests vendor/build/vk/llama/guest-test
#
# `native` builds for this host instead ($build/vk/llama/native-build) for
# runs through test/vk/relay.mjs (with this host's Vulkan loader and
# headers). Needs cmake and ninja. glslc is $GLSLC (a path or a name on
# PATH), else the pinned one, which vk/glslc.sh builds on first use (python3
# and a C++ compiler); the SPIR-V headers come from vk/glslc.sh and the
# cross build's Vulkan headers from vk/pins.sh. Downloads llama.cpp
# (shallow, into $build/vk/llamacpp unless present) and the stories260K
# model (into $build/vk/model-dl).
set -eu
. "$(cd "$(dirname "$0")/../../.." && pwd)/kernel/tools/env.sh"
need_zig
out="$build/vk/llama"
src="$build/vk/llamacpp"
models="$build/vk/model-dl"
mkdir -p "$out" "$models"
[ -f "$src/CMakeLists.txt" ] || git clone --depth 1 https://github.com/ggml-org/llama.cpp "$src"
[ -f "$models/stories260K.gguf" ] ||
	curl -fL -o "$models/stories260K.gguf" https://huggingface.co/ggml-org/models/resolve/main/tinyllamas/stories260K.gguf
common=(-G Ninja -S "$src" -DCMAKE_BUILD_TYPE=Release -DGGML_VULKAN=ON -DGGML_NATIVE=OFF -DLLAMA_CURL=OFF
	-DLLAMA_BUILD_SERVER=OFF -DLLAMA_BUILD_TESTS=ON)
# glslc runs on this host in both builds (ggml's shaders and its
# GGML_VULKAN_*_GLSLC_SUPPORT probes)
if [ -n "${GLSLC:-}" ]; then
	glslc="$(command -v "$GLSLC")" || { echo "build-llama.sh: GLSLC=$GLSLC not found" >&2; exit 1; }
	glslc_dir="$("$root/vk/glslc.sh" headers)"
else
	glslc_dir="$("$root/vk/glslc.sh")" || {
		echo "build-llama.sh: building the pinned glslc failed (vk/glslc.sh; needs cmake, ninja, python3, a C++ compiler);" \
			"set GLSLC=/path/to/glslc to use another" >&2
		exit 1
	}
	glslc="$glslc_dir/bin/glslc"
fi
common+=(-DVulkan_GLSLC_EXECUTABLE="$glslc" -DSPIRV-Headers_DIR="$glslc_dir/share/cmake/SPIRV-Headers")
if [ "${1:-}" = native ]; then
	cmake "${common[@]}" -B "$out/native-build"
	ninja -C "$out/native-build" llama-simple test-backend-ops
	exit 0
fi
x="$out/cross"
mkdir -p "$x/inc" "$x/stub"
. "$root/vk/headers.sh"
vk_headers "$x/inc"
grep -ho "VKAPI_CALL vk[A-Za-z0-9]*" "$x/inc/vulkan/vulkan_core.h" | awk '{ print "void " $2 "(void) {}" }' | sort -u >"$x/stub/vulkan.c"
"$zig" cc -target aarch64-linux-gnu.2.36 -shared -nostdlib -Wl,-soname,libvulkan.so.1 -o "$x/stub/libvulkan.so.1" "$x/stub/vulkan.c"
ln -sf libvulkan.so.1 "$x/stub/libvulkan.so"
printf '#!/bin/sh\nexec %s cc -target aarch64-linux-gnu.2.36 -mcpu=generic "$@"\n' "$zig" >"$x/cc.sh"
# zig's linker crashes on CMake's -Xlinker --dependency-file=...: drop the pair
cat >"$x/cxx.sh" <<EOF
#!/bin/sh
held=""
for a; do
	shift
	if [ -n "\$held" ]; then
		held=""
		case "\$a" in --dependency-file=*) continue ;; esac
		set -- "\$@" -Xlinker "\$a"
		continue
	fi
	case "\$a" in -Xlinker) held=1 ;; --dependency-file=*) ;; *) set -- "\$@" "\$a" ;; esac
done
exec $zig c++ -target aarch64-linux-gnu.2.36 -mcpu=generic "\$@"
EOF
chmod +x "$x/cc.sh" "$x/cxx.sh"
cmake "${common[@]}" -B "$x/build" -DCMAKE_SYSTEM_NAME=Linux -DCMAKE_SYSTEM_PROCESSOR=aarch64 \
	-DCMAKE_C_COMPILER="$x/cc.sh" -DCMAKE_CXX_COMPILER="$x/cxx.sh" -DGGML_OPENMP=OFF -DBUILD_SHARED_LIBS=OFF \
	-DVulkan_INCLUDE_DIR="$x/inc" -DVulkan_LIBRARY="$x/stub/libvulkan.so" \
	-DCMAKE_FIND_ROOT_PATH_MODE_PROGRAM=NEVER
ninja -C "$x/build" llama-simple
llvm-strip -o "$x/llama-simple" "$x/build/bin/llama-simple"
w=$(mktemp -d)
trap 'rm -rf "$w"' EXIT
cp "$x/llama-simple" "$models/stories260K.gguf" "$w/"
tar czf "$w/p.tgz" -C "$w" llama-simple stories260K.gguf
mkdir -p "$out/guest-test"
{
	printf '#!/bin/sh\nset -e\nd=/tmp/llama; mkdir -p $d; sed "1,/^__PAYLOAD__$/d" "$0" | base64 -d | tar xz -C $d\n'
	printf 'cd $d; echo "== GPU (-ngl 99)"; KWVK_STATS=1 ./llama-simple -m stories260K.gguf -n 32 -ngl 99 "Once upon a time" 2>gpu.err; grep -a "decoded\\|eval time\\|kwvk stats" gpu.err | tail -4\n'
	printf 'echo "== CPU (-ngl 0, no Vulkan)"; VK_DRIVER_FILES=/nonexistent ./llama-simple -m stories260K.gguf -n 32 -ngl 0 "Once upon a time" 2>cpu.err; grep -a "decoded\\|eval time" cpu.err | tail -2\nexit 0\n__PAYLOAD__\n'
	base64 "$w/p.tgz"
} >"$out/guest-test/vk-llama"
chmod +x "$out/guest-test/vk-llama"
echo "$out/guest-test/vk-llama"
