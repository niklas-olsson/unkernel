#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Build the unkernel kernels (wasm64 vmlinux with emulated aarch64 user mode)
# and their 32-bit-memory variants (the ones the page and the bundle use):
# the UP kernel and the SMP kernel (CONFIG_SMP, one wasm instance per CPU on
# a shared memory) from the same tree; the data disk template; the base
# initramfs (guest/build.sh base) and the single-file bundle unkernel.wasm
# (the UP kernel, the base initramfs, the data disk template and a patch
# from the UP to the SMP kernel); and the distro images with their index
# distros.json (guest/build.sh distro).
# ./setup.sh at the repository root checks the prerequisites and runs `all`.
#
#   kernel/build.sh [toolchain|binaryen|kernel|smp|lower|datadisk|base|distro|stats|all]  (default: all)
#
# `all` is idempotent: finished steps are skipped or rebuilt incrementally.
# It builds both kernels (KW_SMP=0: the UP kernel only), the data disk
# template, the base bundle and every distro image.
#
# `kernel` builds the UP kernel only (the quick loop for kernel work), `smp`
# the SMP kernel only (vendor/build/kernel-smp, with kwemu built with atomics
# in vendor/build/kwemu-smp); each refreshes the bundle (when the base
# initramfs exists) and distros.json. The bundle carries the patch to the
# SMP kernel when that kernel was built from the same tree as the UP one
# (the kernels' banners, kernel/tools/bundle.mjs --smp), and otherwise
# leaves it out with a warning (run `smp` after `kernel`).
#
# `stats` builds a profiling variant next to the normal outputs, which it
# leaves alone: kwemu with -Dkwemu-stats (exit counters, the kw_debug_stats
# export) in vendor/build/kwemu-stats, the UP kernel in
# vendor/build/kernel-stats (the first run is a full kernel build) and the
# bundle vendor/build/bundle/unkernel-stats.wasm (the base initramfs, no SMP
# patch; run `base` first). Boot it with
# `node js/cli.ts --kernel vendor/build/bundle/unkernel-stats.wasm --stats`.
#
# Kernels are reproducible: two builds of the same tree with the same
# toolchain are byte for byte the same (so is the bundle's SMP patch). The
# banner (linux_banner, `uname -v`) has fixed stamps instead of the user,
# host, build count and time: (unkernel@unkernel), the build id as the build
# "number" (#<12 hex digits>: a hash of the kernel tree with its uncommitted
# changes, the kwemu sources, the wasm-ld patches and the zig version, so
# every other build of the kernel module has another banner, which is what a
# snapshot is matched against), and the date of the newest commit (author
# date) on the kernel tree. KBUILD_BUILD_USER, _HOST, _VERSION and
# _TIMESTAMP in the environment take precedence.
#
# Everything large lives under vendor/ (gitignored):
#   vendor/src/llvm22               llvm-project llvmorg-22.1.8 (sparse: llvm, lld)
#   vendor/build/lld22              wasm-ld with kernel/patches/llvm applied
#   vendor/src/linux-wasm-kernel    Linux at $LINUX_BASE (kernel.org) + kernel/patches/linux
#                                   (branch kw-arm64-user)
#   vendor/build/kernel             UP kernel build output (vmlinux = the wasm64 module,
#                                   vmlinux32.wasm = the same lowered to a 32-bit memory/table,
#                                   the default for the browser page)
#   vendor/build/kernel-smp         SMP kernel build output (kw_defconfig + kw_smp.config),
#                                   and up.kwpatch, the UP->SMP patch the last bundle used
#   vendor/build/kwemu-smp          kwemu built with atomics, for the SMP kernel
#   vendor/toolchain/binaryen       Binaryen release (wasm-opt), fetched by `binaryen`
#   vendor/build/disk/kwdata.kwsparse.gz  empty ext4 "kwdata" data disk template (`datadisk`)
#   vendor/build/initramfs/         base.cpio (also holds /usr/bin/kwtest, abitest and kwbench;
#                                   with KW_RELEASE=1 only base-test.cpio does; `base`)
#   vendor/build/distro/            the distro images <name>.erofs, <name>.ext4, their ids
#                                   <name>.id and the index distros.json (`distro`; guest/README.md)
#   vendor/build/bundle/            unkernel.wasm (vmlinux32.wasm + base.cpio + cmdline + the data
#                                   disk template + the SMP patch in custom sections; `base`): the
#                                   default of the CLI (js/cli.ts) and the SDK, and copied to
#                                   web/kernel/ for the page's dev server; unkernel-stats.wasm
#                                   from `stats`
#
# Environment:
#   KW_BUILD=dir   build output root instead of vendor/build (every output above but
#                  the toolchain's vendor/build/lld22), e.g. with KSRC to build a branch
#                  without touching the main outputs.
#                  The CLI, the SDK build and the tests read vendor/build: give them
#                  paths (--kernel, --distro, UNKERNEL_TEST_KERNEL, UNKERNEL_TEST_DISTRO_DIR)
#   KW_BASE_OUT=dir  `base` (and the bundle refresh of `kernel`, `smp`, `lower`, `datadisk`)
#                  reads and writes base.cpio, base-test.cpio and unkernel.wasm there
#                  instead of vendor/build/initramfs and vendor/build/bundle, and does not
#                  copy unkernel.wasm to web/kernel/ (a build beside the main outputs);
#                  KW_DISTRO_OUT=dir does the same for `distro` (guest/README.md)
#   KW_SMP=1|0     1: the bundle must carry the SMP patch (fail otherwise); 0: no SMP
#                  kernel in `all` and no patch in the bundle. Default: `all` builds
#                  both and requires it, every other step adds it when it matches
#   KWEMU=path     wasm64 kwemu static library for the UP kernel (default:
#                  zig-out/lib/libkwemu.a, rebuilt with `zig build` on every run;
#                  set KWEMU=none for the stub)
#   KWEMU_SMP=path the same for the SMP kernel, built with -Dkwemu-atomics=true
#                  (default: vendor/build/kwemu-smp/lib/libkwemu.a, rebuilt on every run).
#                  Libraries given here count as built from this checkout with the
#                  default options (the build id hashes the sources, not the library)
#   KWEMU_JIT=0    build those libraries without the JIT tier (-Dkwemu-jit=false; the
#                  kernel then imports no unkernel.kw_host_jit_*; ignored with KWEMU=).
#                  Default 1
#   KWEMU_STATS=1  build the UP library with -Dkwemu-stats into vendor/build/kwemu-stats
#                  (what `stats` sets; ignored with KWEMU=)
#   JOBS=n         parallelism (default: nproc)
#   KSRC=dir       kernel source tree, e.g. a git worktree (default: vendor/src/linux-wasm-kernel)
#   KOUT=dir       UP kernel build output (default: vendor/build/kernel)
#   KOUT_SMP=dir   SMP kernel build output (default: vendor/build/kernel-smp)
#   LINUX_REPO=url where a fresh kernel tree fetches $LINUX_BASE from (default: kernel.org)
#   WASM_OPT=path  wasm-opt for the 32-bit lowering (default: vendor/toolchain/binaryen,
#                  then PATH); `lower` redoes only that step on existing vmlinux files
set -euo pipefail

