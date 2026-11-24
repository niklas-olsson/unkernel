/* SPDX-License-Identifier: GPL-2.0-or-later */
/*
 * Contract between the wasm Linux kernel (arch side) and the guest CPU
 * emulator ("kwemu", Zig, src/a64 on top of the MMU in src/emu). The
 * emulator is a freestanding library with no allocator and no global
 * mutable state: everything lives in the kernel-owned struct kw_cpu, and
 * guest registers in a kernel-owned struct kw_regs (normally inside the
 * task's pt_regs).
 *
 * Guest ISA: AArch64, A64 instruction set, ARMv8.0-A user mode (EL0),
 * little-endian, with FP and AdvSIMD. No SVE, pointer authentication or
 * MTE; the PAC and BTI encodings in the hint space run as NOPs. The crypto
 * extensions, LSE atomics, SHA-512 and SHA-3 are optional features
 * (KW_ISA_*, below), enabled only when this build implements them.
 * .agents/a64.md lists which instructions are implemented; every other
 * encoding raises KW_EV_ILLEGAL.
 *
 * Memory model: kernel and emulator share one wasm64 linear memory. A
 * "physical address" is a linear-memory address minus cpu->phys_base.
 * The emulator walks the kernel's user page tables itself, like hardware:
 * the kernel writes PTEs and calls the flush hooks below.
 *
 * Page-table format (the RISC-V Sv48 layout, independent of the guest ISA:
 * 4 KiB pages, 4 levels, 512 entries per level, 8-byte little-endian PTEs;
 * user virtual addresses below 2^48, all four levels' index bits, with no
 * sign-extended upper half):
 *   bit 0 V, 1 R, 2 W, 3 X, 4 U, 5 G, 6 A, 7 D, bits 8-9 software,
 *   bits 10..53 PPN (physical address >> 12).
 * A valid PTE with R=W=X=0 points to the next level. Leaves are only
 * honoured at the last level (no huge pages). User access needs U=1.
 * The emulator never writes PTEs: an access with A=0, or a store with
 * D=0, raises KW_EV_FAULT so the kernel can set the bits.
 *
 * Decoded-code cache: kw_run decodes guest code into blocks of up
 * to 64 instructions inside one page (src/a64/tier.zig) and keeps them in
 * struct kw_cpu, keyed by virtual pc and trusted only under the exec-TLB
 * fill they were checked against. Every flush below (kw_flush_tlb_range()
 * of a page that maps the code, kw_flush_tlb_all(), kw_set_pgd()) makes
 * each block be checked again (same physical page, same instruction
 * words) before it runs; kw_set_isa() and kw_host_reset() drop them all.
 * So:
 *  - Stores by this CPU's guest code into decoded code are tracked exactly
 *    and take effect at the next instruction (self-modifying code needs no
 *    flush), including stores through another virtual alias of the page.
 *  - Code the kernel writes (or another CPU's guest writes) is seen after
 *    a flush of a page that maps it on this CPU, or after IC IVAU of the
 *    line by any guest on any CPU (+ ISB), as on hardware with
 *    CTR_EL0.DIC = IDC = 0. A kernel that rewrites code in place must
 *    therefore flush the page (it already must when it changes a mapping).
 *  - Several CPUs: IC IVAU on one CPU is seen by every other CPU at its
 *    next decoded-block boundary (at most 64 instructions later) or kw_run
 *    entry, through a code epoch in kwemu's static data; no kernel action
 *    is needed.
 * Decoded blocks hold no state the kernel must save: a task's registers
 * are in struct kw_regs whenever kw_run returns.
 *
 * Several CPUs: an SMP kernel gives each CPU its own struct
 * kw_cpu, used only by that CPU's thread, on one shared memory. kwemu
 * built with wasm atomics (zig build -Dkwemu-atomics) makes barriers (DMB,
 * DSB) full barriers, exclusives and LSE atomics atomic, and IC IVAU
 * visible to every CPU (above); without atomics everything assumes one CPU.
 *
 * jit_busy / flush_all: the window in which a CPU compiles JIT code and
 * another CPU may skip waiting for its TLB flush. kwemu sets jit_busy while
 * it compiles (with the JIT built in), a window in which it reads no guest
 * memory or page table; a CPU that finds it set may set flush_all instead
 * of waiting for this CPU's TLB flush, and kwemu then flushes its whole TLB
 * when the compile ends, before it runs guest code again.
 */
#ifndef KW_EMU_H
#define KW_EMU_H

