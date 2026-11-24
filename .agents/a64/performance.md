# A64 performance

Numbers, what they rest on, and what was tried. All on an i7-10700K
(16 threads) with Node 24.22.1 unless said. Single runs on a busy machine
vary by up to 20%, and the first command after boot most (V8 is still
optimising the kernel): compare interleaved medians only, and give
machine, date and command with any number. The ISA-neutral core's numbers
and rejected designs are in kwemu.md.

## Measuring

- **Guest MIPS**: `node test/kwemu-bench.mjs --ref --reps 5 --median`
  (the A64 guests `test/guest/a64/bench.c` and `test/guest/kbench.c` modes, native
  and wasm64, tier and reference; `--wasm-only`). The guests are built
  with `-fno-vectorize`, so `fp` is scalar FP.
- **Alpine**: `test/guest-bench.sh` (20 apk and shell commands timed in the
  guest from /proc/uptime, 10 ms steps; its header has the command line),
  boots interleaved, medians of 5. Node rows: a data disk with Node 24 and
  npm 11, `--mem 1024 --snapshot` (an empty npm cache each boot), medians
  of 3.
- **Debian with Node, Bun and Claude Code**: a data disk
  (`vendor/build/profile/debian-node.img`, gitignored) with Node 24.22.3
  and npm from nodejs.org, Bun 1.4.5 and the native Claude Code 2.1.329 (a
  Bun executable) installed for the user, and a host copy of its root in
  `vendor/build/profile/root` for `--profile-root`; `node js/cli.ts
  --distro debian --data vendor/build/profile/debian-node.img --snapshot
  --mem 1024`. All three are non-PIE and run with no illegal instruction.
  Workloads (2026-11-21; user instructions per run, then the median wall
  time of a later run, UP bundle inline): `claude --help` 441 M, 2.48 s;
  `npm --version` 310-370 M, 2.28 s (3.15 s on the first run); `bun
  cpu.js 150` (a numeric, string, object, Map and sort mix) 1.1 G, 2.87 s;
  on 2 CPUs with the 64K ring: `claude --version` 12.8 M, 0.115 s; `bun
  build` of a 0.5 MB TypeScript file 144 M, 0.66 s. Later runs of the same
  binary reuse code compiled by earlier processes (Tenured ring), so
  report first and later runs apart. The A/B numbers below are SDK boots
  (`createKernel` inline, the disk with `snapshot: true`), one per variant
  and workload, timing 3-5 `vm.exec` runs of the command each.
- **Node, Bun and Claude Code in one script**: `node test/app-bench.mjs
  [--rounds N] [--cpus N] [--stats] [NAME=]BUNDLE.wasm[,VAR=VALUE]...`
  boots Debian on that disk (`--snapshot --no-net`, so runs share it and
  fetch nothing) once per bundle and round, the order rotated, and runs
  `test/app-bench.sh` from a mount: `claude --help`, `npm --version`, `bun
  cpu.js 150`, `node cpu.js 40`, `node -e 0`, `claude --version` x 5 and
  `bun build` of a generated 0.5 MB TypeScript file, three times each, then
  one mixed pass over claude, npm and bun. It prints the median first and
  later run per command with the difference to the first bundle; a boot
  takes about a minute. `test/guest/app/cpu.js` is not the `cpu.js` of the
  numbers above. `,ASLR=0` (or another variable of the guest script) makes
  a variant of the same bundle. With `--stats` (a stats bundle) the guest
  powers off at the end and each boot's output, with the counters of the
  whole boot, goes to `app-bench-NAME-ROUND.log`. Look at the host's load
  first (`uptime`): with about six other busy cores the same bundle
  differed from itself by 14-68% per row (2026-11-21), while its counters
  stayed within 3%; on a quiet host rows spread 3-5% (`node cpu.js` first
  runs more).