. "$(dirname "$0")/tools/env.sh"   # root, vendor, build, zig, pins, real_bin, ...
jobs="${JOBS:-$(nproc)}"
what="${1:-all}"
use_real_host_tools

# Kernel base: Linux v7.3.4 from kernel.org, fetched by exact commit (shallow).
# arch/wasm is based on Joel Severin's linux-wasm (joelseverin/linux, branch
# wasm-7.0); see .agents/kernel.md.
LINUX_REPO="${LINUX_REPO:-https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git}"
LINUX_BASE=7595a62d45ee1a2297eafa5f2ef5d0a45142d84d
LLVM_REPO=https://github.com/llvm/llvm-project.git
LLVM_TAG=llvmorg-22.1.8
LLVM_COMMIT=ca7933e47d3a3451d81e72ac174dcb5aa28b59d1
BINARYEN_VERSION=133
BINARYEN_SHA256_x86_64=2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489
BINARYEN_SHA256_aarch64=89c07ea56faf38d0fbecf36ca8ec0721756716185f265b568e133d427f299bf8

ksrc="${KSRC:-$vendor/src/linux-wasm-kernel}"
kout="${KOUT:-$build/kernel}"
# The base initramfs and its bundle (guest/lib/env.sh), the distro images.
base_out="$(realpath -m "${KW_BASE_OUT:-$build/initramfs}")"
distro_out="$(realpath -m "${KW_DISTRO_OUT:-$build/distro}")"
kout_smp="${KOUT_SMP:-$build/kernel-smp}"
toolchain="$vendor/toolchain/bin"

