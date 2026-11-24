# Toolchain

## clang plus a patched wasm-ld 22

- clang (21 or newer, 22 tested) and the llvm-* tools come from the
  system. Only `lld` is built (`vendor/build/lld22`), from
  `vendor/src/llvm22`: detached `llvmorg-22.1.8` (tag and commit checked
  after the clone) plus `kernel/patches/llvm/`. `vendor/toolchain/bin`
  links the patched linker together with the system tools.
- The patches: Joel Severin's GNU-ld linker-script support and
  weak-signature fix, forward-ported from LLVM 18 (stock wasm-ld has no
  linker scripts, which the kernel link needs), plus two fixes for
  non-shared memory.
- Why LLVM 22 and not linux-wasm's LLVM 18: clang 20 and later and Zig emit
  table64 `call_indirect` for wasm64, and an LLVM 18 wasm-ld links such
  objects into an invalid module.
- To change wasm-ld, commit in `vendor/src/llvm22`, then:

  ```sh
  kernel/build.sh toolchain        # ninja -C vendor/build/lld22 lld, then relink vendor/toolchain/bin
  rm kernel/patches/llvm/*.patch
  git -C vendor/src/llvm22 format-patch -N -o "$PWD/kernel/patches/llvm" llvmorg-22.1.8..HEAD
  ```

  build.sh decides whether the patches are already applied by looking for
  "linker scripts" in `git log -3`, so keep the subject of patch 0001.
- Kbuild runs everything through `kernel/tools/fake-llvm/llvm-wrapper.py`.

## Binaryen

`kernel/build.sh binaryen` downloads release 133 (checksum pinned) into
`vendor/toolchain/binaryen`. `lower` uses `$WASM_OPT`, then that copy, then
`PATH`, and needs `--table64-lowering`. If none is found and the download
fails, `lower` fails and removes a stale `vmlinux32.wasm`.

## Zig 0.16

The API differs from 0.13-0.15. Examples of all of these are in
`src/emu/harness_native.zig` and `build.zig`:

- `pub fn main(init: std.process.Init)` provides `init.io`, `init.gpa` and
  `init.arena`.
- I/O goes through `std.Io`: `std.Io.File.stdout().writeStreamingAll(io, ...)`,
  `std.Io.Dir.cwd().readFileAlloc(io, path, gpa, .limited(n))`,
  `std.Io.Clock`.
- `std.ArrayList(T)` is unmanaged: initialise it with `.empty` and pass the
  allocator to each call.
- build.zig uses `root_module = b.createModule(...)`,
  `b.addLibrary(.{ .linkage })` and `b.addTranslateC`.
- kwemu is built for wasm64 with cpu `mvp`, so the object needs only
  memory64: no atomics, bulk memory or sign-ext (`-Dkwemu-atomics` adds
  atomics and bulk memory for an SMP kernel).
- The guest programs (kwtest, kwbench, glimmer, kwtty, kw9p, kwvsock,
  kwshm) are built with `zig cc` (`aarch64-linux-musl`, `-mcpu=generic`,
  static); abitest freestanding (`aarch64-linux-none`, `-nostdlib`).
- `zig build test` compares the A64 test guests with `qemu-aarch64`
  (`QEMU_AARCH64=` names another binary) and skips the comparison, with a
  note, when it is missing; `setup.sh --check` reports it as optional.

## Host tools

- `kernel/tools/env.sh` `use_real_host_tools` links the first real ELF
  binary of m4, bc, flex, bison, gcc, clang, cmake, ninja and others into
  `vendor/toolchain/host-bin`, puts that first on `PATH`, and sets `M4`. A
  wrapper script on `PATH` that does not pass stdin through breaks flex
  (its m4 pipe) and `echo $HZ | bc` in the kernel build. On a normal host
  this changes nothing.
  On a host with such a wrapper, running `make` yourself (measuring an
  option, a throwaway `KOUT`) with a changed `.config` regenerates
  `timeconst.h` with `HZ == 0` ("Totally bogus HZ value!"). Put the real
  tools first on `PATH` for such runs.
- Do not hard-code `/usr/bin` paths or home-directory fallbacks.
- `setup.sh` runs only ELF binaries for its version checks, so a wrapper
  that installs packages on first use is never triggered.

## Pinned downloads

The kernel base commit and the LLVM tag and commit are in build.sh, and
so is the SHA-256 sum for Binaryen 133; the guest's (the Alpine 3.24.4 aarch64
minirootfs, Debian, busybox-static, erofs-utils, lz4, zstd) in
`guest/**/pins.sh` (erofs-utils is patched: `guest/tools/erofs-utils-patches/`,
data in tar order and the metadata zone in front, for the distro images'
layout; guest/README.md) (`ALPINE_TARBALL=file` overrides the download);
the Vulkan headers guest Vulkan's ICD builds against in `vk/pins.sh`. wterm (`@wterm/dom`
0.5.10, Apache-2.0) is an npm dependency of `web/`, pinned exactly and
locked in `pnpm-lock.yaml` (see web.md).