- **Counters**: a `-Dkwemu-stats` kernel (`kernel/build.sh stats`, CLI
  `--stats`, or `kw_debug_stats` per window: kwemu.md, Measuring). The
  A64 tier adds `tier.Ax` in JitStats.hb_gen (interpreted instructions by
  why they were not compiled: never compiled, counting down, the tail
  after a hand-back; hand-backs by kind; countdown progress lost; generic
  hand-backs and executions by class, `tier.genClass`), `tier.Ar` in the
  tail of Stats.op_hist (nursery resets and what was live, tenured blocks,
  decodes by what the table way held, countdown taken over), `tier.fpForm`
  (generic executions by FP form), `Jx.sync_site` (where NZCV is
  materialised, counted in the generated code), `Jx.free_why` (modules
  freed by reason, `jc.Why`; the CLI's `[kwemu-free]` line), and generic ops by
  instruction word (`kwemu.countGenWord`, `JitStats.gen_words`: 256
  entries of key = word with Rd and Rn cleared, executions, calls from
  compiled code; `KwemuStats.words` from word 501 on; disassemble the
  keys with llvm-mc).
- **Counter traps**: all counters run from boot. `gen_words` fills up
  during the boot, so in a later window about half of the generic ops land
  in the last entry (its key stays 0); the class totals (`tier.genClass`)
  are complete. `Ar.heat_kept` re-adds a block's whole progress at every
  re-decode, so it is a running stock, not a flow: do not compare it with
  `Ax.lost_drop`. Two losses of progress are not counted: `victim()`
  halving the surviving way's progress on a conflict eviction, and
  `jc.evict` resetting a compiled block to the full threshold
  (`Ar.ten_evicted_compiled` counts those blocks, not what they lose).
- **One guest command**: with the SDK, take `vm.stats().kwemu` (and
  `stats().jit` for compile time and bytes) before and after
  `vm.exec(...)` on a stats bundle, and subtract word by word. Host time
  for the same window: `node:inspector`'s `Profiler.start`/`stop` around
  the exec. Pre-install big programs on a data disk opened with
  `openDisk(file, { snapshot: true })` so each boot skips the install.
  `claude -p` (no valid key) is not repeatable (4.5-12 G instructions per
  run); `claude --help` is (441 M), so use it for A/B comparisons, with 8
  or more interleaved rounds to resolve 3%.
- **Guest profile**: `--profile FILE` (with `--cpus 2` or more for time
  samples, `--profile-root DIR` for symbols; kwemu.md, Measuring): where
  guest user time goes by file and offset over every process, and by
  command, process and pc, against instruction samples at the same keys;
  a page of a file or a symbol whose time share is well above its
  instruction share is slow per instruction (interpreted, a hand-back, a
  slow path). For one command, take `vm.profile()` before and after it and
  subtract the counts.
- **Host profile**: `node --cpu-prof` of the CLI; it stops at wasm
  functions, and V8's first-call compile of JIT modules shows as
  `(program)`. In such breakdowns `decode.exec` is the reference
  interpreter running generic ops, not decoding.
- **Host counters**: `perf stat`/`perf record` with `:u` events of `node
  --perf-basic-prof js/cli.ts ...` give cycles, instructions and misses per
  kernel function (perf 7.3.3; the host needs
  `kernel.perf_event_paranoid` 1 or lower; no PEBS events in a container).
  Window them with `perf record -D -1 --control fifo:CTL,ACK` around the
  command.

## Current numbers

**Tier vs reference** (2026-11-17, guest MIPS, `kwemu-bench.mjs`):

| benchmark | Minsns | native ref | native tier | wasm64 ref | wasm64 tier |
| --- | ---: | ---: | ---: | ---: | ---: |
| sieve+fib | 99.7 | 71.3 | 525.7 | 45.2 | 274.1 |
| mem | 65.3 | 68.1 | 522.4 | 42.9 | 288.0 |
| fib | 25.6 | 67.5 | 565.0 | 42.2 | 295.5 |
| fp | 136.0 | 57.1 | 151.5 | 35.8 | 96.6 |
| sha | 171.9 | 71.8 | 547.5 | 47.4 | 284.4 |
| interp | 175.2 | 64.6 | 406.5 | 40.5 | 246.8 |

On the image the tier was 3.3-4.9x the reference loop (`apk search` 1.14
against 4.87 s, `seq 100000 | sort -r` 6.57 against 32.14).

**JIT** (2026-11-18, `kwemu-harness-jit.wasm` at the default threshold,
the same guests, medians of 5): sieve+fib 1204 MIPS (memory32 1303), mem
1164 (1321), fib 804 (1024), fp 98 (106), sha 1748 (1952), interp 1184
(1364). A register-only loop guest ran 1965 MIPS with lazy NZCV against
1277 with NZCV packed after every producer. Modules average 1-1.4 KiB
and take 0.1-0.3 ms each to compile and install.

**7-Zip LZMA** (2026-11-23, i7-10700K, UP bundle, the official static
arm64 7-Zip 26.04 `7zzs b -mmt1 -md22` on Alpine, `--mem 1024`, 3 boots
per bundle interleaved, medians): total rating 780 MIPS (774-793;
compress 463, decompress 1097), against 677 (658-689) for the bundle
before the changes below in the same session; native x86-64 7-Zip 26.04
rates about 5800 (`7z b -mmt1`), qemu-aarch64 user mode 1943. In an
earlier session (the same build without eager NZCV in guests, which
measured the same: 780): 797 against 679; with a 16 KiB emit
buffer, no growth towards the region's own page and no self-loop guests
it was 716, and 679 before `noteExit` tested the closed bit inline; the
buffer is the gain (own-page growth alone: 707). Stats bundle: 27.9 G
instructions, 98.7% compiled, 629 M entries into compiled code (823 M
with 16 KiB), 23.4 M hand-backs (data-TLB misses: the match finder reads
57 MB at random), 176 M entries into self-loop modules, 421 M after exits
from closed regions (kwemu.md, Next steps); 126 modules, 56 ms compiling
1407 KiB. Host `perf` of the 679 MIPS build: about 62% of the time in
compiled modules, 23% in `run`, `enter` and `noteHot`, 6% in the decoded
tier and 4% in the MMU's slow paths; a data-TLB check is about 22 wasm
ops and half the time of the match finder's tree loop. The 32 KiB
buffer, own-page growth and self-loop guests against the 716 MIPS build
on the profile disk (`test/app-bench.mjs`, 6 boots, 1 CPU): later runs
of `claude --help` -1.2%, `npm --version` -0.9%, bun cpu.js -1.4%, bun
build -5.7%, the mixed sequence +0.8% (the buffer alone: npm +1.2%,
mixed +2.3%); the Alpine 20-row sum (2 boots) 22.1-23.0 against
23.2-24.3 s, no apk or ash row slower; hot guests on
`kwemu-harness-jit.wasm` within -3% to +1% MIPS, except fib: 915 against
643 MIPS (9 interleaved runs, every run of the new build at or above the
old median).

**Alpine apk and shell** (2026-11-18, guest seconds, medians of 5, the
riscv64 guest's last bundle for scale; A64 with generic calls and inline
forms, before the op-arena and later changes, which took the 20-row sum
from 24.6 to 22.0 s):

| command | riscv64 | A64 |
| --- | ---: | ---: |
| apk update | 1.15 | 1.29 |
| apk search | 0.69 | 0.82 |
| apk info -v | 0.61 | 0.67 |
| apk add jq | 1.19 | 1.26 |
| apk add python3 | 3.53 | 4.06 |
| ash loop, 30000 iterations | 1.86 | 2.04 |
| `seq 100000 \| sort -r` | 2.82 | 2.82 |
| `seq 250000 \| gzip \| gunzip` | 2.19 | 1.97 |

apk stays 6-25% behind riscv64 although it runs about 12% fewer
instructions. Compiled share (stats kernel): apk update, search, info and
add jq 76-86%; apk add git and python3, ash, sort, gzip 93-98%; the rest
is blocks counting down to the threshold, hand-backs (data-TLB misses)
0.1-0.5%.

**Node and Bun** (2026-11-18, UP bundle, guest seconds, cold and warm
runs): `npm --version` 3.91 and 3.54, `npx --version` 3.53 and 3.55, `npx
--yes cowsay hi` 38.0 and 14.6, `node -e 0` 0.69 and 0.64, a JSON loop
4.12; Bun `bun -e` x10 0.65, `bun run t.ts` x5 0.79. SMP kernel with
`--cpus 2`: `npm --version` 3.47 and 2.99. Compiled share: npm 44%, `node
-e 0` 63%, V8 loops 80-92%.

`test/app-bench.mjs` (2026-11-21, the profile disk, quiet host, ms,
medians of 5 boots on one CPU and 4 on two, first / later runs):

| command | 1 CPU | 2 CPUs |
| --- | ---: | ---: |
| `claude --help` | 3196 / 2502 | 3231 / 2622 |
| `npm --version` | 3225 / 2388 | 2728 / 2033 |
| `bun cpu.js 150` | 3329 / 3148 | 1961 / 1603 |
| `node cpu.js 40` | 3566 / 3049 | 2075 / 2063 |
| `node -e 0` | 385 / 348 | 343 / 324 |
| `claude --version` x 5 | 585 / 539 | 615 / 581 |
| `bun build` | 947 / 753 | 946 / 856 |
| mixed pass | 13150 | 11747 |

**OpenSSL** (2026-11-18, UP bundle, libcrypto built with gcc `-O2`; the
image now has Alpine's `-Os` build, whose NEON and crypto paths are the
same assembly; `openssl speed -evp ALG -bytes 16384 -seconds 2`, MB/s, medians of 3 boots;
"integer" is `OPENSSL_armcap=0`, "NEON + crypto" what HWCAP selects on a
SIMD host, "no SIMD" the same code as interpreter calls):

| algorithm | integer | NEON + crypto | NEON + crypto, no SIMD |
| --- | ---: | ---: | ---: |
| aes-128-gcm | 23.8 | 98.8 | 13.9 |
| aes-256-gcm | 20.5 | 79.5 | 11.4 |
| aes-256-ctr | 25.0 | 137.2 | 14.3 |
| aes-128-cbc | 42.5 | 189.7 | 23.1 |
| chacha20-poly1305 | 167.9 | 203.4 | 4.8 |
| sha256 | 59.4 | 157.0 | 26.6 |
| sha512 | 130.8 | 216.9 | 9.8 |
| sha1 | 158.4 | 323.6 | 30.9 |

A host without wasm SIMD is 2-13x slower than the integer paths would be;
it could boot with `kw.isa=-sha512` or set `OPENSSL_armcap=0` (status.md).

**Tenured ring** (`ten_default` 128K ops beside a 320K-op nursery,
`KW_CPU_SIZE` 9 MiB). The 64K ring, which is FIFO, could not hold one
run's compiled set of a Bun-based program, so every run compiled again;
non-PIE binaries reuse what the ring keeps (Where the time goes, Compiled
code across processes). Taking the 128K ring out of a 384K-op arena (a
256K nursery) made npm slower, so the arena grew by 1 MiB.
Measured 2026-11-21 on the Debian profile disk (Measuring), UP bundle
inline, 8 boots per variant with bundles rotated per round, medians,
first / later runs against a 64K ring and a 320K nursery (8 MiB):

| Nursery (`KW_CPU_SIZE`) | `claude --help` | `npm --version` | `bun cpu.js 150` | mixed sequence | compiles per later claude run |
| --- | --- | --- | --- | --- | --- |
| 256K (8 MiB) | -1.8% / -14.9% | +2.1% / +3.3% | -1.4% / -4.7% | -2.2% | 448 to 97 |
| 320K (9 MiB, the default) | -1.2% / -14.6% | +1.6% / -0.6% | -2.4% / -3.5% | -3.6% | 448 to 98 |
| 384K (10 MiB) | -2.4% / -15.4% | -1.5% / -2.0% | -2.8% / -2.3% | -3.7% | 448 to 101 |
| 512K (12 MiB) | -4.2% / -15.9% | -2.6% / -2.0% | -2.0% / -0.3% | -4.8% | 448 to 96 |

Baseline spread: first runs about ±5%, later runs ±3-5% (claude
2796-3072 ms, npm 2241-2403). The mixed sequence is one boot of claude,
npm, claude, npm, claude, npm (17.09 s with the 64K ring); with a 320K nursery the
steps compile 426, 298, 146, 77, 336, 60 blocks against 430, 296, 437,
272, 437, 275: an npm run between two claude runs still pushes part of
claude's code out. On 2 CPUs (5 boots): claude -2.4% / -17.8% with a
320K nursery (256K: +0.9% / -16.4%), npm -0.6% / -3.4% (256K: +2.2% /
-2.9%), the mixed sequence -4.2% (256K: -4.8%; 512K: -8.3%). Alpine (5
boots): the 20-row sum +0.8% with a 320K nursery (256K +1.0%, 384K +2.3%,
512K +2.9%), gzip +3.3% (ranges overlapping), OpenSSL -2.8% to +1.1%;
`kwemu-bench.mjs` within -1% to +4%. Boot time (448-452 ms to the first
command UP, 662-672 ms on 2 CPUs) and the host's RSS do not change; each
MiB of `KW_CPU_SIZE` comes out of guest RAM on every CPU (MemTotal at
`--mem 1024`: 1022964 KiB with 8 MiB, 1021940 with 9 MiB, 1018868 with 12
MiB; twice that loss on 2 CPUs). Stats bundle, later npm runs: 41 nursery
resets with the 320K nursery, 39-42 with the 64K ring, 57-59 with 256K (decodes
670K, 651-679K, 752-762K; re-decodes 51%, 51%, 57%); the mixed sequence
evicts 78-706 compiled blocks per step after the first.

**Sizes**: `kwemu.o` (wasm64, ReleaseFast) 234 KB, 199.6 KB with
`-Dkwemu-a64-ref`; `kwemu-jit.o` about 600 KB.

## Where the time goes (2026-11-18 unless dated)

- **node's cold code.** Host profile of three `npm --version` and an `npx
  --version` with the boot: `runOps` 40.8%, `kw_run`'s loop 14.4%,
  compiled code 14.4%, decode 10.4%, lookupSlow 2.3%, validate 2.0%,
  `jitcore.enter` 1.4%, generic ops in the tier about 1.5%. npm runs 56% of
  its instructions outside compiled code and decodes once per ~480
  instructions; of its 1.0M decodes per command 0.46M are first decodes of
  the process (ops hold absolute addresses, so a PIE binary at a new base
  decodes again), 0.58M decodes again after nursery resets. Exclusives
  (1-10M per command) and AdvSIMD (1-8M) in node run mostly interpreted,
  in cold code.
- **Node, Bun and Claude Code on Debian** (2026-11-20, the profile disk,
  Measuring; 64-instruction blocks and the 64K ring). Interpreted instructions are almost all blocks counting
  down to the threshold: `claude --help` 40%, `npm --version` 50%, `bun
  cpu.js` 12%, `bun build` 13-40%; at least 28%, 47% and 7.4% (claude,
  npm, bun cpu.js) are in blocks that never reach 2^17 in the run; blocks
  never compiled 0%, tails after a hand-back 0.4-1.6%. The profiles are
  flat: the 50 hottest 4 KiB pages hold 53% of claude's time and 29% of
  npm's. Time by tier (time samples, 2 CPUs), decoded against compiled:
  claude 63/35, npm 76/23, bun cpu.js 34/64, bun build 49/50; kernel time
  is 2-4% of busy time (16-20% for tiny commands such as `claude
  --version`). A guest JIT's own (anonymous) code is about 1% of claude's
  time and 15% of bun cpu.js's (for 23% of its instructions), mostly
  compiled. Hand-backs are data-TLB misses and stores into code pages
  (about 75% loads, 10% stores, 8% exclusives and LSE). Generic ops are
  0.1-1.6% of instructions; the most frequent words are `dc zva`, `movi
  v0.2d, #0`, `fmov` between X and D, `ldar`, `casab`/`caslb`, `ldadd(al)`,
  `scvtf` and `fcmp` in Bun and claude, `ldar`/`stlr`, `pmull`/`pmull2`,
  `casl` and `swpl` in npm. The 1024 JIT slots never fill and the tenured
  ring never resets. Two thirds of the modules are `shortened` (the first
  emit overflowed the emit buffer, 16 KiB in that measurement, because
  `jc.candidate` takes any decoded block not compiled yet as a member;
  those members do run: Rejected designs). With the 128K ring and 320K nursery (stats bundle,
  2026-11-21, later runs of `claude --help` in one boot; the 64K ring
  in parentheses): 70-72% compiled (54-56%), 25-28% counting down
  (42-44%), 78-133 compiles (457-477) taking 30-86 ms (162-198), no
  compiled block evicted from the ring (about 1500), 23-25 nursery resets
  (25-27), and 55-57% of decodes re-decode blocks a reset discarded
  (56-60%).
- **Why compiled modules are freed** (2026-11-21, stats bundle, one
  `test/app-bench.mjs` boot each: 9.7-10.1 G instructions, 9.0-9.8 M
  decodes, about 650-700 nursery resets). The tenured ring and the
  1024-entry slot pool are two limits one behind the other, and neither is
  what keeps a third of the instructions out of compiled code:

  | | 128K ring, 1024 slots | 512K ring (15 MiB) | 512K ring, 4096 slots (16 MiB) |
  | --- | ---: | ---: | ---: |
  | compiled share of instructions | 63.4% | 63.5% | 65.1% |
  | modules compiled | 6531 | 5867 | 5504 |
  | most live at once | 624 | 900 | 1925 |
  | freed: the ring made room | 3322 | 0 | 623 |
  | freed: the pool's clock | 0 | 2307 | 0 |
  | freed: region compiled again with another block | 2425 | 2375 | 2422 |
  | freed: other (re-decoded, table entry replaced) | 260 | 327 | 596 |

  A larger ring moves the evictions to the slot pool; with both raised
  they nearly stop and the compiled share gains 1.7 points, for no time
  (Rejected designs). About 2400 frees per boot were regions growing
  (before warm page members, next item), which no cache size removes.
  Compiling was 2.6-2.7 s of a boot of about 80 s.
- **Regions compiled again** (2026-11-21, stats bundle, one
  `test/app-bench.mjs` boot each). Of the grows by a hot block of the
  region's own page (`findRegion`), 90% added a block no member branches
  to (entered from other pages, by returns or indirect branches), so the
  breadth-first search could not have found it; more than two thirds came more
  than 10 M instructions after the region's last compile, so batching
  grows in time would catch few; half were repeat grows of one region
  (some 8 times or more); 70% were regions of up to 5 members. So a region
  takes the blocks of its page that have counted a quarter of the
  threshold (`jc.pageWarm`, kwemu.md, Regions), and exit growth waits for
  32768 exits per KiB of module (8192 before):

  | | before | warm at 1/4 | warm at 1/8 | exits x4 | both (current) |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | modules compiled | 6526-6760 | 5362-5373 | 5532-5538 | 6143 | 4873-4877 |
  | freed: grown by a block of its page | 1803-1964 | 781-788 | 773-778 | 1877 | 764-803 |
  | freed: grown along exits | 569-612 | 565-629 | 595-600 | 188 | 163-184 |
  | freed: the ring made room | 3325-3398 | 3239-3294 | 3463-3493 | 3307 | 3157-3213 |
  | freed: other | 275-290 | 218-231 | 197-203 | 238 | 223-238 |
  | compiled share of instructions | 63.3-64.0% | 64.4-64.5% | 65.5-65.6% | 63.6% | 63.8-64.5% |
  | module bytes compiled (MiB) | 49.7-51.6 | 42.9-43.2 | 45.7-46.2 | 47.5 | 39.3-39.8 |

  Compile time fell 21% (2262 to 1789 ms in a pair of boots side by
  side). Warm at 1/2: 5725 modules; at 1/32: 6136 (members fill the ring:
  4210 ring frees); any decoded block of the page: 7384 and 62.6%
  compiled. Timing, quiet host (load 1.3-2.4), 1 CPU, 5 boots, first /
  later runs: `claude --help` -3.4% / -3.0%, npm +0.3% / -1.6%, `bun
  cpu.js` -0.6% / -3.5%, `bun build` -3.6% / -2.0%, the mixed pass -1.7%
  (ranges apart); `node cpu.js` and `node -e 0` moved ±7-15% both ways
  (their usual spread). 2 CPUs, 6 boots (load 1.6-3.4): claude -2.6% /
  -8.8%, npm -3.2% / -3.6%, `bun cpu.js` -13.4% / -3.5%, `node cpu.js`
  0.0% / -1.2%, `bun build` -4.4% / -2.0%, the mixed pass -2.9%.
- **Compiled code across processes.** node, bun and claude are non-PIE,
  so a later process maps their code at the same addresses and its blocks
  revalidate: code compiled by an earlier process runs again if the
  tenured ring still holds it (Tenured ring). On SMP each
  CPU has its own code cache (kwemu.md, JIT on several CPUs): later npm
  runs compiled 99-365 blocks on 2 CPUs against 48-59 on one (64K ring).
- **Per-unit costs** (2026-11-20; `perf` `:u`, `node --perf-basic-prof`,
  UP bundle inline with 64-instruction blocks and the 64K ring, windows
  of 3 runs after a warm-up; Measuring). The
  decoded tier (`runOps`) per guest instruction: 25-30 cycles, 49-54 host
  instructions, 0.30-0.39 branch mispredicts (almost all at its one
  dispatch jump), 0.13 L1 and 0.04-0.055 L2 load misses. A hot shell loop
  costs the same (25.7 cycles, 48.8 instructions, 0.37 mispredicts) as
  cold claude and npm code: in the kernel decoded code costs the same hot
  or cold. The dispatch head is 14 host instructions, the simplest
  handlers about 25 more. `kw_run`'s loop (JIT on): 71-74 cycles, 114-117
  instructions and about 0.4 mispredicts per iteration, stalling on the
  block-table load and the exec-TLB generation load. A decode: 2100-3640
  cycles, 4400-7860 host instructions (about 300 per guest instruction).
  Compiled modules: 10-12 cycles, 17 host instructions per guest
  instruction, about 2.4x cheaper than decoded (time share against
  instruction share from the guest profile: 2.5-3.6x). Compiling is 4.6%
  of a claude run (`jit.compileMs` 142 of 3113 ms). V8's worker threads
  take 36% of the process's cycles on `claude --help` and 13.5% on npm
  with the JIT on (unsymbolized; likely tier-up of the modules), invisible
  in wall time on an idle 16-thread host. The wasm64 harness's hot loops
  (17.6-21.3 cycles, 69-73 host instructions, 0.007-0.10 mispredicts per
  guest instruction, whole process) do not compare with these.
- **apk.** Outside compiled code nearly all is blocks counting down
  (13-27% of instructions): about half the warm-up of blocks that do get
  compiled (compiles x 2^17), the rest blocks that never reach the
  threshold before a nursery reset. Host profile of apk search and info:
  compiled code 30%, `runOps` 29%, `kw_run`'s loop 17%, `jitcore.enter` 3%,
  `noteHot` 2%, module compiles 2.5%, decode 1%.
- **Exit costs**, priced by doubling one piece in a throwaway build (7
  boots interleaved, 6 apk/shell rows): NZCV materialisation +3.0%, the
  module prologue's register loads +5.0%, `run`'s entry path (a second
  `lookupIn`, `ready` and an indirect call) +5.4% (sort +11%).
- **NZCV materialisation sites** (`Jx.sync_site`, per command): exit or
  hand-back / back edge / member transfer / eager: `seq | sort` 9.0M,
  3.8M, 17.3M, 54.4M; gzip 16.2M, 26.4M, 8.9M, 14.7M; apk add python3
  29.4M, 31.4M, 14.8M, 9.2M. The eager site after a member's last producer
  is the largest.
- **Generic calls left** from compiled code: FMADD off its fast path
  (busybox `seq`, measured when every FMADD was a call: 0.25M in the gzip
  row), OpenSSL's LD4/ST4 (11K per second of
  chacha20-poly1305); exclusive pairs and CASP never ran in any workload.