need_clang() {
	local v
	v="$(clang --version 2>/dev/null | sed -n 's/.*clang version \([0-9]*\).*/\1/p' | head -1)"
	if [ "${v:-0}" -lt 21 ]; then
		echo "need clang >= 21 (wasm64 table64 call_indirect; tested with 22), have ${v:-none}" >&2
		exit 1
	fi
}

# git_am DIR PATCH...: apply a patch series; on failure leave DIR as it was.
git_am() {
	local dir="$1"
	shift
	if ! git -C "$dir" -c user.name=unkernel -c user.email=unkernel@localhost am "$@"; then
		git -C "$dir" am --abort || true
		echo "patches did not apply in $dir" >&2
		return 1
	fi
}

build_toolchain() {
	need_clang
	local src="$vendor/src/llvm22" out="$vendor/build/lld22"
	if [ ! -d "$src/lld/wasm" ]; then
		mkdir -p "$vendor/src"
		rm -rf "$src.tmp"
		git -c advice.detachedHead=false clone --depth 1 --branch "$LLVM_TAG" --filter=blob:none --sparse "$LLVM_REPO" "$src.tmp"
		git -C "$src.tmp" sparse-checkout set llvm lld cmake third-party libunwind/include
		if [ "$(git -C "$src.tmp" rev-parse HEAD)" != "$LLVM_COMMIT" ]; then
			echo "$LLVM_TAG is not $LLVM_COMMIT; refusing to build an unexpected LLVM" >&2
			exit 1
		fi
		mv "$src.tmp" "$src"
	fi
	if ! git -C "$src" log --oneline -3 | grep -q "linker scripts"; then
		git_am "$src" "$root"/kernel/patches/llvm/*.patch
	fi
	if [ ! -f "$out/build.ninja" ]; then
		cmake -G Ninja -S "$src/llvm" -B "$out" -DCMAKE_BUILD_TYPE=Release \
			-DLLVM_ENABLE_PROJECTS=lld -DLLVM_TARGETS_TO_BUILD=WebAssembly \
			-DLLVM_ENABLE_ASSERTIONS=ON -DCMAKE_C_COMPILER="$(real_bin clang)" -DCMAKE_CXX_COMPILER="$(real_bin clang++)" \
			-DLLVM_USE_LINKER=lld -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF \
			-DLLVM_INCLUDE_EXAMPLES=OFF -DLLVM_ENABLE_ZSTD=OFF -DLLVM_ENABLE_LIBXML2=OFF
	fi
	ninja -C "$out" -j"$jobs" lld
	mkdir -p "$toolchain"
	for t in clang llvm-ar llvm-nm llvm-objcopy llvm-objdump llvm-ranlib llvm-readelf llvm-strip; do
		ln -sf "$(real_bin $t)" "$toolchain/$t"
	done
	ln -sf "$out/bin/lld" "$toolchain/wasm-ld"
}

prepare_kernel_tree() {
	if [ ! -e "$ksrc/.git" ]; then  # -e: a worktree has a .git file
		# Only the base commit (shallow); `git fetch --deepen N` adds history.
		rm -rf "$ksrc.tmp"
		mkdir -p "$ksrc.tmp"
		git -C "$ksrc.tmp" init -q
		git -C "$ksrc.tmp" remote add origin "$LINUX_REPO"
		git -C "$ksrc.tmp" fetch --depth 1 origin "$LINUX_BASE"
		git -C "$ksrc.tmp" checkout -q --detach FETCH_HEAD
		mv "$ksrc.tmp" "$ksrc"
	fi
	if ! git -C "$ksrc" rev-parse -q --verify kw-arm64-user >/dev/null; then
		git -C "$ksrc" checkout -q --detach "$LINUX_BASE"
		git_am "$ksrc" "$root"/kernel/patches/linux/*.patch
		git -C "$ksrc" checkout -q -b kw-arm64-user
	fi
	# An existing branch is never re-applied: say so when what is checked
	# out (kw-arm64-user, or the branch of a KSRC worktree) no longer
	# matches the series (an older series, or commits not yet exported).
	local npatch ncommit
	npatch=$(ls "$root"/kernel/patches/linux/*.patch | wc -l)
	ncommit=$(git -C "$ksrc" rev-list --count "$LINUX_BASE..HEAD" 2>/dev/null || echo "?")
	if [ "$npatch" != "$ncommit" ]; then
		echo "warning: $ksrc has $ncommit commits on $LINUX_BASE, kernel/patches/linux has $npatch patches;" >&2
		echo "  export your commits, or rename the branch (git -C $ksrc branch -m kw-arm64-user old) to re-apply the series" >&2
	fi
	# The emulator contract (include/kw_emu.h) is the source of truth; the
	# kernel tree has a copy (arch/wasm/include/asm/kw_emu.h). Keep the build consistent if they
	# drift, and say so: the kernel patch needs updating.
	if ! cmp -s "$root/include/kw_emu.h" "$ksrc/arch/wasm/include/asm/kw_emu.h"; then
		echo "warning: include/kw_emu.h differs from the kernel tree's arch/wasm/include/asm/kw_emu.h;" >&2
		echo "  copying it (commit it on kw-arm64-user and re-export kernel/patches/linux)" >&2
		cp "$root/include/kw_emu.h" "$ksrc/arch/wasm/include/asm/kw_emu.h"
	fi
}

# The zig build option for the kwemu JIT tier (src/emu/jitcore.zig, A64:
# src/a64/jit/; .agents/a64/jit.md), on unless KWEMU_JIT=0. Hosts without
# the JIT simply answer kw_host_jit_caps() with 0.
kwemu_jit_flag() {
	if [ "${KWEMU_JIT:-1}" = 0 ]; then echo -Dkwemu-jit=false; else echo -Dkwemu-jit=true; fi
}

# kwemu_obj up|smp: the kwemu library to link into that kernel (empty for
# the stub). The SMP kernel's is built with atomics (kernel.md, SMP), into
# its own prefix, as a stats library is, so zig-out keeps the normal one.
kwemu_obj() {
	local prefix="$root/zig-out" flags=() k="${KWEMU:-}"
	if [ "$1" = smp ]; then
		prefix="$build/kwemu-smp"
		flags=(-Dkwemu-atomics=true)
		k="${KWEMU_SMP:-}"
	elif [ "${KWEMU_STATS:-0}" = 1 ]; then
		prefix="$build/kwemu-stats"
		flags=(-Dkwemu-stats=true)
	fi
	if [ "$k" = none ]; then
		echo ""
		return
	fi
	if [ -z "$k" ]; then
		# Always run it: zig build is incremental and keeps libkwemu.a current
		# (also after a `zig build` or `zig build test` without the JIT option).
		need_zig
		(cd "$root" && "$zig" build "$(kwemu_jit_flag)" "${flags[@]}" --prefix "$prefix" >&2) || return 1
		k="$prefix/lib/libkwemu.a"
	fi
	if [ ! -f "$k" ]; then
		echo "no kwemu library at $k (KWEMU=none links a stub that cannot run user code)" >&2
		return 1
	fi
	echo "$k"
}

# digest_files DIR PATH...: sha256 lines of the files under PATH (tracked or
# untracked but not ignored, when DIR is a git checkout).
digest_files() {
	local dir="$1"
	shift
	(
		cd "$dir"
		if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
			git --no-optional-locks ls-files -z -co --exclude-standard -- "$@"
		else
			find "$@" -type f ! -path '*/__pycache__/*' -print0 2>/dev/null | sort -z
		fi | xargs -0r sha256sum 2>/dev/null || true
	)
}

# kernel_stamps: export the fixed build stamps (KBUILD_BUILD_*; see the top
# of this file), unless the environment has them. Both kernels of a tree get
# the same ones, so their banners differ only in "SMP".
kernel_stamps() {
	[ -z "${stamps_done:-}" ] || return 0
	stamps_done=1
	local id when
	id="$(
		{
			echo "tree $(git -C "$ksrc" rev-parse 'HEAD^{tree}')"
			git -C "$ksrc" --no-optional-locks diff --binary HEAD
			(cd "$ksrc" && git --no-optional-locks ls-files -z -o --exclude-standard | xargs -0r sha256sum)
			digest_files "$root" src include build.zig build.zig.zon kernel/patches/llvm kernel/tools/fake-llvm
			echo "zig $("${zig:-zig}" version 2>/dev/null) jit ${KWEMU_JIT:-1} stats ${KWEMU_STATS:-0}"
		} | sha256sum | cut -c1-12
	)"
	when="$({
		git -C "$ksrc" log -1 --format=%at "$LINUX_BASE"
		git -C "$ksrc" log --format=%at "$LINUX_BASE..HEAD"
	} | sort -n | tail -1)"
	export KBUILD_BUILD_USER="${KBUILD_BUILD_USER:-unkernel}"
	export KBUILD_BUILD_HOST="${KBUILD_BUILD_HOST:-unkernel}"
	export KBUILD_BUILD_VERSION="${KBUILD_BUILD_VERSION:-$id}"
	export KBUILD_BUILD_TIMESTAMP="${KBUILD_BUILD_TIMESTAMP:-$(LC_ALL=C date -u -d "@$when")}"
	echo "kernel stamps: #$KBUILD_BUILD_VERSION $KBUILD_BUILD_TIMESTAMP ($KBUILD_BUILD_USER@$KBUILD_BUILD_HOST)"
}

# check_config OUT FRAGMENT...: every option the fragments set (a later one
# wins) must be in OUT/.config as written. Kconfig drops an option whose
# dependencies are not met without a word.
check_config() {
	local out="$1" bad
	shift
	bad="$(cd "$ksrc/arch/wasm/configs" && awk -v cfg="$out/.config" '
		function key(l) {
			if (l ~ /^CONFIG_[A-Za-z0-9_]+=/) { sub(/=.*/, "", l); return l }
			if (l ~ /^# CONFIG_[A-Za-z0-9_]+ is not set$/) { l = substr(l, 3); sub(/ is not set$/, "", l); return l }
			return ""
		}
		{ k = key($0) }
		k == "" { next }
		FILENAME != cfg { want[k] = $0; next }
		{ have[k] = $0 }
		END {
			for (k in want) {
				w = want[k]; h = (k in have) ? have[k] : "# " k " is not set"
				if (w ~ /^#/ ? h !~ /^#/ : w != h) print "  " w " (.config: " h ")"
			}
		}' "$@" "$out/.config")"
	if [ -n "$bad" ]; then
		echo "$out/.config lacks what $* set (dependencies not met?):" >&2
		echo "$bad" >&2
		return 1
	fi
}

# build_kernel [up|smp]: the UP kernel (kw_defconfig) into KOUT, or the SMP
# kernel (kw_defconfig + kw_smp.config, kwemu with atomics) into KOUT_SMP,
# from the same tree, then lowered (vmlinux32.wasm).
build_kernel() {
	local variant="${1:-up}" out="$kout" frags=(kw_defconfig) f stale= kwemu
	if [ "$variant" = smp ]; then
		out="$kout_smp"
		frags+=(kw_smp.config)
	fi
	[ -x "$toolchain/wasm-ld" ] || build_toolchain
	prepare_kernel_tree
	kernel_stamps
	kwemu="$(kwemu_obj "$variant")" || exit 1
	local make_cmd=(make -C "$ksrc" O="$out" ARCH=wasm
		LLVM="$root/kernel/tools/fake-llvm/" REAL_LLVM="$toolchain/"
		CROSS_COMPILE=wasm64-unknown-unknown- HOSTCC=gcc KWEMU="$kwemu")
	# The wrapper (python3) and Kbuild find clang/wasm-ld through REAL_LLVM.
	mkdir -p "$out"
	# (Re)configure when there is no .config or a fragment changed since, and
	# then check the result.
	[ -f "$out/.config" ] || stale=1
	for f in "${frags[@]}"; do
		[ "$ksrc/arch/wasm/configs/$f" -nt "$out/.config" ] && stale=1
	done
	if [ -n "$stale" ]; then
		"${make_cmd[@]}" "${frags[@]}"
		check_config "$out" "${frags[@]}" || exit 1
	fi
	"${make_cmd[@]}" -j"$jobs" vmlinux
	echo "kernel ($variant): $out/vmlinux"
	lower_kernel "$out"
}

