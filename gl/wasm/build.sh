#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Build virglrenderer (vrend, the GL renderer) and its vtest protocol decoder
# for the browser: one wasm module, single-threaded, that renders through one
# WebGL2 context the page hands it. Its C API is kw_virgl.h, its JS helpers
# post.js; gl/wasm/test/check.mjs runs it in headless Chromium.
#
# The pieces: virglrenderer 1.3.0 with gl/patches/virglrenderer/ (the single
# GL context mode, GLES 3.0 and WebGL 2 fixes, emscripten platform fixes, an
# embedder hook in the vtest decoder), built by meson with emscripten.ini and
# no EGL, GLX, GBM, DRM, video, Venus or threads; epoxy/ in place of
# libepoxy (GL calls go straight to emscripten's WebGL2 bindings); kw_gl.js,
# GL entry points made from WebGL2 (buffer types and maps, indexed blend,
# base vertex draws); gl-missing.txt, the rest of what WebGL2 lacks, made
# into logging stubs by gen-gl-missing.py; kw_virgl.c, the GL context hooks
# and the vtest I/O layer.
#
#   gl/wasm/build.sh [toolchain|source|lib|module|all|native]   (default: all)
#
#   toolchain  emscripten $EMSCRIPTEN_VERSION (pins.sh), fetched and checked,
#              into vendor/toolchain/emscripten-$EMSCRIPTEN_VERSION
#   source     virglrenderer $VIRGLRENDERER_TAG into vendor/src/virglrenderer-wasm,
#              branch kw-wasm = the tag + gl/patches/virglrenderer/*.patch
#   lib        meson + ninja: the static libraries (vendor/build/gl-wasm/meson)
#   module     emcc link: vendor/build/gl-wasm/virgl.mjs and virgl.wasm
#   native     the same source for this host (EGL), for test/gl/vtest-check.sh:
#              vendor/build/gl-native/vtest/virgl_test_server (needs the
#              host's libepoxy, gbm, libdrm and EGL development files)
#
# Everything is reproducible from a clean vendor/: the inputs are pins.sh,
# the patches and the files in this directory. An existing kw-wasm branch is
# never re-applied (rename or delete it to re-apply the series); a commit
# there is exported with
#   git -C vendor/src/virglrenderer-wasm format-patch -N -o "$PWD/gl/patches/virglrenderer" $VIRGLRENDERER_COMMIT..kw-wasm
#
# Two builds of the same inputs are byte for byte the same, wherever the
# output goes. Check the module with `node gl/wasm/test/check.mjs`.
#
# Environment:
#   KW_BUILD=dir   the outputs go to dir/gl-wasm (as kernel/build.sh)
#   KW_LDFLAGS=... more emcc link flags, for debugging: -sASSERTIONS=1
#                  -sGL_ASSERTIONS=1 (also test/check.mjs --glcheck)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
. "$here/../../kernel/tools/env.sh"   # root, vendor, build, fetch_verified
. "$here/pins.sh"

emroot="$vendor/toolchain/emscripten-$EMSCRIPTEN_VERSION"
src="$vendor/src/virglrenderer-wasm"
out="$build/gl-wasm"
jobs="$(nproc)"

need() {
	local t
	for t in "$@"; do
		command -v "$t" >/dev/null || { echo "$t not found (needed by gl/wasm/build.sh)" >&2; exit 1; }
	done
}

use_emscripten() {
	export EM_CONFIG="$emroot/emscripten.config"
	export EM_CACHE="$emroot/cache"
	export PATH="$emroot/install/emscripten:$emroot/install/bin:$PATH"
}

build_toolchain() {
	need curl tar xz node python3
	if [ ! -x "$emroot/install/emscripten/emcc" ]; then
		local tarball="$vendor/downloads/emscripten-$EMSCRIPTEN_VERSION-linux.tar.xz"
		fetch_verified "$EMSCRIPTEN_URL" "$tarball" "$EMSCRIPTEN_SHA256"
		rm -rf "$emroot.tmp"
		mkdir -p "$emroot.tmp"
		tar -xJf "$tarball" -C "$emroot.tmp"
		mv "$emroot.tmp" "$emroot"
	fi
	# emsdk would write this file; LLVM, Binaryen and node are the ones above
	# and on PATH. Rewritten every run: node may move.
	cat >"$emroot/emscripten.config" <<-EOF
		LLVM_ROOT = '$emroot/install/bin'
		BINARYEN_ROOT = '$emroot/install'
		NODE_JS = '$(command -v node)'
	EOF
	use_emscripten
	emcc --version | head -1
}

