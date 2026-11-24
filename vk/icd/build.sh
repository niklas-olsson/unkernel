#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Builds kwvk, the guest's Vulkan ICD (libvulkan_kw.so), its ICD manifest
# and the test programs in test/vk/guest/.
#
#   vk/icd/build.sh          aarch64 glibc (the Debian guest): $build/vk/
#                            libvulkan_kw.so, kw_icd.json (library_path
#                            /usr/lib/kw/libvulkan_kw.so) and the test
#                            programs (vk-compute, vk-triangle, ...)
#   vk/icd/build.sh native   this host (x86_64): $build/vk/native/, with
#                            kw_icd.json pointing at the absolute path there
#
# Native tests against the page's renderer in headless Chrome (KWVK_DEBUG=1
# logs the ICD's errors, KWVK_DUMP=FILE writes each presented frame):
#
#   node test/vk/relay.mjs -- vendor/build/vk/native/vk-compute
#   node test/vk/relay.mjs -- vendor/build/vk/native/vk-triangle
#   node test/vk/relay.mjs -- vendor/build/vk/native/vk-headless
#   WAYLAND_DISPLAY=... node test/vk/relay.mjs -- vkcube --wsi wayland --c 60
#
# The Vulkan headers are pinned (vk/pins.sh, fetched by vk/headers.sh), so
# the build needs none on the host. The test programs link against a stand-in
# libvulkan.so.1 for the guest and the host's loader natively.
set -eu
. "$(cd "$(dirname "$0")/../.." && pwd)/kernel/tools/env.sh"
need_zig
mode=${1:-guest}
src="$root/vk/icd"
tests="$root/test/vk/guest"
. "$root/vk/headers.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
vk_headers "$work/inc"
case "$mode" in
guest)
	out="$build/vk"
	cc=("$zig" cc -target aarch64-linux-gnu.2.36 -mcpu=generic "-ffile-prefix-map=$root/=")
	libpath=/usr/lib/kw/libvulkan_kw.so
	;;
native)
	out="$build/vk/native"
	cc=(cc)
	libpath="$out/libvulkan_kw.so"
	;;
*) echo "usage: $0 [guest|native]" >&2; exit 2 ;;
esac
mkdir -p "$out"
flags=(-O2 -g0 -Wall -Wextra -Wno-unused-parameter -fPIC -fvisibility=hidden -I "$work/inc" -D_GNU_SOURCE)
strip=()
[ "$mode" = guest ] && strip=(-s)
"${cc[@]}" "${flags[@]}" "${strip[@]}" -shared -Wl,-soname,libvulkan_kw.so -o "$out/libvulkan_kw.so" \
	"$src/icd.c" "$src/link.c" "$src/wsi.c" -lpthread -ldl -lm
cat >"$out/kw_icd.json" <<EOF
{
    "file_format_version": "1.0.0",
    "ICD": {
        "library_path": "$libpath",
        "api_version": "1.0.314"
    }
}
EOF
# test programs: every test/vk/guest/vk-*.c
progs=()
for t in "$tests"/vk-*.c; do progs+=("$(basename "$t" .c)"); done
if [ "$mode" = guest ]; then
	for p in "${progs[@]}"; do "${cc[@]}" -O2 -I "$work/inc" -c "$tests/$p.c" -o "$work/$p.o"; done
	nm -u "$work"/vk-*.o | awk '$2 ~ /^vk/ { print $2 }' | sort -u |
		sed 's/$/(void) {}/; s/^/void /' >"$work/vulkan.c"
	"${cc[@]}" -shared -nostdlib -Wl,-soname,libvulkan.so.1 -o "$work/libvulkan.so.1" "$work/vulkan.c"
	for p in "${progs[@]}"; do "${cc[@]}" -s -o "$out/$p" "$work/$p.o" "$work/libvulkan.so.1"; done
else
	for p in "${progs[@]}"; do "${cc[@]}" -O2 -Wall -I "$work/inc" -o "$out/$p" "$tests/$p.c" -lvulkan; done
fi
ls -l "$out"