# Binaryen release binaries (wasm-opt) into vendor/toolchain/binaryen.
fetch_binaryen() {
	local v="version_$BINARYEN_VERSION" arch
	case "$(uname -m)" in
	x86_64) arch=x86_64-linux ;;
	aarch64 | arm64) arch=aarch64-linux ;;
	*) echo "no Binaryen release binary for $(uname -m); install binaryen >= $BINARYEN_VERSION and set WASM_OPT" >&2; return 1 ;;
	esac
	local tgz="binaryen-$v-$arch.tar.gz" url="https://github.com/WebAssembly/binaryen/releases/download/$v"
	local sum_var="BINARYEN_SHA256_${arch%%-*}"
	fetch_verified "$url/$tgz" "$vendor/downloads/$tgz" "${!sum_var}"
	mkdir -p "$vendor/toolchain"
	tar xzf "$vendor/downloads/$tgz" -C "$vendor/toolchain"
	ln -sfn "binaryen-$v" "$vendor/toolchain/binaryen"
	"$vendor/toolchain/binaryen/bin/wasm-opt" --version
}

find_wasm_opt() {
	local w
	for w in "${WASM_OPT:-}" "$vendor/toolchain/binaryen/bin/wasm-opt" "$(command -v wasm-opt || true)"; do
		[ -n "$w" ] && [ -x "$w" ] || continue
		# Older releases cannot lower table64 (call_indirect with an i64 index).
		if [[ "$("$w" --help 2>/dev/null)" == *--table64-lowering* ]]; then
			echo "$w"
			return
		fi
		echo "warning: $w ($("$w" --version 2>/dev/null)) has no --table64-lowering; too old" >&2
	done
}