# git_am DIR PATCH...: as in kernel/build.sh.
git_am() {
	local dir="$1"
	shift
	if ! git -C "$dir" -c user.name=unkernel -c user.email=unkernel@localhost am -q "$@"; then
		git -C "$dir" am --abort || true
		echo "patches did not apply in $dir" >&2
		return 1
	fi
}

prepare_source() {
	need git
	if [ ! -e "$src/.git" ]; then
		mkdir -p "$vendor/src"
		rm -rf "$src.tmp"
		git -c advice.detachedHead=false clone -q --depth 1 --branch "$VIRGLRENDERER_TAG" "$VIRGLRENDERER_REPO" "$src.tmp"
		if [ "$(git -C "$src.tmp" rev-parse HEAD)" != "$VIRGLRENDERER_COMMIT" ]; then
			echo "virglrenderer $VIRGLRENDERER_TAG is not $VIRGLRENDERER_COMMIT; refusing to build it" >&2
			exit 1
		fi
		mv "$src.tmp" "$src"
	fi
	if ! git -C "$src" rev-parse -q --verify kw-wasm >/dev/null; then
		git -C "$src" checkout -q --detach "$VIRGLRENDERER_COMMIT"
		git_am "$src" "$root"/gl/patches/virglrenderer/*.patch
		git -C "$src" checkout -q -b kw-wasm
	fi
	local npatch ncommit
	npatch=$(ls "$root"/gl/patches/virglrenderer/*.patch | wc -l)
	ncommit=$(git -C "$src" rev-list --count "$VIRGLRENDERER_COMMIT..kw-wasm")
	if [ "$npatch" != "$ncommit" ]; then
		echo "warning: kw-wasm in $src has $ncommit commits on $VIRGLRENDERER_TAG, gl/patches/virglrenderer has $npatch patches" >&2
	fi
}

build_lib() {
	need meson ninja pkg-config
	use_emscripten
	local m="$out/meson"
	mkdir -p "$out/pkgconfig"
	# epoxy: the header shim in epoxy/ (no EGL, no GLX: meson then builds
	# neither winsys).
	cat >"$out/pkgconfig/epoxy.pc.tmp" <<-EOF
		Name: epoxy
		Description: epoxy stand-in for emscripten WebGL2 (gl/wasm/epoxy)
		Version: 1.5.10
		epoxy_has_glx=0
		epoxy_has_egl=0
		epoxy_has_wgl=0
		Cflags: -I$here/epoxy/include
	EOF
	cat >"$out/paths.ini.tmp" <<-EOF
		[properties]
		pkg_config_libdir = '$out/pkgconfig'
	EOF
	# rewritten only when changed: meson reconfigures when they change
	for f in "$out/pkgconfig/epoxy.pc" "$out/paths.ini"; do
		if cmp -s "$f.tmp" "$f"; then rm "$f.tmp"; else mv "$f.tmp" "$f"; fi
	done
	local opts=(-Dbuildtype=release -Db_ndebug=true
		-Dplatforms=auto -Dvenus=false -Ddrm-renderers=[] -Dvideo=false
		-Dtests=false -Dfuzzer=false -Dtracing=none -Dcheck-gl-errors=false)
	# meson reads cross files only at setup: set up afresh when they or the
	# options change
	local stamp
	stamp="$(cat "$here/emscripten.ini" "$out/paths.ini"; echo "${opts[*]}")"
	if [ ! -f "$m/build.ninja" ] || [ "$(cat "$m/kw-setup" 2>/dev/null)" != "$stamp" ]; then
		rm -rf "$m"
		meson setup "$m" "$src" --cross-file "$here/emscripten.ini" --cross-file "$out/paths.ini" "${opts[@]}"
		printf '%s' "$stamp" >"$m/kw-setup"
	fi
	ninja -C "$m" -j"$jobs" src/libvirglrenderer.a src/libvirgl.a \
		src/gallium/libgallium.a src/mesa/libmesa.a
}

build_module() {
	use_emscripten
	local m="$out/meson" o="$out/obj" f
	local cflags=(-O2 -std=gnu11 -Wall -Wno-unused-parameter -fvisibility=hidden
		-imacros "$m/config.h" -DHAVE_CONFIG_H=1 -DVTEST_EXTERNAL_IO=1
		-I"$here/epoxy/include" -I"$here" -I"$m" -I"$m/src" -I"$m/src/gallium" -I"$src" -I"$src/src" -I"$src/vtest"
		-I"$src/src/gallium/include" -I"$src/src/gallium/auxiliary" -I"$src/src/gallium/auxiliary/util"
		-I"$src/src/mesa" -I"$src/src/mesa/compat" -I"$src/src/mesa/util" -I"$src/src/mesa/pipe"
		-I"$src/src/drm" -I"$src/src/drm/drm-uapi"
		"-ffile-prefix-map=$root/=")
	mkdir -p "$o"
	# The GL entry points virglrenderer names that emscripten does not bind:
	# a stub each, from the list and the prototypes of epoxy/gl.h.
	python3 -I "$here/gen-gl-missing.py" "$here/gl-missing.txt" \
		<(emcc -E -P -DGL_GLEXT_PROTOTYPES=1 -I"$here/epoxy/include" -x c - <<<'#include <epoxy/gl.h>') \
		>"$o/kw_gl_missing.c.tmp"
	mv "$o/kw_gl_missing.c.tmp" "$o/kw_gl_missing.c"
	for f in "$here/kw_virgl.c" "$here/epoxy/epoxy.c" "$o/kw_gl_missing.c" \
		"$src/vtest/vtest_renderer.c" "$src/vtest/util.c"; do
		emcc "${cflags[@]}" -c "$f" -o "$o/$(basename "${f%.c}").o"
	done
	# MODULARIZE + EXPORT_ES6: `import createVirgl from './virgl.mjs'`;
	# post.js adds the JS helpers (Module.virgl: init(gl), open, feed, ...).
	emcc -O2 -o "$out/virgl.mjs" \
		"$o/kw_virgl.o" "$o/epoxy.o" "$o/kw_gl_missing.o" "$o/vtest_renderer.o" "$o/util.o" \
		"$m/src/libvirglrenderer.a" "$m/src/libvirgl.a" \
		"$m/src/gallium/libgallium.a" "$m/src/mesa/libmesa.a" \
		-sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createVirgl \
		-sENVIRONMENT=web,worker -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=4MB \
		-sMIN_WEBGL_VERSION=2 -sMAX_WEBGL_VERSION=2 \
		-sGL_EMULATE_GLES_VERSION_STRING_FORMAT=1 -sGL_EXTENSIONS_IN_PREFIXED_FORMAT=1 \
		-sGL_SUPPORT_AUTOMATIC_ENABLE_EXTENSIONS=1 \
		-sEXPORTED_FUNCTIONS=_kw_virgl_init,_kw_virgl_open,_kw_virgl_close,_kw_virgl_feed,_kw_virgl_poll,_kw_virgl_reply_ptr,_kw_virgl_reply_len,_kw_virgl_consume,_kw_virgl_state,_kw_virgl_stats,_kw_vgpu_command,_kw_vgpu_capset,_kw_vgpu_format,_kw_vgpu_fence,_kw_vgpu_fences_done,_kw_vgpu_gl_errors,_kw_vgpu_info,_kw_vgpu_blit,_kw_vgpu_present,_kw_vgpu_read,_malloc,_free \
		-sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32 \
		'-sDEFAULT_LIBRARY_FUNCS_TO_INCLUDE=$GL' \
		--js-library "$here/kw_gl.js" --post-js "$here/post.js" ${KW_LDFLAGS:-}
	ls -l "$out/virgl.mjs" "$out/virgl.wasm"
}

build_native() {
	need meson ninja pkg-config cc
	local m="$build/gl-native"
	local opts=(-Dplatforms=egl -Dtests=false -Dbuildtype=debugoptimized -Dcheck-gl-errors=false)
	if [ ! -f "$m/build.ninja" ] || [ "$(cat "$m/kw-setup" 2>/dev/null)" != "${opts[*]}" ]; then
		rm -rf "$m"
		meson setup "$m" "$src" "${opts[@]}"
		printf '%s' "${opts[*]}" >"$m/kw-setup"
	fi
	ninja -C "$m" -j"$jobs" vtest/virgl_test_server
	ls -l "$m/vtest/virgl_test_server"
}

case "${1:-all}" in
toolchain) build_toolchain ;;
source) prepare_source ;;
lib) build_toolchain; prepare_source; build_lib ;;
module) build_toolchain; prepare_source; build_lib; build_module ;;
all) build_toolchain; prepare_source; build_lib; build_module ;;
native) prepare_source; build_native ;;
*) sed -n '2,/^set -e/p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac
