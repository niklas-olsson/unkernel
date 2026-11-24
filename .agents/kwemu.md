# kwemu: MMU, block cache and JIT core

kwemu is the guest CPU, linked into the kernel. The CPU itself is AArch64
(`src/a64`, a64.md). This file covers what lies under it and is
ISA-neutral: `struct kw_cpu`, the page walker and TLBs and the block
cache (`src/emu/kwemu.zig`), the JIT core (`src/emu/jitcore.zig`,
`Jit(I)` over the ISA's emit hooks), shared types and AES/carry-less
primitives (`src/cpu/core.zig`) and the softfloat (`src/cpu/fpu.zig`):
the design, the invariants the tests guard, the numbers behind decisions
and the designs that were rejected. Measurements marked "riscv64 guest"
were taken with the CPU kwemu had before A64 (in git history) on
machinery that is unchanged.

## Sources and outputs

| Path | What |
| --- | --- |
| `src/libkwemu.zig` | library root: exports the A64 C ABI (`src/a64/run.zig`) |
| `src/emu/kwemu.zig` | `Cpu` (struct kw_cpu), page walker and TLBs, the block cache (lookup, validation, code tracking, op arena; generic over the ISA's block hooks), `kw_debug_cpu_of_jit_buf` |
| `src/emu/jitcore.zig` | the JIT core: slot pool, host imports, compile policy, `install` and its emit retries, module skeleton, regions, the compile window, `Emit` helpers, statistics (`Jx`) |
| `src/cpu/core.zig` | `Hart` (traps, exclusive monitor), `Kind`, `Access`, `Error`, `Exit`, `smp`; AES tables (`aes`), carry-less multiply (`bitmanip`) |
| `src/cpu/fpu.zig` | exact softfloat for all rounding modes and flags, host-float fast paths for RNE |
| `src/emu/harness*.zig` | test "kernel" using only the C ABI (native and wasm64; A64 ELFs) |
| `test/kwemu-unit-wasm.mjs` | runs a wasm64 unit-test module against an eager JIT host |
| `test/kwemu-jit-host.mjs` | JS host of the JIT imports, for tests and benchmarks |
| `test/kwemu-bench.mjs` | benchmark table (a64/performance.md) |

`zig build` writes `zig-out/lib/{kwemu.o,libkwemu.a}` (wasm64, cpu `mvp` +
memory64 only, undefined `__stack_pointer`), `zig-out/lib/kwemu-jit.o`,
`zig-out/lib/native/libkwemu.a`, `zig-out/bin/kwemu-harness{,.wasm}`,
`kwemu-harness-jit.wasm`, and the A64 tools and guests.

Build options: `-Dkwemu-jit` (off for plain `zig build`; kernel/build.sh
turns it on), `-Dkwemu-jit-threshold` (2^17), `-Dkwemu-jit-grow` (32768
exits per KiB of module, 0 = never), `-Dkwemu-stats` (counters, the
`kw_debug_stats` export, CLI `--stats`; `kernel/build.sh stats`),
`-Dkwemu-atomics` (a shared-memory kernel), `-Dlib-optimize`
(ReleaseFast), `-Doptimize` (native library and harness), and the A64
test options (a64.md, Tests).

## Interpreter machinery

What every interpreted instruction goes through; what an op is and how a
block is shaped is the ISA's (a64/tier.md).

- **MMU.** Walks Sv48-layout page tables (kw_emu.h; independent of the
  guest ISA) straight out of linear memory and caches fully permitted
  translations in TLBs inside kw_cpu. It never writes PTEs (A = 0, or D =
  0 on a store, raises KW_EV_FAULT), so the kernel flushes on downgrades.
- **Memory fast path.** One compare per access: the entry holds `tag =
  vpn` and `add = host - va`, and the tag is compared against the vpn of
  the access's last byte, so page-straddling accesses take the slow path
  for free (still about 15 wasm instructions per access). Read and write
  TLBs are direct-mapped, 1024 entries each (32 KiB). Against 256 (riscv64
  guest, 2026-11-15): apk, sort, gzip and an ash loop 1.5-3% faster; 4096
  gained nothing (Rejected designs).
- **Ops.** The op arena is an array of 16-byte slots (`kwemu.Slot`) the
  ISA views as its own op type (`Cpu.opArena`). One guest instruction is
  one op, so an op index is a count of retired instructions; what the ISA
  keeps beside the ops (A64: the raw words) sits after them. `Stats.op_hist`
  and `JitStats.hb` have room for `kwemu.max_ops` (192) kinds. Every kind
  costs dispatch code, so variants share a kind where a field selects the
  variant without a branch.
- **Superblocks.** Up to 64 instructions inside one page, in execution
  order: conditional branches are side exits, direct branches inside the
  page are followed. A branch back to the block's start ends it, and such
  a self-loop re-enters without a lookup. A block never depends on a
  second page.
- **Lookup.** A 2-way table of 32K blocks keyed by virtual pc, set
  `((pc >> 1) ^ (pc >> 15)) & 16383`. The fast path is two compares: pc,
  and `tgen` against the generation of either entry of pc's exec-TLB set.
  The exec TLB is 2-way (256 sets), and every fill gets a fresh 64-bit
  generation. Both the 2-way exec TLB and that hash are needed: a 1-way
  exec TLB or a `pc >> 16` hash made an ash loop vary between 3 and 5 s
  (riscv64 guest).
- **Coherence.** A block is trusted only under the generation it was
  validated with. Flushes, `kw_set_pgd` and instruction-cache invalidation
  (A64 IC IVAU, `Cpu.icInvalidate`) retire generations. A stale block is
  revalidated (same pc, host address and raw bits) or re-decoded. Guest
  stores are tracked exactly: pages holding code sit in a hashed filter
  (4096 slots) with a 64-byte-chunk bitmap, and their write-TLB entries
  carry `code_flag`, which sends stores to the slow path. A slot two pages
  share is wild and marks every page hashing to it; the write TLB is
  scanned only when a slot changes state. A store into a marked chunk
  retires the page's generations and ends the block, so self-modifying
  code takes effect at the next instruction. Code changed by another CPU:
  a64/tier.md, Coherence.
- **Several CPUs** (an SMP kernel, kernel/smp.md): each CPU has its own
  `struct kw_cpu` on one shared memory, and code tracking is per kw_cpu.
  Built with `-Dkwemu-atomics` (`core.smp`), exclusives and LSE are wasm
  atomics (a load-exclusive's value is what the store-exclusive
  compare-and-swaps against: ABA goes unnoticed, as in QEMU), everything
  is seq_cst, and a barrier is a seq_cst RMW of `Hart.fence_word` (a
  locked instruction on x86-64 V8, about 4.3 ns, against 8.9 ns for
  `atomic.fence`; an atomic load costs nothing extra in V8, and is a
  read-modify-write in JavaScriptCore; 2026-11-16). Without
  the option everything assumes one CPU.
- **Precise state.** Ops update `kw_regs` directly. On a fault mid-block,
  pc is recomputed from the ops (`pcAt`) and the budget refunded. `icount`
  and the budget are exact: a block that does not fit the remaining
  budget is single-stepped. `*irq_pending` is polled at every block end.
  An interpreted self-loop that an interrupt ends still counts its passes
  towards the compile threshold (`loopDone`): under a stream of IPIs a hot
  loop otherwise never got compiled.
- **Cache.** 32K block slots, 448K op slots (7 MiB of the 9 MiB
  `KW_CPU_SIZE`). The op arena has a nursery (320K slots) where blocks
  are decoded and a tenured ring (128K, `ten_default`) where a block's ops
  are copied when it is compiled. When the nursery fills, only its ops
  are discarded: blocks keep their table entry with pc, host and compile
  countdown (`op_gone`), a re-decode of the same pc and host goes on
  counting, and compiled code keeps running. The ring makes room by
  dropping its oldest blocks and their code; 128K ops hold what one run
  of claude or bun compiles, which the next process then reuses
  (a64/performance.md, Tenured ring). Tenured ops are numbered on for
  good (ring position = number modulo size), so a module's member check never
  mistakes a later copy for the one it was emitted from. The table
  replaces the way with less countdown progress (compiled counts as most);
  the survivor loses half its progress. Only kw_cpu_init, kw_set_isa and
  kw_host_reset drop everything. Why so: a64/tier.md, The op arena. The
  block table cannot grow past 64K entries (region members are u16 block
  indexes); a nursery beyond 320K was no faster (a64/performance.md,
  Tenured ring).
- **FP** (`fpu.zig`). All five rounding modes and flags exact. RNE uses
  host-float fast paths with exact inexact detection. f64 FMA uses Boldo
  & Melquiond's emulated FMA (Dekker product, TwoSum, round to odd),
  checked against the integer path on more than 2M cases. A64's rules are
  applied on top in `src/a64/fparith.zig`. Its unit tests run in `zig
  build test`.
- **Dispatch** is one central `while (true) switch` over the op kinds (A64:
  `opexec.runOps`), a loop over a single `br_table`. Keep it that way: a
  threaded `switch` (`continue :sw`) gives every handler its own
  `br_table`, a 7x larger run loop and much slower cold code (Rejected
  designs). Per guest instruction the loop costs the same on hot and on
  cold code (a64/performance.md, Where the time goes).

## JIT tier

**Scope.** A decoded block (not raw instructions) is translated into one
wasm function. Hot blocks that branch to each other share one module (a
region), also across pages. What the ISA translates is its own (a64/jit.md);
an op it does not translate ends the compiled prefix: the code hands that
op back and the interpreter finishes the pass. A block whose first op is
not translated is never compiled.

**Generated code.** `f(x, cpu, irqp, jl: i64) -> i64`, where `x` =
`&regs.x`. Guest registers live in wasm locals, loaded on entry and
written back at a single exit. Loads and stores inline the data-TLB fast
path on the same `tlb_r`/`tlb_w` arrays; a miss hands the op back before
it executes, which covers faults, straddles and stores into code pages,
so SMC detection is unchanged. A self-loop becomes a wasm `loop` that
polls `*irqp` and checks `jl` at each back edge. The result is `(jl_left
<< 8) | code`: 0..63 = handed back before op k, 64..127 = done
(terminator retired, or a stop), 128+k = side exit at op k. The code
depends only on pc, the ops, cpu-relative offsets and block-table
positions, never on host addresses or generations: a revalidated block
keeps its code, a re-decoded one frees it. Modules use MVP instructions
plus memory64, and fixed-width SIMD only when the host offers it.

**When.** After a block has retired 2^17 interpreted instructions,
counted per entry and per self-loop pass. The countdown lives in the
block's state word, so a block never compiled costs one load per entry.
Eager mode (caps bit 2) compiles on first entry, for tests. Compiling
everything eagerly is much slower for short programs (riscv64 guest: 13
vs 110 MIPS); a64/performance.md has the thresholds tried.

**Slots.** kwemu owns 1024 stub functions in the function table: no
table growth and no allocator. A stub returns "handed back at op 0", so
an empty slot is harmless. When all are in use a clock (second chance)
evicts one. Slots are freed only from `run` between entries, never from
inside compiled code. `kw_cpu_init` forgets slots without freeing them,
so a host must accept a compile into an installed slot. `kw_host_reset`
(a restored snapshot, whose table is a new instance's) forgets them the
same way, sets every block's `jx` back to `never`, asks
`kw_host_jit_caps` again and resets the cache.

**Emit buffer.** 32 KiB inside `struct kw_cpu`. A module that does not
fit is emitted again with less: fewer region members (the ones found last
are dropped and the region is closed), then 3/4 of the hot block's ops
each time. A module that overflowed is never handed to the host.

### Regions

A module holds up to 16 decoded blocks (members), on any pages. The body
is a `loop` over a `br_table` with two entries per member: its checked
entry, which falls through into the member, and the member itself (only
for the member `run` entered). A member that leaves towards a member
(terminator, side exit, or an indirect branch whose target matches a
member's pc) sets the index and branches to the loop; other exits return
to `run`. `cpu.jit.cur` names the member a region left from.

- **Home and guest members.** A block's state word names one region, its
  home (`compiled | member << 16 | pool entry`), and `run` enters it only
  there. A region may also hold copies of blocks whose home is elsewhere
  (guests): a member's code depends only on its decoded ops, so a copy is
  exact while the block holds the same decode. `State.members` lists
  both, `member_op` the low 16 bits of each member's op index.
- **Membership.** When a block gets hot, `compile` takes it, the members
  of an open region of the same virtual page that has room (that region
  is replaced), the blocks of that page that could be members and have
  counted at least a quarter of the threshold (`pageWarm`, which probes
  every pc of the page; without it most of them got hot later, one at a
  time, and each compiled the region again to join it), then
  breadth-first the decoded, valid, not-yet-compiled
  blocks reachable through side exits, branch targets and call return
  sites (the ISA's `targets`), on any page. A self-loop's home is a
  closed module of its own (as a plain wasm loop it is much faster than
  as a member, and loops over big arrays hand back on every data-TLB
  miss, cheap only for a small module); it joins other regions only as a
  guest (growth along exits), where its back edge branches to its own
  member's `loop` (`backEdge`). A region cut to fit the buffer is closed,
  and so is a full one.
- **Growth along exits** (`noteExit`/`noteHot`). After compiled code
  leaves an open region (not a hand-back), `run` checks the block it
  looks up next. If it is compiled in another region (on any page, the
  region's own included; a self-loop too), it counts the exit (`hits`).
  After `grow_threshold` exits per KiB of the leaving region's module, the
  block joins that region as a guest: the region is emitted again and
  replaces the old module (if it does not fit, the old one stays,
  closed). Calls into libc and PLT stubs, functions spanning pages,
  blocks of the page compiled into other modules and self-loops entered
  from the region then stay in one module. `noteExit` tests the closed
  bit inline: most exits leave closed regions. A grow recompiles the
  whole region (a few hundred µs), so the threshold is high and per KiB
  makes big regions wait longer; a round trip through `run` costs about
  30 ns (A64, 7-Zip's LZMA, 2026-11-23).
- **Checked entry** (`checkedEntry`). Every branch into another member m
  goes through m's checked entry: m's `op` is still the op index it was
  compiled from; m is valid under the current exec-TLB fill of its page
  (`tgen` equals l_g, the running member's `tgen`, or the generation of
  one of the two exec-TLB entries of m's set; l_g then becomes m's
  `tgen`); `jl` covers all of m; `*irqp` is 0. Then it charges m. An
  indirect branch to the start of the running member tests only `jl` and
  `*irqp`. A failed check returns "done" with pc = m's start, and `run`
  looks m up. The checks exist once per member, and a branch site is 6
  bytes (an indirect target 18); inline checks per site would be 40% of
  module bytes in apk (riscv64 guest).
- **Register file.** The prologue loads the union of the registers any
  member uses (the ISA's `blockUse`), the single epilogue writes back the
  union of those written. ISA state kept as emit-time knowledge (A64:
  lazy NZCV) is made architectural before every branch that leaves
  straight-line code (`sync`).
- **Invalidation.** A re-decoded member loses only its own home state
  (`dropMember`); its copies elsewhere fail the op check from then on. A
  region is freed when its last home member goes, when the clock evicts
  it, when it is grown (replaced), or on `resetCache`.

### Invariants (what the tests check)

- Compiled code must leave exactly the state the interpreter would:
  registers, flags, memory, faults and `icount`.
- Budget and `icount` are exact: `run` charges the entered member in full,
  every further member is charged before it runs and only if `jl` covers
  it, and a side exit refunds the rest of the member it leaves. A budget
  that ends inside a member stops at its start, and `run` single-steps.
- IRQ latency: every member branch and self-loop pass reads `*irqp`, so it
  is read at most 64 instructions apart, as in `run`.
- Precise state on fault, trap and hand-back: registers are written back
  at the single exit, and `run` continues from op k of the named member.
- A member runs only while it is the decode it was compiled from and valid
  under the current fill of its page, checked at every branch into it.
  Nothing in compiled code changes the exec TLB, so the check holds until
  the module returns. Flushes, `kw_set_pgd`, IC IVAU, SMC, remaps and
  unmaps stop exactly the branches into the affected page.
- SMC: compiled stores into code pages miss the write TLB and hand back;
  the interpreter's store retires the generations.
- Flushes, `kw_set_pgd` and IC IVAU only retire generations: revalidated
  members keep their code (the tests check nothing is recompiled).

The A64 tests that check these: a64/tier.md and a64/jit.md, Tests.

### JIT on several CPUs

An SMP kernel (kernel/smp.md) runs one instance of the module per CPU, in
its own thread, on one shared memory. The JIT is per CPU:

- **Per-CPU code.** Each CPU has its own `struct kw_cpu` (block cache,
  TLBs, slot pool, emit buffer) and its own instance with its own
  `__indirect_function_table`; `kw_cpu_init` asks that CPU's host for the
  caps. A `kw_cpu` is used only by its own CPU, so a module of one CPU is
  never reachable from another; a task that moves finds a cold cache and
  compiles again. Sharing modules would need instantiating in every CPU's
  thread, a slot installed in every table before any CPU enters it, and a
  free that waits until no CPU runs it; and V8 compiles the same bytes
  again in each thread (a64/performance.md, Rejected designs).
- **Interrupts.** Compiled code polls the `irqp` it is called with (taken
  from the CPU's own `irq_pending` at every call; nothing is baked into a
  module). With a shared memory (caps bit 3) the load is
  `i32.atomic.load` (a read-modify-write in JavaScriptCore, so the kernel
  gives each CPU's word 128 bytes to itself): a plain load in a loop that stores nothing may be
  hoisted, and another CPU's IPI (a TLB shootdown waits for the answer)
  would never be seen. Nothing in compiled code waits for another CPU.
- **Compile window: compiles do not hold up TLB flushes.** A compile
  (gathering, emitting, `new WebAssembly.Module`, `new Instance`, V8's
  first-call compile, `table.set`) takes 0.1-0.4 ms, up to a few ms, and
  polls no interrupt. `jit_busy` in `struct kw_cpu` (kw_emu.h, "jit_busy /
  flush_all") is 1 from before the region is gathered (`windowOpen`) until
  after the host returns (`windowClose`), and nothing in between runs
  guest code, reads guest memory or walks a page table. A flush (tlb.c
  `kw_flush_later()`) that finds a target busy sets its `flush_all`,
  `smp_mb()`, and skips it if it still reads `jit_busy` (kwemu's
  `jit_busy = 1` is a seq_cst store, so the user stores before it are
  visible). kwemu stores 0, then takes `flush_all` with an atomic
  exchange: either the flusher saw the window closed and waits as before,
  or kwemu sees the mark, flushes everything and `run` looks the block up
  again (`Go.again`, also after a grow). V8 compiles a wasm function at its
  first call: every module starts with `if (cpu == 0) return 0`, and the
  host calls `f(0, 0, 0, 0)` inside the import (`flags` bit 0), so that
  compile is in the window too. Before gathering, kwemu takes an interrupt
  already pending (an IPI whose sender waits), and the block compiles at
  its next pass. Still waited for: an IPI raised in the ~1-2 µs between a
  flusher's read of `jit_busy` and its IPI; IPIs that are not TLB flushes;
  reschedule IPIs; frees (`table.set`, a few µs, outside the window). The
  20 ms yield to the host is skipped by flushes the same way
  (kernel/smp.md, MM).
- **Flushes** retire generations on each CPU, as on one CPU; a flushed CPU
  revalidates each block before running it again, and a block rewritten or
  moved is decoded again and its code freed. Code another CPU's guest
  changed is seen after IC IVAU on any CPU (the code epoch, a64/tier.md).
  Safety holds regardless of timing: decoded blocks and compiled code hold
  no host addresses (compiled code reaches guest memory only through this
  CPU's data TLB), so stale code only runs old instructions with current
  translations.
- **Atomics** in compiled code are the ISA's (a64/jit.md); the monitor
  lives in the CPU's `Hart` (cleared at every entry to user mode), never
  in a module.
- **Task switches.** Compiled code writes registers back at its single
  exit and returns to `run` before the kernel can run, so a task's state
  is in `kw_regs` whenever it can be switched out or moved.
- **Host.** Each CPU's thread has its own `JitHost` (js.md, CPU threads),
  whose counters CPU 0's host reads; it yields to its event loop every
  20 ms of user code, without which V8 never finished collecting freed
  modules there.

### Host contract

These imports exist only with `-Dkwemu-jit`. The kernel host is
`js/core/jit.ts`, the test host `test/kwemu-jit-host.mjs`.

| Import | |
| --- | --- |
| `kw_host_jit_caps() -> u32` | Called once from `kw_cpu_init`, by each CPU on its own host. Bit 0 = JIT available (0: never compile). Bit 1 = 32-bit memory (lowered kernel: the code imports a 32-bit `env.memory` and wraps addresses). Bit 2 = eager. Bit 3 = shared memory (the code declares `env.memory` shared, with a maximum of 65536 pages for memory32 and 262144 for memory64, and reads `*irqp` atomically; set when the kernel's memory is a SharedArrayBuffer). Bit 4 = the host passes the kernel's function table as `env.table` (A64 calls its interpreter through it; `jit.ts` always sets it). Bit 5 = the engine compiles fixed-width SIMD (`jit.ts` sets it when `WebAssembly.validate` accepts a small SIMD module; the test host unless `KWEMU_JIT_SIMD=0`). |
| `kw_host_jit_compile(ptr, len, slot, flags) -> i32` | Compile the module at `ptr` (imports `env.memory`, maybe `env.table`, exports `f`) synchronously with `new WebAssembly.Module` and `table.set` its `f` into `slot` (a BigInt for table64). 0 = installed, < 0 = failed (slot untouched, that block is never compiled). `flags` bit 0: `f(0, 0, 0, 0)` returns at once, and the host calls it once so V8 compiles it inside the compile window. |
| `kw_host_jit_free(slot)` | Put back the stub that was there before the first compile, and drop the module. |

kwemu's 1024 stubs are the last 1024 entries of the kernel's exported
`__indirect_function_table`, distinct in `vmlinux` and after the Binaryen
lowering: check that again after changing link flags or Binaryen passes.
`jit.ts` installs only into existing non-null slots, restores only slots
it installed, never throws into the kernel, and counts compiles, frees,
failures, bytes and time (`stats().jit`, CLI `--stats`, page
`KW.jitStats()`).

**Collecting freed modules.** Engines collect a freed module only when
their GC runs, and a module costs more memory than the GC is told about
(JavaScriptCore counts the kernel's wasm memory in its heap, so with 512
MiB of RAM it waits for about 3 GB of further allocation; V8 in Chromium
waits for about as much as the external memory it holds; Node for 64
MiB). So `jit.ts` tracks modules with a FinalizationRegistry. While 256 or
more freed modules are uncollected (`RETAINED_NUDGE`), it allocates and
detaches an ArrayBuffer on every compile (not on a free, which is outside
the compile window). The nudge starts at 64 MiB, doubles up to 4 GiB
whenever nudges have seen no collection for 250 ms, and halves when an
allocation fails. At 2048 uncollected (`RETAINED_LIMIT`) it refuses
compiles, and kwemu interprets those blocks. Measured 2026-11-13: a
14,000-module WebKit session stays at most ~620 uncollected with no
refusals but grows by about 50 MiB (unexplained); Chromium stays below
700. Counters: `collected`, `retained`, `maxRetained`, `gcNudges`,
`refused`.

**Compile cost, and why it stays on the kernel's thread** (riscv64 guest,
2026-11-14, 1644 real modules of 6.5 KiB on average, mean µs per module):

| engine | `new Module` | `new Instance` | `table.set` | first call | later calls |
| --- | ---: | ---: | ---: | ---: | ---: |
| Node 24.22.1 | 60 | 12 | 0.7 | 167 | 0.6 |
| Chromium 151 | 80 | 12 | 1 | 261 | 0.8 |
| WebKit (Safari 27.2) | 145 | 9 | 0.6 | 2 | 0.6 |

V8 compiles lazily: `new Module` only decodes and validates (about 55 µs
+ 6 µs/KiB) and the first call compiles with Liftoff on the calling thread
(16 µs + 30 µs/KiB), which `jit.ts` now makes inside the import (counted
in `compileMs`). JavaScriptCore compiles in the constructor. TurboFan
tier-up already runs on background threads. Even if compiling were free,
a set of shell commands would gain 2.4% and `npx --version` 4.5%; an
asynchronous install could only land at the 20 ms yields, leaving a hot
block interpreted that long instead of the ~0.25 ms compiling takes.

## Measuring

The guest has no perf events; host-side `perf` works (a64/performance.md,
Measuring).
`kernel/build.sh stats` builds a `-Dkwemu-stats` bundle of the UP kernel
only, so counters come from one CPU and time samples (which need two or
more) from the regular bundle; the CLI's `--stats` prints its counters
for the whole run at exit (`JitHost.kwemuStats()`, `stats().kwemu`). For a window inside a run, a
host driver calls the exported `kw_debug_stats` at markers the guest
prints (for example `@@S name` / `@@E name` around each command). Either
finds the cpu through the stats-only export
`kw_debug_cpu_of_jit_buf(ptr)`, where `ptr` is what `kw_host_jit_compile`
receives; `icount` is at offset 32. `[kwemu-free]` counts the modules
freed by reason (`jc.Why`, `Jx.free_why`). Exit counters (`[kwemu-exits]` and
`[kwemu-jx]`, indices in `jc.Jx`): every entry ends as a hand-back, a
side exit (`exit_side`, of which `exit_side_region` from region members),
a direct or indirect terminator, or a stop (`exit_stop`: budget,
interrupt or a failed checked entry); compiled code tells `run` which
through the done codes. `next_by` crosses that with the class of the
block run next (`jc.Nx`: same block, never compiled, not yet compiled,
same region, a self-loop module, another region that could grow, or a
full one). The A64 counters and bench scripts: a64/performance.md,
Measuring.

**Guest pc profile** (any build; CLI `--profile FILE [--profile-hz N]
[--profile-insns N] [--profile-root DIR]`, SDK `createKernel({ profile })`,
`vm.profile()` and `symbolizeProfile()`, `js/core/profile.ts`; kernel
`arch/wasm/kernel/prof.c`): a histogram of user code in two domains, by
the file and file offset of the code over every process (`sites`, 4 KiB
`pages` of files, `files`; anonymous memory, such as a guest JIT's code,
keeps its raw address per process) and by command, process and user pc
(`rows`, `procPages`), as JSON with the commands and per-CPU totals, and a
table on stderr. `--profile-root DIR` (a host copy of the guest's root, such
as `vendor/build/distro/debian-root`) or `symbolizeProfile(report, read)`
add the nearest ELF function symbol (.symtab, else .dynsym) and `symbols`.
Time samples: a sampler
thread (`js/node/sampler.ts`; Node only) sets IRQ 9 in every CPU's word
`hz` times a second (default 1000) without a notify, so it needs a shared
memory (the SMP kernel, `--cpus 2` or more; otherwise instruction samples
only). kwemu stops at its next poll; the kernel records the pc, and from
`kw_debug_last_stop(cpu, &block)` (a kwemu export outside the ABI, written
only on interrupt and budget returns) the tier that saw the bit (entry,
reference, decoded, compiled, budget) and the start of the block that ran
before (of a compiled region, the member it left from: `jc.lastBlock`),
which is the code that used the time (the stop pc is the next block's
start). A tick taken when the last kw_run retired nothing, or
outside user mode, is a kernel or idle sample; a tick whose bit is still
set from the last one counts as missed (the CPU idles or is in one long
kernel stay). Instruction samples: every `insns` user instructions of a
CPU (default 10^6), exact, at the next pc to retire: `user_mode_loop()`
lowers `cpu->budget` to what is left of the period and gives the slice the
rest back. Each user sample names the file behind its address (the block
before, else the pc) and the offset in it. The VMA lookup needs the task's
mmap_lock, so a user time sample is only noted in the interrupt and
recorded by `do_user_interrupt()` right after it, and an instruction
sample in `user_mode_loop()`: task context, interrupts off, nothing held,
so a trylock, never a sleep (a busy lock leaves the file unknown, counted
in the report's `where`). A file gets an id when first seen (by device and
inode) and its path (`d_path` of the path the task sees, so an overlay's)
once, in a table of 512 names of 128 bytes that the host reads by id; when
it is full, further files are counted, not named. Each CPU writes its own
ring of 512 samples; the host drains them on the kernel's thread every 20
ms (at the 20 ms yields while user code runs) and counts what was dropped,
which happens at periods under about 10^5 instructions. Off, the kernel's
cost is one load per kw_run and a call per interrupt.

## Numbers

Rules for numbers: a64/performance.md (interleaved medians, machine, date,
command).

**SMP with the JIT** (riscv64 guest, 2026-11-16, 16-core host, lowered
kernels, 12 rounds in random order, medians). Compiled code costs the same
on every CPU count (int and fp loops within their IQRs; a memory loop -7%
on the SMP build, from its atomics); kernel-side costs (clock_gettime 349
to 416-439 ns, fork+exit+wait 0.13 to 0.19-0.25 ms) are the SMP build's.
Parallel compiled loops scale linearly: N threads of a spin loop take as
long as one (1.99x on 2 CPUs, 3.93x on 4); `kwjob N` (N parallel gzip,
bzip2 and awk jobs) is 1.94x on 2 CPUs and 3.81x on 4. Host memory (peak
RSS after `kwjob N`, JIT vs `--no-jit`): 1 CPU 244 vs 193 MiB, 2 CPUs 365
vs 300, 4 CPUs 457 vs 394; a CPU thread costs about 100 MiB either way.

**IPI answers** (`kwipi` in `vendor/smp-deferred/tools`: CPU 0 mprotects a
page back and forth, each call a shootdown that waits for CPU 1): with CPU
1 in a compiled self-loop p50 1.8 µs, p99 3.3, p99.99 74 (interpreted
2.0 / 3.8 / 210). Single calls of about 1 ms in every mode are the
host's scheduling.

**Compile stalls** (riscv64 guest, 2026-11-17; kwipi `churn`: CPU 1
compiling all the time, 2 CPUs, 20 s, 4 boots, medians), before and after
the compile window: mprotects in 20 s 5.53M to 7.07M, p99.9 130 to 13 µs,
max 20.0 to 3.9 ms, calls over 1 ms 194 to 3. Without the host's first
call in the window: p99.9 47 µs, max 16.5 ms. Real workloads compile far
less (a node set on 2 CPUs: 1-2% of the CPUs to answer were compiling);
there the time flushes spent waiting fell from 145 to 18 ms on 2 CPUs and
206 to 46 ms on 4. The remaining long waits overlap the 20 ms yield
(median 32 µs, up to 19 ms while V8 runs finalizers). The window costs
nothing measurable (`compileMs` rises 2.6x because it now holds V8's
first-call compile). kwstorm + kwmmstress and kwtlb on 4 CPUs with the
JIT: no errors, and each CPU still collects what it frees.

**Sizes** (2026-11-23). `struct kw_cpu` with the JIT leaves 11,840 bytes
of `KW_CPU_SIZE` spare, 3,312 in a `-Dkwemu-stats` build (`jc.State` is
117,376 bytes, of them the 32 KiB emit buffer and `members` and
`member_op` 64 KiB at 16 members; every block carries an 8-byte `jx`):
check the headroom before growing JIT tables.

## Rejected designs

Measured under V8 (Node 24), on the riscv64 guest unless dated later; the
machinery is the same for A64 (a64/performance.md has A64's own). Do not
retry without a new reason.

| Idea | Result |
| --- | --- |
| Threaded dispatch (`continue :sw` per handler) | a `br_table` per handler, run loop 7x larger, `kwemu.o` 528 vs 363 KB; `npx --version` 6.14 vs 3.66 s with `--no-jit` |
| Tail-call dispatch (`return_call_indirect` chain) | about 2x slower |
| Fusing common op pairs | no gain |
| Multiplicative block-set hash | fixes collisions, but costs the interpreter 3-7% |
| ReleaseSmall for libkwemu | about 5% slower than ReleaseFast |
| Calling the next compiled block from compiled code (`call_indirect`) | almost no gain: each hop still writes back and reloads registers |
| Re-entering the next compiled block straight from `run` | no gain on top of regions |
| Region "light entry" (load only the entered member's registers) | slower everywhere (ash 2.55 to 3.51 s) |
| Self-loops as region members (their home) | much slower (1150 vs 1880 MIPS) |
| Caching modules by content | only 4% of modules repeat |
| Growing regions with a fixed threshold (64-1024 exits per target) | some loops 30% faster, ash 4-9% slower, `md5sum` x 8 +40% (each grow recompiles the region) |
| Cutting a grown region to fit the buffer | dropped members ran interpreted again: ash compiled 50% instead of 88% |
| Growing only regions of up to 8 members, or only towards a target with a quarter of the exits | no better |
| Cross-page members only from the breadth-first search, no growth | `yes` 5.90 vs 5.49 s |
| Compiling modules off the kernel's thread | at most 2.4% (shell) / 4.5% (npx) even if free (Host contract) |
| A fixed JIT threshold of 2^19 | npx at parity with `--no-jit`, but a memory loop -18%, `md5sum` x 8 +60% |
| Per-site data-TLB page cache in self-loop modules | slower: TLB loads are L1 hits, extra loop-carried locals cost more |
| 32-member regions (2026-11-15, with a 32 KiB emit buffer) | fewer entries and exits, but apk 3.05 vs 2.88 s: bigger modules cost more per entry and recompile |
| Grow threshold 1024 per KiB (2026-11-15) | a quarter to a third more compiles, time within noise |
| Four AES T-tables instead of one plus `i32.rotl` | aes-256-cbc +3.6%, below the 4% bar for 6 KiB more `AesTab` |
| SMP: taking a pending interrupt right after the compile, before the block runs (2026-11-17) | the JIT then takes an interrupt earlier than the interpreter does, so the two diverge; kwemu looks before the compile instead |
| SMP: making the host's first call of a new module trap instead of the `cpu == 0` test | a wasm trap costs 33-43 µs in a CPU's thread, against one compare per entry |
| SMP: compiling asynchronously (`WebAssembly.compile`, a helper worker) | a finished Module reaches a CPU's thread only through its event loop, at the 20 ms yields; V8's first-call compile stays on the CPU anyway |
| SMP: returning to the kernel between `new Module`, `new Instance` and the first call | the first-call compile alone is most of it and cannot be split |
| Data TLBs of 4096 entries each (2026-11-20, A64, the profile disk of a64/performance.md, 6 boots) | `claude --help` first runs 0.0%, later -2.5%, npm -0.5% and +2.9%, bun cpu.js -0.8% and -1.0%: noise, for 4x the TLB memory |
| No halving of the surviving way's progress in `jc.victim` (2026-11-20, same) | 4-23% slower: `claude --help` +4.2% / +8.2% (first / later runs), npm +5.9% / +23.2%, bun cpu.js +6.1% / +8.4%; compiles per later claude run 453 to 855 |

## Next steps

Shared-core levers (A64's ranked list: a64/performance.md, Next levers).
Bigger regions: most exits that remain leave full or closed regions. On
7-Zip's LZMA (A64, 2026-11-23) 421 M of 629 M entries follow an exit
from a closed region: its match finder's regions close at 25-28 KiB with
7-12 members (about 3.5 KiB per member, much of it data-TLB checks and
NZCV packing on exit paths), so fewer bytes per member (shared exit
stubs) would let them grow; more members also need a smaller
`members`/`member_op` encoding (or a bigger `KW_CPU_SIZE`, an ABI
change). Exits into self-loop modules and back are the other large group
(176 M of those entries): self-loops join open regions as guests, but
not closed ones, and a self-loop module, closed itself, never grows
towards the region it returns to (a self-loop module that dissolves into
a home member once its exits are hot would). Cheaper `enter` and region
entries (a smaller register prologue).