# vmlinux32.wasm: vmlinux with its memory and table lowered to 32 bits. It runs
# on every engine (also those without memory64: Safari/WebKit, so every iOS
# browser), as fast as wasm64 in V8 and faster in JavaScriptCore, so the page
# and the bundle use it. Pointers stay i64 in code and at the JS boundary;
# every load/store, memory and table op wraps its address to i32, which is
# exact because guest RAM is < 4 GiB. The import/export signatures (and with
# them JSPI) are unchanged. Fetches the pinned Binaryen if there is no wasm-opt.
# $1: the kernel build output (default KOUT).
lower_kernel() {
	local k="${1:-$kout}" wasm_opt
	wasm_opt="$(find_wasm_opt)"
	[ -n "$wasm_opt" ] || { fetch_binaryen && wasm_opt="$(find_wasm_opt)"; } || true
	if [ -z "$wasm_opt" ]; then
		echo "lower: no wasm-opt with --table64-lowering (run '$0 binaryen' or set WASM_OPT);" >&2
		echo "  the browser page and the bundle need vmlinux32.wasm" >&2
		if [ -f "$k/vmlinux32.wasm" ] && [ "$k/vmlinux" -nt "$k/vmlinux32.wasm" ]; then
			rm -f "$k/vmlinux32.wasm"
			echo "  removed the stale $k/vmlinux32.wasm (older than vmlinux)" >&2
		fi
		return 1
	fi
	# -g keeps the name section (function names in traps and stack dumps).
	# In current Binaryen --table64-lowering is an alias of --memory64-lowering
	# (which lowers both); giving both is harmless (identical output) and also
	# covers releases where they were separate passes. -O2 then optimizes
	# the lowered module (about 4% smaller and as much faster on shell
	# commands; -O3 was no faster).
	"$wasm_opt" "$k/vmlinux" -g --memory64-lowering --table64-lowering -O2 -o "$k/vmlinux32.wasm.tmp"
	mv "$k/vmlinux32.wasm.tmp" "$k/vmlinux32.wasm"
	echo "kernel (32-bit memory): $k/vmlinux32.wasm ($("$wasm_opt" --version))"
}