#ifdef __KERNEL__
#include <linux/types.h>
#else
#include <stdint.h>
#endif

#ifdef __cplusplus
extern "C" {
#endif

#define KW_ABI_VERSION 4

/*
 * A64 register state of one task. Fixed layout (offsets in bytes): x[0..30]
 * at 0, sp 248, pc 256, nzcv 264, fpcr 268, fpsr 272, tpidr_el0 280, and
 * the 32 128-bit V registers at 288 (16-byte aligned; each is two
 * little-endian 64-bit halves, low half first, i.e. the memory image of a
 * little-endian __uint128_t). Register number 31 is SP or XZR depending on
 * the instruction, as in the architecture; there is no x[31].
 */
struct kw_regs {
	uint64_t x[31];
	uint64_t sp;       /* SP_EL0 */
	uint64_t pc;
	uint32_t nzcv;     /* PSTATE.{N,Z,C,V} in bits 31..28 (as MRS NZCV
			      reads them); the other bits are zero */
	uint32_t fpcr;     /* FPCR as MSR/MRS see it */
	uint32_t fpsr;     /* FPSR (cumulative exception flags, QC) */
	uint32_t _pad;
	uint64_t tpidr_el0;
	uint64_t v[32][2] __attribute__((aligned(16)));
} __attribute__((aligned(16)));

enum kw_event_kind {
	KW_EV_BUDGET = 0,      /* instruction budget used up (timer tick point) */
	KW_EV_SYSCALL = 1,     /* SVC #imm (any imm); pc already past it; the
				  number is in x8, the arguments in x0..x5 */
	KW_EV_FAULT = 2,       /* page fault; pc at the faulting instruction */
	KW_EV_ILLEGAL = 3,     /* unallocated or unimplemented encoding, UDF,
				  HLT, HVC, SMC, a system register EL0 may not
				  access; pc at it, ev.insn = the raw word */
	KW_EV_BREAKPOINT = 4,  /* BRK #imm; pc at it, ev.insn = the raw word */
	KW_EV_MISALIGNED = 5,  /* pc not 4-byte aligned (ev.addr = pc), or an
				  exclusive or acquire/release access that is
				  not naturally aligned (ev.addr = the
				  address); pc at the instruction */
	KW_EV_INTERRUPT = 6,   /* *cpu->irq_pending became non-zero */
};

enum kw_access {
	KW_ACCESS_READ = 0,
	KW_ACCESS_WRITE = 1,
	KW_ACCESS_EXEC = 2,
};

struct kw_event {
	uint32_t kind;    /* enum kw_event_kind */
	uint32_t access;  /* enum kw_access, for KW_EV_FAULT */
	uint64_t addr;    /* faulting guest virtual address (FAULT: any byte of
			     the faulting page; MISALIGNED: the address;
			     ILLEGAL/BREAKPOINT: the pc) */
	uint64_t insn;    /* raw instruction, for KW_EV_ILLEGAL and
			     KW_EV_BREAKPOINT */
};

/*
 * Bytes the kernel must reserve for a struct kw_cpu (8-byte aligned): TLBs,
 * the decoded-block cache and its op arena, JIT bookkeeping.
 */
#define KW_CPU_SIZE (9 * 1024 * 1024)

/*
 * Only the leading fields are public. The rest of the KW_CPU_SIZE bytes
 * (TLBs, exclusive monitor, caches) belong to the emulator.
 */
struct kw_cpu {
	uint64_t phys_base;            /* linear address of physical address 0 */
	uint64_t pgd;                  /* physical address of the root table */
	const volatile uint32_t *irq_pending; /* polled at least every 64
						 instructions; may be NULL */
	uint64_t budget;               /* instructions kw_run may execute */
	uint64_t icount;               /* total instructions executed (stats) */
	struct kw_event ev;            /* details of the last event */
	/* see "jit_busy / flush_all" above */
	uint32_t jit_busy;             /* written by kwemu only */
	uint32_t flush_all;            /* set by other CPUs, cleared by kwemu */
};

/* Zero and initialise the whole KW_CPU_SIZE block. */
void kw_cpu_init(struct kw_cpu *cpu);

/*
 * Run guest code from regs until an event. Returns enum kw_event_kind and
 * fills cpu->ev. Never blocks, never re-enters the kernel.
 * cpu->budget is decremented per retired instruction (SVC retires;
 * faulting/illegal instructions do not) and cpu->icount advanced by the
 * same amount; KW_EV_BUDGET when it reaches exactly 0 (returns at once if
 * 0 on entry). *irq_pending is checked on entry and at the end of every
 * decoded block, which is at least every 64 instructions and at every
 * taken branch out of a block (a branch the decoder followed
 * inside a page is not a check point). Every event leaves regs (incl. pc)
 * exactly at an instruction boundary. Data accesses may be unaligned
 * (SCTLR_EL1.A = 0); SP alignment is not checked.
 */
uint32_t kw_run(struct kw_cpu *cpu, struct kw_regs *regs);

/* Switch address space: sets cpu->pgd, drops the TLB and the exclusive monitor. */
void kw_set_pgd(struct kw_cpu *cpu, uint64_t pgd);

void kw_flush_tlb_all(struct kw_cpu *cpu);
void kw_flush_tlb_range(struct kw_cpu *cpu, uint64_t start, uint64_t end);

/*
 * Clear the exclusive monitor (LDXR/STXR; call on every context switch /
 * trap return, as exception entry and return clear it on hardware).
 */
void kw_clear_reservation(struct kw_cpu *cpu);

uint32_t kw_abi_version(void);

/*
 * Optional ISA features beyond ARMv8.0-A with FP and AdvSIMD, one bit each
 * (they map to the AT_HWCAP bits the kernel reports). Bits 8..63 are
 * reserved. An instruction of a feature that is not implemented, or not
 * enabled, raises KW_EV_ILLEGAL like any other unknown encoding.
 * kw_isa_supported() says which ones this build implements.
 */
#define KW_ISA_AES	(1ULL << 0)	/* AESE, AESD, AESMC, AESIMC (HWCAP_AES) */
#define KW_ISA_PMULL	(1ULL << 1)	/* PMULL/PMULL2 with 64-bit elements (HWCAP_PMULL) */
#define KW_ISA_SHA1	(1ULL << 2)	/* SHA1C, SHA1P, SHA1M, SHA1H, SHA1SU0/1 (HWCAP_SHA1) */
#define KW_ISA_SHA2	(1ULL << 3)	/* SHA256H, SHA256H2, SHA256SU0/1 (HWCAP_SHA2) */
#define KW_ISA_CRC32	(1ULL << 4)	/* CRC32B/H/W/X, CRC32CB/H/W/X (HWCAP_CRC32) */
#define KW_ISA_LSE	(1ULL << 5)	/* LSE atomics: CAS, CASP, SWP, LDADD, LDCLR,
					   LDEOR, LDSET, LD{S,U}{MAX,MIN} (HWCAP_ATOMICS) */
#define KW_ISA_SHA512	(1ULL << 6)	/* SHA512H, SHA512H2, SHA512SU0/1 (HWCAP_SHA512);
					   needs KW_ISA_SHA2: kw_set_isa drops it without */
#define KW_ISA_SHA3	(1ULL << 7)	/* EOR3, BCAX, RAX1, XAR (HWCAP_SHA3) */

/* The KW_ISA_* features this kwemu build implements. */
uint64_t kw_isa_supported(void);

/*
 * Enable the features in `isa` that are implemented (isa &
 * kw_isa_supported()) and disable all others; returns the enabled set.
 * kw_cpu_init enables every implemented feature. Call it once at boot,
 * after kw_cpu_init and before the first kw_run. The kernel advertises
 * exactly the returned set to user space (AT_HWCAP).
 */
uint64_t kw_set_isa(struct kw_cpu *cpu, uint64_t isa);

/*
 * The host changed under a live struct kw_cpu: the kernel's memory was
 * restored into a new module instance (a snapshot). Drop everything that
 * belongs to the old instance (compiled code, if a JIT is built in) and
 * all decoded code. Call it before the first kw_run on the new instance.
 */
void kw_host_reset(struct kw_cpu *cpu);

/*
 * Optional JIT tier (-Dkwemu-jit; not part of the ABI version): hot decoded
 * blocks are compiled to wasm (src/a64/jit on the ISA-neutral core in
 * src/emu/jitcore.zig). A library built with it imports these from wasm
 * module "unkernel" (see src/emu/jitcore.zig for their contract):
 *   uint32_t kw_host_jit_caps(void);
 *   int32_t kw_host_jit_compile(const uint8_t *module, size_t len, uint32_t slot,
 *                               uint32_t flags);
 *   void kw_host_jit_free(uint32_t slot);
 */

#ifdef __cplusplus
}
#endif

#endif /* KW_EMU_H */