- One stats boot showed an ash loop at 82% compiled with 12% of its
  instructions in tails after data-TLB misses: the direct-mapped data TLB
  aliases hot pages in some address layouts; other boots do not.

## Next levers (ranked, 2026-11-20)

Node, Bun and Claude Code (Where the time goes), in this order:

1. **Measure again with the 128K ring**: V8's worker
   threads' share of cycles and the decode share (`perf`, Measuring).
2. **Fewer compiles of the same code**: about 950 of the 4900 compiles of
   a `test/app-bench.mjs` boot are regions compiled again to add a block,
   down from 2400 of 6500 (Where the time goes, Regions compiled again);
   the ring's 3200 frees are the larger group now. More cache does not
   help (Rejected designs: the 512K ring with 4096 slots, the shared op
   store).
3. **Per-CPU code caches on SMP**: each CPU compiles the same code again
   (kwemu.md, JIT on several CPUs, says what sharing needs); V8 does not
   reuse a compile of the same bytes in another thread, so sharing would
   save only kwemu's own gathering and emitting.
4. **A cheaper decoder**, only if decode stays above about 8% of npm's
   time (about 300 host instructions per decoded guest instruction).
5. **Binaryen `-O2` after the 32-bit lowering**: 2-3.5% fewer main-thread
   host instructions on claude and npm (2026-11-20, perf); wall time not
   yet measured on a quiet machine.