# The bundle's SMP options (bundle.mjs): the SMP kernel and the file that
# caches the patch to it (reused while both kernels are the same). Unless
# KW_SMP=1 a kernel that does not match the UP one (another build of the
# tree) is left out with a warning (--smp-optional).
smp_bundle_args() {
	[ "${KW_SMP:-}" != 0 ] || return 0
	if [ -f "$kout_smp/vmlinux32.wasm" ]; then
		printf '%s\n' --smp "$kout_smp/vmlinux32.wasm" --smp-patch "$kout_smp/up.kwpatch"
		[ "${KW_SMP:-}" = 1 ] || echo --smp-optional
	elif [ "${KW_SMP:-}" = 1 ]; then
		echo "bundle: no SMP kernel $kout_smp/vmlinux32.wasm (run '$0 smp'; KW_SMP=1)" >&2
		return 1
	else
		echo "bundle: no SMP kernel ($kout_smp; '$0 smp' builds it), so no SMP patch" >&2
	fi
}

# A single-file kernel (the 32-bit-memory build) with the base initramfs
# (uncompressed: the kernel unpacks it about 10 ms faster, for about 0.75
# MiB more raw bundle; drop --no-gzip to gzip it), its command line, the
# data disk template and the patch to the SMP kernel bundled in custom
# sections; the runtime boots it when given no initrd of its own.
# $1: the bundle's file name (default unkernel.wasm; another name, the
# stats bundle, gets no SMP patch and no web/kernel/ copy).
bundle_base() {
	local name="${1:-unkernel.wasm}" out="$build/bundle" cpio="$base_out/base.cpio" web=1
	if [ -n "${KW_BASE_OUT:-}" ]; then
		out="$base_out" web=
	fi
	[ -f "$cpio" ] || { echo "bundle: no $cpio (run '$0 base')" >&2; return 1; }
	[ -f "$kout/vmlinux32.wasm" ] || { echo "bundle: no $kout/vmlinux32.wasm (run '$0 lower')" >&2; return 1; }
	mkdir -p "$out"
	local dd=() smp=() args tpl="$build/disk/kwdata.kwsparse.gz"
	if [ -f "$tpl" ]; then
		dd=(--datadisk "$tpl")
	else
		echo "warning: no $tpl ('$0 datadisk' needs mke2fs); the bundle has no data disk template" >&2
	fi
	if [ "$name" = unkernel.wasm ]; then
		args="$(smp_bundle_args)" || return 1
		[ -z "$args" ] || mapfile -t smp <<< "$args"
	fi
	node "$root/kernel/tools/bundle.mjs" "$kout/vmlinux32.wasm" "$cpio" -o "$out/$name" \
		--cmdline "console=hvc0 rdinit=/init" --no-gzip "${dd[@]}" "${smp[@]}"
	# The page's dev server runs web/kernel/'s copy (web/scripts/kernel.ts).
	if [ -n "$web" ] && [ "$name" = unkernel.wasm ]; then
		mkdir -p "$root/web/kernel"
		cp "$out/$name" "$root/web/kernel/$name"
	fi
}

# The data disk template: an empty ext4 file system labelled kwdata (4 GiB,
# 4 KiB blocks) as a gzipped kwsparse image (only its non-zero blocks). The
# page copies it into IndexedDB on first use, the CLI's --data creates an
# image file from it, and the guest mounts it at /data; a saved disk is never
# replaced by a newer template.
# The output is reproducible: fixed UUID, hash seed and timestamps, a pinned
# mke2fs.conf (common ext4 host defaults, which kw_defconfig supports),
# inode tables and journal zeroed now.
# The orphan file is 32 KiB (8 blocks, ~8000 slots; the default for 4 GiB is
# 1 MiB): the kernel reads it one block at a time at every mount, and on the
# page each read was an IndexedDB round trip.
DATADISK_UUID=6b776461-7461-4000-8000-000000000001
DATADISK_HASH_SEED=6b776461-7461-4000-8000-000000000002
DATADISK_EPOCH=1767225600   # 2026-01-01T00:00:00Z
build_datadisk() {
	local out="$build/disk" mke2fs e2fsck
	mke2fs="$(PATH="$PATH:/usr/sbin:/sbin" command -v mke2fs || true)"
	e2fsck="$(PATH="$PATH:/usr/sbin:/sbin" command -v e2fsck || true)"
	if [ -z "$mke2fs" ]; then
		echo "warning: no mke2fs (e2fsprogs); no data disk template" >&2
		return 1
	fi
	mkdir -p "$out"
	local img="$out/kwdata.ext4.tmp" conf="$out/kwdata-mke2fs.conf.tmp"
	printf '%s\n' '[defaults]' \
		'	base_features = sparse_super,large_file,filetype,resize_inode,dir_index,ext_attr' \
		'	default_mntopts = acl,user_xattr' \
		'	enable_periodic_fsck = 0' \
		'	blocksize = 4096' \
		'	inode_size = 256' \
		'	inode_ratio = 16384' \
		'[fs_types]' \
		'	ext4 = {' \
		'		features = has_journal,extent,huge_file,flex_bg,metadata_csum,metadata_csum_seed,64bit,dir_nlink,extra_isize,orphan_file' \
		'	}' > "$conf"
	rm -f "$img"
	truncate -s 4G "$img"   # sparse; removed below
	MKE2FS_CONFIG="$conf" E2FSPROGS_FAKE_TIME="$DATADISK_EPOCH" SOURCE_DATE_EPOCH="$DATADISK_EPOCH" \
		"$mke2fs" -q -F -t ext4 -b 4096 -L kwdata -U "$DATADISK_UUID" -m 0 -J size=8 \
		-E "hash_seed=$DATADISK_HASH_SEED,lazy_itable_init=0,lazy_journal_init=0,root_owner=0:0,orphan_file_size=32K" "$img"
	if [ -n "$e2fsck" ]; then
		E2FSPROGS_FAKE_TIME="$DATADISK_EPOCH" "$e2fsck" -fn "$img" >/dev/null 2>&1 || { "$e2fsck" -fn "$img"; rm -f "$img" "$conf"; exit 1; }
	fi
	node "$root/kernel/tools/kwsparse.mjs" encode "$img" -o "$out/kwdata.kwsparse.gz"
	rm -f "$img" "$conf"
}
# After a kernel rebuild: keep the bundle (the default of the CLI, the SDK
# and the page) in step when the base initramfs exists, and with it the
# ABI and base id in distros.json when there are distro images.
refresh_bundle() {
	[ -f "$base_out/base.cpio" ] && [ -f "$kout/vmlinux32.wasm" ] || return 0
	bundle_base
	refresh_index
}

# distros.json (guest/build.sh index), when there are distro images and the
# bundle and the images are both the main outputs or both elsewhere
# (KW_BASE_OUT and KW_DISTRO_OUT), so a build beside the main outputs does
# not rewrite the main index.
refresh_index() {
	[ -z "${KW_BASE_OUT:-}" ] && [ -z "${KW_DISTRO_OUT:-}" ] ||
		{ [ -n "${KW_BASE_OUT:-}" ] && [ -n "${KW_DISTRO_OUT:-}" ]; } || return 0
	compgen -G "$distro_out/*.id" >/dev/null || return 0
	"$root/guest/build.sh" index || echo "warning: distros.json in $distro_out not updated" >&2
}

case "$what" in
toolchain) build_toolchain ;;
binaryen) fetch_binaryen ;;
kernel) build_kernel up; refresh_bundle ;;
smp) build_kernel smp; refresh_bundle ;;
lower)
	lower_kernel "$kout"
	if [ -f "$kout_smp/vmlinux" ]; then lower_kernel "$kout_smp"; fi
	refresh_bundle
	;;
datadisk) build_datadisk; refresh_bundle ;;
base) "$root/guest/build.sh" base; bundle_base; refresh_index ;;
distro) shift; "$root/guest/build.sh" distro "$@" ;;   # <name>.{erofs,ext4,id}, distros.json
stats)
	KWEMU_STATS=1
	kout="${KOUT:-$build/kernel-stats}"
	build_kernel up
	bundle_base unkernel-stats.wasm
	;;
all)
	build_kernel up
	if [ "${KW_SMP:-}" != 0 ]; then
		build_kernel smp
		KW_SMP=1   # so the bundle must carry the patch
	fi
	build_datadisk || true   # without mke2fs: a bundle without the data disk
	"$root/guest/build.sh" base
	bundle_base
	"$root/guest/build.sh" distro   # every distro, then distros.json
	;;
*) echo "usage: $0 [toolchain|binaryen|kernel|smp|lower|datadisk|base|distro|stats|all]" >&2; exit 2 ;;
esac