Smaller: tier op kinds for LDAR/STLR and LSE (generic ops are 0.1-1.6% of
these programs' instructions). Not worth revisiting: the compile
threshold and heat policy, the block-table size, the interpreter's
dispatch and op density (Rejected designs).

Apk and shell rows:

1. **`run`'s entry path and the region prologue**: about 5% of the
   apk/shell rows each. Lighter prologues need a region-wide "written
   before every exit" analysis (loading only the entered member's
   registers was slower; kwemu.md, Rejected designs).
2. **NZCV materialisation**: about 3%. Carrying lazy state across member
   transfers needs a runtime kind for the checked entry's stop path.

The shared-core levers (bigger regions, self-loop exits, threshold) are in
kwemu.md, Next steps.

## Rejected designs (A64)

Do not retry without a new reason. Dates 2026-11-17/18 unless given; UP
bundle, boots interleaved.

| Idea | Result |
| --- | --- |
| `runOps` inlined into `run` | wasm64: sieve +13%, mem +5%, but sha -9%, interp -7%; a separate function running self-loop passes gets the gains without the losses |
| An op that does not continue handled inside `runOps`' `inline else` body | every leaving kind had its own copy; handling it once after the `switch` made cold code faster (npm 4.23 to 3.91 s, the 20 apk/shell rows 22.75 to 22.18 s) |
| Self-loop pass count as `left / ninsn` per entry | a 64-bit division per entry: sha, interp, fib -6..-9%; `runOps` subtracts per pass |
| Error unions from non-inlined slow paths inside `runOps` | each result slot is a shadow-stack frame slot set up on every call (~50 wasm instructions); plain integer results: mem +7%, interp +4% |
| No cross-CPU invalidation | kwtest's cross-CPU rewrite check ran 751695 of 877496 calls stale (a64/tier.md, Coherence) |
| JIT threshold 2^15 or 2^13 | 2^15 within noise; 2^13 apk rows 5-25% slower: extra compiles (~0.3 ms each) cost more than they move into compiled code. With countdowns kept across resets 2^15 made npm 5.93 against 4.86 s. 2^16 with the 128K ring and 32-instruction blocks (2026-11-20, the profile disk, 6 boots, medians): `claude --help` first runs +1.6% and later runs +4.1%, npm +2.5% and +0.8%, bun cpu.js +1.3% and -0.4%; twice the compiles per later claude run (171 against 88) |
| Region members only with a quarter of the threshold counted (a heat test in `jc.candidate`), alone or at threshold 2^16; `region_max` 8 | Claude Code `--help`, 8 rounds (2026-11-19): 3.55, 3.68 and 3.57 s against 3.56. Alone: `shortened` 292 to 75 and members 2059 to 1556, but compiled share 54.5% to 49.8% (the cold members did run). At 2^16: 61.8% compiled, 898 compiles, compile time 148 to 264 ms |
| V8 without Liftoff (`node --no-liftoff`) | Claude Code `--help` 4.7 against 3.3 s, about 3.5 ms more per extra compile (2026-11-19) |
| A heat table keyed by host address (short countdown for code compiled before, also in an earlier process) | compiled share +2..+8 points on apk, but twice the compiles; time equal at best, worse with shorter countdowns; remembering counting blocks too thrashed the table |
| Countdowns kept across arena resets with alternating-way replacement | npm 6.04 against 5.22 s: conflict evictions lost progress and evicted members failed checked entries; replacing the way with less progress fixed it |
| A tenured part that frees every module when full | short apk commands 10-15% slower (~450 modules freed per command) |
| `jc.enter` inlined into `run` | within noise |
| Exec TLB of 1024 sets instead of 256 | npm exec-TLB walks 160K to 30K and revalidations 1.3M to 0.5M per command, time within noise: a revalidation is cheap |
| A nursery beyond 320K with the 128K ring: 384K (`KW_CPU_SIZE` 10 MiB) or 512K (12 MiB); earlier 16 MiB (64K blocks, a 704K nursery) | 2026-11-21, against the 320K nursery (Tenured ring; UP 8 boots, 2 CPUs 5): `claude --help` later runs -1.0% and -1.5%, npm later runs -1.4% and -1.4%, the mixed sequence -0.1% and -1.2% (on 2 CPUs 512K -4.3%), bun cpu.js later runs +1.2% and +3.3%, the Alpine sum +1.5% and +2.0%: within noise or mixed, for 1 and 3 MiB more guest RAM per CPU. 16 MiB (2026-11-18/19, Alpine's node, single runs, before the ring change): npm decodes 880K to 565K, time within noise, `node -e 0` slower |
| A 512K-op tenured ring with 4096 JIT slots (`KW_CPU_SIZE` 16 MiB), so that compiled code is almost never evicted (2026-11-21, `test/app-bench.mjs`, quiet host) | no faster, partly slower. One CPU, 5 boots: later runs of `claude --help` +3.0%, npm +4.5%, `bun cpu.js` -2.2%, `bun build` +24.5% (753 to 937 ms, ranges apart), the mixed pass +8.8%. Two CPUs, 4 boots: claude +9.8%, npm +2.1%, the mixed pass -0.1% (ranges overlapping). Compiles 6531 to 5504 per boot, compiled share 63.4% to 65.1%; the 512K ring alone only moves the evictions to the slot pool (Where the time goes, Why compiled modules are freed). Why it is slower is not traced |
| A store of decoded ops keyed by physical page and shared by processes and CPUs, with position-independent ops, in memory from the kernel (no nursery, no ring; "as Rosetta keeps translations per binary"), not built (2026-11-21) | bounded first. Guest ASLR off (`randomize_va_space` 0: libraries and PIE programs at the same addresses in every process, which is what such a store would give) changed nothing on one CPU: 8.916M against 8.909M decodes and 6291 against 6522 compiles per `test/app-bench.mjs` boot, because node, bun and claude are non-PIE and already revalidate. Not evicting compiled code gains no time (the row above), not evicting decoded ops neither (the nursery row above). Persisted translations do not carry over: a wasm module cannot be mapped from a file, and V8 (Node 24.22.1) compiles the same 1.3 KiB module in a second thread as slowly as a new one (62-73 against 70-81 µs, `new WebAssembly.Module`, instantiate and first call). Sharing would also need a replacement for the per-CPU exec-TLB generations and code-page write marks, a compile window that no longer reads only its own `kw_cpu`, and a rule for ops freed while another CPU runs them |
| Chaining interpreted blocks inside `runOps` | the `run` loop is 12% of npm's host time, but every node row got 2-4% slower: the chain code in each branch kind costs more than the returns it saves |
| Shorter blocks: `max_block` 32, 48 or 16 instead of 64 (2026-11-20, UP bundle) | 32 with the 128K ring, the profile disk (6 boots): `claude --help` +0.8% / -15.9% (first / later runs; the ring alone -15.7%), npm -4.9% / -2.8%, bun cpu.js 0.0% / -9.0%, the mixed sequence -4.8%; the Alpine 20-row sum -3.3% and -5.6% in two sessions (gzip -32%, sha256sum +4-6%); but OpenSSL (5 boots, two sessions) chacha20-poly1305 -25%, sha512 -10%, aes-128-gcm -5..-9%, aes-256-ctr -6%. 32 alone (an earlier round, 6 boots): claude +0.9% / -12.1%, npm -3.4% / -1.8%, bun cpu.js -4.3% / -5.0%; hot guests (`kwemu-harness-jit.wasm`) -0.9..+3.7% (noise ±4%). 48 with the ring: OpenSSL chacha20-poly1305 -11%, aes-256-ctr -6%, sha512 -5%, aes-128-gcm -5%, and no gzip gain. 16: claude +10.9% / -2.9%, hot sha -15.8%, interp -6.0%. The OpenSSL losses are not traced; a length rule that does not cut OpenSSL's blocks might keep the gains (untested) |
| Interpreter-loop work for cold code: fewer dispatch mispredicts, denser ops (2026-11-20, perf) | hot and cold code mispredict alike (Where the time goes, Per-unit costs); if every mispredict vanished, at most about 23% of `runOps`; L1/L2 misses on ops bound denser ops below 5% of `runOps` |
| NZCV of hand-back paths through module helper functions | materialisation fell from 31% to 20% of module bytes, but regions took more members up to the buffer: module bytes unchanged, compile time +9%, time within noise |
| Warm page members from 1/8 of the threshold instead of 1/4; closing a region after it was grown twice (2026-11-21, `test/app-bench.mjs`) | 1/8: 65.5% compiled and 5530 modules (1/4: 64.5%, 5370), but later `claude --help` runs +10.1% and +5.0% in two sessions on a busy host (load 5-9), against -1.8% at 1/4. Closing after two grows: 6407 modules against 6620, the rest unchanged (Where the time goes, Regions compiled again) |
