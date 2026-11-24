// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
/* unkernel smoke test (static aarch64 musl): /usr/bin/kwtest in the Alpine
 * initramfs, as /init with rdinit=/usr/bin/kwtest or from a shell. */
#include <errno.h>
#include <fcntl.h>
#include <fenv.h>
#include <math.h>
#include <pthread.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/reboot.h>
#include <sys/syscall.h>
#include <sys/time.h>
#include <sys/utsname.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile int got_signal;

static void on_usr1(int sig)
{
	got_signal = sig;
}

/* Wrong tp (clone tls/ctid swapped) shows up as a bad pthread_self or TLS. */
static _Thread_local int tls_var;

static void *thread_fn(void *arg)
{
	(void)arg;
	if (tls_var != 0)
		return NULL;
	tls_var = 2;
	return (void *)pthread_self();
}

/*
 * Hot loops for kwemu's JIT tier, which compiles a block once it has
 * retired 2^17 instructions: 64-bit and W integer ops, mul/div/rem, and
 * byte/half/word loads and stores over fresh anonymous pages, so the first
 * touch of each page faults from inside compiled code. HOT_EXPECT is what a
 * native build computes: `cc -O2 -o /tmp/kwtest guest/src/test/kwtest.c
 * -lpthread && /tmp/kwtest hot` on any 64-bit host.
 */
#define HOT_SEED 0x2545f4914f6cdd1dUL
#define HOT_EXPECT 0xd096af30f48152faUL
#define HOT_WORDS 4096

static unsigned long hot(unsigned long seed)
{
	unsigned long *w = mmap(NULL, HOT_WORDS * 8, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	unsigned char *b = (unsigned char *)w;
	unsigned long a = seed, sum = 0;

	if (w == MAP_FAILED)
		return 0;
	for (unsigned long r = 0; r < 24; r++) {
		for (unsigned long i = 0; i < HOT_WORDS; i++) {
			a = a * 6364136223846793005UL + i;
			unsigned long q = a / ((i | 1) + r) + a % 1000003;
			int32_t h = (int32_t)((uint32_t)(a >> 17) * 2654435761u);
			long s = (long)(h >> 3) / (long)(r + 3);
			uint16_t hw;
			uint32_t word;

			w[i] += q ^ (unsigned long)s;
			b[(i * 13) & (HOT_WORDS * 8 - 1)] ^= (unsigned char)a;
			memcpy(&hw, b + 2 * ((i * 7) & (HOT_WORDS * 4 - 1)), 2);
			memcpy(&word, b + 4 * ((i * 5) & (HOT_WORDS * 2 - 1)), 4);
			sum += w[(i * 7) & (HOT_WORDS - 1)] + hw + (unsigned long)(int32_t)word;
		}
	}
	munmap(w, HOT_WORDS * 8);
	return sum ^ a;
}

/*
 * FP hot loop for the JIT's F/D translation: double and float arithmetic,
 * fma(), sqrt(), fmax(), conversions both ways, compares, and a last round
 * in FE_UPWARD (dynamic rounding, which the JIT hands back). Returns a hash
 * of the results and of the accrued flags. FPHOT_EXPECT is what a native
 * build computes: `cc -O2 -ffp-contract=off -o /tmp/kwtest
 * guest/src/test/kwtest.c -lpthread -lm && /tmp/kwtest fphot` on a 64-bit
 * host with IEEE double/float (x86-64, aarch64).
 */
#pragma STDC FP_CONTRACT OFF
#pragma STDC FENV_ACCESS ON
#define FPHOT_EXPECT 0x75228a7bc4a10579UL

static unsigned long fphot(unsigned long seed)
{
	double x = 1.0 + (double)(seed & 0xffff) / 65536.0, acc = 0.0, m = 0.0;
	float fx = 0.5f, facc = 0.0f;
	unsigned long h = seed, bd, bm;
	uint32_t bf;

	feclearexcept(FE_ALL_EXCEPT);
	for (int r = 0; r < 4; r++) {
		if (r == 3)
			fesetround(FE_UPWARD);
		for (int i = 1; i <= 20000; i++) {
			double y = x * 1.000001 + 1.0 / i;
			acc = fma(y, 0.999, acc * 0.5);
			acc += sqrt(y) - (double)(i & 7);
			fx = fx * 1.0001f + (float)acc * 1e-3f;
			facc += sqrtf(fx > 0 ? fx : -fx) - fx / 3.0f;
			m = fmax(m, acc);
			long l = (long)(acc * 1024.0);
			h = (h ^ (unsigned long)l) * 0x100000001b3UL;
			if (y > acc)
				h += 1;
			x = y - (double)l / 4096.0 * 1e-6;
		}
	}
	fesetround(FE_TONEAREST);
	int ex = (fetestexcept(FE_INEXACT) ? 1 : 0) | (fetestexcept(FE_INVALID) ? 2 : 0) |
		 (fetestexcept(FE_OVERFLOW) ? 4 : 0) | (fetestexcept(FE_UNDERFLOW) ? 8 : 0) |
		 (fetestexcept(FE_DIVBYZERO) ? 16 : 0);
	memcpy(&bd, &acc, 8);
	memcpy(&bm, &m, 8);
	memcpy(&bf, &facc, 4);
	return h ^ bd ^ (bm * 3) ^ ((unsigned long)bf << 7) ^ (unsigned long)ex;
}

static int failures;
#define CHECK(cond, ...) do { \
	if (cond) printf("ok   " __VA_ARGS__); \
	else { printf("FAIL " __VA_ARGS__); failures++; } \
	printf("\n"); \
} while (0)

#ifdef __aarch64__
#include <setjmp.h>
#include <sys/auxv.h>
#include <linux/futex.h>
#include <poll.h>
#include <sys/epoll.h>
#include <sys/mount.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/sysmacros.h>
#include <sys/ucontext.h>
#include <linux/vm_sockets.h>
#include <linux/userfaultfd.h>
#include <linux/rtnetlink.h>
#include <linux/fib_rules.h>
#include <linux/veth.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sys/prctl.h>
#include <elf.h>
#include <sys/ptrace.h>
#include <sys/uio.h>

/*
 * The arm64 features the kernel may report (arch/wasm/kernel/cpu.c): the
 * AT_HWCAP bits and the /proc/cpuinfo "Features" line, which lists their
 * names in this (HWCAP bit) order. kind: 2 = always listed (ARMv8.0-A with
 * FP and AdvSIMD), 1 = one of kwemu's optional features (KW_ISA_*), listed
 * unless kw.isa= masks it or kwemu does not implement it yet (either),
 * 0 = cpuid, listed once kwemu answers the ID registers (either). probe: an
 * instruction only this feature defines, on x0, x1, d0/v0, v1 and the
 * stack; it must raise SIGILL exactly when the feature is not listed. Any
 * other HWCAP bit (SVE, PAC, ...) must never be set, and AT_HWCAP2 and
 * AT_HWCAP3 are 0. kw.isa= also takes "lse" for "atomics".
 */
static const struct a64_feat {
	const char *name;
	unsigned long hwcap;
	int kind;
	uint32_t probe;
} a64_feats[] = {
	{ "fp",    1UL << 0,  2, 0x1e602000 },	/* fcmp d0, d0 */
	{ "asimd", 1UL << 1,  2, 0x4ea11c20 },	/* orr v0.16b, v1.16b, v1.16b */
	{ "aes",   1UL << 3,  1, 0x4e284820 },	/* aese v0.16b, v1.16b */
	{ "pmull", 1UL << 4,  1, 0x0ee1e000 },	/* pmull v0.1q, v0.1d, v1.1d */
	{ "sha1",  1UL << 5,  1, 0x5e280820 },	/* sha1h s0, s1 */
	{ "sha2",  1UL << 6,  1, 0x5e282820 },	/* sha256su0 v0.4s, v1.4s */
	{ "crc32", 1UL << 7,  1, 0x1ac14000 },	/* crc32b w0, w0, w1 */
	{ "atomics", 1UL << 8, 1, 0xf8ff03e0 },	/* ldaddal xzr, x0, [sp] */
	{ "cpuid", 1UL << 11, 0, 0xd5380600 },	/* mrs x0, id_aa64isar0_el1 */
	{ "sha3",  1UL << 17, 1, 0xce618c00 },	/* rax1 v0.2d, v0.2d, v1.2d */
	{ "sha512", 1UL << 21, 1, 0xcec08020 },	/* sha512su0 v0.2d, v1.2d */
};
#define NFEAT (int)(sizeof(a64_feats) / sizeof(a64_feats[0]))
#define A64_RET 0xd65f03c0u

static int feat_find(const char *name, size_t len)
{
	if (len == 3 && !strncmp(name, "lse", 3))
		name = "atomics", len = 7;
	for (int i = 0; i < NFEAT; i++)
		if (strlen(a64_feats[i].name) == len && !strncmp(a64_feats[i].name, name, len))
			return i;
	return -1;
}

/* The first line of `path` that starts with `key`, from after ": " or `key`. */
static int read_line(const char *path, const char *key, int colon, char *out, size_t n)
{
	char line[1024];
	FILE *f = fopen(path, "r");
	int found = 0;

	if (!f)
		return 0;
	while (!found && fgets(line, sizeof(line), f)) {
		char *v = line;

		if (strncmp(line, key, strlen(key)))
			continue;
		if (colon) {
			v = strstr(line, ": ");
			if (!v)
				continue;
			v += 2;
		}
		v[strcspn(v, "\n")] = 0;
		snprintf(out, n, "%s", v);
		found = 1;
	}
	fclose(f);
	return found;
}

static sigjmp_buf trap_jmp;
static volatile int trap_sig, trap_code;
static volatile unsigned long trap_addr;

static void on_trap(int sig, siginfo_t *si, void *uc)
{
	(void)uc;
	trap_sig = sig;
	trap_code = si->si_code;
	trap_addr = (unsigned long)si->si_addr;
	siglongjmp(trap_jmp, 1);
}

/*
 * Run n instruction words (ending in ret) as long f(x0, x1); 0 when they
 * returned, else the signal (SIGILL, SIGTRAP, ...) they raised, with
 * trap_code and trap_addr set from its siginfo.
 */
static int run_code(const uint32_t *w, int n, long a0, long a1, long *ret)
{
	static uint32_t *page;
	struct sigaction sa = { .sa_sigaction = on_trap, .sa_flags = SA_SIGINFO }, oill, otrap;

	if (!page) {
		page = mmap(NULL, 4096, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
		if (page == MAP_FAILED) {
			page = NULL;
			return -2;
		}
	}
	memcpy(page, w, n * 4);
	__builtin___clear_cache((char *)page, (char *)(page + n));
	trap_sig = 0;
	sigaction(SIGILL, &sa, &oill);
	sigaction(SIGTRAP, &sa, &otrap);
	if (!sigsetjmp(trap_jmp, 1))
		*ret = ((long (*)(long, long))(void *)page)(a0, a1);
	sigaction(SIGILL, &oill, NULL);
	sigaction(SIGTRAP, &otrap, NULL);
	return trap_sig;
}

#define MRS(reg) ({ unsigned long _v; __asm__ volatile("mrs %0, " #reg : "=r"(_v)); _v; })

/* Signal frames (arch/wasm/kernel/signal.c, as arch/arm64). */
#define FPSIMD_MAGIC_ 0x46508001u
#define FPCR_RZ (3UL << 22)
struct a64_fpsimd {
	uint32_t magic, size, fpsr, fpcr;
	__uint128_t vregs[32];
};
static volatile int fr_ok, fr_ran;
static volatile unsigned long fr_pc, fr_lr;

static void on_frame(int sig, siginfo_t *si, void *ucv)
{
	ucontext_t *uc = ucv;
	struct a64_fpsimd *fp = (struct a64_fpsimd *)uc->uc_mcontext.__reserved;
	uint32_t *end = (uint32_t *)((char *)fp + sizeof(*fp));

	(void)si;
	fr_ran++;
	/* main set d8 = 0x1122334455667788, d9 = 1, FPCR.RMode = RP before the svc. */
	fr_ok = sig == SIGUSR2 && fp->magic == FPSIMD_MAGIC_ && fp->size == sizeof(*fp) && sizeof(*fp) == 528 &&
		end[0] == 0 && end[1] == 0 && (uint64_t)fp->vregs[8] == 0x1122334455667788UL &&
		(uint64_t)fp->vregs[9] == 1 && (fp->fpcr & (3U << 22)) == (1U << 22) &&
		(uc->uc_mcontext.pstate & ~0xf0000000UL) == 0 && uc->uc_mcontext.regs[8] == SYS_kill;
	fr_pc = uc->uc_mcontext.pc;
	/* sigreturn must load these. */
	fp->vregs[9] = 0xa5a5a5a5deadbeefUL;
	fp->fpcr = (fp->fpcr & ~(3U << 22)) | FPCR_RZ;
}

/* Raw rt_sigaction without SA_RESTORER: the handler returns through [sigpage]. */
struct k_sigaction_ {
	void (*handler)(int, siginfo_t *, void *);
	unsigned long flags;
	void (*restorer)(void);
	unsigned long mask;
};

static void on_sigpage(int sig, siginfo_t *si, void *uc)
{
	(void)sig;
	(void)si;
	(void)uc;
	fr_ran++;
	fr_lr = (unsigned long)__builtin_return_address(0);
}

/* The start and end of the mapping named `name` in /proc/self/maps. */
static int find_map(const char *name, unsigned long *start, unsigned long *end)
{
	char line[512];
	FILE *f = fopen("/proc/self/maps", "r");
	int found = 0;

	if (!f)
		return 0;
	while (!found && fgets(line, sizeof(line), f))
		if (strstr(line, name) && sscanf(line, "%lx-%lx", start, end) == 2)
			found = 1;
	fclose(f);
	return found;
}

static void isa_checks(void)
{
	char feats[512] = "", cmdline[1024] = "", mask[256] = "-", line[256];
	int want[NFEAT], have[NFEAT] = { 0 }, ordered = 1, unknown = 0, bad = 0, last = -1;
	unsigned long hwcap = getauxval(AT_HWCAP), allowed = 0, hw_want = 0;
	const char *p;

	mkdir("/proc", 0555);
	mount("proc", "/proc", "proc", 0, NULL); /* EBUSY when it is mounted */
	read_line("/proc/cpuinfo", "Features", 1, feats, sizeof(feats));
	read_line("/proc/cmdline", "", 0, cmdline, sizeof(cmdline));

	/* What should be listed: kind 2, then kw.isa= from left to right. */
	for (int i = 0; i < NFEAT; i++)
		want[i] = a64_feats[i].kind == 2 ? 1 : -1; /* -1: either */
	p = strstr(cmdline, "kw.isa=");
	if (p && (p == cmdline || p[-1] == ' ')) {
		p += 7;
		snprintf(mask, sizeof(mask), "%.*s", (int)strcspn(p, " "), p);
		for (char *tok = mask, *end; *tok; tok = *end ? end + 1 : end) {
			int on = *tok != '-', i;

			end = tok + strcspn(tok, ",");
			if (end - tok == 5 && !strncmp(tok, "armv8", 5)) {
				for (i = 0; i < NFEAT; i++)
					if (a64_feats[i].kind == 1)
						want[i] = 0;
				continue;
			}
			if (*tok == '-' || *tok == '+')
				tok++;
			i = feat_find(tok, end - tok);
			if (i >= 0 && a64_feats[i].kind == 1)
				want[i] = on ? -1 : 0;
		}
	}

	/* The Features line: known names, in HWCAP order, and AT_HWCAP to match. */
	for (p = feats; *p; ) {
		size_t len = strcspn(p, " ");
		int i = feat_find(p, len);

		if (i < 0)
			unknown++;
		else {
			ordered &= i > last;
			last = i;
			have[i] = 1;
			hw_want |= a64_feats[i].hwcap;
		}
		p += len;
		p += *p == ' ';
	}
	for (int i = 0; i < NFEAT; i++) {
		allowed |= a64_feats[i].hwcap;
		if (want[i] >= 0 && want[i] != have[i]) {
			printf("     %s: want %s\n", a64_feats[i].name, want[i] ? "listed" : "not listed");
			bad++;
		}
	}
	CHECK(!unknown && ordered && !bad && hwcap == hw_want && !(hwcap & ~allowed),
	      "cpuinfo Features: %s (kw.isa=%s); AT_HWCAP %#lx (want %#lx)", feats, mask, hwcap, hw_want);
	/*
	 * ID_AA64ISAR0_EL1 (kwemu's answer) says what AT_HWCAP says: AES (2 with
	 * PMULL), SHA1, SHA2 (2 with SHA512), CRC32, Atomic (2), SHA3; SHA512
	 * only together with SHA2 (kw.isa=-sha2 drops both).
	 */
	if (hwcap & (1UL << 11)) {
		unsigned long isar0 = MRS(id_aa64isar0_el1), want_isar0 = 0;

		if (hwcap & (1UL << 3))
			want_isar0 |= (hwcap & (1UL << 4) ? 2UL : 1UL) << 4;
		if (hwcap & (1UL << 5))
			want_isar0 |= 1UL << 8;
		if (hwcap & (1UL << 6))
			want_isar0 |= (hwcap & (1UL << 21) ? 2UL : 1UL) << 12;
		if (hwcap & (1UL << 7))
			want_isar0 |= 1UL << 16;
		if (hwcap & (1UL << 8))
			want_isar0 |= 2UL << 20;
		if (hwcap & (1UL << 17))
			want_isar0 |= 1UL << 32;
		CHECK(isar0 == want_isar0 && (!(hwcap & (1UL << 21)) || (hwcap & (1UL << 6))),
		      "ID_AA64ISAR0_EL1 %#lx matches AT_HWCAP (want %#lx); SHA512 only with SHA2", isar0, want_isar0);
	}
	CHECK(getauxval(AT_HWCAP2) == 0 && getauxval(29 /* AT_HWCAP3 */) == 0 && !getauxval(AT_SYSINFO_EHDR) &&
	      getauxval(AT_PLATFORM) && !strcmp((char *)getauxval(AT_PLATFORM), "aarch64") &&
	      getauxval(51 /* AT_MINSIGSTKSZ */) == 4720,
	      "auxv: HWCAP2 %#lx, HWCAP3 %#lx, no vDSO (%#lx), platform %s, MINSIGSTKSZ %lu (want 4720, as arm64 without SVE)",
	      getauxval(AT_HWCAP2), getauxval(29), getauxval(AT_SYSINFO_EHDR),
	      getauxval(AT_PLATFORM) ? (char *)getauxval(AT_PLATFORM) : "-", getauxval(51));

	/* The rest of arm64's cpuinfo, for kwemu's MIDR_EL1 (0x000f0000). */
	int midr_ok = read_line("/proc/cpuinfo", "CPU implementer", 1, line, sizeof(line)) && !strcmp(line, "0x00");
	midr_ok &= read_line("/proc/cpuinfo", "CPU architecture", 1, line, sizeof(line)) && !strcmp(line, "8");
	midr_ok &= read_line("/proc/cpuinfo", "CPU part", 1, line, sizeof(line)) && !strcmp(line, "0x000");
	midr_ok &= read_line("/proc/cpuinfo", "BogoMIPS", 1, line, sizeof(line));
	CHECK(midr_ok, "cpuinfo: CPU implementer 0x00, architecture 8, part 0x000, BogoMIPS");

	/* EL0's system registers (.agents/a64/isa.md): CTR, DCZID, TPIDRRO, MIDR, TPIDR. */
	unsigned long ctr = MRS(ctr_el0), dczid = MRS(dczid_el0), tpidrro = MRS(tpidrro_el0);
	unsigned long midr = MRS(midr_el1), tp = MRS(tpidr_el0);
	CHECK(ctr == 0x8444c004 && dczid == 4 && tpidrro == 0 && midr == 0x000f0000 &&
	      tp == (unsigned long)__builtin_thread_pointer(),
	      "MRS: CTR_EL0 %#lx, DCZID_EL0 %#lx, TPIDRRO_EL0 %#lx, MIDR_EL1 %#lx, TPIDR_EL0 = thread pointer",
	      ctr, dczid, tpidrro, midr);

	/* DC ZVA zeroes one aligned 64-byte block, nothing around it. */
	static uint8_t zbuf[192] __attribute__((aligned(64)));
	memset(zbuf, 0x77, sizeof(zbuf));
	__asm__ volatile("dc zva, %0" :: "r"(zbuf + 64 + 17) : "memory");
	int zok = zbuf[63] == 0x77 && zbuf[128] == 0x77;
	for (int i = 64; i < 128; i++)
		zok &= zbuf[i] == 0;
	CHECK(zok, "DC ZVA: 64 bytes zeroed");

	/*
	 * Misaligned LDR/STR of X, W and D registers, and LDP/STP, inside a page
	 * and across the boundary of two (SCTLR_EL1.A = 0 for user space).
	 */
	uint8_t *mp = mmap(NULL, 8192, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	int mis = mp == MAP_FAILED;
	for (int r = 0; !mis && r < 200; r++)
		for (int off = 4077; off < 4100; off++) {
			uint8_t *q = mp + off;
			uint64_t v = 0x0123456789abcdefUL * (uint64_t)(r + off), d = 0, x, y;
			uint32_t w;

			__asm__ volatile("str %1, [%0]" :: "r"(q), "r"(v) : "memory");
			for (int k = 7; k >= 0; k--)
				d = d << 8 | q[k];
			__asm__ volatile("ldr %0, [%1]" : "=r"(x) : "r"(q) : "memory");
			mis += d != v || x != v;
			__asm__ volatile("str %w2, [%1, #1]\n\tldr %w0, [%1, #1]" : "=&r"(x) : "r"(q), "r"(~v) : "memory");
			memcpy(&w, q + 1, 4);
			mis += (uint32_t)x != (uint32_t)~v || w != (uint32_t)~v;
			__asm__ volatile("fmov d16, %2\n\tstr d16, [%1, #3]\n\tldr d17, [%1, #3]\n\tfmov %0, d17"
					 : "=r"(x) : "r"(q), "r"(v) : "v16", "v17", "memory");
			memcpy(&d, q + 3, 8);
			mis += x != v || d != v;
			__asm__ volatile("stp %2, %3, [%4]\n\tldp %0, %1, [%4]"
					 : "=&r"(x), "=&r"(y) : "r"(v), "r"(~v), "r"(q + 5) : "memory");
			mis += x != v || y != ~v;
		}
	CHECK(!mis, "misaligned LDR/STR (X, W, D) and LDP/STP in a page and across pages (%d wrong)", mis);
	if (mp != MAP_FAILED)
		munmap(mp, 8192);

	/* UDF and BRK: SIGILL (ILL_ILLOPC) and SIGTRAP (TRAP_BRKPT) at their pc. */
	static const uint32_t udf[] = { 0x00000000, A64_RET }, brk[] = { 0xd4200000, A64_RET };
	long rv = 0;
	int sig = run_code(udf, 2, 0, 0, &rv), code = trap_code;
	unsigned long a1 = trap_addr;
	int sig2 = run_code(brk, 2, 0, 0, &rv);
	CHECK(sig == SIGILL && code == ILL_ILLOPC && sig2 == SIGTRAP && trap_code == TRAP_BRKPT && a1 == trap_addr,
	      "UDF: signal %d code %d, BRK: signal %d code %d, both at %#lx", sig, code, sig2, trap_code, a1);

	/* Optional features: an instruction of each runs iff it is listed. */
	int ran = 0, trapped = 0;
	bad = 0;
	for (int i = 0; i < NFEAT; i++) {
		const struct a64_feat *e = &a64_feats[i];
		uint32_t code2[2] = { e->probe, A64_RET };
		long r = 0;
		int rc = run_code(code2, 2, 3, 5, &r);

		if (rc == 0)
			ran++;
		else
			trapped++;
		if ((rc == 0) != have[i] || (rc && rc != SIGILL)) {
			printf("     %s (%#x): %s but %s %d\n", e->name, e->probe, have[i] ? "listed" : "not listed",
			       rc == 0 ? "ran" : "raised signal", rc);
			bad++;
		}
	}
	CHECK(!bad, "features: %d ran (listed), %d raised SIGILL (not listed)", ran, trapped);

	/*
	 * The signal frame: an fpsimd_context record (528 bytes) and the
	 * terminator in __reserved, x8 and the V registers and FPCR as they were
	 * at the svc, and sigreturn loading V9 and FPCR from the frame. All in
	 * one asm block, so the compiler keeps nothing in d8/d9 meanwhile.
	 */
	struct sigaction sa = { .sa_sigaction = on_frame, .sa_flags = SA_SIGINFO }, osa;
	unsigned long d8, d9, fpcr_after, pc_svc;
	sigaction(SIGUSR2, &sa, &osa);
	fr_ok = fr_ran = 0;
	__asm__ volatile(
		"mrs x9, fpcr\n\t"
		"bic x9, x9, #(3 << 22)\n\t"
		"orr x9, x9, #(1 << 22)\n\t"
		"msr fpcr, x9\n\t"
		"movz x9, #0x7788\n\tmovk x9, #0x5566, lsl #16\n\tmovk x9, #0x3344, lsl #32\n\tmovk x9, #0x1122, lsl #48\n\t"
		"fmov d8, x9\n\t"
		"mov x9, #1\n\t"
		"fmov d9, x9\n\t"
		"mov x0, %4\n\t"
		"mov x1, %5\n\t"
		"mov x8, %6\n\t"
		"adr %3, 1f\n\t"
		"svc #0\n"
		"1:\tfmov %0, d8\n\t"
		"fmov %1, d9\n\t"
		"mrs %2, fpcr\n\t"
		"bic x9, %2, #(3 << 22)\n\t"
		"msr fpcr, x9"
		: "=&r"(d8), "=&r"(d9), "=&r"(fpcr_after), "=&r"(pc_svc)
		: "r"((long)getpid()), "r"((long)SIGUSR2), "r"((long)SYS_kill)
		: "x0", "x1", "x8", "x9", "v8", "v9", "memory");
	sigaction(SIGUSR2, &osa, NULL);
	CHECK(fr_ran == 1 && fr_ok && fr_pc == pc_svc && d8 == 0x1122334455667788UL && d9 == 0xa5a5a5a5deadbeefUL &&
	      (fpcr_after & (3UL << 22)) == FPCR_RZ,
	      "signal frame: fpsimd record %s, pc %s, after sigreturn d8 %#lx, d9 %#lx, FPCR.RMode %lu (want 3)",
	      fr_ok ? "ok" : "BAD", fr_pc == pc_svc ? "ok" : "BAD", d8, d9, (fpcr_after >> 22) & 3);

	/*
	 * Return paths: musl's sigaction sets SA_RESTORER, so its handlers
	 * return to sa_restorer; without it they return to [sigpage].
	 */
	unsigned long sp_start = 0, sp_end = 0;
	struct k_sigaction_ ksa = { on_sigpage, SA_SIGINFO, NULL, 0 }, kold;
	int have_map = find_map("[sigpage]", &sp_start, &sp_end);
	fr_ran = 0;
	fr_lr = 0;
	syscall(SYS_rt_sigaction, SIGUSR2, &ksa, &kold, 8);
	kill(getpid(), SIGUSR2);
	syscall(SYS_rt_sigaction, SIGUSR2, &kold, NULL, 8);
	unsigned long lr_sigpage = fr_lr;
	sa.sa_sigaction = on_sigpage;
	sigaction(SIGUSR2, &sa, &osa);
	kill(getpid(), SIGUSR2);
	sigaction(SIGUSR2, &osa, NULL);
	CHECK(have_map && fr_ran == 2 && lr_sigpage == sp_start && fr_lr && (fr_lr < sp_start || fr_lr >= sp_end),
	      "signal return: without SA_RESTORER to [sigpage] %#lx (lr %#lx), with it (musl) to %#lx",
	      sp_start, lr_sigpage, fr_lr);

	/* No vDSO: clock_gettime is a system call, and time goes on. */
	struct timespec t0, t1;
	clock_gettime(CLOCK_MONOTONIC, &t0);
	usleep(2000);
	clock_gettime(CLOCK_MONOTONIC, &t1);
	CHECK((t1.tv_sec - t0.tv_sec) * 1000000000L + (t1.tv_nsec - t0.tv_nsec) >= 2000000L,
	      "clock_gettime without a vDSO: monotonic clock advanced over usleep(2000)");
}

/*
 * ISA results: the optional features' known answers, scalar FP through
 * FPCR and FPSR, and the user state the kernel keeps per task (V registers,
 * FPCR, FPSR, TPIDR_EL0, the exclusive monitor). `kwtest isa` runs only
 * these; under `qemu-aarch64 -cpu cortex-a53` they pass too, except the
 * FPCR/FPSR read-back (qemu keeps AArch32's Len, Stride and NZCV bits) and
 * the exec check (qemu-user cannot exec a foreign binary). Everything here
 * is integer or scalar FP: kwemu has no AdvSIMD FP yet.
 */
#define CX_EXT ".arch_extension aes\n\t.arch_extension sha2\n\t.arch_extension sha3\n\t.arch_extension crc\n\t"
/* d = insn(d, n, m) on whole q registers: v0 = d, v1 = n, v2 = m */
#define CX3(fn, insn) static void fn(uint8_t *d, const uint8_t *n, const uint8_t *m) { \
	__asm__ volatile(CX_EXT "ldr q0, [%0]\n\tldr q1, [%1]\n\tldr q2, [%2]\n\t" insn "\n\tstr q0, [%0]" \
			 : : "r"(d), "r"(n), "r"(m) : "v0", "v1", "v2", "memory"); }
/* d = insn(d, n) */
#define CX2(fn, insn) static void fn(uint8_t *d, const uint8_t *n) { \
	__asm__ volatile(CX_EXT "ldr q0, [%0]\n\tldr q1, [%1]\n\t" insn "\n\tstr q0, [%0]" \
			 : : "r"(d), "r"(n) : "v0", "v1", "memory"); }
CX2(cx_aese, "aese v0.16b, v1.16b")
CX2(cx_aesd, "aesd v0.16b, v1.16b")
CX2(cx_aesmc, "aesmc v0.16b, v1.16b")
CX2(cx_aesimc, "aesimc v0.16b, v1.16b")
CX3(cx_sha1c, "sha1c q0, s1, v2.4s")
CX3(cx_sha1p, "sha1p q0, s1, v2.4s")
CX3(cx_sha1m, "sha1m q0, s1, v2.4s")
CX3(cx_sha1su0, "sha1su0 v0.4s, v1.4s, v2.4s")
CX2(cx_sha1h, "sha1h s0, s1")
CX2(cx_sha1su1, "sha1su1 v0.4s, v1.4s")
CX3(cx_sha256h, "sha256h q0, q1, v2.4s")
CX3(cx_sha256h2, "sha256h2 q0, q1, v2.4s")
CX3(cx_sha256su1, "sha256su1 v0.4s, v1.4s, v2.4s")
CX2(cx_sha256su0, "sha256su0 v0.4s, v1.4s")
CX3(cx_sha512h, "sha512h q0, q1, v2.2d")
CX3(cx_sha512h2, "sha512h2 q0, q1, v2.2d")
CX3(cx_sha512su1, "sha512su1 v0.2d, v1.2d, v2.2d")
CX2(cx_sha512su0, "sha512su0 v0.2d, v1.2d")
#define CXCRC(fn, insn, reg) static uint32_t fn(uint32_t a, uint64_t v) { uint32_t r; \
	__asm__ volatile(CX_EXT insn " %w0, %w1, %" reg "2" : "=r"(r) : "r"(a), "r"(v)); return r; }
CXCRC(cx_crc32b, "crc32b", "w")
CXCRC(cx_crc32h, "crc32h", "w")
CXCRC(cx_crc32w, "crc32w", "w")
CXCRC(cx_crc32x, "crc32x", "x")
CXCRC(cx_crc32cb, "crc32cb", "w")
CXCRC(cx_crc32ch, "crc32ch", "w")
CXCRC(cx_crc32cw, "crc32cw", "w")
CXCRC(cx_crc32cx, "crc32cx", "x")

static uint32_t cx_be32(const uint8_t *p) { return (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | p[3]; }
static void cx_put32(uint8_t *p, uint32_t v) { memcpy(p, &v, 4); }
static uint32_t cx_get32(const uint8_t *p) { uint32_t v; memcpy(&v, p, 4); return v; }

/* AES-128, FIPS-197 C.1: the key expanded through AESE, encrypt and decrypt. */
static int kat_aes(void)
{
	static const uint8_t key[16] = { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15 };
	static const uint8_t pt[16] = { 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
					0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff };
	static const uint8_t ct[16] = { 0x69, 0xc4, 0xe0, 0xd8, 0x6a, 0x7b, 0x04, 0x30,
					0xd8, 0xcd, 0xb7, 0x80, 0x70, 0xb4, 0xc5, 0x5a };
	static const uint8_t rcon[10] = { 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36 };
	static const uint8_t zero16[16] __attribute__((aligned(16)));
	uint8_t rk[11][16] __attribute__((aligned(16))), s[16] __attribute__((aligned(16)));
	uint8_t dk[16] __attribute__((aligned(16)));
	uint32_t w[44];
	int ok;

	for (int i = 0; i < 4; i++)
		w[i] = cx_get32(key + 4 * i);
	for (int i = 4; i < 44; i++) {
		uint32_t x = w[i - 1];

		if (i % 4 == 0) {
			/* SubWord by AESE: with four equal columns ShiftRows is the identity. */
			x = x >> 8 | x << 24;
			for (int j = 0; j < 4; j++)
				cx_put32(s + 4 * j, x);
			cx_aese(s, zero16);
			x = cx_get32(s) ^ rcon[i / 4 - 1];
		}
		w[i] = w[i - 4] ^ x;
	}
	for (int r = 0; r < 11; r++)
		for (int j = 0; j < 4; j++)
			cx_put32(rk[r] + 4 * j, w[4 * r + j]);
	memcpy(s, pt, 16);
	for (int r = 0; r < 9; r++) {
		cx_aese(s, rk[r]);
		cx_aesmc(s, s);
	}
	cx_aese(s, rk[9]);
	for (int i = 0; i < 16; i++)
		s[i] ^= rk[10][i];
	ok = !memcmp(s, ct, 16);
	/* The equivalent inverse cipher. */
	cx_aesd(s, rk[10]);
	for (int r = 9; r >= 1; r--) {
		cx_aesimc(s, s);
		cx_aesimc(dk, rk[r]);
		cx_aesd(s, dk);
	}
	for (int i = 0; i < 16; i++)
		s[i] ^= rk[0][i];
	return ok && !memcmp(s, pt, 16);
}

/* lo = a[0] * b[0] (PMULL), hi = a[1] * b[1] (PMULL2), carry-less. */
static void cx_pmull(const uint64_t a[2], const uint64_t b[2], uint64_t lo[2], uint64_t hi[2])
{
	__asm__ volatile(CX_EXT "ldr q0, [%0]\n\tldr q1, [%1]\n\t"
			 "pmull v2.1q, v0.1d, v1.1d\n\tpmull2 v3.1q, v0.2d, v1.2d\n\t"
			 "str q2, [%2]\n\tstr q3, [%3]"
			 : : "r"(a), "r"(b), "r"(lo), "r"(hi) : "v0", "v1", "v2", "v3", "memory");
}

static void clmul_ref(uint64_t a, uint64_t b, uint64_t r[2])
{
	r[0] = r[1] = 0;
	for (int i = 0; i < 64; i++)
		if (b >> i & 1) {
			r[0] ^= a << i;
			r[1] ^= i ? a >> (64 - i) : 0;
		}
}

/* A GCM block as a polynomial: bit i is the coefficient of x^i (bit-reflected). */
static void gf_load(const uint8_t *b, uint64_t x[2])
{
	x[0] = x[1] = 0;
	for (int j = 0; j < 16; j++) {
		uint64_t r = 0;

		for (int k = 0; k < 8; k++)
			r |= (uint64_t)(b[j] >> (7 - k) & 1) << k;
		x[j / 8] |= r << (8 * (j % 8));
	}
}

static void gf_store(const uint64_t x[2], uint8_t *b)
{
	for (int j = 0; j < 16; j++) {
		uint8_t v = x[j / 8] >> (8 * (j % 8)), r = 0;

		for (int k = 0; k < 8; k++)
			r |= (v >> k & 1) << (7 - k);
		b[j] = r;
	}
}

/* x = x * h in GF(2^128) mod x^128 + x^7 + x^2 + x + 1, the product by PMULL/PMULL2. */
static void gf_mul(uint64_t x[2], const uint64_t h[2])
{
	uint64_t hs[2] = { h[1], h[0] }, p0[2], p3[2], m0[2], m1[2], r[4];

	cx_pmull(x, h, p0, p3);
	cx_pmull(x, hs, m0, m1);
	r[0] = p0[0];
	r[1] = p0[1] ^ m0[0] ^ m1[0];
	r[2] = p3[0] ^ m0[1] ^ m1[1];
	r[3] = p3[1];
	for (int i = 255; i >= 128; i--)
		if (r[i >> 6] >> (i & 63) & 1) {
			static const int t[4] = { 0, 1, 2, 7 };

			r[i >> 6] ^= 1UL << (i & 63);
			for (int k = 0; k < 4; k++)
				r[(i - 128 + t[k]) >> 6] ^= 1UL << ((i - 128 + t[k]) & 63);
		}
	x[0] = r[0];
	x[1] = r[1];
}

/*
 * PMULL and PMULL2 (.1Q) against a C carry-less multiply, then GHASH of the
 * GCM specification's test case 2 (H, one ciphertext block, the lengths).
 */
static int kat_pmull(void)
{
	static const uint8_t H[16] = { 0x66, 0xe9, 0x4b, 0xd4, 0xef, 0x8a, 0x2c, 0x3b,
				       0x88, 0x4c, 0xfa, 0x59, 0xca, 0x34, 0x2b, 0x2e };
	static const uint8_t C[16] = { 0x03, 0x88, 0xda, 0xce, 0x60, 0xb6, 0xa3, 0x92,
				       0xf3, 0x28, 0xc2, 0xb9, 0x71, 0xb2, 0xfe, 0x78 };
	static const uint8_t want[16] = { 0xf3, 0x8c, 0xbb, 0x1a, 0xd6, 0x92, 0x23, 0xdc,
					  0xc3, 0x45, 0x7a, 0xe5, 0xb6, 0xb0, 0xf8, 0x85 };
	uint8_t len[16] = { 0 }, out[16];
	uint64_t a[2], b[2], lo[2], hi[2], rl[2], rh[2], y[2] = { 0, 0 }, h[2], c[2], l[2];
	uint64_t s = 0x9e3779b97f4a7c15UL;
	int bad = 0;

	for (int i = 0; i < 64; i++) {
		for (int k = 0; k < 2; k++) {
			s ^= s << 13, s ^= s >> 7, s ^= s << 17;
			a[k] = i == 0 ? ~0UL : s;
			s ^= s << 13, s ^= s >> 7, s ^= s << 17;
			b[k] = i == 0 ? ~0UL : s;
		}
		cx_pmull(a, b, lo, hi);
		clmul_ref(a[0], b[0], rl);
		clmul_ref(a[1], b[1], rh);
		bad += lo[0] != rl[0] || lo[1] != rl[1] || hi[0] != rh[0] || hi[1] != rh[1];
	}
	len[15] = 0x80;	/* len(A) = 0, len(C) = 128 bits */
	gf_load(H, h);
	gf_load(C, c);
	gf_load(len, l);
	y[0] ^= c[0], y[1] ^= c[1];
	gf_mul(y, h);
	y[0] ^= l[0], y[1] ^= l[1];
	gf_mul(y, h);
	gf_store(y, out);
	return !bad && !memcmp(out, want, 16);
}

static void cx_add4(uint8_t *d, const uint8_t *a, const uint32_t *k)
{
	for (int i = 0; i < 4; i++)
		cx_put32(d + 4 * i, cx_get32(a + 4 * i) + k[i]);
}

static void sha256_block(uint32_t st[8], const uint8_t *blk)
{
	static const uint32_t K[64] = {
		0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
		0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
		0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
		0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
		0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
		0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
		0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
		0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
	};
	uint8_t w[4][16] __attribute__((aligned(16))), abcd[16] __attribute__((aligned(16)));
	uint8_t efgh[16] __attribute__((aligned(16))), old[16] __attribute__((aligned(16)));
	uint8_t wk[16] __attribute__((aligned(16)));

	for (int i = 0; i < 16; i++)
		cx_put32(w[i / 4] + 4 * (i % 4), cx_be32(blk + 4 * i));
	for (int i = 0; i < 4; i++) {
		cx_put32(abcd + 4 * i, st[i]);
		cx_put32(efgh + 4 * i, st[4 + i]);
	}
	for (int q = 0; q < 16; q++) {
		cx_add4(wk, w[q % 4], K + 4 * q);
		memcpy(old, abcd, 16);
		cx_sha256h(abcd, efgh, wk);
		cx_sha256h2(efgh, old, wk);
		if (q < 12) {
			cx_sha256su0(w[q % 4], w[(q + 1) % 4]);
			cx_sha256su1(w[q % 4], w[(q + 2) % 4], w[(q + 3) % 4]);
		}
	}
	for (int i = 0; i < 4; i++) {
		st[i] += cx_get32(abcd + 4 * i);
		st[4 + i] += cx_get32(efgh + 4 * i);
	}
}

static void sha1_block(uint32_t st[5], const uint8_t *blk)
{
	static const uint32_t K[4] = { 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xca62c1d6 };
	uint8_t w[4][16] __attribute__((aligned(16))), abcd[16] __attribute__((aligned(16)));
	uint8_t wk[16] __attribute__((aligned(16))), e[16] __attribute__((aligned(16))) = { 0 };
	uint8_t en[16] __attribute__((aligned(16)));

	for (int i = 0; i < 16; i++)
		cx_put32(w[i / 4] + 4 * (i % 4), cx_be32(blk + 4 * i));
	for (int i = 0; i < 4; i++)
		cx_put32(abcd + 4 * i, st[i]);
	cx_put32(e, st[4]);
	for (int q = 0; q < 20; q++) {
		uint32_t k[4] = { K[q / 5], K[q / 5], K[q / 5], K[q / 5] };

		cx_add4(wk, w[q % 4], k);
		memset(en, 0xa5, 16);
		cx_sha1h(en, abcd);
		if (q / 5 == 0)
			cx_sha1c(abcd, e, wk);
		else if (q / 5 == 2)
			cx_sha1m(abcd, e, wk);
		else
			cx_sha1p(abcd, e, wk);
		memcpy(e, en, 16);
		if (q < 16) {
			cx_sha1su0(w[q % 4], w[(q + 1) % 4], w[(q + 2) % 4]);
			cx_sha1su1(w[q % 4], w[(q + 3) % 4]);
		}
	}
	for (int i = 0; i < 4; i++)
		st[i] += cx_get32(abcd + 4 * i);
	st[4] += cx_get32(e);
}

/* FIPS 180's "abc" and two-block message, padded; returns the block count. */
static int sha_pad(uint8_t out[128], int m)
{
	const char *msg = m ? "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq" : "abc";
	size_t n = strlen(msg);
	int blocks = n < 56 ? 1 : 2;

	memset(out, 0, 128);
	memcpy(out, msg, n);
	out[n] = 0x80;
	for (int i = 0; i < 8; i++)
		out[64 * blocks - 1 - i] = (uint8_t)((uint64_t)n * 8 >> (8 * i));
	return blocks;
}

static int kat_sha1(void)
{
	static const uint32_t want[2][5] = {
		{ 0xa9993e36, 0x4706816a, 0xba3e2571, 0x7850c26c, 0x9cd0d89d },
		{ 0x84983e44, 0x1c3bd26e, 0xbaae4aa1, 0xf95129e5, 0xe54670f1 },
	};
	int ok = 1;

	for (int m = 0; m < 2; m++) {
		uint8_t buf[128];
		uint32_t st[5] = { 0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0 };
		int nb = sha_pad(buf, m);

		for (int b = 0; b < nb; b++)
			sha1_block(st, buf + 64 * b);
		ok &= !memcmp(st, want[m], sizeof(st));
	}
	return ok;
}

static int kat_sha2(void)
{
	static const uint32_t want[2][8] = {
		{ 0xba7816bf, 0x8f01cfea, 0x414140de, 0x5dae2223, 0xb00361a3, 0x96177a9c, 0xb410ff61, 0xf20015ad },
		{ 0x248d6a61, 0xd20638b8, 0xe5c02693, 0x0c3e6039, 0xa33ce459, 0x64ff2167, 0xf6ecedd4, 0x19db06c1 },
	};
	int ok = 1;

	for (int m = 0; m < 2; m++) {
		uint8_t buf[128];
		uint32_t st[8] = { 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
				   0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19 };
		int nb = sha_pad(buf, m);

		for (int b = 0; b < nb; b++)
			sha256_block(st, buf + 64 * b);
		ok &= !memcmp(st, want[m], sizeof(st));
	}
	return ok;
}

/*
 * SHA-512 of one 128-byte block, the way OpenSSL's sha512_block_armv8
 * drives the instructions: the state in four 2D registers (ab, cd, ef, gh)
 * and a fifth that rotates through the roles, two rounds per step.
 */
static const uint64_t k512[80] = {
	0x428a2f98d728ae22, 0x7137449123ef65cd, 0xb5c0fbcfec4d3b2f, 0xe9b5dba58189dbbc, 0x3956c25bf348b538, 0x59f111f1b605d019,
	0x923f82a4af194f9b, 0xab1c5ed5da6d8118, 0xd807aa98a3030242, 0x12835b0145706fbe, 0x243185be4ee4b28c, 0x550c7dc3d5ffb4e2,
	0x72be5d74f27b896f, 0x80deb1fe3b1696b1, 0x9bdc06a725c71235, 0xc19bf174cf692694, 0xe49b69c19ef14ad2, 0xefbe4786384f25e3,
	0x0fc19dc68b8cd5b5, 0x240ca1cc77ac9c65, 0x2de92c6f592b0275, 0x4a7484aa6ea6e483, 0x5cb0a9dcbd41fbd4, 0x76f988da831153b5,
	0x983e5152ee66dfab, 0xa831c66d2db43210, 0xb00327c898fb213f, 0xbf597fc7beef0ee4, 0xc6e00bf33da88fc2, 0xd5a79147930aa725,
	0x06ca6351e003826f, 0x142929670a0e6e70, 0x27b70a8546d22ffc, 0x2e1b21385c26c926, 0x4d2c6dfc5ac42aed, 0x53380d139d95b3df,
	0x650a73548baf63de, 0x766a0abb3c77b2a8, 0x81c2c92e47edaee6, 0x92722c851482353b, 0xa2bfe8a14cf10364, 0xa81a664bbc423001,
	0xc24b8b70d0f89791, 0xc76c51a30654be30, 0xd192e819d6ef5218, 0xd69906245565a910, 0xf40e35855771202a, 0x106aa07032bbd1b8,
	0x19a4c116b8d2d0c8, 0x1e376c085141ab53, 0x2748774cdf8eeb99, 0x34b0bcb5e19b48a8, 0x391c0cb3c5c95a63, 0x4ed8aa4ae3418acb,
	0x5b9cca4f7763e373, 0x682e6ff3d6b2b8a3, 0x748f82ee5defb2fc, 0x78a5636f43172f60, 0x84c87814a1f0ab72, 0x8cc702081a6439ec,
	0x90befffa23631e28, 0xa4506cebde82bde9, 0xbef9a3f7b2c67915, 0xc67178f2e372532b, 0xca273eceea26619c, 0xd186b8c721c0c207,
	0xeada7dd6cde0eb1e, 0xf57d4f7fee6ed178, 0x06f067aa72176fba, 0x0a637dc5a2c898a6, 0x113f9804bef90dae, 0x1b710b35131c471b,
	0x28db77f523047d84, 0x32caab7b40c72493, 0x3c9ebe0a15c9bebc, 0x431d67c49c100d4c, 0x4cc5d4becb3e42b6, 0x597f299cfc657e2a,
	0x5fcb6fab3ad6faec, 0x6c44198c4a475817,
};
struct q128 { uint64_t v[2]; } __attribute__((aligned(16)));
static struct q128 q_pair(uint64_t lo, uint64_t hi) { struct q128 r = { { lo, hi } }; return r; }
static struct q128 q_add(struct q128 a, struct q128 b) { return q_pair(a.v[0] + b.v[0], a.v[1] + b.v[1]); }
static struct q128 q_ext8(struct q128 n, struct q128 m) { return q_pair(n.v[1], m.v[0]); }

static void sha512_block(uint64_t st[8], const uint8_t *blk)
{
	struct q128 msg[8], h[5], saved[4];
	int hi[5] = { 0, 1, 2, 3, 4 };

	for (int i = 0; i < 16; i++) {
		uint64_t v = 0;

		for (int k = 0; k < 8; k++)
			v = v << 8 | blk[8 * i + k];
		msg[i / 2].v[i % 2] = v;
	}
	for (int i = 0; i < 4; i++)
		saved[i] = h[i] = q_pair(st[2 * i], st[2 * i + 1]);
	for (int i = 0; i < 40; i++) {
		struct q128 *m0 = &msg[i % 8], kw, v5, v6, v7, t3;
		int n[5] = { hi[3], hi[0], hi[4], hi[2], hi[1] };

		kw = q_add(*m0, q_pair(k512[2 * i], k512[2 * i + 1]));
		kw = q_ext8(kw, kw);
		v5 = q_ext8(h[hi[2]], h[hi[3]]);
		v6 = q_ext8(h[hi[1]], h[hi[2]]);
		t3 = q_add(h[hi[3]], kw);
		if (i < 32)
			cx_sha512su0((uint8_t *)m0, (uint8_t *)&msg[(i + 1) % 8]);
		v7 = q_ext8(msg[(i + 4) % 8], msg[(i + 5) % 8]);
		cx_sha512h((uint8_t *)&t3, (uint8_t *)&v5, (uint8_t *)&v6);
		if (i < 32)
			cx_sha512su1((uint8_t *)m0, (uint8_t *)&msg[(i + 7) % 8], (uint8_t *)&v7);
		h[hi[4]] = q_add(h[hi[1]], t3);
		cx_sha512h2((uint8_t *)&t3, (uint8_t *)&h[hi[1]], (uint8_t *)&h[hi[0]]);
		h[hi[3]] = t3;
		memcpy(hi, n, sizeof(n));
	}
	for (int i = 0; i < 4; i++) {
		struct q128 r = q_add(h[hi[i]], saved[i]);

		st[2 * i] = r.v[0];
		st[2 * i + 1] = r.v[1];
	}
}

/* SHA-512 of FIPS 180 "abc" (one block) and its 896-bit message (two). */
static int kat_sha512(void)
{
	static const char *msgs[2] = { "abc", "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmn"
					     "hijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu" };
	static const uint64_t want[2][8] = {
		{ 0xddaf35a193617aba, 0xcc417349ae204131, 0x12e6fa4e89a97ea2, 0x0a9eeee64b55d39a,
		  0x2192992a274fc1a8, 0x36ba3c23a3feebbd, 0x454d4423643ce80e, 0x2a9ac94fa54ca49f },
		{ 0x8e959b75dae313da, 0x8cf4f72814fc143f, 0x8f7779c6eb9f7fa1, 0x7299aeadb6889018,
		  0x501d289e4900f7e4, 0x331b99dec4b5433a, 0xc7d329eeb6dd2654, 0x5e96e55b874be909 },
	};
	int ok = 1;

	for (int m = 0; m < 2; m++) {
		uint8_t buf[256] = { 0 };
		size_t n = strlen(msgs[m]);
		int blocks = n < 112 ? 1 : 2;
		uint64_t st[8] = { 0x6a09e667f3bcc908, 0xbb67ae8584caa73b, 0x3c6ef372fe94f82b, 0xa54ff53a5f1d36f1,
				   0x510e527fade682d1, 0x9b05688c2b3e6c1f, 0x1f83d9abfb41bd6b, 0x5be0cd19137e2179 };

		memcpy(buf, msgs[m], n);
		buf[n] = 0x80;
		for (int i = 0; i < 8; i++)
			buf[128 * blocks - 1 - i] = (uint8_t)((uint64_t)n * 8 >> (8 * i));
		for (int b = 0; b < blocks; b++)
			sha512_block(st, buf + 128 * b);
		ok &= !memcmp(st, want[m], sizeof(st));
	}
	return ok;
}

/*
 * Keccak-f[1600] on the SHA3 instructions, the way OpenSSL's ARMv8.2 path
 * (KeccakF1600_ce) uses them: theta's column sums by EOR3, D by RAX1, rho
 * by XAR, chi by BCAX. Each of the 25 lanes is a 2D register, so lane 0
 * and lane 1 of the vectors are two independent states.
 */
typedef struct { uint64_t v[2]; } __attribute__((aligned(16))) kq;
#define K_EXT ".arch_extension sha3\n\t"
static void k_eor3(kq *d, const kq *n, const kq *m, const kq *a) {
	__asm__ volatile(K_EXT "ldr q1, [%1]\n\tldr q2, [%2]\n\tldr q3, [%3]\n\teor3 v0.16b, v1.16b, v2.16b, v3.16b\n\tstr q0, [%0]"
		: : "r"(d), "r"(n), "r"(m), "r"(a) : "v0", "v1", "v2", "v3", "memory");
}
static void k_bcax(kq *d, const kq *n, const kq *m, const kq *a) {
	__asm__ volatile(K_EXT "ldr q1, [%1]\n\tldr q2, [%2]\n\tldr q3, [%3]\n\tbcax v0.16b, v1.16b, v2.16b, v3.16b\n\tstr q0, [%0]"
		: : "r"(d), "r"(n), "r"(m), "r"(a) : "v0", "v1", "v2", "v3", "memory");
}
static void k_rax1(kq *d, const kq *n, const kq *m) {
	__asm__ volatile(K_EXT "ldr q1, [%1]\n\tldr q2, [%2]\n\trax1 v0.2d, v1.2d, v2.2d\n\tstr q0, [%0]"
		: : "r"(d), "r"(n), "r"(m) : "v0", "v1", "v2", "memory");
}
#define K_XAR1(k) case k: __asm__ volatile(K_EXT "ldr q1, [%1]\n\tldr q2, [%2]\n\txar v0.2d, v1.2d, v2.2d, %3\n\tstr q0, [%0]" \
		: : "r"(d), "r"(n), "r"(m), "i"(k) : "v0", "v1", "v2", "memory"); break;
#define K_XAR8(k) K_XAR1(k) K_XAR1(k + 1) K_XAR1(k + 2) K_XAR1(k + 3) K_XAR1(k + 4) K_XAR1(k + 5) K_XAR1(k + 6) K_XAR1(k + 7)
static void k_xar(kq *d, const kq *n, const kq *m, int imm) {
	switch (imm) { K_XAR8(0) K_XAR8(8) K_XAR8(16) K_XAR8(24) K_XAR8(32) K_XAR8(40) K_XAR8(48) K_XAR8(56) }
}

static const uint64_t keccak_rc[24] = {
	0x0000000000000001, 0x0000000000008082, 0x800000000000808a, 0x8000000080008000, 0x000000000000808b, 0x0000000080000001,
	0x8000000080008081, 0x8000000000008009, 0x000000000000008a, 0x0000000000000088, 0x0000000080008009, 0x000000008000000a,
	0x000000008000808b, 0x800000000000008b, 0x8000000000008089, 0x8000000000008003, 0x8000000000008002, 0x8000000000000080,
	0x000000000000800a, 0x800000008000000a, 0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
};
/* rotation of lane x + 5y */
static const int keccak_rho[25] = { 0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14 };

static void keccak_f(kq a[25]) {
	kq c[5], d[5], b[25];
	for (int r = 0; r < 24; r++) {
		for (int x = 0; x < 5; x++) {
			k_eor3(&c[x], &a[x], &a[x + 5], &a[x + 10]);
			k_eor3(&c[x], &c[x], &a[x + 15], &a[x + 20]);
		}
		for (int x = 0; x < 5; x++) k_rax1(&d[x], &c[(x + 4) % 5], &c[(x + 1) % 5]);
		/* theta and rho by XAR (rotate right by 64 - r), pi by where it goes */
		for (int x = 0; x < 5; x++)
			for (int y = 0; y < 5; y++)
				k_xar(&b[y + 5 * ((2 * x + 3 * y) % 5)], &a[x + 5 * y], &d[x], (64 - keccak_rho[x + 5 * y]) & 63);
		for (int y = 0; y < 5; y++)
			for (int x = 0; x < 5; x++)
				k_bcax(&a[x + 5 * y], &b[x + 5 * y], &b[(x + 2) % 5 + 5 * y], &b[(x + 1) % 5 + 5 * y]);
		a[0].v[0] ^= keccak_rc[r];
		a[0].v[1] ^= keccak_rc[r];
	}
}

/* One-block sponge (message < rate) in both lanes: msg0 in lane 0, msg1 in lane 1. */
static void keccak_one(uint8_t *out0, uint8_t *out1, int outlen, int rate, uint8_t pad, const char *msg0, const char *msg1)
{
	kq a[25];
	uint8_t blk[2][200];
	const char *msg[2] = { msg0, msg1 };
	memset(a, 0, sizeof a);
	for (int l = 0; l < 2; l++) {
		size_t n = strlen(msg[l]);
		memset(blk[l], 0, sizeof blk[l]);
		memcpy(blk[l], msg[l], n);
		blk[l][n] ^= pad;
		blk[l][rate - 1] ^= 0x80;
		for (int i = 0; i < rate / 8; i++) { uint64_t w; memcpy(&w, blk[l] + 8 * i, 8); a[i].v[l] ^= w; }
	}
	keccak_f(a);
	for (int i = 0; i < outlen / 8; i++) { memcpy(out0 + 8 * i, &a[i].v[0], 8); memcpy(out1 + 8 * i, &a[i].v[1], 8); }
}

/* SHA3-256 of "" and "abc" (one permutation, one per lane), SHAKE128 of "". */
static int kat_sha3(void)
{
	static const uint8_t want_e[32] = { 0xa7, 0xff, 0xc6, 0xf8, 0xbf, 0x1e, 0xd7, 0x66, 0x51, 0xc1, 0x47, 0x56, 0xa0, 0x61, 0xd6, 0x62,
					    0xf5, 0x80, 0xff, 0x4d, 0xe4, 0x3b, 0x49, 0xfa, 0x82, 0xd8, 0x0a, 0x4b, 0x80, 0xf8, 0x43, 0x4a };
	static const uint8_t want_abc[32] = { 0x3a, 0x98, 0x5d, 0xa7, 0x4f, 0xe2, 0x25, 0xb2, 0x04, 0x5c, 0x17, 0x2d, 0x6b, 0xd3, 0x90, 0xbd,
					      0x85, 0x5f, 0x08, 0x6e, 0x3e, 0x9d, 0x52, 0x5b, 0x46, 0xbf, 0xe2, 0x45, 0x11, 0x43, 0x15, 0x32 };
	static const uint8_t want_shake[32] = { 0x7f, 0x9c, 0x2b, 0xa4, 0xe8, 0x8f, 0x82, 0x7d, 0x61, 0x60, 0x45, 0x50, 0x76, 0x05, 0x85, 0x3e,
						0xd7, 0x3b, 0x80, 0x93, 0xf6, 0xef, 0xbc, 0x88, 0xeb, 0x1a, 0x6e, 0xac, 0xfa, 0x66, 0xef, 0x26 };
	uint8_t a[32], b[32];
	int ok;

	keccak_one(a, b, 32, 136, 0x06, "", "abc");
	ok = !memcmp(a, want_e, 32) && !memcmp(b, want_abc, 32);
	keccak_one(a, b, 32, 168, 0x1f, "", "");
	return ok && !memcmp(a, want_shake, 32);
}

/* CRC-32 and CRC-32C of "123456789": by bytes, by X then B, by W, H, B, H. */
static int kat_crc32(void)
{
	const char *s = "123456789";
	uint32_t a = ~0u, c = ~0u, w4 = cx_get32((const uint8_t *)s);
	uint64_t v, h56 = (uint8_t)s[4] | (uint64_t)(uint8_t)s[5] << 8, h89 = (uint8_t)s[7] | (uint64_t)(uint8_t)s[8] << 8;
	int ok;

	for (int i = 0; i < 9; i++) {
		a = cx_crc32b(a, (uint8_t)s[i]);
		c = cx_crc32cb(c, (uint8_t)s[i]);
	}
	ok = ~a == 0xcbf43926 && ~c == 0xe3069283;
	memcpy(&v, s, 8);
	a = cx_crc32b(cx_crc32x(~0u, v), '9');
	c = cx_crc32cb(cx_crc32cx(~0u, v), '9');
	ok &= ~a == 0xcbf43926 && ~c == 0xe3069283;
	a = cx_crc32h(cx_crc32b(cx_crc32h(cx_crc32w(~0u, w4), h56), (uint8_t)s[6]), h89);
	c = cx_crc32ch(cx_crc32cb(cx_crc32ch(cx_crc32cw(~0u, w4), h56), (uint8_t)s[6]), h89);
	return ok && ~a == 0xcbf43926 && ~c == 0xe3069283;
}

/*
 * LSE atomics: each atomic memory operation, SWP, CAS and CASP once (or
 * twice) with a known answer, on B, H, W and X.
 */
#define LSE_EXT ".arch_extension lse\n\t"
#define LSEOP(fn, insn, T, r) static T fn(T *p, T v) { T old; \
	__asm__ volatile(LSE_EXT insn " %" r "1, %" r "0, [%2]" : "=&r"(old) : "r"(v), "r"(p) : "memory"); return old; }
LSEOP(lse_ldaddal_x, "ldaddal", uint64_t, "x")
LSEOP(lse_ldclrl_w, "ldclrl", uint32_t, "w")
LSEOP(lse_ldeorah, "ldeorah", uint16_t, "w")
LSEOP(lse_ldsetb, "ldsetb", uint8_t, "w")
LSEOP(lse_ldsmax_w, "ldsmax", uint32_t, "w")
LSEOP(lse_ldsmin_x, "ldsmin", uint64_t, "x")
LSEOP(lse_ldumaxb, "ldumaxb", uint8_t, "w")
LSEOP(lse_lduminh, "lduminh", uint16_t, "w")
LSEOP(lse_swpal_x, "swpal", uint64_t, "x")
LSEOP(lse_swpb, "swpb", uint8_t, "w")
/* CAS: returns the old value (what Rs holds after) */
#define LSECAS(fn, insn, T, r) static T fn(T *p, T cmp, T v) { \
	__asm__ volatile(LSE_EXT insn " %" r "0, %" r "2, [%1]" : "+&r"(cmp) : "r"(p), "r"(v) : "memory"); return cmp; }
LSECAS(lse_casal_x, "casal", uint64_t, "x")
LSECAS(lse_casa_w, "casa", uint32_t, "w")
LSECAS(lse_casb, "casb", uint8_t, "w")
LSECAS(lse_caslh, "caslh", uint16_t, "w")
/* CASPAL on a 16-byte pair: Rs:Rs+1 = x4:x5 (in: compare, out: old), Rt:Rt+1 = x6:x7 */
static void lse_caspal(uint64_t *p, uint64_t *c0, uint64_t *c1, uint64_t n0, uint64_t n1)
{
	register uint64_t s0 __asm__("x4") = *c0, s1 __asm__("x5") = *c1;
	register uint64_t t0 __asm__("x6") = n0, t1 __asm__("x7") = n1;

	__asm__ volatile(LSE_EXT "caspal x4, x5, x6, x7, [%2]" : "+r"(s0), "+r"(s1) : "r"(p), "r"(t0), "r"(t1) : "memory");
	*c0 = s0;
	*c1 = s1;
}
/* STADD (LDADD with Rt = XZR) */
static void lse_staddl_x(uint64_t *p, uint64_t v)
{
	__asm__ volatile(LSE_EXT "staddl %0, [%1]" : : "r"(v), "r"(p) : "memory");
}

static int kat_lse(void)
{
	static uint64_t q[2] __attribute__((aligned(16)));
	uint64_t x = 40, c0, c1;
	uint32_t w = 0xff00ff00;
	uint16_t h = 0x1234;
	uint8_t b = 0x80;
	int ok = 1;

	ok &= lse_ldaddal_x(&x, 2) == 40 && x == 42;
	lse_staddl_x(&x, 8);
	ok &= x == 50;
	ok &= lse_ldclrl_w(&w, 0x0f0f0f0f) == 0xff00ff00 && w == 0xf000f000;
	ok &= lse_ldeorah(&h, 0xffff) == 0x1234 && h == 0xedcb;
	ok &= lse_ldsetb(&b, 1) == 0x80 && b == 0x81;
	w = 0x80000000;
	ok &= lse_ldsmax_w(&w, 1) == 0x80000000 && w == 1;
	x = 5;
	ok &= lse_ldsmin_x(&x, (uint64_t)-3) == 5 && x == (uint64_t)-3;
	b = 0xff;
	ok &= lse_ldumaxb(&b, 1) == 0xff && b == 0xff;
	h = 0x8000;
	ok &= lse_lduminh(&h, 0x7fff) == 0x8000 && h == 0x7fff;
	x = 5;
	ok &= lse_swpal_x(&x, 77) == 5 && x == 77;
	ok &= lse_swpb(&b, 3) == 0xff && b == 3;
	ok &= lse_casal_x(&x, 77, 9) == 77 && x == 9;	/* passes */
	ok &= lse_casal_x(&x, 77, 1) == 9 && x == 9;	/* fails */
	w = 0x80000000;
	ok &= lse_casa_w(&w, 0x80000000, 7) == 0x80000000 && w == 7;
	ok &= lse_casb(&b, 3, 0xfe) == 3 && b == 0xfe;
	ok &= lse_caslh(&h, 0x7ffe, 1) == 0x7fff && h == 0x7fff;
	q[0] = 1;
	q[1] = 2;
	c0 = 1, c1 = 3;
	lse_caspal(q, &c0, &c1, 7, 8);	/* the high half differs: fails */
	ok &= c0 == 1 && c1 == 2 && q[0] == 1 && q[1] == 2;
	lse_caspal(q, &c0, &c1, 7, 8);
	ok &= c0 == 1 && c1 == 2 && q[0] == 7 && q[1] == 8;
	return ok;
}

/* fn() (1 = right, 0 = wrong), or minus the signal it raised. */
static int guarded(int (*fn)(void))
{
	struct sigaction sa = { .sa_sigaction = on_trap, .sa_flags = SA_SIGINFO }, oill;
	volatile int r = -1;

	trap_sig = 0;
	sigaction(SIGILL, &sa, &oill);
	if (!sigsetjmp(trap_jmp, 1))
		r = fn();
	sigaction(SIGILL, &oill, NULL);
	return trap_sig ? -trap_sig : r;
}

/*
 * Each optional feature's known answers run right when AT_HWCAP lists it,
 * and raise SIGILL when it does not (kw.isa=, or not implemented).
 */
static void crypto_checks(void)
{
	static const struct {
		const char *name, *what;
		unsigned long hwcap;
		int (*fn)(void);
	} kats[] = {
		{ "aes", "AES-128 FIPS-197 C.1 encrypt and decrypt (AESE, AESMC, AESD, AESIMC)", 1UL << 3, kat_aes },
		{ "pmull", "PMULL/PMULL2 .1Q against a C multiply, GHASH of GCM test case 2", 1UL << 4, kat_pmull },
		{ "sha1", "SHA-1 of FIPS 180 \"abc\" and the 2-block message", 1UL << 5, kat_sha1 },
		{ "sha2", "SHA-256 of FIPS 180 \"abc\" and the 2-block message", 1UL << 6, kat_sha2 },
		{ "crc32", "CRC-32 and CRC-32C of \"123456789\" by B, H, W, X", 1UL << 7, kat_crc32 },
		{ "atomics", "LSE: LD<op> of each kind, STADD, SWP, CAS and CASP known answers", 1UL << 8, kat_lse },
		{ "sha3", "SHA3-256 of \"\" and \"abc\", SHAKE128 of \"\" (Keccak-f[1600] on EOR3, RAX1, XAR, BCAX)", 1UL << 17, kat_sha3 },
		{ "sha512", "SHA-512 of FIPS 180 \"abc\" and the 2-block message", 1UL << 21, kat_sha512 },
	};
	unsigned long hwcap = getauxval(AT_HWCAP);

	for (size_t i = 0; i < sizeof(kats) / sizeof(kats[0]); i++) {
		int on = !!(hwcap & kats[i].hwcap), r = guarded(kats[i].fn);

		if (on)
			CHECK(r == 1, "isa %s: %s: %s", kats[i].name, kats[i].what,
			      r == 1 ? "right" : r == 0 ? "WRONG" : "raised a signal");
		else
			CHECK(r == -SIGILL, "isa %s: not in AT_HWCAP: %s", kats[i].name,
			      r == -SIGILL ? "SIGILL" : "ran without SIGILL");
	}
}

/* Scalar FP on raw bits, with FPCR and FPSR set and read around it. */
#define FPCR_RMODE(m) ((unsigned long)(m) << 22)
#define FPCR_FZ (1UL << 24)
#define FPCR_DN (1UL << 25)
#define FPSR_IOC 0x01UL
#define FPSR_DZC 0x02UL
#define FPSR_OFC 0x04UL
#define FPSR_UFC 0x08UL
#define FPSR_IXC 0x10UL
#define FPSR_IDC 0x80UL

enum { F_DIVD, F_DIVS, F_MULD, F_ADDD, F_SQRTD, F_FRINTID, F_SCVTFD, F_FCVTZSW };

static unsigned long fp_op(int op, unsigned long a, unsigned long b, unsigned long fpcr, unsigned long *fpsr)
{
	unsigned long r = 0, old = MRS(fpcr), sr;

	__asm__ volatile("msr fpcr, %0\n\tmsr fpsr, xzr" : : "r"(fpcr));
	switch (op) {
	case F_DIVD:
		__asm__ volatile("fmov d0, %1\n\tfmov d1, %2\n\tfdiv d0, d0, d1\n\tfmov %0, d0"
				 : "=r"(r) : "r"(a), "r"(b) : "v0", "v1");
		break;
	case F_DIVS:
		__asm__ volatile("fmov s0, %w1\n\tfmov s1, %w2\n\tfdiv s0, s0, s1\n\tfmov %w0, s0"
				 : "=r"(r) : "r"(a), "r"(b) : "v0", "v1");
		break;
	case F_MULD:
		__asm__ volatile("fmov d0, %1\n\tfmov d1, %2\n\tfmul d0, d0, d1\n\tfmov %0, d0"
				 : "=r"(r) : "r"(a), "r"(b) : "v0", "v1");
		break;
	case F_ADDD:
		__asm__ volatile("fmov d0, %1\n\tfmov d1, %2\n\tfadd d0, d0, d1\n\tfmov %0, d0"
				 : "=r"(r) : "r"(a), "r"(b) : "v0", "v1");
		break;
	case F_SQRTD:
		__asm__ volatile("fmov d0, %1\n\tfsqrt d0, d0\n\tfmov %0, d0" : "=r"(r) : "r"(a) : "v0");
		break;
	case F_FRINTID:
		__asm__ volatile("fmov d0, %1\n\tfrinti d0, d0\n\tfmov %0, d0" : "=r"(r) : "r"(a) : "v0");
		break;
	case F_SCVTFD:
		__asm__ volatile("scvtf d0, %1\n\tfmov %0, d0" : "=r"(r) : "r"(a) : "v0");
		break;
	case F_FCVTZSW:
		__asm__ volatile("fmov d0, %1\n\tfcvtzs %w0, d0" : "=r"(r) : "r"(a) : "v0");
		break;
	}
	sr = MRS(fpsr);
	__asm__ volatile("msr fpcr, %0\n\tmsr fpsr, xzr" : : "r"(old));
	*fpsr = sr;
	return r;
}

#define D_1 0x3ff0000000000000UL
#define D_M1 0xbff0000000000000UL
#define D_2 0x4000000000000000UL
#define D_3 0x4008000000000000UL
#define D_0 0UL
#define D_MAX 0x7fefffffffffffffUL
#define D_MIN 0x0010000000000000UL
#define D_HALF 0x3fe0000000000000UL
#define D_QNAN 0x7ff8000000000000UL

/*
 * The rounding modes (FPCR.RMode, for division, square root, FRINTI and
 * SCVTF), each FPSR flag and their accumulation, FZ (denormal input and
 * output), DN (NaN payloads), the FPCR and FPSR bits that stick, and the
 * FP state across fork and exec.
 */
static void fp_checks(char *self)
{
	static const struct {
		const char *what;
		int op;
		unsigned long a, b, want[4];	/* RN, RP, RM, RZ */
	} rm[] = {
		{ "fdiv d 1/3", F_DIVD, D_1, D_3,
		  { 0x3fd5555555555555, 0x3fd5555555555556, 0x3fd5555555555555, 0x3fd5555555555555 } },
		{ "fdiv d -1/3", F_DIVD, D_M1, D_3,
		  { 0xbfd5555555555555, 0xbfd5555555555555, 0xbfd5555555555556, 0xbfd5555555555555 } },
		{ "fdiv s 1/3", F_DIVS, 0x3f800000, 0x40400000, { 0x3eaaaaab, 0x3eaaaaab, 0x3eaaaaaa, 0x3eaaaaaa } },
		{ "fdiv s -1/3", F_DIVS, 0xbf800000, 0x40400000, { 0xbeaaaaab, 0xbeaaaaaa, 0xbeaaaaab, 0xbeaaaaaa } },
		{ "fsqrt d 2", F_SQRTD, D_2, 0,
		  { 0x3ff6a09e667f3bcd, 0x3ff6a09e667f3bcd, 0x3ff6a09e667f3bcc, 0x3ff6a09e667f3bcc } },
		{ "frinti 2.5", F_FRINTID, 0x4004000000000000, 0, { D_2, D_3, D_2, D_2 } },
		{ "frinti -2.5", F_FRINTID, 0xc004000000000000, 0,
		  { 0xc000000000000000, 0xc000000000000000, 0xc008000000000000, 0xc000000000000000 } },
		{ "scvtf 2^53+1", F_SCVTFD, (1UL << 53) + 1, 0,
		  { 0x4340000000000000, 0x4340000000000001, 0x4340000000000000, 0x4340000000000000 } },
	};
	static const struct {
		const char *what;
		int op;
		unsigned long a, b, fpcr, want, fpsr;
	} fl[] = {
		{ "1/3", F_DIVD, D_1, D_3, 0, 0x3fd5555555555555, FPSR_IXC },
		{ "1/0", F_DIVD, D_1, D_0, 0, 0x7ff0000000000000, FPSR_DZC },
		{ "0/0", F_DIVD, D_0, D_0, 0, D_QNAN, FPSR_IOC },
		{ "sqrt(-1)", F_SQRTD, D_M1, 0, 0, D_QNAN, FPSR_IOC },
		{ "max*2", F_MULD, D_MAX, D_2, 0, 0x7ff0000000000000, FPSR_OFC | FPSR_IXC },
		{ "min*min", F_MULD, D_MIN, D_MIN, 0, 0, FPSR_UFC | FPSR_IXC },
		{ "min*0.5 (exact)", F_MULD, D_MIN, D_HALF, 0, 0x0008000000000000, 0 },
		{ "fcvtzs w 1e10", F_FCVTZSW, 0x4202a05f20000000, 0, 0, 0x7fffffff, FPSR_IOC },
		{ "1.5*2 (exact)", F_MULD, 0x3ff8000000000000, D_2, 0, D_3, 0 },
		{ "FZ denormal+0", F_ADDD, 1, D_0, FPCR_FZ, 0, FPSR_IDC },
		{ "denormal+0", F_ADDD, 1, D_0, 0, 1, 0 },
		{ "FZ min*0.5", F_MULD, D_MIN, D_HALF, FPCR_FZ, 0, FPSR_UFC },
		{ "qNaN payload+1", F_ADDD, 0x7ff8000000000123, D_1, 0, 0x7ff8000000000123, 0 },
		{ "DN qNaN payload+1", F_ADDD, 0x7ff8000000000123, D_1, FPCR_DN, D_QNAN, 0 },
		{ "sNaN payload+1", F_ADDD, 0x7ff0000000000123, D_1, 0, 0x7ff8000000000123, FPSR_IOC },
		{ "DN sNaN payload+1", F_ADDD, 0x7ff0000000000123, D_1, FPCR_DN, D_QNAN, FPSR_IOC },
	};
	unsigned long sr, r, fpcr_rb, fpsr_rb, old = MRS(fpcr);
	int bad = 0;

	for (size_t i = 0; i < sizeof(rm) / sizeof(rm[0]); i++)
		for (int m = 0; m < 4; m++) {
			r = fp_op(rm[i].op, rm[i].a, rm[i].b, FPCR_RMODE(m), &sr);
			if (r != rm[i].want[m]) {
				printf("     %s, RMode %d: %#lx, want %#lx\n", rm[i].what, m, r, rm[i].want[m]);
				bad++;
			}
		}
	CHECK(!bad, "fp: rounding modes through FPCR.RMode (RN, RP, RM, RZ: fdiv d and s, fsqrt, frinti, scvtf): %d wrong", bad);

	bad = 0;
	for (size_t i = 0; i < sizeof(fl) / sizeof(fl[0]); i++) {
		r = fp_op(fl[i].op, fl[i].a, fl[i].b, fl[i].fpcr, &sr);
		if (r != fl[i].want || sr != fl[i].fpsr) {
			printf("     %s: %#lx FPSR %#lx, want %#lx FPSR %#lx\n", fl[i].what, r, sr, fl[i].want, fl[i].fpsr);
			bad++;
		}
	}
	/* The flags accumulate until FPSR is written. */
	__asm__ volatile("msr fpsr, xzr\n\tfmov d0, %1\n\tfmov d1, %2\n\tfmov d2, %3\n\t"
			 "fdiv d3, d0, d1\n\tfdiv d3, d0, d2\n\tmrs %0, fpsr\n\tmsr fpsr, xzr"
			 : "=r"(r) : "r"(D_1), "r"(D_3), "r"(D_0) : "v0", "v1", "v2", "v3");
	if (r != (FPSR_IXC | FPSR_DZC)) {
		printf("     1/3 then 1/0: FPSR %#lx, want %#lx\n", r, FPSR_IXC | FPSR_DZC);
		bad++;
	}
	CHECK(!bad, "fp: FPSR flags (IOC, DZC, OFC, UFC, IXC, IDC, sticky), FZ and DN: %d wrong", bad);

	/* What FPCR and FPSR keep (.agents/a64/isa.md: AHP, DN, FZ, RMode; QC, IDC, IXC..IOC). */
	__asm__ volatile("msr fpcr, %2\n\tmrs %0, fpcr\n\tmsr fpcr, %3\n\tmsr fpsr, %2\n\tmrs %1, fpsr\n\tmsr fpsr, xzr"
			 : "=&r"(fpcr_rb), "=&r"(fpsr_rb) : "r"(~0UL), "r"(old));
	CHECK(fpcr_rb == 0x07c00000 && fpsr_rb == 0x0800009f, "fp: FPCR reads back %#lx (want 0x7c00000), FPSR %#lx (want 0x800009f)",
	      fpcr_rb, fpsr_rb);

	/* fork copies FPCR and FPSR; exec starts with both 0. */
	int st_fork = -1, st_exec = -1;
	unsigned long dirty_cr = FPCR_RMODE(3) | FPCR_DN, dirty_sr = FPSR_IXC | FPSR_UFC;
	pid_t pid;

	__asm__ volatile("msr fpcr, %0\n\tmsr fpsr, %1" : : "r"(dirty_cr), "r"(dirty_sr));
	pid = fork();
	if (pid == 0)
		_exit(MRS(fpcr) == dirty_cr && MRS(fpsr) == dirty_sr ? 0 : 1);
	if (pid > 0)
		waitpid(pid, &st_fork, 0);
	pid = fork();
	if (pid == 0) {
		char *av[] = { self, "fpstate", NULL };

		__asm__ volatile("msr fpcr, %0\n\tmsr fpsr, %1" : : "r"(dirty_cr), "r"(dirty_sr));
		execv(self, av);
		_exit(99);
	}
	__asm__ volatile("msr fpcr, %0\n\tmsr fpsr, xzr" : : "r"(old));
	if (pid > 0)
		waitpid(pid, &st_exec, 0);
	CHECK(WIFEXITED(st_fork) && !WEXITSTATUS(st_fork) && WIFEXITED(st_exec) && !WEXITSTATUS(st_exec),
	      "fp: fork keeps FPCR and FPSR (%s), exec clears them (%s)",
	      WIFEXITED(st_fork) && !WEXITSTATUS(st_fork) ? "ok" : "BAD",
	      WIFEXITED(st_exec) && !WEXITSTATUS(st_exec) ? "ok" : "BAD");
}

/*
 * The whole user register state a task switch or a signal must keep: V0..V31
 * (128 bits each), FPCR, FPSR, x9..x18 (which a handler clobbers), and
 * TPIDR_EL0. Loaded and stored in one asm block each, because libc
 * (memcpy, malloc) uses q registers.
 */
struct ustate {
	unsigned long fpcr, fpsr, x[10], tpidr, pad;
	__uint128_t v[32];
};

#define LDV(r) "ldp q0, q1, [" r "]\n\tldp q2, q3, [" r ", #32]\n\tldp q4, q5, [" r ", #64]\n\t" \
	"ldp q6, q7, [" r ", #96]\n\tldp q8, q9, [" r ", #128]\n\tldp q10, q11, [" r ", #160]\n\t" \
	"ldp q12, q13, [" r ", #192]\n\tldp q14, q15, [" r ", #224]\n\tldp q16, q17, [" r ", #256]\n\t" \
	"ldp q18, q19, [" r ", #288]\n\tldp q20, q21, [" r ", #320]\n\tldp q22, q23, [" r ", #352]\n\t" \
	"ldp q24, q25, [" r ", #384]\n\tldp q26, q27, [" r ", #416]\n\tldp q28, q29, [" r ", #448]\n\t" \
	"ldp q30, q31, [" r ", #480]\n\t"
#define STV(r) "stp q0, q1, [" r "]\n\tstp q2, q3, [" r ", #32]\n\tstp q4, q5, [" r ", #64]\n\t" \
	"stp q6, q7, [" r ", #96]\n\tstp q8, q9, [" r ", #128]\n\tstp q10, q11, [" r ", #160]\n\t" \
	"stp q12, q13, [" r ", #192]\n\tstp q14, q15, [" r ", #224]\n\tstp q16, q17, [" r ", #256]\n\t" \
	"stp q18, q19, [" r ", #288]\n\tstp q20, q21, [" r ", #320]\n\tstp q22, q23, [" r ", #352]\n\t" \
	"stp q24, q25, [" r ", #384]\n\tstp q26, q27, [" r ", #416]\n\tstp q28, q29, [" r ", #448]\n\t" \
	"stp q30, q31, [" r ", #480]\n\t"
/* x9..x18 = s->x[], FPCR, FPSR, TPIDR_EL0 (the old one saved in x26), V0..V31 from *r. */
#define LDS(r) "ldp x9, x10, [" r ", #16]\n\tldp x11, x12, [" r ", #32]\n\t" \
	"ldp x13, x14, [" r ", #48]\n\tldp x15, x16, [" r ", #64]\n\tldp x17, x18, [" r ", #80]\n\t" \
	"ldr x0, [" r "]\n\tmsr fpcr, x0\n\tldr x0, [" r ", #8]\n\tmsr fpsr, x0\n\t" \
	"mrs x26, tpidr_el0\n\tldr x0, [" r ", #96]\n\tmsr tpidr_el0, x0\n\tadd x0, " r ", #112\n\t" LDV("x0")
#define STS(r) "stp x9, x10, [" r ", #16]\n\tstp x11, x12, [" r ", #32]\n\t" \
	"stp x13, x14, [" r ", #48]\n\tstp x15, x16, [" r ", #64]\n\tstp x17, x18, [" r ", #80]\n\t" \
	"add x0, " r ", #112\n\t" STV("x0") \
	"mrs x0, fpcr\n\tstr x0, [" r "]\n\tmrs x0, fpsr\n\tstr x0, [" r ", #8]\n\t" \
	"mrs x0, tpidr_el0\n\tstr x0, [" r ", #96]\n\tmsr tpidr_el0, x26\n\t"
#define VCLOB "v0", "v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9", "v10", "v11", "v12", "v13", \
	"v14", "v15", "v16", "v17", "v18", "v19", "v20", "v21", "v22", "v23", "v24", "v25", "v26", "v27", \
	"v28", "v29", "v30", "v31"
#define XCLOB "x0", "x1", "x2", "x8", "x9", "x10", "x11", "x12", "x13", "x14", "x15", "x16", "x17", "x18", \
	"x19", "x20", "x21", "x22", "x23", "x24", "x26"

_Static_assert(__builtin_offsetof(struct ustate, x) == 16 && __builtin_offsetof(struct ustate, tpidr) == 96 &&
	       __builtin_offsetof(struct ustate, v) == 112, "ustate layout");

static void ustate_fill(struct ustate *s, unsigned long seed, unsigned long fpcr, unsigned long fpsr)
{
	unsigned long z = seed;

	for (int i = 0; i < 32; i++) {
		unsigned long lo, hi;

		z += 0x9e3779b97f4a7c15UL, lo = (z ^ z >> 31) * 0xbf58476d1ce4e5b9UL;
		z += 0x9e3779b97f4a7c15UL, hi = (z ^ z >> 29) * 0x94d049bb133111ebUL;
		s->v[i] = (__uint128_t)hi << 64 | lo;
	}
	for (int i = 0; i < 10; i++)
		s->x[i] = seed * 31 + i;
	s->fpcr = fpcr;
	s->fpsr = fpsr;
	s->tpidr = seed ^ 0x7e57000000000000UL;
}

/* Which parts differ: bit i for V(i), 32 FPCR, 33 FPSR, 34 an X register, 35 TPIDR_EL0. */
static unsigned long ustate_diff(const struct ustate *a, const struct ustate *b)
{
	unsigned long d = 0;

	for (int i = 0; i < 32; i++)
		d |= (unsigned long)(a->v[i] != b->v[i]) << i;
	d |= (unsigned long)(a->fpcr != b->fpcr) << 32 | (unsigned long)(a->fpsr != b->fpsr) << 33;
	d |= (unsigned long)!!memcmp(a->x, b->x, sizeof(a->x)) << 34 | (unsigned long)(a->tpidr != b->tpidr) << 35;
	return d;
}

/*
 * Signal handlers that clobber everything: V0..V31, FPCR, FPSR, x9..x18
 * (sigreturn must restore them all from the frame). kwt_vsig_handler first
 * checks the frame (kwt_vsig_check); kwt_valarm_handler counts.
 */
__attribute__((used, aligned(16))) struct ustate kwt_vgarbage;
__attribute__((used)) const struct ustate *kwt_vsig_want;
__attribute__((used)) volatile int kwt_vsig_frame_ok, kwt_valarms;
__attribute__((used)) volatile unsigned long kwt_vsig_tpidr;

__attribute__((used)) void kwt_vsig_check(int sig, siginfo_t *si, void *ucv)
{
	ucontext_t *uc = ucv;
	struct a64_fpsimd *fp = (struct a64_fpsimd *)uc->uc_mcontext.__reserved;
	const struct ustate *w = kwt_vsig_want;
	int ok = sig == SIGUSR2 && fp->magic == FPSIMD_MAGIC_ && fp->fpcr == w->fpcr && fp->fpsr == w->fpsr;

	(void)si;
	for (int i = 0; i < 32; i++)
		ok &= fp->vregs[i] == w->v[i];
	for (int i = 0; i < 10; i++)
		ok &= uc->uc_mcontext.regs[9 + i] == w->x[i];
	kwt_vsig_frame_ok = ok;
	kwt_vsig_tpidr = MRS(tpidr_el0);
}

#define CLOBBER_ALL "adrp x9, kwt_vgarbage\n\tadd x9, x9, :lo12:kwt_vgarbage\n\tadd x9, x9, #112\n\t" LDV("x9") \
	"mov x9, #(3 << 22)\n\tmsr fpcr, x9\n\tmov x9, #0x9f\n\tmsr fpsr, x9\n\t" \
	"mov x9, #-1\n\tmov x10, #-1\n\tmov x11, #-1\n\tmov x12, #-1\n\tmov x13, #-1\n\t" \
	"mov x14, #-1\n\tmov x15, #-1\n\tmov x16, #-1\n\tmov x17, #-1\n\tmov x18, #-1\n\t"

__attribute__((naked)) static void kwt_vsig_handler(int sig, siginfo_t *si, void *uc)
{
	__asm__ volatile("stp x29, x30, [sp, #-16]!\n\tmov x29, sp\n\tbl kwt_vsig_check\n\t"
			 CLOBBER_ALL "ldp x29, x30, [sp], #16\n\tret");
}

__attribute__((naked)) static void kwt_valarm_handler(int sig)
{
	__asm__ volatile("adrp x9, kwt_valarms\n\tadd x9, x9, :lo12:kwt_valarms\n\t"
			 "ldr w10, [x9]\n\tadd w10, w10, #1\n\tstr w10, [x9]\n\t" CLOBBER_ALL "ret");
}

/*
 * Run with the state of *in: n round trips of one byte (write wfd, read
 * rfd) when rfd >= 0, else spin until *stop >= 5 or n loops; with sig set,
 * first send that signal to pid. The state is then stored to *out, and
 * FPCR, FPSR and TPIDR_EL0 are put back.
 */
static void ustate_run(const struct ustate *in, struct ustate *out, long rfd, long wfd, long n,
		       volatile int *stop, long pid, long sig)
{
	unsigned long fpcr = MRS(fpcr), fpsr = MRS(fpsr);
	struct {
		const struct ustate *in;
		struct ustate *out;
		long rfd, wfd, n;
		volatile int *stop;
		long pid, sig;
		char buf[8];
	} a = { in, out, rfd, wfd, n, stop, pid, sig, { 0 } };

	__asm__ volatile(
		"mov x25, %0\n\t"
		"ldp x19, x20, [x25]\n\tldp x21, x22, [x25, #16]\n\tldp x23, x24, [x25, #32]\n\t"
		LDS("x19")
		"ldr x1, [x25, #56]\n\tcbz x1, 1f\n\t"
		"ldr x0, [x25, #48]\n\tmov x8, %1\n\tsvc #0\n"
		"1:\ttbnz x21, #63, 3f\n"
		"2:\tcbz x23, 4f\n\t"
		"mov x0, x22\n\tadd x1, x25, #64\n\tmov x2, #1\n\tmov x8, %2\n\tsvc #0\n\t"
		"mov x0, x21\n\tadd x1, x25, #64\n\tmov x2, #1\n\tmov x8, %3\n\tsvc #0\n\t"
		"sub x23, x23, #1\n\tb 2b\n"
		"3:\tcbz x23, 4f\n\tsub x23, x23, #1\n\tldr w0, [x24]\n\tcmp w0, #5\n\tb.lo 3b\n"
		"4:\t" STS("x20")
		: : "r"(&a), "i"(SYS_kill), "i"(SYS_write), "i"(SYS_read)
		: XCLOB, "x25", VCLOB, "cc", "memory");
	__asm__ volatile("msr fpcr, %0\n\tmsr fpsr, %1" : : "r"(fpcr), "r"(fpsr));
}

/* A child that keeps its own state through n round trips or a spin; exit 0 if it kept it. */
static int ustate_child(unsigned long seed, long rfd, long wfd, long n)
{
	static struct ustate in __attribute__((aligned(16))), out __attribute__((aligned(16)));
	static volatile int never;
	struct rusage ru;

	ustate_fill(&in, seed, FPCR_RMODE(seed & 3) | FPCR_FZ, FPSR_IXC | (seed & 7));
	ustate_run(&in, &out, rfd, wfd, n, &never, 0, 0);
	if (ustate_diff(&in, &out))
		return 1;
	getrusage(RUSAGE_SELF, &ru);
	return rfd < 0 && !ru.ru_nivcsw ? 2 : 0;
}

static void vreg_checks(void)
{
	static struct ustate in __attribute__((aligned(16))), out __attribute__((aligned(16)));
	struct sigaction sa = { .sa_sigaction = kwt_vsig_handler, .sa_flags = SA_SIGINFO }, osa;
	unsigned long d;

	ustate_fill(&kwt_vgarbage, 0xbad, 0, 0);
	ustate_fill(&in, 1, FPCR_RMODE(1) | FPCR_FZ | FPCR_DN, 0x08000000UL | FPSR_IXC | FPSR_OFC | FPSR_IOC);

	/* A signal at an svc: the frame has the state, sigreturn restores it. */
	sigaction(SIGUSR2, &sa, &osa);
	kwt_vsig_want = &in;
	kwt_vsig_frame_ok = 0;
	memset(&out, 0, sizeof(out));
	ustate_run(&in, &out, -1, -1, 0, &kwt_valarms, getpid(), SIGUSR2);
	sigaction(SIGUSR2, &osa, NULL);
	d = ustate_diff(&in, &out);
	CHECK(kwt_vsig_frame_ok && !d && kwt_vsig_tpidr == in.tpidr,
	      "vregs: signal at an svc: frame %s, handler's TPIDR_EL0 %s, V0..V31, FPCR, FPSR, x9..x18 back after sigreturn (diff %#lx)",
	      kwt_vsig_frame_ok ? "ok" : "BAD", kwt_vsig_tpidr == in.tpidr ? "ok" : "BAD", d);

	/* Signals between any two instructions: a 1 ms SIGALRM while the state is live. */
	struct itimerval it = { { 0, 1000 }, { 0, 1000 } }, off = { 0 };
	sa.sa_handler = kwt_valarm_handler;
	sa.sa_flags = 0;
	sigaction(SIGALRM, &sa, &osa);
	kwt_valarms = 0;
	in.tpidr ^= 1;
	setitimer(ITIMER_REAL, &it, NULL);
	ustate_run(&in, &out, -1, -1, 1L << 40, &kwt_valarms, 0, 0);
	setitimer(ITIMER_REAL, &off, NULL);
	sigaction(SIGALRM, &osa, NULL);
	d = ustate_diff(&in, &out);
	CHECK(kwt_valarms >= 5 && !d, "vregs: %d SIGALRMs in a spin, the handler clobbering all: state kept (diff %#lx)",
	      kwt_valarms, d);

	/*
	 * Task switches: two processes with different states ping-pong 300
	 * bytes (a switch at each blocking read), then spin side by side on
	 * one CPU (preempted: involuntary switches).
	 */
	int p1[2], p2[2], st1 = -1, st2 = -1, st3 = -1, st4 = -1;
	pid_t a, b;

	if (pipe(p1) || pipe(p2)) {
		CHECK(0, "vregs: pipe");
		return;
	}
	a = fork();
	if (a == 0)
		_exit(ustate_child(2, p1[0], p2[1], 300));
	b = fork();
	if (b == 0) {
		/* the other end: read first, so the two alternate */
		char c;

		if (read(p2[0], &c, 1) != 1 || write(p1[1], &c, 1) != 1)
			_exit(3);
		_exit(ustate_child(3, p2[0], p1[1], 299));
	}
	waitpid(a, &st1, 0);
	waitpid(b, &st2, 0);
	close(p1[0]), close(p1[1]), close(p2[0]), close(p2[1]);

	unsigned long one = 1;
	a = fork();
	if (a == 0) {
		syscall(SYS_sched_setaffinity, 0, sizeof(one), &one);
		_exit(ustate_child(4, -1, -1, 6000000));
	}
	b = fork();
	if (b == 0) {
		syscall(SYS_sched_setaffinity, 0, sizeof(one), &one);
		_exit(ustate_child(5, -1, -1, 6000000));
	}
	waitpid(a, &st3, 0);
	waitpid(b, &st4, 0);
#define ST_OK(s) (WIFEXITED(s) && !WEXITSTATUS(s))
	CHECK(ST_OK(st1) && ST_OK(st2) && ST_OK(st3) && ST_OK(st4),
	      "vregs: two processes with their own V0..V31, FPCR, FPSR, TPIDR_EL0: 300 pipe round trips %s/%s, "
	      "spinning on one CPU %s/%s",
	      ST_OK(st1) ? "ok" : "BAD", ST_OK(st2) ? "ok" : "BAD",
	      ST_OK(st3) ? "ok" : WIFEXITED(st3) && WEXITSTATUS(st3) == 2 ? "never preempted" : "BAD",
	      ST_OK(st4) ? "ok" : WIFEXITED(st4) && WEXITSTATUS(st4) == 2 ? "never preempted" : "BAD");
}

/* TPIDR_EL0 per thread: 3 threads set their own and yield 2000 times. */
static void *tpidr_fn(void *arg)
{
	unsigned long want = (unsigned long)arg, bad, last;

	__asm__ volatile("mrs x19, tpidr_el0\n\tmsr tpidr_el0, %2\n\tmov x20, #2000\n\tmov %0, #0\n"
			 "1:\tmov x8, %3\n\tsvc #0\n\tmrs x0, tpidr_el0\n\tcmp x0, %2\n\tcinc %0, %0, ne\n\t"
			 "mov x0, #500\n2:\tsubs x0, x0, #1\n\tb.ne 2b\n\t"
			 "subs x20, x20, #1\n\tb.ne 1b\n\tmrs %1, tpidr_el0\n\tmsr tpidr_el0, x19"
			 : "=&r"(bad), "=&r"(last) : "r"(want), "i"(SYS_sched_yield)
			 : "x0", "x8", "x19", "x20", "cc", "memory");
	return (void *)(bad + (last != want));
}

static void tpidr_checks(void)
{
	pthread_t t[2];
	void *r[3] = { (void *)1, (void *)1, (void *)1 };
	int prc[2], tls_ok;

	for (int i = 0; i < 2; i++)
		prc[i] = pthread_create(&t[i], NULL, tpidr_fn, (void *)(0x7ead0000UL + i));
	r[2] = tpidr_fn((void *)0x7ead0002UL);
	for (int i = 0; i < 2; i++)
		if (!prc[i])
			pthread_join(t[i], &r[i]);
	tls_ok = MRS(tpidr_el0) == (unsigned long)__builtin_thread_pointer();
	CHECK(!prc[0] && !prc[1] && !r[0] && !r[1] && !r[2] && tls_ok,
	      "tpidr: 3 threads with their own TPIDR_EL0 over 2000 yields each: %lu/%lu/%lu wrong, TLS %s",
	      (unsigned long)r[0], (unsigned long)r[1], (unsigned long)r[2], tls_ok ? "ok" : "BAD");
}

/*
 * The exclusive monitor: an LDXR, then something that enters the kernel,
 * then an STXR to the same word must fail (ERET clears the monitor on
 * arm64): a syscall, a signal whose handler did its own LDXR of the word,
 * a switch to a thread that did one. Without anything between, it passes.
 */
__attribute__((used, aligned(16))) volatile unsigned long kwt_excl_word;

__attribute__((naked)) static void kwt_excl_handler(int sig)
{
	__asm__ volatile("adrp x9, kwt_excl_word\n\tadd x9, x9, :lo12:kwt_excl_word\n\tldxr x10, [x9]\n\tret");
}

static int ex_pipe[2];

static void *excl_thread(void *arg)
{
	unsigned long v;

	(void)arg;
	/* the main thread blocks in read(); arm the monitor on its word, wake it */
	__asm__ volatile("ldxr %0, [%1]" : "=r"(v) : "r"(&kwt_excl_word) : "memory");
	write(ex_pipe[1], "x", 1);
	return NULL;
}

static void excl_checks(void)
{
	unsigned long v, *w = (unsigned long *)&kwt_excl_word;
	unsigned int plain = 9, sc = 9, sig = 9, sw = 9;
	struct sigaction sa = { .sa_handler = kwt_excl_handler }, osa;
	pthread_t t;
	char c;
	int prc;

	kwt_excl_word = 100;
	__asm__ volatile("ldxr %0, [%2]\n\tadd %0, %0, #1\n\tstxr %w1, %0, [%2]"
			 : "=&r"(v), "=&r"(plain) : "r"(w) : "memory");
	__asm__ volatile("ldxr %0, [%2]\n\tmov x8, %3\n\tsvc #0\n\tadd %0, %0, #1\n\tstxr %w1, %0, [%2]"
			 : "=&r"(v), "=&r"(sc) : "r"(w), "i"(SYS_getppid) : "x0", "x8", "memory");
	sigaction(SIGUSR2, &sa, &osa);
	__asm__ volatile("ldxr %0, [%2]\n\tmov x0, %3\n\tmov x1, %4\n\tmov x8, %5\n\tsvc #0\n\t"
			 "add %0, %0, #1\n\tstxr %w1, %0, [%2]"
			 : "=&r"(v), "=&r"(sig) : "r"(w), "r"((long)getpid()), "r"((long)SIGUSR2), "i"(SYS_kill)
			 : "x0", "x1", "x8", "memory");
	sigaction(SIGUSR2, &osa, NULL);
	prc = pipe(ex_pipe) || pthread_create(&t, NULL, excl_thread, NULL);
	if (!prc) {
		__asm__ volatile("ldxr %0, [%2]\n\tmov x0, %3\n\tmov x1, %4\n\tmov x2, #1\n\tmov x8, %5\n\tsvc #0\n\t"
				 "add %0, %0, #1\n\tstxr %w1, %0, [%2]"
				 : "=&r"(v), "=&r"(sw) : "r"(w), "r"((long)ex_pipe[0]), "r"(&c), "i"(SYS_read)
				 : "x0", "x1", "x2", "x8", "memory");
		pthread_join(t, NULL);
		close(ex_pipe[0]);
		close(ex_pipe[1]);
	}
	CHECK(plain == 0 && sc == 1 && sig == 1 && sw == 1 && kwt_excl_word == 101,
	      "exclusive monitor: STXR passes right after LDXR (%u), fails after a syscall (%u), a signal whose handler did LDXR (%u), "
	      "a switch to a thread that did LDXR (%u); word %lu (want 0 1 1 1, 101)",
	      plain, sc, sig, sw, (unsigned long)kwt_excl_word);
}

static void isa_result_checks(char *self)
{
	crypto_checks();
	fp_checks(self);
	vreg_checks();
	tpidr_checks();
	excl_checks();
}
#endif /* __aarch64__ */

static volatile int alarms;

static void on_alarm(int sig)
{
	(void)sig;
	alarms++;
}

#ifdef __aarch64__
static int file_has(const char *path, const char *word)
{
	char buf[4096];
	int fd = open(path, O_RDONLY), n;

	if (fd < 0)
		return 0;
	n = read(fd, buf, sizeof(buf) - 1);
	close(fd);
	buf[n > 0 ? n : 0] = 0;
	return strstr(buf, word) != NULL;
}

/*
 * Optional kernel features in kw_defconfig (needs /proc, which isa_checks
 * mounted): the pids controller, user namespaces, userfaultfd, PSI, task
 * I/O accounting, sysrq and the loop-control and tun misc devices.
 */
static void config_checks(void)
{
	int status, uffd;
	pid_t pid = fork();

	if (pid == 0)
		_exit(syscall(SYS_unshare, 0x10000000 /* CLONE_NEWUSER */) ? 1 : 0);
	waitpid(pid, &status, 0);
	uffd = syscall(SYS_userfaultfd, O_CLOEXEC);
	if (uffd >= 0)
		close(uffd);
	CHECK(WIFEXITED(status) && !WEXITSTATUS(status) && uffd >= 0 && file_has("/proc/cgroups", "pids") &&
	      file_has("/proc/pressure/cpu", "some") && file_has("/proc/self/io", "rchar") &&
	      !access("/proc/sysrq-trigger", W_OK) && file_has("/proc/misc", "loop-control") &&
	      file_has("/proc/misc", " tun"),
	      "config: user ns %s, userfaultfd %s, pids cgroup, PSI, /proc/self/io, sysrq, loop-control, tun",
	      WIFEXITED(status) && !WEXITSTATUS(status) ? "ok" : "BAD", uffd >= 0 ? "ok" : "BAD");
}

static volatile int sys_nr, sys_code, sys_errno;
static volatile unsigned sys_arch;

static void on_sigsys(int sig, siginfo_t *si, void *uc)
{
	sys_nr = si->si_syscall;
	sys_arch = si->si_arch;
	sys_code = si->si_code;
	sys_errno = si->si_errno;
}

/*
 * seccomp, each case in a child of its own: a filter (tsync) that checks the
 * arch and returns ERRNO for getppid, ERRNO for close(4242) only (the first
 * argument), TRAP for getpgid (SIGSYS with the syscall, the arch and the
 * data) and ALLOW otherwise; KILL_PROCESS (SIGSYS); strict mode (write
 * works, getpid is SIGKILL).
 */
static void seccomp_checks(void)
{
	struct sock_filter f[] = {
		BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_AARCH64, 1, 0),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
		BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_getppid, 0, 1),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_getpgid, 0, 1),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_TRAP | 7),
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_close, 0, 3),
		BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 4242, 0, 1),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOTTY),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
	};
	struct sock_filter kill[] = {
		BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
		BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_getppid, 0, 1),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
		BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
	};
	struct sock_fprog prog = { sizeof(f) / sizeof(f[0]), f }, kprog = { sizeof(kill) / sizeof(kill[0]), kill };
	int status, st_kill, st_strict, fds[2];
	char c = 0;
	pid_t pid = fork();

	if (pid == 0) {
		struct sigaction sa = { 0 };
		int bad = 0;

		sa.sa_sigaction = on_sigsys;
		sa.sa_flags = SA_SIGINFO;
		sigaction(SIGSYS, &sa, NULL);
		if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) ||
		    syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_TSYNC, &prog))
			_exit(1);
		errno = 0;
		bad |= (syscall(SYS_getppid) != -1 || errno != EPERM) << 1;
		errno = 0;
		bad |= (close(4242) != -1 || errno != ENOTTY) << 2;
		errno = 0;
		bad |= (close(4243) != -1 || errno != EBADF) << 3;
		syscall(SYS_getpgid, 0);
		bad |= (sys_nr != SYS_getpgid || sys_arch != AUDIT_ARCH_AARCH64 || sys_code != SYS_SECCOMP ||
			sys_errno != 7) << 4;
		bad |= !file_has("/proc/self/status", "Seccomp:\t2") << 5;
		bad |= (getpid() <= 0) << 6;
		_exit(bad);
	}
	waitpid(pid, &status, 0);

	pid = fork();
	if (pid == 0) {
		if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &kprog))
			_exit(1);
		syscall(SYS_getppid);
		_exit(2);
	}
	waitpid(pid, &st_kill, 0);

	pipe(fds);
	pid = fork();
	if (pid == 0) {
		if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_STRICT))
			_exit(1);
		syscall(SYS_write, fds[1], "w", 1);
		syscall(SYS_getpid);
		syscall(SYS_exit, 2);
	}
	close(fds[1]);
	read(fds[0], &c, 1);
	close(fds[0]);
	waitpid(pid, &st_strict, 0);

	CHECK(WIFEXITED(status) && !WEXITSTATUS(status) && WIFSIGNALED(st_kill) && WTERMSIG(st_kill) == SIGSYS &&
	      c == 'w' && WIFSIGNALED(st_strict) && WTERMSIG(st_strict) == SIGKILL,
	      "seccomp: filter %s (%#x), kill %s, strict %s", WIFEXITED(status) && !WEXITSTATUS(status) ? "ok" : "BAD",
	      WIFEXITED(status) ? WEXITSTATUS(status) : 0x100 | WTERMSIG(status),
	      WIFSIGNALED(st_kill) && WTERMSIG(st_kill) == SIGSYS ? "ok" : "BAD",
	      c == 'w' && WIFSIGNALED(st_strict) && WTERMSIG(st_strict) == SIGKILL ? "ok" : "BAD");
}

/*
 * ptrace (arch/wasm/kernel/ptrace.c, the single-step in traps.c, the flush
 * of user code the kernel writes in mm/tlb.c), each case in a traced child:
 * NT_PRSTATUS, NT_PRFPREG, NT_ARM_TLS and NT_ARM_SYSTEM_CALL read at a BRK
 * and written back (a non-EL0t pstate refused, other bits than NZCV
 * dropped); syscall stops with x0 the first argument, a syscall changed and
 * one skipped through NT_ARM_SYSTEM_CALL, and the first argument changed
 * through x0; a BRK written over compiled code through /proc/self/mem and
 * by PTRACE_POKETEXT, then the original put back, twice on one page;
 * PTRACE_SINGLESTEP over a branch and an SVC (reported at its exit),
 * through a compiled loop, and into a signal handler.
 */
struct pt_gpr { uint64_t x[31], sp, pc, pstate; };
struct pt_fpr { __uint128_t v[32]; uint32_t fpsr, fpcr, res[2]; };

#define PT_A 0x1122334455667788UL
#define PT_B 0x0f0e0d0c0b0a0908UL
#define PT_BRK(n) (0xd4200000u | (n) << 5)

/* PTRACE_GETREGSET/SETREGSET: the length the kernel took, or -errno. */
static long pt_regset(int req, pid_t pid, int type, void *buf, size_t len)
{
	struct iovec iov = { buf, len };

	if (ptrace(req, pid, (void *)(long)type, &iov))
		return -errno;
	return (long)iov.iov_len;
}

/* The next stop of pid: the stop signal and event bits (status >> 8), -1 when it ended. */
static int pt_wait(pid_t pid)
{
	int st;

	if (waitpid(pid, &st, 0) != pid || !WIFSTOPPED(st))
		return -1;
	return (st >> 8) & 0xffff;
}

static int pt_cont(int req, pid_t pid, int sig)
{
	if (ptrace(req, pid, 0, (void *)(long)sig))
		return -1;
	return pt_wait(pid);
}

/* Exit status of a child, or 0x100 + the signal that ended it; kills it first if asked. */
static int pt_reap(pid_t pid, int kill_it)
{
	int st;

	if (kill_it)
		kill(pid, SIGKILL);
	if (waitpid(pid, &st, 0) != pid)
		return 0x200;
	return WIFEXITED(st) ? WEXITSTATUS(st) : 0x100 | WTERMSIG(st);
}

/* Continue a stopped child to its end: its exit status as pt_reap(). */
static int pt_finish(pid_t pid)
{
	return pt_reap(pid, ptrace(PTRACE_CONT, pid, 0, 0) != 0);
}

static uint32_t pt_peek32(pid_t pid, uint64_t addr)
{
	errno = 0;
	return (uint32_t)ptrace(PTRACE_PEEKTEXT, pid, (void *)addr, 0);
}

static int pt_poke32(pid_t pid, uint64_t addr, uint32_t w)
{
	unsigned long d;

	errno = 0;
	d = ptrace(PTRACE_PEEKTEXT, pid, (void *)addr, 0);
	if (errno)
		return -1;
	d = (d & ~0xffffffffUL) | w;
	return ptrace(PTRACE_POKETEXT, pid, (void *)addr, (void *)d) ? -1 : 0;
}

static void pt_regs_child(void)
{
	uint64_t out[6], tp = MRS(tpidr_el0);
	int bad = 0;

	ptrace(PTRACE_TRACEME, 0, 0, 0);
	__asm__ volatile(
		"mov x19, %[a]\n\t"
		"mov x20, %[b]\n\t"
		"fmov d8, %[a]\n\t"
		"fmov d9, %[b]\n\t"
		"msr tpidr_el0, %[b]\n\t"
		"msr fpcr, %[fc]\n\t"
		"msr nzcv, %[nz]\n\t"
		"brk #7\n\t"
		"str x19, [%[o]]\n\t"
		"mrs x9, nzcv\n\t"
		"str x9, [%[o], #8]\n\t"
		"fmov x9, d9\n\t"
		"str x9, [%[o], #16]\n\t"
		"mrs x9, fpcr\n\t"
		"str x9, [%[o], #24]\n\t"
		"mrs x9, tpidr_el0\n\t"
		"str x9, [%[o], #32]\n\t"
		"str x20, [%[o], #40]\n\t"
		"msr fpcr, xzr\n\t"
		:
		: [a] "r"(PT_A), [b] "r"(PT_B), [fc] "r"(FPCR_RZ), [nz] "r"(0x60000000UL), [o] "r"(out)
		: "x9", "x19", "x20", "v8", "v9", "memory", "cc");
	__asm__ volatile("msr tpidr_el0, %0" : : "r"(tp));
	bad |= (out[0] != PT_B) << 0;
	bad |= (out[1] != 0x90000000UL) << 1;
	bad |= (out[2] != PT_A) << 2;
	bad |= (out[3] != (FPCR_RZ | 1UL << 24)) << 3;
	bad |= (out[4] != PT_A) << 4;
	bad |= (out[5] != PT_B) << 5;
	_exit(bad);
}

static void pt_regs_checks(void)
{
	struct pt_gpr g, g2;
	struct pt_fpr f;
	uint64_t tls[2] = { 0, 1 };
	siginfo_t si = { 0 };
	int nr = 0, sig, rc;
	long lg, lf, lt, ls, einval, want_pc = 0;
	uint32_t word = 0;
	pid_t pid = fork();

	if (pid == 0)
		pt_regs_child();
	sig = pt_wait(pid);
	lg = pt_regset(PTRACE_GETREGSET, pid, NT_PRSTATUS, &g, sizeof(g));
	lf = pt_regset(PTRACE_GETREGSET, pid, NT_PRFPREG, &f, sizeof(f));
	lt = pt_regset(PTRACE_GETREGSET, pid, NT_ARM_TLS, tls, sizeof(tls));
	ls = pt_regset(PTRACE_GETREGSET, pid, NT_ARM_SYSTEM_CALL, &nr, sizeof(nr));
	ptrace(PTRACE_GETSIGINFO, pid, 0, &si);
	if (lg == sizeof(g))
		word = pt_peek32(pid, g.pc);
	int got = sig == SIGTRAP && si.si_code == TRAP_BRKPT && lg == sizeof(g) && (uint64_t)si.si_addr == g.pc &&
		  word == PT_BRK(7) && g.x[19] == PT_A && g.x[20] == PT_B && g.pstate == 0x60000000UL &&
		  lf == sizeof(f) && (uint64_t)f.v[8] == PT_A && (uint64_t)f.v[9] == PT_B && f.fpcr == FPCR_RZ &&
		  lt == sizeof(tls) && tls[0] == PT_B && tls[1] == 0 && ls == sizeof(nr) && nr == -1;

	/* EL1h, and D set: refused, nothing changed. */
	g2 = g;
	g2.pstate = 0x5;
	einval = pt_regset(PTRACE_SETREGSET, pid, NT_PRSTATUS, &g2, sizeof(g2));
	g2.pstate = 0x200;
	einval = einval == -EINVAL ? pt_regset(PTRACE_SETREGSET, pid, NT_PRSTATUS, &g2, sizeof(g2)) : einval;
	/* x19, pc past the BRK, N and V (SSBS dropped), V9, FPCR, TPIDR_EL0. */
	g.x[19] = PT_B;
	g.pc += 4;
	want_pc = g.pc;
	g.pstate = 0x90000000UL | 0x1000;
	f.v[9] = PT_A;
	f.fpcr = FPCR_RZ | 1U << 24;
	tls[0] = PT_A;
	tls[1] = 5;
	int set = pt_regset(PTRACE_SETREGSET, pid, NT_PRSTATUS, &g, sizeof(g)) == sizeof(g) &&
		  pt_regset(PTRACE_SETREGSET, pid, NT_PRFPREG, &f, sizeof(f)) == sizeof(f) &&
		  pt_regset(PTRACE_SETREGSET, pid, NT_ARM_TLS, tls, sizeof(tls)) == sizeof(tls) &&
		  pt_regset(PTRACE_GETREGSET, pid, NT_PRSTATUS, &g2, sizeof(g2)) == sizeof(g2) &&
		  g2.pstate == 0x90000000UL && g2.pc == (uint64_t)want_pc && g2.x[19] == PT_B;
	rc = pt_finish(pid);
	CHECK(got && einval == -EINVAL && set && rc == 0,
	      "ptrace regsets: read at BRK %s (stop %#x, sizes %ld %ld %ld %ld), bad pstate %s, written %s, child saw %#x",
	      got ? "ok" : "BAD", sig, lg, lf, lt, ls, einval == -EINVAL ? "refused" : "BAD", set ? "ok" : "BAD", rc);
}

/* Up to the entry stop of syscall nr with first argument a0 (the info, op ENTRY), or -1. */
static int pt_to_entry(pid_t pid, int nr, unsigned long a0, struct __ptrace_syscall_info *si)
{
	for (int i = 0; i < 20; i++) {
		if (pt_cont(PTRACE_SYSCALL, pid, 0) != (SIGTRAP | 0x80) ||
		    ptrace(PTRACE_GET_SYSCALL_INFO, pid, (void *)sizeof(*si), si) <= 0)
			return -1;
		if (si->op == PTRACE_SYSCALL_INFO_ENTRY && si->entry.nr == (unsigned long)nr && si->entry.args[0] == a0)
			return 0;
	}
	return -1;
}

/* To the exit stop of the syscall entered; its result, or -12345. */
static long pt_to_exit(pid_t pid)
{
	struct __ptrace_syscall_info si;

	if (pt_cont(PTRACE_SYSCALL, pid, 0) != (SIGTRAP | 0x80) ||
	    ptrace(PTRACE_GET_SYSCALL_INFO, pid, (void *)sizeof(si), &si) <= 0 || si.op != PTRACE_SYSCALL_INFO_EXIT)
		return -12345;
	return si.exit.rval;
}

static void pt_syscall_checks(void)
{
	struct __ptrace_syscall_info si;
	struct pt_gpr g;
	int nr = 0, entry = 0, rc;
	long r1 = 0, r2 = 0, r3 = 0;
	pid_t pid = fork();

	if (pid == 0) {
		int bad = 0;

		ptrace(PTRACE_TRACEME, 0, 0, 0);
		raise(SIGSTOP);
		bad |= (syscall(SYS_close, 4242) != getpid()) << 0;	/* made getpid */
		bad |= (syscall(SYS_close, 4243) != 77) << 1;		/* skipped, x0 = 77 */
		bad |= (syscall(SYS_getpgid, 999999) != getpgid(0)) << 2;	/* x0 = 0 */
		_exit(bad);
	}
	if (pt_wait(pid) != SIGSTOP || ptrace(PTRACE_SETOPTIONS, pid, 0, (void *)PTRACE_O_TRACESYSGOOD))
		goto out;
	/* close(4242): x0 is the argument at the entry stop, x8 and NT_ARM_SYSTEM_CALL the number. */
	if (pt_to_entry(pid, SYS_close, 4242, &si) ||
	    pt_regset(PTRACE_GETREGSET, pid, NT_PRSTATUS, &g, sizeof(g)) != sizeof(g) ||
	    pt_regset(PTRACE_GETREGSET, pid, NT_ARM_SYSTEM_CALL, &nr, sizeof(nr)) != sizeof(nr))
		goto out;
	entry = si.arch == AUDIT_ARCH_AARCH64 && g.x[0] == 4242 && g.x[8] == SYS_close && nr == SYS_close;
	nr = SYS_getpid;
	pt_regset(PTRACE_SETREGSET, pid, NT_ARM_SYSTEM_CALL, &nr, sizeof(nr));
	r1 = pt_to_exit(pid);
	/* close(4243) skipped with the result 77. */
	if (pt_to_entry(pid, SYS_close, 4243, &si) ||
	    pt_regset(PTRACE_GETREGSET, pid, NT_PRSTATUS, &g, sizeof(g)) != sizeof(g))
		goto out;
	g.x[0] = 77;
	nr = -1;
	pt_regset(PTRACE_SETREGSET, pid, NT_PRSTATUS, &g, sizeof(g));
	pt_regset(PTRACE_SETREGSET, pid, NT_ARM_SYSTEM_CALL, &nr, sizeof(nr));
	r2 = pt_to_exit(pid);
	/* getpgid(999999) run as getpgid(0). */
	if (pt_to_entry(pid, SYS_getpgid, 999999, &si) ||
	    pt_regset(PTRACE_GETREGSET, pid, NT_PRSTATUS, &g, sizeof(g)) != sizeof(g))
		goto out;
	g.x[0] = 0;
	pt_regset(PTRACE_SETREGSET, pid, NT_PRSTATUS, &g, sizeof(g));
	r3 = pt_to_exit(pid);
	rc = pt_finish(pid);
	CHECK(entry && r1 == pid && r2 == 77 && r3 == getpgid(0) && rc == 0,
	      "ptrace syscall stops: entry regs %s, close made getpid %ld, skipped %ld, x0 changed %ld, child %#x",
	      entry ? "ok" : "BAD", r1, r2, r3, rc);
	return;
out:
	CHECK(0, "ptrace syscall stops: stop sequence broken (child %#x)", pt_reap(pid, 1));
}

/* A few instructions, called through a pointer so that it stays a call. */
__attribute__((noinline, aligned(64))) static long pt_fn(long x)
{
	return x * 3 + 1;
}
static long (*volatile pt_fnp)(long) = pt_fn;

/* Enough calls for pt_fn and the loop to be compiled (2^17 instructions a block). */
static long pt_warm(void)
{
	long s = 0;

	for (long i = 0; i < 200000; i++)
		s += pt_fnp(i);
	return s;
}
#define PT_WARM (3L * (199999L * 200000L / 2) + 200000L)

/* Child: BRK over pt_fn through /proc/self/mem, then the original back, twice. */
static int pt_selfmem_child(void)
{
	struct sigaction sa = { .sa_sigaction = on_trap, .sa_flags = SA_SIGINFO };
	uint32_t orig, brk = PT_BRK(9);
	off_t off = (off_t)(uintptr_t)pt_fn;
	int fd = open("/proc/self/mem", O_RDWR), bad = 0;
	long r;

	if (fd < 0 || pread(fd, &orig, 4, off) != 4)
		return 0x40;
	/* A stale BRK outside the expected trap kills the child (SIGTRAP), and nothing may hang. */
	alarm(30);
	for (int round = 0; round < 2; round++) {
		bad |= (pt_warm() != PT_WARM) << (round * 3);
		if (pwrite(fd, &brk, 4, off) != 4)
			return 0x80;
		trap_sig = 0;
		sigaction(SIGTRAP, &sa, NULL);
		if (!sigsetjmp(trap_jmp, 1))
			pt_fnp(5);
		signal(SIGTRAP, SIG_DFL);
		bad |= !(trap_sig == SIGTRAP && trap_addr == (uintptr_t)pt_fn) << (round * 3 + 1);
		if (pwrite(fd, &orig, 4, off) != 4)
			return 0x80;
		r = pt_fnp(5);
		bad |= (r != 16) << (round * 3 + 2);
		if (bad)
			break;
	}
	return bad;
}

static void pt_poke_checks(void)
{
	struct pt_gpr g;
	uint32_t orig;
	int rc, sm, stops = 0;
	pid_t pid = fork();

	if (pid == 0)
		_exit(pt_selfmem_child());
	sm = pt_reap(pid, 0);

	pid = fork();
	if (pid == 0) {
		int bad = 0;

		ptrace(PTRACE_TRACEME, 0, 0, 0);
		for (int round = 0; round < 2; round++) {
			bad |= (pt_warm() != PT_WARM) << (round * 2);
			raise(SIGSTOP);
			bad |= (pt_fnp(5) != 16) << (round * 2 + 1);
		}
		_exit(bad);
	}
	orig = 0;
	for (int round = 0; round < 2; round++) {
		if (pt_wait(pid) != SIGSTOP)
			break;
		if (!round)
			orig = pt_peek32(pid, (uintptr_t)pt_fn);
		/* The BRK must trap at pt_fn, and after the original is back pt_fn must run. */
		if (pt_poke32(pid, (uintptr_t)pt_fn, PT_BRK(9)) ||
		    pt_cont(PTRACE_CONT, pid, 0) != SIGTRAP ||
		    pt_regset(PTRACE_GETREGSET, pid, NT_PRSTATUS, &g, sizeof(g)) != sizeof(g) ||
		    g.pc != (uintptr_t)pt_fn || pt_poke32(pid, (uintptr_t)pt_fn, orig) ||
		    ptrace(PTRACE_CONT, pid, 0, 0))
			break;
		stops++;
	}
	rc = pt_reap(pid, stops != 2);
	CHECK(sm == 0 && stops == 2 && rc == 0,
	      "ptrace text writes (JIT warm): /proc/self/mem BRK and back twice %s (%#x), POKETEXT twice %d/2, child %#x",
	      sm == 0 ? "ok" : "BAD", sm, stops, rc);
}

static volatile int pt_usr1;
static void pt_on_usr1(int sig)
{
	(void)sig;
	pt_usr1 = 1;
}

static void pt_step_child(void)
{
	signal(SIGUSR1, pt_on_usr1);
	ptrace(PTRACE_TRACEME, 0, 0, 0);
	__asm__ volatile(
		"brk #1\n\t"		/* P */
		"mov x9, #1\n\t"	/* P+4 */
		"add x9, x9, #1\n\t"	/* P+8 */
		"mov x8, #172\n\t"	/* P+12: getpid */
		"svc #0\n\t"		/* P+16 */
		"add x9, x9, #1\n\t"	/* P+20 */
		"b 1f\n\t"		/* P+24 */
		"brk #2\n\t"		/* P+28 */
		"1: nop\n\t"		/* P+32 */
		"brk #3\n\t"		/* P+36 */
		"mov x9, #0\n\t"
		"mov x10, #0x4000\n\t"
		"movk x10, #4, lsl #16\n\t"	/* 278528 passes: compiled */
		"2: add x9, x9, #1\n\t"	/* L */
		"cmp x9, x10\n\t"	/* L+4 */
		"b.ne 2b\n\t"		/* L+8 */
		"brk #4\n\t"		/* L+12 */
		"brk #5\n\t"
		: : : "x0", "x8", "x9", "x10", "memory", "cc");
	_exit(pt_usr1 ? 0 : 1);
}

static void pt_step_checks(void)
{
	static const int adv[] = { 8, 12, 16, 20, 24, 32, 36 };
	struct pt_gpr g;
	siginfo_t si;
	uint64_t p, l;
	int sig, steps = 0, codes = 0, svc = 0, loop = 0, handler = 0, rc;
	pid_t pid = fork();

	if (pid == 0)
		pt_step_child();
	if (pt_wait(pid) != SIGTRAP || pt_regset(PTRACE_GETREGSET, pid, NT_PRSTATUS, &g, sizeof(g)) != sizeof(g) ||
	    pt_peek32(pid, g.pc) != PT_BRK(1))
		goto out;
	p = g.pc;
	g.pc = p + 4;
	pt_regset(PTRACE_SETREGSET, pid, NT_PRSTATUS, &g, sizeof(g));
	/* One instruction a step; the SVC's step stops at its exit, with getpid's result. */
	for (int i = 0; i < 7; i++) {
		if (pt_cont(PTRACE_SINGLESTEP, pid, 0) != SIGTRAP ||
		    pt_regset(PTRACE_GETREGSET, pid, NT_PRSTATUS, &g, sizeof(g)) != sizeof(g) ||
		    ptrace(PTRACE_GETSIGINFO, pid, 0, &si) || g.pc != p + adv[i])
			break;
		if (adv[i] == 20)
			svc = g.x[0] == (uint64_t)pid && g.x[9] == 2;
		else
			codes += si.si_code == TRAP_TRACE && (uint64_t)si.si_addr == g.pc;
		steps++;
	}
	if (steps != 7)
		goto out;
	/* BRK #3, then past it to BRK #4 after the compiled loop. */
	if (pt_cont(PTRACE_CONT, pid, 0) != SIGTRAP || pt_regset(PTRACE_GETREGSET, pid, NT_PRSTATUS, &g, sizeof(g)) != sizeof(g) ||
	    g.pc != p + 36)
		goto out;
	g.pc += 4;
	pt_regset(PTRACE_SETREGSET, pid, NT_PRSTATUS, &g, sizeof(g));
	if (pt_cont(PTRACE_CONT, pid, 0) != SIGTRAP || pt_regset(PTRACE_GETREGSET, pid, NT_PRSTATUS, &g, sizeof(g)) != sizeof(g) ||
	    pt_peek32(pid, g.pc) != PT_BRK(4))
		goto out;
	/* Three passes of the loop again, one step at a time. */
	l = g.pc - 12;
	g.pc = l;
	g.x[9] = 0;
	g.x[10] = 3;
	pt_regset(PTRACE_SETREGSET, pid, NT_PRSTATUS, &g, sizeof(g));
	loop = 1;
	for (int i = 0; i < 9; i++) {
		uint64_t want = i == 8 ? l + 12 : l + 4 * ((i + 1) % 3);

		if (pt_cont(PTRACE_SINGLESTEP, pid, 0) != SIGTRAP ||
		    pt_regset(PTRACE_GETREGSET, pid, NT_PRSTATUS, &g, sizeof(g)) != sizeof(g) || g.pc != want)
			loop = 0;
		if (!loop)
			break;
	}
	loop = loop && g.x[9] == 3;
	/* Past BRK #4 and BRK #5, a step with SIGUSR1 stops at the handler's first instruction. */
	g.pc = l + 20;
	pt_regset(PTRACE_SETREGSET, pid, NT_PRSTATUS, &g, sizeof(g));
	sig = pt_cont(PTRACE_SINGLESTEP, pid, SIGUSR1);
	handler = sig == SIGTRAP && pt_regset(PTRACE_GETREGSET, pid, NT_PRSTATUS, &g, sizeof(g)) == sizeof(g) &&
		  g.pc == (uintptr_t)pt_on_usr1;
	rc = pt_finish(pid);
	CHECK(codes == 6 && svc && loop && handler && rc == 0,
	      "ptrace single-step: 7 steps, %d/6 TRAP_TRACE, SVC at its exit %s, compiled loop %s, into handler %s, child %#x",
	      codes, svc ? "ok" : "BAD", loop ? "ok" : "BAD", handler ? "ok" : "BAD", rc);
	return;
out:
	CHECK(0, "ptrace single-step: broken after %d steps (child %#x)", steps, pt_reap(pid, 1));
}

/*
 * A core dump: a child with x19 = PT_A dies of SIGTRAP at a BRK in /tmp
 * (core_pattern "core"); the file is an aarch64 ET_CORE whose notes hold
 * NT_PRSTATUS (x19, pc at the BRK, EL0t), NT_PRFPREG and NT_ARM_TLS.
 */
static void core_checks(void)
{
	static unsigned char buf[1 << 16];
	Elf64_Ehdr *eh = (Elf64_Ehdr *)buf;
	int status, fd, notes = 0, x19 = 0, pc = 0, fp = 0, tls = 0;
	ssize_t n = 0;
	pid_t pid;

	unlink("/tmp/core");
	pid = fork();
	if (pid == 0) {
		struct rlimit rl = { RLIM_INFINITY, RLIM_INFINITY };

		if (setrlimit(RLIMIT_CORE, &rl) || chdir("/tmp"))
			_exit(1);
		__asm__ volatile("mov x19, %0\n\tbrk #11" : : "r"(PT_A) : "x19", "memory");
		_exit(2);
	}
	waitpid(pid, &status, 0);
	fd = open("/tmp/core", O_RDONLY);
	if (fd >= 0) {
		n = read(fd, buf, sizeof(buf));
		close(fd);
	}
	if (n >= (ssize_t)sizeof(*eh) && !memcmp(buf, ELFMAG, SELFMAG) && eh->e_type == ET_CORE &&
	    eh->e_machine == EM_AARCH64 && eh->e_phoff + (uint64_t)eh->e_phnum * sizeof(Elf64_Phdr) <= (uint64_t)n) {
		Elf64_Phdr *ph = (Elf64_Phdr *)(buf + eh->e_phoff);

		for (int i = 0; i < eh->e_phnum; i++) {
			uint64_t off = ph[i].p_offset, end = off + ph[i].p_filesz;

			if (ph[i].p_type != PT_NOTE || end > (uint64_t)n)
				continue;
			while (off + sizeof(Elf64_Nhdr) <= end) {
				Elf64_Nhdr *nh = (Elf64_Nhdr *)(buf + off);
				uint64_t d = off + sizeof(*nh) + ((nh->n_namesz + 3) & ~3u);
				const uint64_t *reg = (const uint64_t *)(buf + d + 112);	/* elf_prstatus pr_reg */

				if (d + nh->n_descsz > end)
					break;
				notes++;
				if (nh->n_type == NT_PRSTATUS && nh->n_descsz >= 112 + 34 * 8) {
					x19 = reg[19] == PT_A;
					/* The BRK is in this function (the same address after fork). */
					pc = reg[32] > (uintptr_t)core_checks && reg[32] < (uintptr_t)core_checks + 4096 &&
					     (reg[33] & 0xf) == 0;
				}
				fp |= nh->n_type == NT_PRFPREG && nh->n_descsz == sizeof(struct pt_fpr);
				tls |= nh->n_type == NT_ARM_TLS && nh->n_descsz == 16;
				off = d + ((nh->n_descsz + 3) & ~3u);
			}
		}
	}
	unlink("/tmp/core");
	CHECK(WIFSIGNALED(status) && WTERMSIG(status) == SIGTRAP && WCOREDUMP(status) && x19 && pc && fp && tls,
	      "core dump: SIGTRAP %s, core file %zd bytes, %d notes: NT_PRSTATUS %s, NT_PRFPREG %s, NT_ARM_TLS %s",
	      WIFSIGNALED(status) && WCOREDUMP(status) ? "dumped" : "BAD", n, notes, x19 && pc ? "ok" : "BAD",
	      fp ? "ok" : "BAD", tls ? "ok" : "BAD");
}

static void ptrace_checks(void)
{
	pt_regs_checks();
	pt_syscall_checks();
	pt_poke_checks();
	pt_step_checks();
	core_checks();
}

/*
 * rtnetlink requests for net_config_checks: attributes appended to a
 * buffer (without data: a nest, or room that the caller fills).
 */
struct nl_req {
	struct nlmsghdr h;
	char body[256];
};

static struct rtattr *nl_attr(struct nl_req *r, int type, const void *data, int len)
{
	struct rtattr *a = (struct rtattr *)((char *)r + NLMSG_ALIGN(r->h.nlmsg_len));

	a->rta_type = type;
	a->rta_len = RTA_LENGTH(len);
	if (data)
		memcpy(RTA_DATA(a), data, len);
	r->h.nlmsg_len = NLMSG_ALIGN(r->h.nlmsg_len) + RTA_ALIGN(a->rta_len);
	return a;
}

static void nl_nest_end(struct nl_req *r, struct rtattr *a)
{
	a->rta_len = (char *)r + NLMSG_ALIGN(r->h.nlmsg_len) - (char *)a;
}

/* Sends the request and returns the kernel's ack: 0 or a negative errno. */
static int nl_ack(int fd, struct nl_req *r)
{
	struct {
		struct nlmsghdr h;
		struct nlmsgerr e;
		char pad[128];
	} ans;

	r->h.nlmsg_flags = NLM_F_REQUEST | NLM_F_ACK | NLM_F_CREATE | NLM_F_EXCL;
	if (send(fd, r, r->h.nlmsg_len, 0) < 0 || recv(fd, &ans, sizeof(ans), 0) < (ssize_t)NLMSG_LENGTH(sizeof(ans.e)) ||
	    ans.h.nlmsg_type != NLMSG_ERROR)
		return -EIO;
	return ans.e.error;
}

static void nl_newlink(struct nl_req *r, const char *name)
{
	memset(r, 0, sizeof(*r));
	r->h.nlmsg_type = RTM_NEWLINK;
	r->h.nlmsg_len = NLMSG_LENGTH(sizeof(struct ifinfomsg));
	nl_attr(r, IFLA_IFNAME, name, strlen(name) + 1);
}

/*
 * Network options in kw_defconfig, tried in a network namespace of the
 * child's own, so nothing is left behind: a dummy link, a veth pair and a
 * policy routing rule (IP_MULTIPLE_TABLES; tailscale's "from all lookup 52").
 */
static void net_config_checks(void)
{
	int status;
	pid_t pid = fork();

	if (pid == 0) {
		struct nl_req r;
		struct rtattr *info, *data, *peer;
		struct fib_rule_hdr *rule;
		uint32_t prio = 5270;
		int fd, bad = 0;

		if (syscall(SYS_unshare, 0x40000000 /* CLONE_NEWNET */))
			_exit(8);
		fd = socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_ROUTE);
		if (fd < 0)
			_exit(8);

		nl_newlink(&r, "kwd0");
		info = nl_attr(&r, IFLA_LINKINFO, NULL, 0);
		nl_attr(&r, IFLA_INFO_KIND, "dummy", 5);
		nl_nest_end(&r, info);
		bad |= nl_ack(fd, &r) ? 1 : 0;

		nl_newlink(&r, "kwv0");
		info = nl_attr(&r, IFLA_LINKINFO, NULL, 0);
		nl_attr(&r, IFLA_INFO_KIND, "veth", 4);
		data = nl_attr(&r, IFLA_INFO_DATA, NULL, 0);
		peer = nl_attr(&r, VETH_INFO_PEER, NULL, sizeof(struct ifinfomsg));
		memset(RTA_DATA(peer), 0, sizeof(struct ifinfomsg));
		nl_attr(&r, IFLA_IFNAME, "kwv1", 5);
		nl_nest_end(&r, peer);
		nl_nest_end(&r, data);
		nl_nest_end(&r, info);
		bad |= nl_ack(fd, &r) ? 2 : 0;

		memset(&r, 0, sizeof(r));
		r.h.nlmsg_type = RTM_NEWRULE;
		r.h.nlmsg_len = NLMSG_LENGTH(sizeof(*rule));
		rule = NLMSG_DATA(&r.h);
		rule->family = AF_INET;
		rule->table = 52;
		rule->action = FR_ACT_TO_TBL;
		nl_attr(&r, FRA_PRIORITY, &prio, sizeof(prio));
		bad |= nl_ack(fd, &r) ? 4 : 0;
		_exit(bad);
	}
	waitpid(pid, &status, 0);
	status = WIFEXITED(status) ? WEXITSTATUS(status) : 8;
	CHECK(!status, "net config: netns %s, dummy %s, veth %s, ip rule %s", status & 8 ? "BAD" : "ok",
	      status & 9 ? "BAD" : "ok", status & 10 ? "BAD" : "ok", status & 12 ? "BAD" : "ok");
}

/*
 * Software uaccess (arch/wasm/mm/fault.c). A kernel access to user memory
 * whose fault returns VM_FAULT_RETRY with a signal pending must be retried
 * (only a fatal signal ends it): read() from a pipe into a userfaultfd page
 * while the handler signals the reader before it supplies the page. And
 * the futex ops on user words (FUTEX_WAKE_OP here) must be atomic against
 * user atomics on other CPUs: one thread adds through FUTEX_OP_ADD while
 * another (on another CPU when there is one) runs an atomic add (an
 * LDXR/STXR loop) on the same word,
 * and no increment may be lost.
 */
static volatile int ua_sigs;
static void ua_on_sig(int sig)
{
	ua_sigs++;
}

static struct {
	char *page;
	int fd[2];
	long n;
	int err;
	pid_t tid;
} ua_rd;

static void *ua_reader(void *arg)
{
	__atomic_store_n(&ua_rd.tid, syscall(SYS_gettid), __ATOMIC_RELEASE);
	ua_rd.n = read(ua_rd.fd[0], ua_rd.page, 100);
	ua_rd.err = ua_rd.n < 0 ? errno : 0;
	return NULL;
}

#define UA_ITERS 100000
static unsigned ua_word, ua_dummy;
static void *ua_adder(void *arg)
{
	unsigned long mask = 1UL << (long)arg;
	int i;

	syscall(SYS_sched_setaffinity, 0, sizeof(mask), &mask);
	for (i = 0; i < UA_ITERS; i++)
		__atomic_fetch_add(&ua_word, 1, __ATOMIC_RELAXED);
	return NULL;
}

static void *ua_wakeop(void *arg)
{
	unsigned long mask = 1UL << (long)arg;
	int i;

	syscall(SYS_sched_setaffinity, 0, sizeof(mask), &mask);
	for (i = 0; i < UA_ITERS; i++)
		syscall(SYS_futex, &ua_dummy, FUTEX_WAKE_OP_PRIVATE, 0, 0, &ua_word,
			FUTEX_OP(FUTEX_OP_ADD, 1, FUTEX_OP_CMP_EQ, 0));
	return NULL;
}

/*
 * The user address space is 48 bits (four page-table levels): a reservation
 * larger than 39 bits fits, and a page in the upper half is reached by user
 * code (kwemu's walk) and by the kernel (the uaccess walk).
 */
static void vaspace_checks(void)
{
	size_t big = (4UL << 40) + (32UL << 30);
	char *high = (char *)((1UL << 47) + (5UL << 39) + (3UL << 30) + (7UL << 21));
	void *r = mmap(NULL, big, PROT_NONE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_NORESERVE, -1, 0);
	void *over = mmap((void *)(1UL << 48), 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0);
	char *p = mmap(high, 8192, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0);
	int fds[2], user = 0, kernel = 0;

	if (r != MAP_FAILED)
		munmap(r, big);
	if (p == high) {
		memset(p, 0x5a, 4096);
		user = p[0] == 0x5a && p[4095] == 0x5a;
		if (!pipe(fds)) {
			kernel = write(fds[1], p, 4096) == 4096 && read(fds[0], p + 4096, 4096) == 4096 &&
				 !memcmp(p, p + 4096, 4096);
			close(fds[0]);
			close(fds[1]);
		}
		munmap(p, 8192);
	}
	CHECK(r != MAP_FAILED && over == MAP_FAILED && p == high && user && kernel,
	      "address space: 4 TiB reservation %s, nothing at 1 << 48 %s, a page above 1 << 47: mapped %s, user %s, kernel %s",
	      r != MAP_FAILED ? "ok" : "BAD", over == MAP_FAILED ? "ok" : "BAD", p == high ? "ok" : "BAD",
	      user ? "ok" : "BAD", kernel ? "ok" : "BAD");
}

static void uaccess_checks(void)
{
	long online = sysconf(_SC_NPROCESSORS_ONLN);
	struct uffdio_api api = { .api = UFFD_API };
	struct sigaction sa = { .sa_handler = ua_on_sig }, old;
	char src[4096], *area;
	int uffd, rounds = 0, good = 0, i;
	unsigned sum = 0;

	/* 1. The fault retried with a signal pending. */
	uffd = syscall(SYS_userfaultfd, O_CLOEXEC);
	area = mmap(NULL, 4 * 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (uffd >= 0 && area != MAP_FAILED && !ioctl(uffd, UFFDIO_API, &api) && !pipe(ua_rd.fd)) {
		struct uffdio_register reg = {
			.range = { (unsigned long)area, 4 * 4096 }, .mode = UFFDIO_REGISTER_MODE_MISSING,
		};

		sigaction(SIGUSR2, &sa, &old);
		memset(src, 'u', sizeof(src));
		if (!ioctl(uffd, UFFDIO_REGISTER, &reg)) {
			for (i = 0; i < 4; i++) {
				struct pollfd pfd = { .fd = uffd, .events = POLLIN };
				struct uffd_msg msg;
				struct uffdio_copy cp = {
					.dst = (unsigned long)area + i * 4096, .src = (unsigned long)src, .len = 4096,
				};
				pthread_t th;

				rounds++;
				ua_rd.page = area + i * 4096;
				ua_rd.tid = 0;
				if (write(ua_rd.fd[1], "0123456789abcdef0123456789abcdef0123456789abcdef"
						       "0123456789abcdef0123456789abcdef0123", 100) != 100 ||
				    pthread_create(&th, NULL, ua_reader, NULL))
					break;
				/* The reader is now asleep in the fault. */
				if (poll(&pfd, 1, 5000) == 1 && read(uffd, &msg, sizeof(msg)) == sizeof(msg) &&
				    msg.event == UFFD_EVENT_PAGEFAULT) {
					while (!__atomic_load_n(&ua_rd.tid, __ATOMIC_ACQUIRE))
						;
					syscall(SYS_tgkill, getpid(), ua_rd.tid, SIGUSR2);
					usleep(20000);
				}
				ioctl(uffd, UFFDIO_COPY, &cp);
				pthread_join(th, NULL);
				good += ua_rd.n == 100 && !memcmp(ua_rd.page, "0123456789", 10);
				if (ua_rd.n != 100)
					printf("     uaccess: read() into a userfaultfd page with a signal pending: %ld (%s)\n",
					       ua_rd.n, strerror(ua_rd.err));
			}
		}
		sigaction(SIGUSR2, &old, NULL);
		close(ua_rd.fd[0]);
		close(ua_rd.fd[1]);
	}
	if (uffd >= 0)
		close(uffd);
	if (area != MAP_FAILED)
		munmap(area, 4 * 4096);
	CHECK(rounds == 4 && good == 4 && ua_sigs == 4,
	      "uaccess: fault retried with a signal pending (userfaultfd): %d/%d reads whole, %d signals", good, rounds,
	      ua_sigs);

	/* 2. FUTEX_WAKE_OP's add against an atomic add on another CPU. */
	for (i = 0; i < 2; i++) {
		pthread_t a, b;

		ua_word = 0;
		pthread_create(&a, NULL, ua_adder, (void *)0L);
		pthread_create(&b, NULL, ua_wakeop, (void *)(long)(online > 1));
		pthread_join(a, NULL);
		pthread_join(b, NULL);
		sum += ua_word;
	}
	CHECK(sum == 2 * 2 * UA_ITERS, "uaccess: FUTEX_WAKE_OP add beside atomic adds on %s CPU: %u, want %u",
	      online > 1 ? "another" : "the same", sum, 2 * 2 * UA_ITERS);
}

/*
 * The input handlers. kwinput tells the host when a device is opened, and
 * the host then sends that device the keys and the pointer instead of the
 * console and the page, so only user space may open one: evdev opens a
 * device for a program that reads it, and sysrq is a passive observer
 * (drivers/tty/sysrq.c on wasm). Any other handler (VT kbd, leds, mousedev,
 * joydev, ...) opens every device it matches from boot. Before adding one
 * here, make it passive or keep it off the kwinput devices.
 */
static void input_handler_checks(void)
{
	char buf[1024], other[256] = "";
	int fd = open("/proc/bus/input/handlers", O_RDONLY), n, evdev = 0;
	char *p;

	n = fd < 0 ? -1 : read(fd, buf, sizeof(buf) - 1);
	if (fd >= 0)
		close(fd);
	buf[n > 0 ? n : 0] = 0;
	for (p = buf; (p = strstr(p, "Name=")); ) {
		size_t len = strcspn(p += 5, " \n");

		if (len == 5 && !strncmp(p, "evdev", 5))
			evdev = 1;
		else if (!(len == 5 && !strncmp(p, "sysrq", 5)) && strlen(other) + len + 2 < sizeof(other))
			strncat(strcat(other, " "), p, len);
		p += len;
	}
	CHECK(n > 0 && evdev && !other[0], "input handlers: evdev %s, others besides sysrq:%s",
	      evdev ? "ok" : "MISSING", other[0] ? other : " none");
}
/*
 * A path for the char device maj:min: devtmpfs's node dev when it is there,
 * else one made at tmp (as /init, /dev may have no devtmpfs). The node in
 * /dev comes first because a shell on the overlay root (the page with its
 * data disk) has /tmp mounted nodev, where opening a device node fails with
 * EACCES. *made says whether tmp was made (the caller unlinks it). NULL if
 * neither works.
 */
static const char *chrdev_node(const char *dev, const char *tmp, unsigned int maj, unsigned int min, int *made)
{
	struct stat st;

	*made = 0;
	if (!stat(dev, &st) && S_ISCHR(st.st_mode) && st.st_rdev == makedev(maj, min))
		return dev;
	unlink(tmp);   /* left over from a run that was killed */
	if (mknod(tmp, S_IFCHR | 0600, makedev(maj, min)))
		return NULL;
	*made = 1;
	return tmp;
}

/*
 * AF_VSOCK (kwvsock, net/vmw_vsock/kwvsock.c). The guest's CID comes from
 * /dev/vsock (its minor from /proc/misc; chrdev_node). With a host device
 * (the CLI's and the page's default) it is 3, and a connect to host port 9,
 * where nothing listens, is refused (the host answers the request with RST:
 * ECONNRESET). Without one (CLI --no-vsock) there is no transport:
 * VMADDR_CID_ANY, and connect fails with ENODEV.
 */
static void vsock_checks(void)
{
	struct sockaddr_vm a = { .svm_family = AF_VSOCK, .svm_cid = VMADDR_CID_HOST, .svm_port = 9 };
	const char *node;
	unsigned int cid = VMADDR_CID_ANY, minor = 0;
	char buf[4096], *p;
	int fd = open("/proc/misc", O_RDONLY), n, s, rc, err = 0, made, opened = 0;

	n = fd < 0 ? -1 : read(fd, buf, sizeof(buf) - 1);
	if (fd >= 0)
		close(fd);
	buf[n > 0 ? n : 0] = 0;
	p = strstr(buf, " vsock\n");
	while (p && p > buf && p[-1] != '\n')
		p--;
	if (p && sscanf(p, "%u vsock", &minor) == 1 &&
	    (node = chrdev_node("/dev/vsock", "/tmp/.kwtest-vsock", 10, minor, &made))) {
		fd = open(node, O_RDONLY);
		if (made)
			unlink(node);
		if (fd >= 0) {
			opened = 1;
			ioctl(fd, IOCTL_VM_SOCKETS_GET_LOCAL_CID, &cid);
			close(fd);
		}
	}
	s = socket(AF_VSOCK, SOCK_STREAM, 0);
	rc = s < 0 ? -1 : connect(s, (struct sockaddr *)&a, sizeof(a));
	err = rc ? errno : 0;
	if (s >= 0)
		close(s);
	/* Without it the CID would read as "no host device" (VMADDR_CID_ANY). */
	if (p && !opened)
		CHECK(0, "vsock: /proc/misc lists vsock (minor %u), but no /dev/vsock node opened (no devtmpfs, no /tmp?)",
		      minor);
	else if (cid == VMADDR_CID_ANY)
		CHECK(s >= 0 && rc && err == ENODEV, "vsock: no host device (CLI --no-vsock): socket %s, connect: %s",
		      s >= 0 ? "ok" : "FAILED", rc ? strerror(err) : "succeeded?");
	else
		CHECK(cid == 3 && s >= 0 && rc && err == ECONNRESET, "vsock: guest CID %u, connect to host port 9 (nothing listens): %s",
		      cid, rc ? strerror(err) : "succeeded?");
}

/*
 * 9p (NET_9P, NET_9P_FD, 9P_FS in kw_defconfig): the file system type the
 * SDK's host mounts use (guest/src/kw9p.c, js/core/9p.ts). Kconfig drops
 * options silently, so pin that it is registered.
 */
static void ninep_checks(void)
{
	char buf[4096];
	int fd = open("/proc/filesystems", O_RDONLY), n;

	n = fd < 0 ? -1 : read(fd, buf, sizeof(buf) - 1);
	if (fd >= 0)
		close(fd);
	buf[n > 0 ? n : 0] = 0;
	CHECK(strstr(buf, "\t9p\n") != NULL, "9p: file system type %s", strstr(buf, "\t9p\n") ? "registered" : "MISSING from /proc/filesystems");
}

/* From the kernel's include/uapi/linux/kwshm.h. */
struct kwshm_export {
	int32_t fd;
	uint32_t flags;
	uint64_t offset;
	uint64_t length;
	uint64_t size;
	uint32_t id;
	uint32_t pages;
};
#define KWSHM_IOC_EXPORT	_IOWR(0xBB, 0x00, struct kwshm_export)
#define KWSHM_IOC_RELEASE	_IOW(0xBB, 0x01, uint32_t)
#ifndef F_ADD_SEALS
#define F_ADD_SEALS	1033
#define F_SEAL_WRITE	0x0008
#endif

/* A minor from /proc/misc ("NN name"), -1 if absent. */
static int misc_minor(const char *name)
{
	char buf[4096], pat[64], *p;
	int fd = open("/proc/misc", O_RDONLY), n;
	unsigned int minor;

	n = fd < 0 ? -1 : read(fd, buf, sizeof(buf) - 1);
	if (fd >= 0)
		close(fd);
	buf[n > 0 ? n : 0] = 0;
	snprintf(pat, sizeof(pat), " %s\n", name);
	p = strstr(buf, pat);
	while (p && p > buf && p[-1] != '\n')
		p--;
	return p && sscanf(p, "%u", &minor) == 1 ? (int)minor : -1;
}

static int shm_memfd(size_t size)
{
	int fd = syscall(__NR_memfd_create, "kwtest", 2 /* MFD_ALLOW_SEALING */);

	if (fd >= 0 && ftruncate(fd, size)) {
		close(fd);
		fd = -1;
	}
	return fd;
}

/*
 * kwshm (drivers/misc/kwshm.c): /dev/kwshm exists only with a host device
 * (CLI --shm). With one: a 1 MiB memfd, half of it written (the rest are
 * holes, allocated by the export), exports as 256 pages with an id; an
 * unaligned offset, a range past the end and a pipe are refused (EINVAL);
 * while exported its pages are pinned, so F_SEAL_WRITE fails with EBUSY
 * (the extra references that also stop migration); after KWSHM_IOC_RELEASE
 * a second release is ENOENT, and a range export released by closing
 * /dev/kwshm no longer blocks the seal either.
 */
static void shm_checks(void)
{
	const char *node = "/tmp/.kwtest-kwshm";
	int minor = misc_minor("kwshm"), dev, fd, fd2, p[2] = { -1, -1 };
	struct kwshm_export e = { 0 }, bad = { 0 }, r = { 0 };
	int rc, rc_unal, rc_past, rc_pipe, seal_busy, seal_after, rel2, seal_closed;
	static char half[512 * 1024];

	if (minor < 0) {
		CHECK(1, "kwshm: no host device (skipped; CLI --shm adds one)");
		return;
	}
	dev = mknod(node, S_IFCHR | 0600, makedev(10, minor)) ? -1 : open(node, O_RDWR);
	unlink(node);
	fd = shm_memfd(1 << 20);
	memset(half, 0x5a, sizeof(half));
	if (fd >= 0)
		write(fd, half, sizeof(half));
	e.fd = fd;
	rc = ioctl(dev, KWSHM_IOC_EXPORT, &e) ? errno : 0;
	bad.fd = fd;
	bad.offset = 100;
	rc_unal = ioctl(dev, KWSHM_IOC_EXPORT, &bad) ? errno : 0;
	bad.offset = 4096;
	bad.length = 1 << 20;
	rc_past = ioctl(dev, KWSHM_IOC_EXPORT, &bad) ? errno : 0;
	pipe(p);
	bad.fd = p[0];
	bad.offset = bad.length = 0;
	rc_pipe = ioctl(dev, KWSHM_IOC_EXPORT, &bad) ? errno : 0;
	close(p[0]);
	close(p[1]);
	seal_busy = fcntl(fd, F_ADD_SEALS, F_SEAL_WRITE) ? errno : 0;
	rc = rc ? rc : ioctl(dev, KWSHM_IOC_RELEASE, &e.id) ? errno : 0;
	rel2 = ioctl(dev, KWSHM_IOC_RELEASE, &e.id) ? errno : 0;
	seal_after = fcntl(fd, F_ADD_SEALS, F_SEAL_WRITE) ? errno : 0;
	close(fd);
	/* A range export, released by closing the device. */
	fd2 = shm_memfd(1 << 20);
	r.fd = fd2;
	r.offset = 8192;
	r.length = 10000;
	if (ioctl(dev, KWSHM_IOC_EXPORT, &r))
		r.pages = 0;
	close(dev);
	seal_closed = fcntl(fd2, F_ADD_SEALS, F_SEAL_WRITE) ? errno : 0;
	close(fd2);
	CHECK(dev >= 0 && !rc && e.id > 0 && e.size == 1 << 20 && e.pages == 256 && rc_unal == EINVAL &&
	      rc_past == EINVAL && rc_pipe == EINVAL && seal_busy == EBUSY && rel2 == ENOENT && !seal_after &&
	      r.size == 10000 && r.pages == 3 && !seal_closed,
	      "kwshm: export id %u, %llu bytes in %u pages (%s); refused: unaligned %s, past the end %s, a pipe %s; "
	      "F_SEAL_WRITE while exported: %s, after release: %s; second release: %s; range: %llu bytes in %u pages, "
	      "seal after closing /dev/kwshm: %s",
	      e.id, (unsigned long long)e.size, e.pages, rc ? strerror(rc) : "ok", strerror(rc_unal), strerror(rc_past),
	      strerror(rc_pipe), seal_busy ? strerror(seal_busy) : "allowed?", seal_after ? strerror(seal_after) : "ok",
	      strerror(rel2), (unsigned long long)r.size, r.pages, seal_closed ? strerror(seal_closed) : "ok");
}

/* Open and close @path: 0, or the errno of the open. */
static int open_err(const char *path)
{
	int fd = open(path, O_RDWR);

	if (fd < 0)
		return errno;
	close(fd);
	return 0;
}

/*
 * kwfb (drivers/video/fbdev/kwfb.c): /dev/fb0 (char 29:0; chrdev_node)
 * exists only with a host display (CLI --display). One program at a time:
 * while an open file exists a second open fails with EBUSY, also once its
 * opener has closed it but a forked child still holds the shared file, and
 * while a mapping outlives close(); when the last reference is gone (the
 * child's exit, munmap) the device opens again.
 */
static void fb_checks(void)
{
	const char *node;
	int fd = open("/proc/fb", O_RDONLY), n, a, b, go[2] = { -1, -1 }, status = 0, made;
	int a_err, busy_open, busy_child, after_child, busy_map, after_map;
	char buf[256], c = 0;
	void *map = MAP_FAILED;
	pid_t pid;

	n = fd < 0 ? -1 : read(fd, buf, sizeof(buf) - 1);
	if (fd >= 0)
		close(fd);
	buf[n > 0 ? n : 0] = 0;
	if (!strstr(buf, "0 kwfb")) {
		CHECK(1, "kwfb: no host display (skipped; CLI --display adds one)");
		return;
	}
	node = chrdev_node("/dev/fb0", "/tmp/.kwtest-fb0", 29, 0, &made);
	a = node ? open(node, O_RDWR) : -1;
	a_err = a < 0 ? errno : 0;
	if (!node)
		node = "/tmp/.kwtest-fb0";   /* so the opens below fail and report */
	busy_open = open_err(node);
	/* The child shares the file; it outlives the parent's close. */
	pipe(go);
	pid = fork();
	if (pid == 0) {
		read(go[0], &c, 1);
		_exit(0);
	}
	if (a >= 0)
		close(a);
	busy_child = open_err(node);
	write(go[1], &c, 1);
	waitpid(pid, &status, 0);
	close(go[0]);
	close(go[1]);
	/* A mapping keeps the file after close(). */
	b = open(node, O_RDWR);
	if (b >= 0) {
		after_child = 0;
		map = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, b, 0);
		close(b);
	} else {
		after_child = errno;
	}
	busy_map = open_err(node);
	if (map != MAP_FAILED)
		munmap(map, 4096);
	after_map = open_err(node);
	if (made)
		unlink(node);
	CHECK(a >= 0 && busy_open == EBUSY && busy_child == EBUSY && WIFEXITED(status) && !after_child &&
	      map != MAP_FAILED && busy_map == EBUSY && !after_map,
	      "kwfb: first open %s; second open: %s, held by a forked child: %s, after its exit: %s; mmap %s, "
	      "open while mapped after close: %s, after munmap: %s",
	      a >= 0 ? "ok" : strerror(a_err), busy_open ? strerror(busy_open) : "allowed?",
	      busy_child ? strerror(busy_child) : "allowed?", after_child ? strerror(after_child) : "ok",
	      map != MAP_FAILED ? "ok" : "FAILED", busy_map ? strerror(busy_map) : "allowed?",
	      after_map ? strerror(after_map) : "ok");
}

/*
 * Parking (arch/wasm/kernel/park.c): every task stops at a point where its
 * state is all in memory and resumes on a fresh stack. Children sleep in
 * read, poll, nanosleep, futex and epoll_wait, or run hot() in user mode,
 * while this process requests cycles through /proc/kwpark (and is parked
 * itself while it waits). Interrupted sleeps must restart transparently;
 * only epoll_wait may return EINTR (as after SIGSTOP and SIGCONT).
 */
struct park_info {
	unsigned req, done, users, kthreads;
	int result;
	unsigned long long us;
	char blocker[64];
};

static int park_read(struct park_info *p)
{
	char buf[256];
	int fd = open("/proc/kwpark", O_RDONLY), n;

	if (fd < 0)
		return -1;
	n = read(fd, buf, sizeof(buf) - 1);
	close(fd);
	if (n <= 0)
		return -1;
	buf[n] = 0;
	return sscanf(buf, "requests %u done %u result %d users %u kthreads %u us %llu blocker %63s",
		      &p->req, &p->done, &p->result, &p->users, &p->kthreads, &p->us, p->blocker) == 7 ? 0 : -1;
}

/* Request a cycle and wait for it (or one that started after the request). */
static int park_cycle(struct park_info *p)
{
	struct timespec ms = { 0, 1000000 };
	unsigned want;
	int fd, i;

	if (park_read(p))
		return -1;
	want = p->req + 1;
	fd = open("/proc/kwpark", O_WRONLY);
	if (fd < 0 || write(fd, "1", 1) != 1)
		return -1;
	close(fd);
	for (i = 0; i < 5000; i++) {
		nanosleep(&ms, NULL);
		if (park_read(p))
			return -1;
		if ((int)(p->done - want) >= 0)
			return 0;
	}
	return -1;
}

static double mono(void)
{
	struct timespec ts;

	clock_gettime(CLOCK_MONOTONIC, &ts);
	return ts.tv_sec + ts.tv_nsec * 1e-9;
}

enum { PK_READ, PK_POLL, PK_SLEEP, PK_FUTEX, PK_EPOLL, PK_HOT, PK_N };
static const char *const park_names[PK_N] = { "read", "poll", "nanosleep", "futex", "epoll_wait", "hot" };

/* Exit status: 0 ok, 1 wrong result. Writes the number of EINTRs to *eintr. */
static int park_child(int kind, int rfd, volatile int *shared, volatile int *eintr)
{
	char c = 0;
	int r;

	switch (kind) {
	case PK_READ:
		r = read(rfd, &c, 1);
		return !(r == 1 && c == 'r');
	case PK_POLL: {
		struct pollfd pf = { rfd, POLLIN, 0 };

		r = poll(&pf, 1, 20000);
		return !(r == 1 && (pf.revents & POLLIN) && read(rfd, &c, 1) == 1 && c == 'p');
	}
	case PK_SLEEP: {
		struct timespec ts = { 0, 600000000 };	/* 0.6 s, across many cycles */
		double t = mono();

		r = nanosleep(&ts, NULL);
		t = mono() - t;
		return !(r == 0 && t >= 0.6);
	}
	case PK_FUTEX:
		while (!*shared) {
			r = syscall(SYS_futex, shared, FUTEX_WAIT, 0, NULL, NULL, 0);
			if (r < 0 && errno != EAGAIN)
				return 1;	/* EINTR would be a bug: FUTEX_WAIT restarts */
		}
		return 0;
	case PK_EPOLL: {
		struct epoll_event ev = { .events = EPOLLIN }, out;
		int ep = epoll_create1(0);

		epoll_ctl(ep, EPOLL_CTL_ADD, rfd, &ev);
		for (;;) {
			r = epoll_wait(ep, &out, 1, -1);
			if (r < 0 && errno == EINTR) {
				(*eintr)++;
				continue;
			}
			return !(r == 1 && read(rfd, &c, 1) == 1 && c == 'e');
		}
	}
	case PK_HOT: {
		int bad = 0, runs = 0;

		while (!*shared || runs < 2) {
			bad += hot(HOT_SEED) != HOT_EXPECT;
			runs++;
		}
		return bad != 0;
	}
	}
	return 1;
}

static void park_checks(void)
{
	struct park_info p = { 0 }, first;
	int fds[PK_N][2], st[PK_N], bad_cycles = 0, ok_children = 0, i, n = 0;
	unsigned long long us_sum = 0, us_max = 0;
	volatile int *shared;
	pid_t pid[PK_N];
	char wake[PK_N] = { 'r', 'p', 0, 0, 'e', 0 };

	if (park_read(&first)) {
		CHECK(0, "park: no /proc/kwpark");
		return;
	}
	shared = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANONYMOUS, -1, 0);
	shared[0] = 0;	/* futex word and hot()'s stop flag */
	shared[1] = 0;	/* epoll_wait EINTRs */
	for (i = 0; i < PK_N; i++) {
		pipe(fds[i]);
		pid[i] = fork();
		if (pid[i] == 0)
			_exit(park_child(i, fds[i][0], &shared[0], &shared[1]));
	}

	/* Let them block (or start computing), then park and resume 20 times. */
	usleep(50000);
	for (i = 0; i < 20; i++) {
		if (park_cycle(&p) || p.result) {
			if (!bad_cycles++)
				printf("     park cycle %d: result %d, blocker %s\n", i, p.result, p.blocker);
			continue;
		}
		n++;
		us_sum += p.us;
		if (p.us > us_max)
			us_max = p.us;
	}

	shared[0] = 1;
	syscall(SYS_futex, &shared[0], FUTEX_WAKE, 1, NULL, NULL, 0);
	for (i = 0; i < PK_N; i++)
		if (wake[i])
			write(fds[i][1], &wake[i], 1);
	for (i = 0; i < PK_N; i++) {
		waitpid(pid[i], &st[i], 0);
		ok_children += WIFEXITED(st[i]) && !WEXITSTATUS(st[i]);
		if (!(WIFEXITED(st[i]) && !WEXITSTATUS(st[i])))
			printf("     park: %s child: status %#x\n", park_names[i], st[i]);
		close(fds[i][0]);
		close(fds[i][1]);
	}
	CHECK(!bad_cycles && ok_children == PK_N && p.users >= PK_N + 1 && p.kthreads > 0,
	      "park: %d/20 cycles (%u user tasks, %u kernel threads, %llu us mean, %llu us max); "
	      "read, poll, nanosleep, futex restarted, epoll_wait EINTR %d times, hot() in user mode: %d/%d children ok",
	      n, p.users, p.kthreads, n ? us_sum / n : 0, us_max, shared[1], ok_children, PK_N);
	munmap((void *)shared, 4096);
}

/*
 * SMP (more than one CPU online): threads on several CPUs hammer shared
 * counters through atomic adds and compare-and-swap loops (both LDXR/STXR
 * without LSE) and a pthread mutex (exclusives plus futex wait and wake
 * across CPUs); every
 * increment must count, and the threads must have run on more than one
 * CPU (tasks stay on the CPU they first ran on).
 */
#define SMP_THREADS 3
#define SMP_ITERS 300000
static struct {
	unsigned amo, lrsc, locked;
	pthread_mutex_t lock;
	volatile int go;
} smp_shared = { .lock = PTHREAD_MUTEX_INITIALIZER };

static void *smp_worker(void *arg)
{
	unsigned long cpus = 0;
	unsigned cpu;
	int i;

	while (!smp_shared.go)
		;
	for (i = 0; i < SMP_ITERS; i++) {
		unsigned old = __atomic_load_n(&smp_shared.lrsc, __ATOMIC_RELAXED);

		__atomic_fetch_add(&smp_shared.amo, 1, __ATOMIC_RELAXED);
		while (!__atomic_compare_exchange_n(&smp_shared.lrsc, &old, old + 1, 1,
						    __ATOMIC_ACQ_REL, __ATOMIC_RELAXED))
			;
		if (!(i & 15)) {
			pthread_mutex_lock(&smp_shared.lock);
			smp_shared.locked++;
			pthread_mutex_unlock(&smp_shared.lock);
		}
		if (!(i & 4095) && !syscall(SYS_getcpu, &cpu, NULL, NULL) && cpu < 64)
			cpus |= 1UL << cpu;
	}
	return (void *)cpus;
}

static void smp_checks(void)
{
	long online = sysconf(_SC_NPROCESSORS_ONLN);
	unsigned long cpus = 0;
	pthread_t th[SMP_THREADS];
	int i, made = 0;
	void *r;

	if (online < 2) {
		printf("ok   smp: one CPU online (skipped)\n");
		return;
	}
	/* This thread works too: new threads go to the least busy CPU. */
	for (i = 1; i < SMP_THREADS; i++)
		made += !pthread_create(&th[i], NULL, smp_worker, NULL);
	smp_shared.go = 1;
	cpus = (unsigned long)smp_worker(NULL);
	made++;
	for (i = 1; i < SMP_THREADS; i++)
		if (!pthread_join(th[i], &r))
			cpus |= (unsigned long)r;
	CHECK(made == SMP_THREADS && smp_shared.amo == SMP_THREADS * SMP_ITERS &&
	      smp_shared.lrsc == SMP_THREADS * SMP_ITERS &&
	      smp_shared.locked == SMP_THREADS * (SMP_ITERS / 16) && __builtin_popcountl(cpus) >= 2,
	      "smp: %ld CPUs; %d threads on CPUs %#lx: atomic add %u, cas %u, mutex %u (want %u, %u, %u)",
	      online, made, cpus, smp_shared.amo, smp_shared.lrsc, smp_shared.locked,
	      SMP_THREADS * SMP_ITERS, SMP_THREADS * SMP_ITERS, SMP_THREADS * (SMP_ITERS / 16));
}

/*
 * Pins the calling thread of a cross-CPU check (thread id of 0..3) to CPU
 * id % online and returns its old mask (0: one CPU online, nothing done).
 * These checks run for tens of milliseconds: left to fork placement, both
 * threads may start on one CPU (the other one busy for a moment) and end
 * before the balancer's first pull, one or two ticks at HZ=100. `move:`
 * checks the spreading; these check atomicity across CPUs.
 */
static unsigned long smp_pin_self(uint64_t id)
{
	long online = sysconf(_SC_NPROCESSORS_ONLN);
	unsigned long old = 0, mask;

	if (online < 2 || syscall(SYS_sched_getaffinity, 0, sizeof(old), &old) < 0)
		return 0;
	mask = 1UL << (id % (unsigned long)online);
	syscall(SYS_sched_setaffinity, 0, sizeof(mask), &mask);
	return old;
}

static void smp_unpin_self(unsigned long old)
{
	if (old)
		syscall(SYS_sched_setaffinity, 0, sizeof(old), &old);
}

/*
 * LSE atomics on several CPUs (also run on one, where preemption
 * interleaves the threads): one thread per CPU (2 to 4), each pinned to
 * its own (smp_pin_self), hammers shared
 * counters with LDADDAL, STADD, a CASAL loop, SWPAL (every value put in
 * comes out exactly once), LDUMAXAL, a 128-bit CASPAL counter and a lock
 * taken by CASA and released by SWPL around a plain increment; every
 * total must be exact. Skipped when AT_HWCAP has no HWCAP_ATOMICS.
 */
#define LSE_ITERS 60000
static struct {
	uint64_t add, stadd, cas, swp, swp_sum, max, locked;
	uint32_t lock;
	uint64_t pair[2] __attribute__((aligned(16)));
	volatile int go;
} lse_sh;

static void *lse_worker(void *arg)
{
	uint64_t id = (uint64_t)(uintptr_t)arg, sum = 0, cpus = 0;
	unsigned long aff = smp_pin_self(id);
	unsigned cpu;

	while (!lse_sh.go)
		;
	for (uint64_t i = 0; i < LSE_ITERS; i++) {
		uint64_t old = __atomic_load_n(&lse_sh.cas, __ATOMIC_RELAXED), got;

		lse_ldaddal_x(&lse_sh.add, 1);
		lse_staddl_x(&lse_sh.stadd, 3);
		while ((got = lse_casal_x(&lse_sh.cas, old, old + 1)) != old)
			old = got;
		sum += lse_swpal_x(&lse_sh.swp, i * 4 + id + 1);
		__asm__ volatile(LSE_EXT "ldumaxal %1, %0, [%2]" : "=&r"(got) : "r"(i * 4 + id), "r"(&lse_sh.max) : "memory");
		while (lse_casa_w(&lse_sh.lock, 0, 1) != 0)
			;
		lse_sh.locked++;
		__asm__ volatile(LSE_EXT "swpl wzr, %w0, [%1]" : "=&r"(got) : "r"(&lse_sh.lock) : "memory");
		if (!(i & 7)) {
			uint64_t c0 = __atomic_load_n(&lse_sh.pair[0], __ATOMIC_RELAXED), c1 = lse_sh.pair[1], w0, w1;

			for (;;) {
				w0 = c0;
				w1 = c1;
				lse_caspal(lse_sh.pair, &c0, &c1, w0 + 1, w1 + (w0 + 1 == 0));
				if (c0 == w0 && c1 == w1)
					break;
			}
		}
		if (!(i & 4095) && !syscall(SYS_getcpu, &cpu, NULL, NULL) && cpu < 64)
			cpus |= 1UL << cpu;
	}
	lse_ldaddal_x(&lse_sh.swp_sum, sum);
	smp_unpin_self(aff);
	return (void *)(uintptr_t)cpus;
}

static void lse_smp_checks(void)
{
	long online = sysconf(_SC_NPROCESSORS_ONLN);
	int n = online < 2 ? 2 : online > 4 ? 4 : (int)online, made = 1;
	unsigned long cpus = 0;
	pthread_t th[4];
	void *r;

	if (!(getauxval(AT_HWCAP) & (1UL << 8))) {
		printf("ok   lse smp: no HWCAP_ATOMICS (skipped)\n");
		return;
	}
	memset((void *)&lse_sh, 0, sizeof(lse_sh));
	lse_sh.pair[0] = ~0UL - LSE_ITERS / 16;
	for (int i = 1; i < n; i++)
		made += !pthread_create(&th[i], NULL, lse_worker, (void *)(uintptr_t)i);
	lse_sh.go = 1;
	cpus = (unsigned long)lse_worker((void *)0);
	for (int i = 1; i < n; i++)
		if (!pthread_join(th[i], &r))
			cpus |= (unsigned long)r;
	uint64_t total = (uint64_t)n * LSE_ITERS, steps = (uint64_t)n * (LSE_ITERS / 8);
	/* SWP: values 1..4 * LSE_ITERS of the threads that ran, each once */
	uint64_t want_swp = 0;
	for (uint64_t i = 0; i < LSE_ITERS; i++)
		for (int k = 0; k < n; k++)
			want_swp += i * 4 + k + 1;
	CHECK(made == n && lse_sh.add == total && lse_sh.stadd == 3 * total && lse_sh.cas == total &&
	      lse_sh.swp_sum + lse_sh.swp == want_swp && lse_sh.max == (LSE_ITERS - 1) * 4 + n - 1 &&
	      lse_sh.locked == total && lse_sh.lock == 0 &&
	      lse_sh.pair[0] == steps - LSE_ITERS / 16 - 1 && lse_sh.pair[1] == 1 &&
	      (online < 2 || __builtin_popcountl(cpus) >= 2),
	      "lse smp: %d threads on %ld CPUs (%#lx): ldaddal %lu, staddl %lu, casal loop %lu, swpal %s, ldumaxal %#lx, "
	      "casa/swpl lock %lu, caspal 128-bit %#lx:%lx (want %lu each, x3, %#lx, %#lx:1)",
	      made, online, cpus, (unsigned long)lse_sh.add, (unsigned long)lse_sh.stadd, (unsigned long)lse_sh.cas,
	      lse_sh.swp_sum + lse_sh.swp == want_swp ? "exact" : "WRONG", (unsigned long)lse_sh.max,
	      (unsigned long)lse_sh.locked, (unsigned long)lse_sh.pair[1], (unsigned long)lse_sh.pair[0],
	      (unsigned long)total, (unsigned long)((LSE_ITERS - 1) * 4 + n - 1),
	      (unsigned long)(steps - LSE_ITERS / 16 - 1));
}

/*
 * Exclusives and load-acquire/store-release of every size on several CPUs
 * (each thread pinned to its own, smp_pin_self; also on one, where
 * preemption interleaves the threads), long enough for
 * their loops to run compiled (the JIT translates them inline, a64/jit.md):
 * each thread counts in its own halfword of one shared word by LDXRH/STXRH
 * (a store wider than its access would lose a neighbour's counts), all of
 * them in a shared halfword (LDAXRH/STLXRH), a shared byte (LDXRB/STLXRB)
 * and a shared word and doubleword (LDAXR/STXR, LDXR/STLXR), and with LSE
 * also in a shared byte and halfword by LDADDB/LDADDH and the word by a
 * CAS loop; thread 0 and 1 pass messages: data by plain stores, then a
 * sequence number by STLR (W, X, B, H in turn), which the other reads by
 * LDAR and acknowledges by STLR after checking the data.
 */
#define EX_ITERS 50000
#define EX_MSGS 20000
static struct {
	uint64_t own;		/* four 16-bit counters */
	uint64_t pad0[7];
	uint16_t h;
	uint8_t b, lb;
	uint16_t lh;
	uint32_t w;
	uint64_t x;
	uint64_t pad1[6];
	uint64_t data[4];
	uint64_t seq, ack;
	volatile int go;
	int bad_msgs;
} ex_sh __attribute__((aligned(64)));

#define EXCL_INC(T, LD, ST, R, p) do { \
	T v_; unsigned f_; \
	do __asm__ volatile(LD " %" R "0, [%2]\n\tadd %" R "0, %" R "0, #1\n\t" ST " %w1, %" R "0, [%2]" \
			    : "=&r"(v_), "=&r"(f_) : "r"(p) : "memory"); while (f_); \
} while (0)

static void *ex_worker(void *arg)
{
	uint64_t id = (uint64_t)(uintptr_t)arg, cpus = 0, v;
	int lse = !!(getauxval(AT_HWCAP) & (1UL << 8));
	uint16_t *own = (uint16_t *)&ex_sh.own + id;
	unsigned long aff = smp_pin_self(id);
	unsigned cpu;

	while (!ex_sh.go)
		;
	for (int i = 0; i < EX_ITERS; i++) {
		EXCL_INC(uint32_t, "ldxrh", "stxrh", "w", own);
		EXCL_INC(uint32_t, "ldaxrh", "stlxrh", "w", &ex_sh.h);
		EXCL_INC(uint32_t, "ldxrb", "stlxrb", "w", &ex_sh.b);
		EXCL_INC(uint32_t, "ldaxr", "stxr", "w", &ex_sh.w);
		EXCL_INC(uint64_t, "ldxr", "stlxr", "x", &ex_sh.x);
		if (lse) {
			__asm__ volatile(LSE_EXT "ldaddb %w1, %w0, [%2]" : "=&r"(v) : "r"(1), "r"(&ex_sh.lb) : "memory");
			__asm__ volatile(LSE_EXT "ldaddlh %w1, %w0, [%2]" : "=&r"(v) : "r"(1), "r"(&ex_sh.lh) : "memory");
		}
		if (!(i & 4095) && !syscall(SYS_getcpu, &cpu, NULL, NULL) && cpu < 64)
			cpus |= 1UL << cpu;
	}
	/* Messages between thread 0 (sends) and 1 (acknowledges). */
	for (uint64_t k = 1; id < 2 && k <= EX_MSGS; k++) {
		int spins = 0;

		if (id == 0) {
			for (int j = 0; j < 4; j++)
				ex_sh.data[j] = k * 7 + j;
			switch (k & 3) {
			case 0: __asm__ volatile("stlr %0, [%1]" :: "r"(k), "r"(&ex_sh.seq) : "memory"); break;
			case 1: __asm__ volatile("stlr %w0, [%1]" :: "r"(k), "r"(&ex_sh.seq) : "memory"); break;
			case 2: __asm__ volatile("stlrh %w0, [%1]" :: "r"(k), "r"(&ex_sh.seq) : "memory"); break;
			default: __asm__ volatile("stlrb %w0, [%1]" :: "r"(k), "r"(&ex_sh.seq) : "memory"); break;
			}
			do {
				__asm__ volatile("ldar %0, [%1]" : "=r"(v) : "r"(&ex_sh.ack) : "memory");
				if (++spins > 1000)
					sched_yield();
			} while (v != k);
		} else {
			for (;;) {
				switch (k & 3) {
				case 0: __asm__ volatile("ldar %0, [%1]" : "=r"(v) : "r"(&ex_sh.seq) : "memory"); break;
				case 1: __asm__ volatile("ldar %w0, [%1]" : "=r"(v) : "r"(&ex_sh.seq) : "memory"); break;
				case 2: __asm__ volatile("ldarh %w0, [%1]" : "=r"(v) : "r"(&ex_sh.seq) : "memory"); break;
				default: __asm__ volatile("ldarb %w0, [%1]" : "=r"(v) : "r"(&ex_sh.seq) : "memory"); break;
				}
				if (v == ((k & 3) == 0 ? k : (k & 3) == 1 ? (uint32_t)k : (k & 3) == 2 ? (uint16_t)k : (uint8_t)k))
					break;
				if (++spins > 1000)
					sched_yield();
			}
			for (int j = 0; j < 4; j++)
				ex_sh.bad_msgs += ex_sh.data[j] != k * 7 + j;
			__asm__ volatile("stlr %0, [%1]" :: "r"(k), "r"(&ex_sh.ack) : "memory");
		}
	}
	smp_unpin_self(aff);
	return (void *)(uintptr_t)cpus;
}

static void excl_smp_checks(void)
{
	long online = sysconf(_SC_NPROCESSORS_ONLN);
	int n = online < 2 ? 2 : online > 4 ? 4 : (int)online, made = 1, lse = !!(getauxval(AT_HWCAP) & (1UL << 8));
	unsigned long cpus = 0;
	pthread_t th[4];
	void *r;

	memset((void *)&ex_sh, 0, sizeof(ex_sh));
	for (int i = 1; i < n; i++)
		made += !pthread_create(&th[i], NULL, ex_worker, (void *)(uintptr_t)i);
	ex_sh.go = 1;
	cpus = (unsigned long)ex_worker((void *)0);
	for (int i = 1; i < n; i++)
		if (!pthread_join(th[i], &r))
			cpus |= (unsigned long)r;
	uint64_t total = (uint64_t)n * EX_ITERS, own_ok = 1;
	for (int i = 0; i < 4; i++)
		own_ok &= ((ex_sh.own >> (16 * i)) & 0xffff) == (i < n ? EX_ITERS : 0);
	CHECK(made == n && own_ok && ex_sh.h == (uint16_t)total && ex_sh.b == (uint8_t)total &&
	      ex_sh.w == total && ex_sh.x == total &&
	      (!lse || (ex_sh.lb == (uint8_t)total && ex_sh.lh == (uint16_t)total)) &&
	      !ex_sh.bad_msgs && ex_sh.ack == EX_MSGS && (online < 2 || __builtin_popcountl(cpus) >= 2),
	      "excl smp: %d threads on %ld CPUs (%#lx): own halfwords %#lx, ldaxrh %u, ldxrb %u, ldaxr %u, ldxr %lu, "
	      "ldaddb %u, ldaddlh %u (want %u each, %#x, %#x), %d bad of %d stlr/ldar messages",
	      made, online, cpus, (unsigned long)ex_sh.own, ex_sh.h, ex_sh.b, ex_sh.w, (unsigned long)ex_sh.x,
	      ex_sh.lb, ex_sh.lh, (unsigned)total, (unsigned)(uint16_t)total, (unsigned)(uint8_t)total,
	      ex_sh.bad_msgs, EX_MSGS);
}

/*
 * Moving tasks (SMP, more than one CPU online): a user task moves to
 * another CPU where it is switched out on its way to user mode, and starts
 * there on a fresh kernel stack (kernel.md, SMP). Its registers, FP state
 * (rounding mode, flags) and TLS must survive, as must signals and
 * wakeups; busy threads started on one CPU must spread; affinity changes
 * must take effect, for the caller itself, a busy thread and one asleep
 * in a system call.
 */
static long mv_now_ms(void)
{
	struct timespec t;

	clock_gettime(CLOCK_MONOTONIC, &t);
	return t.tv_sec * 1000L + t.tv_nsec / 1000000;
}

static int mv_cpu(void)
{
	unsigned cpu = 999;

	return syscall(SYS_getcpu, &cpu, NULL, NULL) ? -1 : (int)cpu;
}

static int mv_setaff(pid_t tid, unsigned long mask)
{
	return syscall(SYS_sched_setaffinity, tid, sizeof(mask), &mask) ? -errno : 0;
}

static unsigned long mv_getaff(pid_t tid)
{
	unsigned long mask = 0;

	return syscall(SYS_sched_getaffinity, tid, sizeof(mask), &mask) < 0 ? 0 : mask;
}

/* The CPU a thread is on (or last ran on): /proc/self/task/TID/stat field 39. */
static int mv_task_cpu(pid_t tid)
{
	char path[64], buf[512], *p;
	int fd, n, field = 2;

	snprintf(path, sizeof(path), "/proc/self/task/%d/stat", tid);
	fd = open(path, O_RDONLY);
	if (fd < 0)
		return -1;
	n = read(fd, buf, sizeof(buf) - 1);
	close(fd);
	if (n <= 0)
		return -1;
	buf[n] = 0;
	p = strrchr(buf, ')');
	if (!p)
		return -1;
	for (p++; *p && field < 39; p++)
		if (*p == ' ')
			field++;
	return field == 39 ? atoi(p) : -1;
}

struct mv_stats {
	unsigned long released, resumed, moved, restarted, dropped, lost, hinted, followed;
};

static int mv_stats_read(struct mv_stats *s)
{
	FILE *f = fopen("/proc/kwmove", "r");
	int n;

	if (!f)
		return -1;
	s->hinted = s->followed = 0;
	n = fscanf(f, "released %lu resumed %lu moved %lu restarted %lu dropped %lu lost %lu hinted %lu followed %lu",
		   &s->released, &s->resumed, &s->moved, &s->restarted, &s->dropped, &s->lost,
		   &s->hinted, &s->followed);
	fclose(f);
	return n >= 6 ? 0 : -1;
}

static struct {
	unsigned long all;	/* the online CPUs */
	long online;
	volatile int go;
	volatile long deadline, midpoint;
} mv;

/*
 * Threads started on CPU 0 widen their affinity and spin: they must spread.
 * Two per CPU, up to NR_CPUS's limit (32).
 */
#define MV_SPREAD_MAX 32
struct mv_spread {
	pthread_t th;
	unsigned long seen;
	int last, moves, bad, rounds;
};

static void *mv_spread_fn(void *arg)
{
	struct mv_spread *s = arg;
	int prev = 0;	/* they start on CPU 0 */

	s->last = -1;
	while (!mv.go)
		;
	if (mv_setaff(0, mv.all))
		s->bad++;
	while (mv_now_ms() < mv.deadline) {
		int c;

		s->bad += fphot(HOT_SEED) != FPHOT_EXPECT;
		c = mv_cpu();
		if (c >= 0 && c < 64)
			s->seen |= 1UL << c;
		if (c != prev)
			s->moves++;
		/* Where it is at the midpoint, while all of them still run. */
		if (s->last < 0 && mv_now_ms() >= mv.midpoint)
			s->last = c;
		prev = c;
		s->rounds++;
	}
	return NULL;
}

static void mv_spread_check(void)
{
	int n = mv.online * 2 > MV_SPREAD_MAX ? MV_SPREAD_MAX : mv.online * 2, i, made = 0, bad = 0, moves = 0, rounds = 0;
	unsigned long seen = 0, last = 0;
	struct mv_spread s[MV_SPREAD_MAX];
	char per[4 * MV_SPREAD_MAX] = "", *q = per;
	int count[MV_SPREAD_MAX] = { 0 };

	memset(s, 0, sizeof(s));
	mv.go = 0;
	/* All start on CPU 0 (they inherit this thread's affinity). */
	if (mv_setaff(0, 1) || mv_cpu() != 0)
		bad++;
	for (i = 0; i < n; i++)
		made += !pthread_create(&s[i].th, NULL, mv_spread_fn, &s[i]);
	mv_setaff(0, mv.all);
	mv.midpoint = mv_now_ms() + 1200;
	mv.deadline = mv.midpoint + 800;
	mv.go = 1;
	for (i = 0; i < n; i++) {
		pthread_join(s[i].th, NULL);
		seen |= s[i].seen;
		if (s[i].last >= 0 && s[i].last < MV_SPREAD_MAX) {
			last |= 1UL << s[i].last;
			count[s[i].last]++;
		}
		bad += s[i].bad;
		moves += s[i].moves;
		rounds += s[i].rounds;
	}
	for (i = 0; i < mv.online && i < MV_SPREAD_MAX; i++)
		q += snprintf(q, per + sizeof(per) - q, "%s%d", i ? "/" : "", count[i]);
	CHECK(made == n && !bad && seen == mv.all && last == mv.all && moves > 0,
	      "move: spread: %d threads started on CPU 0 ran on CPUs %#lx, %s per CPU after 1.2 s, %d CPU changes in %d fphot rounds (%d bad)",
	      made, seen, per, moves, rounds, bad);
}

/*
 * This thread moves itself round the CPUs (sched_setaffinity, which takes
 * effect on the way back to user mode) between steps of a computation kept
 * in registers, in FE_UPWARD with FE_DIVBYZERO raised; the result must
 * match the same computation without moves.
 */
#define MV_BOUNCES 300

static int mv_bounce(int moves, unsigned long *hp, double *dp, int *tlsp, int *missp)
{
	unsigned long h = 0xcbf29ce484222325UL;
	volatile double zero = 0.0;
	double d = 1.0, f = 3.0;
	int i, miss = 0, fpbad = 0;
	int *addr = &tls_var;

	tls_var = 0;
	feclearexcept(FE_ALL_EXCEPT);
	fesetround(FE_UPWARD);
	f = f / zero;	/* FE_DIVBYZERO, sticky */
	for (i = 0; i < MV_BOUNCES; i++) {
		if (moves) {
			int t = i % mv.online;

			if (mv_setaff(0, 1UL << t) || mv_cpu() != t)
				miss++;
		}
		d = d * 1.0000001 + i * 0.3;
		h = (h ^ (unsigned long)(long)(d * 16.0)) * 0x100000001b3UL + (unsigned long)i;
		tls_var += i;
		if (fegetround() != FE_UPWARD || !fetestexcept(FE_DIVBYZERO))
			fpbad++;
	}
	fesetround(FE_TONEAREST);
	feclearexcept(FE_ALL_EXCEPT);
	mv_setaff(0, mv.all);
	*hp = h;
	*dp = d;
	*tlsp = tls_var;
	*missp = miss;
	return fpbad + (addr != &tls_var) + (f < 0);
}

static void mv_bounce_check(void)
{
	unsigned long h0, h1;
	double d0, d1;
	int t0, t1, m0, m1, bad;

	bad = mv_bounce(0, &h0, &d0, &t0, &m0);
	bad += mv_bounce(1, &h1, &d1, &t1, &m1);
	CHECK(!bad && !m1 && h0 == h1 && !memcmp(&d0, &d1, sizeof(d0)) && t0 == t1,
	      "move: %d self-moves round %ld CPUs: %d missed, registers, FP state and TLS %s (h %#lx/%#lx)",
	      MV_BOUNCES, mv.online, m1, !bad && h0 == h1 && !memcmp(&d0, &d1, sizeof(d0)) && t0 == t1 ? "kept" : "BAD",
	      h0, h1);
}

/* Another thread's affinity: a busy one moves within its slice, a sleeping one when it wakes. */
static struct {
	volatile pid_t tid;
	volatile int stop, cpu_after;
	int pipe[2];
} mv_t;

static void *mv_busy_fn(void *arg)
{
	(void)arg;
	mv_t.tid = syscall(SYS_gettid);
	while (!mv_t.stop) {
		volatile unsigned long x = 0;

		for (int i = 0; i < 2000000 && !mv_t.stop; i++)
			x += i;
	}
	return NULL;
}

static void *mv_sleep_fn(void *arg)
{
	char c;

	(void)arg;
	mv_t.tid = syscall(SYS_gettid);
	read(mv_t.pipe[0], &c, 1);
	mv_t.cpu_after = mv_cpu();
	return NULL;
}

static void mv_other_check(void)
{
	pthread_t th;
	long worst = 0, set_worst = 0, t0, t;
	int i, moved = 0, err = 0, target = 0, cpu;
	unsigned long aff;

	mv_t.tid = 0;
	mv_t.stop = 0;
	if (pthread_create(&th, NULL, mv_busy_fn, NULL))
		err++;
	while (!err && !mv_t.tid)
		;
	for (i = 0; i < 6 && !err; i++) {
		cpu = mv_task_cpu(mv_t.tid);
		target = (cpu + 1) % mv.online;
		t0 = mv_now_ms();
		err += mv_setaff(mv_t.tid, 1UL << target) != 0;
		t = mv_now_ms() - t0;
		set_worst = t > set_worst ? t : set_worst;
		while (mv_task_cpu(mv_t.tid) != target && mv_now_ms() - t0 < 2000)
			usleep(1000);
		t = mv_now_ms() - t0;
		worst = t > worst ? t : worst;
		moved += mv_task_cpu(mv_t.tid) == target;
	}
	mv_t.stop = 1;
	pthread_join(th, NULL);
	CHECK(!err && moved == 6 && set_worst < 100 && worst < 1000,
	      "move: sched_setaffinity on a busy thread: %d/6 moved, call took <= %ld ms, move <= %ld ms",
	      moved, set_worst, worst);

	/* Asleep in read(): the call returns at once, the move happens at the wakeup. */
	mv_t.tid = 0;
	mv_t.cpu_after = -1;
	err = pipe(mv_t.pipe) != 0;
	if (!err && pthread_create(&th, NULL, mv_sleep_fn, NULL))
		err++;
	while (!err && !mv_t.tid)
		;
	usleep(50000);
	cpu = err ? 0 : mv_task_cpu(mv_t.tid);
	target = (cpu + 1) % mv.online;
	t0 = mv_now_ms();
	if (!err)
		err += mv_setaff(mv_t.tid, 1UL << target) != 0;
	t = mv_now_ms() - t0;
	aff = err ? 0 : mv_getaff(mv_t.tid);
	if (!err) {
		write(mv_t.pipe[1], "x", 1);
		pthread_join(th, NULL);
		close(mv_t.pipe[0]);
		close(mv_t.pipe[1]);
	}
	CHECK(!err && t < 100 && aff == 1UL << target && mv_t.cpu_after == target,
	      "move: sched_setaffinity on a thread asleep in read() on CPU %d: returned in %ld ms, mask %#lx, woke on CPU %d (want %d)",
	      cpu, t, aff, mv_t.cpu_after, target);
}

/* Queued RT signals to a thread that keeps moving: none lost, none twice. */
#define MV_SIGS 2000
static volatile unsigned long mv_sig_count, mv_sig_sum;

static void mv_on_rt(int sig, siginfo_t *si, void *uc)
{
	(void)sig;
	(void)uc;
	mv_sig_count++;
	mv_sig_sum += (unsigned long)si->si_value.sival_int;
}

static void *mv_sig_fn(void *arg)
{
	unsigned long i = 0;

	(void)arg;
	mv_t.tid = syscall(SYS_gettid);
	while (!mv_t.stop) {
		volatile unsigned long x = 0;

		mv_setaff(0, 1UL << (i++ % mv.online));
		for (int k = 0; k < 20000; k++)
			x += k;
	}
	mv_setaff(0, mv.all);
	return NULL;
}

static void mv_signal_check(void)
{
	struct sigaction sa = { .sa_sigaction = mv_on_rt, .sa_flags = SA_SIGINFO | SA_RESTART };
	pthread_t th;
	int i, err = 0, retries = 0;
	long t0;

	sigemptyset(&sa.sa_mask);
	sigaction(SIGRTMIN, &sa, NULL);
	mv_sig_count = mv_sig_sum = 0;
	mv_t.tid = 0;
	mv_t.stop = 0;
	if (pthread_create(&th, NULL, mv_sig_fn, NULL))
		err++;
	while (!err && !mv_t.tid)
		;
	for (i = 0; i < MV_SIGS && !err; i++) {
		siginfo_t si;

		memset(&si, 0, sizeof(si));
		si.si_signo = SIGRTMIN;
		si.si_code = SI_QUEUE;
		si.si_pid = getpid();
		si.si_uid = getuid();
		si.si_value.sival_int = i;
		while (syscall(SYS_rt_tgsigqueueinfo, getpid(), mv_t.tid, SIGRTMIN, &si)) {
			if (errno != EAGAIN || ++retries > 100000) {
				err++;
				break;
			}
			usleep(200);
		}
	}
	t0 = mv_now_ms();
	while (mv_sig_count < MV_SIGS && mv_now_ms() - t0 < 5000)
		usleep(1000);
	usleep(50000);
	mv_t.stop = 1;
	pthread_join(th, NULL);
	signal(SIGRTMIN, SIG_DFL);
	CHECK(!err && mv_sig_count == MV_SIGS && mv_sig_sum == (unsigned long)MV_SIGS * (MV_SIGS - 1) / 2,
	      "move: %d queued signals to a thread moving between CPUs: %lu delivered, sum %lu (want %lu)",
	      MV_SIGS, mv_sig_count, mv_sig_sum, (unsigned long)MV_SIGS * (MV_SIGS - 1) / 2);
}

/* Pipe and futex ping-pong between two threads that keep moving. */
#define MV_PP 5000
static struct {
	int ab[2], ba[2];
	volatile int word;
	int bad[2];
} mv_pp;

static void mv_pp_move(unsigned *seed)
{
	*seed = *seed * 1103515245 + 12345;
	mv_setaff(0, 1UL << ((*seed >> 16) % mv.online));
}

static void *mv_pp_fn(void *arg)
{
	int side = (int)(long)arg, i, v;
	unsigned seed = 7 + side;

	/* Pipes: side 0 sends i, side 1 answers i + 1. */
	for (i = 0; i < MV_PP; i++) {
		if (side == 0) {
			if (write(mv_pp.ab[1], &i, 4) != 4 || read(mv_pp.ba[0], &v, 4) != 4 || v != i + 1)
				mv_pp.bad[side]++;
		} else {
			if (read(mv_pp.ab[0], &v, 4) != 4 || v != i || (v = i + 1, write(mv_pp.ba[1], &v, 4) != 4))
				mv_pp.bad[side]++;
		}
		if (i % (31 + 6 * side) == 0)
			mv_pp_move(&seed);
	}
	/* Futex: the word says whose turn it is. */
	for (i = 0; i < MV_PP; i++) {
		while (__atomic_load_n(&mv_pp.word, __ATOMIC_ACQUIRE) != side)
			syscall(SYS_futex, &mv_pp.word, FUTEX_WAIT_PRIVATE, !side, NULL, NULL, 0);
		__atomic_store_n(&mv_pp.word, !side, __ATOMIC_RELEASE);
		syscall(SYS_futex, &mv_pp.word, FUTEX_WAKE_PRIVATE, 1, NULL, NULL, 0);
		if (i % (29 + 8 * side) == 0)
			mv_pp_move(&seed);
	}
	mv_setaff(0, mv.all);
	return NULL;
}

static void mv_pingpong_check(void)
{
	pthread_t th[2];
	int made = 0;
	long t0 = mv_now_ms();

	memset(&mv_pp, 0, sizeof(mv_pp));
	if (pipe(mv_pp.ab) || pipe(mv_pp.ba)) {
		CHECK(0, "move: ping-pong: no pipes");
		return;
	}
	made += !pthread_create(&th[0], NULL, mv_pp_fn, (void *)0L);
	made += !pthread_create(&th[1], NULL, mv_pp_fn, (void *)1L);
	if (made == 2) {
		pthread_join(th[0], NULL);
		pthread_join(th[1], NULL);
	}
	close(mv_pp.ab[0]);
	close(mv_pp.ab[1]);
	close(mv_pp.ba[0]);
	close(mv_pp.ba[1]);
	CHECK(made == 2 && !mv_pp.bad[0] && !mv_pp.bad[1] && mv_pp.word == 0,
	      "move: %d pipe and %d futex round trips between threads that keep moving: %d/%d bad, %ld ms",
	      MV_PP, MV_PP, mv_pp.bad[0], mv_pp.bad[1], mv_now_ms() - t0);
}

/*
 * Placement of held tasks (kernel.md, SMP). A thread asleep in read() on
 * CPU 0, which a busy thread pinned there keeps busy, is woken from CPU 1
 * again and again: it must leave CPU 0 on one of its ways back to user
 * mode (to the waker's CPU, which is about to sleep, or an idle one) and
 * stay away, and every read() must return its byte as usual (no EINTR, no
 * short read). Before, it woke on CPU 0 every time while CPU 1 idled.
 */
#define MV_WAKES 60
static struct {
	int p1[2], p2[2];
	volatile int stop;
	volatile pid_t tid;
	int cpu[MV_WAKES], bad;
} mv_w;

static void *mv_wake_hog(void *arg)
{
	(void)arg;
	if (mv_setaff(0, 1))
		mv_w.bad++;
	while (!mv_w.stop) {
		volatile unsigned long x = 0;

		for (int i = 0; i < 20000; i++)
			x += i;
	}
	return NULL;
}

static void *mv_wake_sleeper(void *arg)
{
	int i, v;

	(void)arg;
	mv_w.tid = syscall(SYS_gettid);
	for (i = 0; i < MV_WAKES; i++) {
		if (read(mv_w.p1[0], &v, sizeof(v)) != sizeof(v) || v != i)
			mv_w.bad++;
		mv_w.cpu[i] = mv_cpu();
		if (write(mv_w.p2[1], &v, sizeof(v)) != sizeof(v))
			mv_w.bad++;
	}
	return NULL;
}

static void mv_wake_check(void)
{
	struct mv_stats a, b;
	pthread_t hog, sl;
	int i, err = 0, left = -1, away = 0;

	memset(&mv_w, 0, sizeof(mv_w));
	if (pipe(mv_w.p1) || pipe(mv_w.p2)) {
		CHECK(0, "move: wakeup on a busy CPU: no pipes");
		return;
	}
	mv_stats_read(&a);
	err += mv_setaff(0, 1) != 0;	/* the sleeper starts on CPU 0 */
	err += pthread_create(&hog, NULL, mv_wake_hog, NULL) != 0;
	err += pthread_create(&sl, NULL, mv_wake_sleeper, NULL) != 0;
	while (!err && !mv_w.tid)
		usleep(1000);
	usleep(50000);
	if (!err)
		err += mv_setaff(mv_w.tid, mv.all) != 0;	/* asleep: held on CPU 0 */
	err += mv_setaff(0, 2) != 0;	/* the waker on CPU 1 */
	for (i = 0; i < MV_WAKES && !err; i++) {
		int v;

		if (write(mv_w.p1[1], &i, sizeof(i)) != sizeof(i) || read(mv_w.p2[0], &v, sizeof(v)) != sizeof(v)) {
			err++;
			break;
		}
		usleep(2000);
	}
	mv_w.stop = 1;
	pthread_join(hog, NULL);
	if (!err)
		pthread_join(sl, NULL);
	mv_setaff(0, mv.all);
	mv_stats_read(&b);
	for (i = MV_WAKES - 1; i >= 0 && mv_w.cpu[i] != 0; i--)
		;
	left = i + 1;	/* the first wakeup from which it stayed away */
	for (i = 0; i < MV_WAKES; i++)
		away += mv_w.cpu[i] != 0;
	close(mv_w.p1[0]);
	close(mv_w.p1[1]);
	close(mv_w.p2[0]);
	close(mv_w.p2[1]);
	CHECK(!err && !mv_w.bad && left <= MV_WAKES - 20,
	      "move: a thread woken in read() on a CPU a busy thread keeps: away from it from wakeup %d of %d on (%d away, %d bad, err %d), %lu better CPUs named, %lu taken",
	      left + 1, MV_WAKES, away, mv_w.bad, err, b.hinted - a.hinted, b.followed - a.followed);
}

/*
 * A child execs beside a busy thread pinned to CPU 0 while other CPUs idle:
 * the new image must start elsewhere (the move happens on execve()'s way
 * to user mode; the exec'd kwtest exits with its CPU). Each child's result
 * is its CPU's digit, or 'x' for an exit that is no CPU (the exec failed:
 * 99) and 's' for one killed by a signal; those count as abnormal.
 */
static void mv_exec_check(void)
{
	pthread_t hog;
	int i, err = 0, away = 0, abnormal = 0, n = 5;
	char cpus[16] = "";

	mv_w.stop = 0;
	mv_w.bad = 0;
	err += mv_setaff(0, 1) != 0;
	err += pthread_create(&hog, NULL, mv_wake_hog, NULL) != 0;
	usleep(20000);
	for (i = 0; i < n && !err; i++) {
		int status = 0;
		pid_t pid = fork();

		if (pid == 0) {
			mv_setaff(0, mv.all);
			execl("/proc/self/exe", "kwtest", "cpu", (char *)NULL);
			_exit(99);
		}
		if (pid < 0 || waitpid(pid, &status, 0) != pid) {
			err++;
			break;
		}
		if (!WIFEXITED(status) || WEXITSTATUS(status) >= 64) {
			cpus[i] = WIFEXITED(status) ? 'x' : 's';
			abnormal++;
			continue;
		}
		cpus[i] = WEXITSTATUS(status) < 10 ? '0' + WEXITSTATUS(status) : '+';
		away += WEXITSTATUS(status) > 0;
	}
	mv_w.stop = 1;
	if (!err || i)
		pthread_join(hog, NULL);
	mv_setaff(0, mv.all);
	CHECK(!err && !abnormal && !mv_w.bad && away >= n - 1,
	      "move: exec beside a busy thread on CPU 0: %d of %d new images started on another CPU (%s; err %d, abnormal %d, bad %d)",
	      away, n, cpus, err, abnormal, mv_w.bad);
}

static void move_checks(void)
{
	struct mv_stats a, b;

	mv.online = sysconf(_SC_NPROCESSORS_ONLN);
	if (mv.online < 2) {
		printf("ok   move: one CPU online (skipped)\n");
		return;
	}
	if (mv.online > 63)
		mv.online = 63;
	mv.all = (1UL << mv.online) - 1;
	if (mv_stats_read(&a)) {
		CHECK(0, "move: no /proc/kwmove");
		return;
	}
	mv_spread_check();
	mv_bounce_check();
	mv_other_check();
	mv_signal_check();
	mv_pingpong_check();
	mv_wake_check();
	mv_exec_check();
	mv_setaff(0, mv.all);
	if (mv_stats_read(&b)) {
		CHECK(0, "move: no /proc/kwmove");
		return;
	}
	CHECK(b.moved > a.moved && b.lost == a.lost,
	      "move: /proc/kwmove during these checks: released %lu, resumed in place %lu, moved %lu, kthreads restarted %lu, stacks dropped %lu, lost %lu",
	      b.released - a.released, b.resumed - a.resumed, b.moved - a.moved,
	      b.restarted - a.restarted, b.dropped - a.dropped, b.lost - a.lost);
}

/*
 * The JIT on SMP (more than one CPU online; kwemu.md, JIT on several CPUs): each
 * CPU's kwemu compiles what it runs hot into its own code, so these run
 * compiled loops on several CPUs at once:
 *  - hot() and fphot() on every CPU, each thread pinned, while the main
 *    thread signals each of them every millisecond (the handler changes
 *    the rounding mode and raises DZ, which sigreturn must undo): exact
 *    results, and every thread took signals;
 *  - plain byte and halfword stores next to exclusives in one cache
 *    line, from loops that get compiled: no store may be lost;
 *  - a thread in hot() and fphot() moved round the CPUs every 4 ms;
 *  - code that one hart rewrites while another runs it compiled: after
 *    the writer's __builtin___clear_cache() (DC CVAU, IC IVAU) the
 *    runner never runs the old version again; a page replaced by
 *    mremap() likewise (the unmap flushes); code made non-executable by
 *    mprotect() faults.
 */
#define JS_MAXT 8
#define JS_ITERS 200000

static _Thread_local volatile int js_sigs;

static void js_on_usr2(int sig)
{
	volatile double z = 0.0, d;

	(void)sig;
	fesetround(FE_TOWARDZERO);
	d = 1.0 / z;	/* DZ: must not leak into the interrupted code */
	(void)d;
	js_sigs++;
}

struct js_hot {
	pthread_t th;
	int cpu, sigs, bad, runs;
	volatile int done;
};

static void *js_hot_fn(void *arg)
{
	struct js_hot *h = arg;

	if (mv_setaff(0, 1UL << h->cpu) || mv_cpu() != h->cpu)
		h->bad++;
	for (int r = 0; r < 3; r++) {
		h->bad += hot(HOT_SEED) != HOT_EXPECT;
		h->bad += fphot(HOT_SEED) != FPHOT_EXPECT;
		h->runs++;
	}
	h->sigs = js_sigs;
	h->done = 1;
	return NULL;
}

static void js_hot_check(void)
{
	int n = mv.online > JS_MAXT ? JS_MAXT : mv.online, i, made = 0, bad = 0, runs = 0, minsigs = 1 << 30, left;
	struct js_hot h[JS_MAXT];
	struct sigaction sa = { .sa_handler = js_on_usr2 };
	long t0 = mv_now_ms();

	memset(h, 0, sizeof(h));
	sigaction(SIGUSR2, &sa, NULL);
	for (i = 0; i < n; i++) {
		h[i].cpu = i;
		made += !pthread_create(&h[i].th, NULL, js_hot_fn, &h[i]);
	}
	do {
		left = 0;
		for (i = 0; i < n; i++)
			if (!h[i].done) {
				pthread_kill(h[i].th, SIGUSR2);
				left++;
			}
		usleep(1000);
	} while (left && made == n);
	for (i = 0; i < n; i++) {
		pthread_join(h[i].th, NULL);
		bad += h[i].bad;
		runs += h[i].runs;
		if (h[i].sigs < minsigs)
			minsigs = h[i].sigs;
	}
	signal(SIGUSR2, SIG_DFL);
	CHECK(made == n && !bad && runs == 3 * n && minsigs >= 3,
	      "jit: hot() and fphot() on %d CPUs at once, 3 times each: %d bad; at least %d signals per thread, %ld ms",
	      n, bad, minsigs, mv_now_ms() - t0);
}

static struct {
	_Alignas(64) volatile uint8_t b[8];
	volatile uint16_t h[4];
	unsigned long amo, lrsc;
	volatile int go;
} js_line;

static void *js_store_fn(void *arg)
{
	int i = (int)(long)arg;
	unsigned long cpus = 0;

	mv_setaff(0, 1UL << (i % mv.online));
	while (!js_line.go)
		;
	for (int k = 0; k < JS_ITERS; k++) {
		js_line.b[i]++;
		js_line.h[i] += 3;
		__atomic_fetch_add(&js_line.amo, 1, __ATOMIC_RELAXED);
		if (!(k & 3)) {
			unsigned long o = __atomic_load_n(&js_line.lrsc, __ATOMIC_RELAXED);

			while (!__atomic_compare_exchange_n(&js_line.lrsc, &o, o + 1, 1, __ATOMIC_ACQ_REL, __ATOMIC_RELAXED))
				;
		}
		if (!(k & 8191)) {
			int c = mv_cpu();

			if (c >= 0 && c < 64)
				cpus |= 1UL << c;
		}
	}
	return (void *)cpus;
}

static void js_store_check(void)
{
	pthread_t th[4];
	int i, made = 0, bad = 0;
	unsigned long cpus = 0;
	void *r;

	memset((void *)&js_line, 0, sizeof(js_line));
	for (i = 0; i < 4; i++)
		made += !pthread_create(&th[i], NULL, js_store_fn, (void *)(long)i);
	js_line.go = 1;
	for (i = 0; i < 4; i++)
		if (!pthread_join(th[i], &r))
			cpus |= (unsigned long)r;
	for (i = 0; i < 4; i++)
		bad += js_line.b[i] != (uint8_t)JS_ITERS || js_line.h[i] != (uint16_t)(3 * JS_ITERS);
	CHECK(made == 4 && !bad && js_line.amo == 4UL * JS_ITERS && js_line.lrsc == JS_ITERS &&
	      cpus == (mv.online < 4 ? mv.all : 15UL),
	      "jit: byte and halfword stores beside exclusives in one line, 4 threads on CPUs %#lx: %d wrong, atomic add %lu, cas %lu (want %lu, %d)",
	      cpus, bad, js_line.amo, js_line.lrsc, 4UL * JS_ITERS, JS_ITERS);
}

struct js_mig {
	volatile int stop;
	volatile pid_t tid;
	int bad, rounds, moves;
	unsigned long seen;
};

static void *js_mig_fn(void *arg)
{
	struct js_mig *s = arg;
	int prev;

	s->tid = syscall(SYS_gettid);
	prev = mv_cpu();
	while (!s->stop) {
		int c;

		s->bad += hot(HOT_SEED) != HOT_EXPECT;
		s->bad += fphot(HOT_SEED) != FPHOT_EXPECT;
		s->rounds++;
		c = mv_cpu();
		if (c >= 0 && c < 64)
			s->seen |= 1UL << c;
		s->moves += c != prev;
		prev = c;
	}
	return NULL;
}

static void js_mig_check(void)
{
	struct js_mig s;
	struct mv_stats a, b;
	pthread_t th;
	long end;
	int k = 0, made;

	memset(&s, 0, sizeof(s));
	if (mv_stats_read(&a)) {
		CHECK(0, "jit: no /proc/kwmove");
		return;
	}
	made = !pthread_create(&th, NULL, js_mig_fn, &s);
	while (made && !s.tid)
		usleep(1000);
	end = mv_now_ms() + 1500;
	while (made && (mv_now_ms() < end || s.rounds < 6)) {
		mv_setaff(s.tid, 1UL << (k++ % mv.online));
		usleep(4000);
	}
	s.stop = 1;
	if (made)
		pthread_join(th, NULL);
	if (mv_stats_read(&b))
		b = a;
	CHECK(made && !s.bad && s.rounds >= 6 && __builtin_popcountl(s.seen) >= 2 && b.moved - a.moved >= 20,
	      "jit: hot() and fphot() %d times in a thread moved %d times (CPUs %#lx; %lu moves in /proc/kwmove): %d bad",
	      s.rounds, k, s.seen, b.moved - a.moved, s.bad);
}

/* f(x0, x1): x1 passes of x0 += v, then return x0 (a self-loop, then ret). */
static void js_gen(uint32_t *p, int v)
{
	p[0] = 0x91000000u | ((uint32_t)v << 10);	/* add x0, x0, #v (v < 4096) */
	p[1] = 0xd1000421u;				/* sub x1, x1, #1 */
	p[2] = 0xb5ffffc1u;				/* cbnz x1, -8 */
	p[3] = 0xd65f03c0u;				/* ret */
}

#define JS_PASSES 64

static struct {
	uint32_t *volatile fn;
	unsigned long published, calls, faults, noexec_faults, ran_noexec, stale, wrong;
	/* odd while the code is not executable */
	unsigned long noexec_seq;
	int stop;
} jx;
static sigjmp_buf js_segv_jmp;

static void js_on_segv(int sig)
{
	(void)sig;
	siglongjmp(js_segv_jmp, 1);
}

/* The runner (CPU 1): calls the current code, checks the version it ran. */
static void *js_run_fn(void *arg)
{
	(void)arg;
	mv_setaff(0, 2);
	while (!__atomic_load_n(&jx.stop, __ATOMIC_ACQUIRE)) {
		unsigned long p0 = __atomic_load_n(&jx.published, __ATOMIC_ACQUIRE), r, p1;
		unsigned long s0 = __atomic_load_n(&jx.noexec_seq, __ATOMIC_ACQUIRE);

		if (sigsetjmp(js_segv_jmp, 1)) {
			__atomic_fetch_add(&jx.faults, 1, __ATOMIC_RELEASE);
			if (s0 & 1)
				__atomic_fetch_add(&jx.noexec_faults, 1, __ATOMIC_RELEASE);
			continue;
		}
		r = ((unsigned long (*)(unsigned long, unsigned long))jx.fn)(0, JS_PASSES);
		p1 = __atomic_load_n(&jx.published, __ATOMIC_ACQUIRE);
		/* The whole call fell into a time the code was not executable. */
		if ((s0 & 1) && __atomic_load_n(&jx.noexec_seq, __ATOMIC_ACQUIRE) == s0)
			jx.ran_noexec++;
		/* Every pass ran a version from p0 to the one being written. */
		if (r < JS_PASSES * p0)
			jx.stale++;
		else if (r > JS_PASSES * (p1 + 1))
			jx.wrong++;
		__atomic_fetch_add(&jx.calls, 1, __ATOMIC_RELEASE);
	}
	return NULL;
}

/* Wait until the runner made `n` more calls (its code gets compiled); 0 on a timeout. */
static int js_wait_calls(unsigned long n)
{
	unsigned long c0 = __atomic_load_n(&jx.calls, __ATOMIC_ACQUIRE);
	long end = mv_now_ms() + 5000;

	while (__atomic_load_n(&jx.calls, __ATOMIC_ACQUIRE) - c0 < n)
		if (mv_now_ms() > end)
			return 0;
	return 1;
}

static void js_smc_check(void)
{
	const int rewrites = 300, remaps = 40, noexecs = 10;
	struct sigaction sa = { .sa_handler = js_on_segv, .sa_flags = SA_NODEFER };
	int i, ok = 1, done_rw = 0, done_rm = 0, done_ne = 0;
	unsigned long v = 1;
	uint32_t *page;
	pthread_t th;
	long t0 = mv_now_ms();

	memset(&jx, 0, sizeof(jx));
	page = mmap(NULL, 4096, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (page == MAP_FAILED) {
		CHECK(0, "jit: cross-hart code changes: no RWX page");
		return;
	}
	js_gen(page, v);
	__builtin___clear_cache((char *)page, (char *)(page + 4));
	jx.fn = page;
	jx.published = v;
	sigaction(SIGSEGV, &sa, NULL);
	mv_setaff(0, 1);
	if (pthread_create(&th, NULL, js_run_fn, NULL)) {
		CHECK(0, "jit: cross-hart code changes: no thread");
		return;
	}
	/* In place: one aligned store of the new add, then the flush. */
	for (i = 0; i < rewrites && ok; i++, done_rw++) {
		ok = js_wait_calls(2500);
		v++;
		__atomic_store_n(&page[0], 0x91000000u | ((uint32_t)v << 10), __ATOMIC_RELAXED);
		__builtin___clear_cache((char *)page, (char *)(page + 4));
		__atomic_store_n(&jx.published, v, __ATOMIC_RELEASE);
	}
	/* A new page at the same address (mremap moves a prepared one over it). */
	for (i = 0; i < remaps && ok; i++, done_rm++) {
		uint32_t *q = mmap(NULL, 4096, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);

		ok = js_wait_calls(2500) && q != MAP_FAILED;
		if (!ok)
			break;
		js_gen(q, ++v);
		/* MREMAP_MAYMOVE | MREMAP_FIXED (mremap() needs _GNU_SOURCE) */
		if ((void *)syscall(SYS_mremap, q, 4096, 4096, 1 | 2, page) != page) {
			ok = 0;
			break;
		}
		__atomic_store_n(&jx.published, v, __ATOMIC_RELEASE);
	}
	/* Not executable any more: the runner must fault (and then run again). */
	for (i = 0; i < noexecs && ok; i++, done_ne++) {
		unsigned long f0;
		long end;

		ok = js_wait_calls(2500);
		mprotect(page, 4096, PROT_READ | PROT_WRITE);
		f0 = __atomic_load_n(&jx.noexec_faults, __ATOMIC_ACQUIRE);
		__atomic_fetch_add(&jx.noexec_seq, 1, __ATOMIC_RELEASE);
		end = mv_now_ms() + 5000;
		while (__atomic_load_n(&jx.noexec_faults, __ATOMIC_ACQUIRE) - f0 < 3 && ok)
			ok = mv_now_ms() < end;
		__atomic_fetch_add(&jx.noexec_seq, 1, __ATOMIC_RELEASE);
		mprotect(page, 4096, PROT_READ | PROT_WRITE | PROT_EXEC);
	}
	__atomic_store_n(&jx.stop, 1, __ATOMIC_RELEASE);
	pthread_join(th, NULL);
	signal(SIGSEGV, SIG_DFL);
	mv_setaff(0, mv.all);
	munmap(page, 4096);
	CHECK(ok && !jx.stale && !jx.wrong && !jx.ran_noexec && done_rw == rewrites && done_rm == remaps && done_ne == noexecs,
	      "jit: code run on CPU 1, changed on CPU 0: %d rewrites + flush, %d mremaps, %d mprotects to no-exec; "
	      "%lu calls: %lu stale, %lu wrong, %lu ran while not executable, %lu faults; %ld ms",
	      done_rw, done_rm, done_ne, jx.calls, jx.stale, jx.wrong, jx.ran_noexec, jx.faults, mv_now_ms() - t0);
}

static void jit_smp_checks(void)
{
	mv.online = sysconf(_SC_NPROCESSORS_ONLN);
	if (mv.online < 2) {
		printf("ok   jit: one CPU online (SMP checks skipped)\n");
		return;
	}
	if (mv.online > 63)
		mv.online = 63;
	mv.all = (1UL << mv.online) - 1;
	js_hot_check();
	js_store_check();
	js_mig_check();
	js_smc_check();
	mv_setaff(0, mv.all);
}
#endif /* __aarch64__ */

static void *hot_thread(void *arg)
{
	return (void *)hot((unsigned long)arg);
}

int main(int argc, char **argv)
{
	struct utsname u;
	const char msg[] = "hello from aarch64 user mode via write()\n";

	if (argc > 1 && !strcmp(argv[1], "child"))
		return 7;	/* exec'd by the execve test */
	if (argc > 1 && !strcmp(argv[1], "cpu")) {
		unsigned cpu = 99;

		syscall(SYS_getcpu, &cpu, NULL, NULL);
		return cpu;	/* exec'd by the move: exec check */
	}
	if (argc > 1 && !strcmp(argv[1], "hot")) {
		printf("%#lx\n", hot(HOT_SEED));	/* HOT_EXPECT, see hot() */
		return 0;
	}
	if (argc > 1 && !strcmp(argv[1], "fphot")) {
		printf("%#lx\n", fphot(HOT_SEED));	/* FPHOT_EXPECT, see fphot() */
		return 0;
	}
#ifdef __aarch64__
	/* exec'd by fp_checks() with FPCR and FPSR set: exec must clear both. */
	if (argc > 1 && !strcmp(argv[1], "fpstate"))
		return (MRS(fpcr) != 0) | (MRS(fpsr) != 0) << 1;
	/* Only the ISA result checks (also under qemu-aarch64). */
	if (argc > 1 && !strcmp(argv[1], "isa")) {
		isa_result_checks(argv[0]);
		goto done;
	}
	/*
	 * As /init on an initramfs that has no /tmp (devtmpfs is not mounted
	 * there either), the device checks make their nodes in /tmp.
	 */
	if (getpid() == 1)
		mkdir("/tmp", 01777);
	/* Only the SMP checks (`rdinit=/usr/bin/kwtest -- smp` repeats them faster). */
	if (argc > 1 && !strcmp(argv[1], "smp")) {
		mkdir("/proc", 0555);
		mount("proc", "/proc", "proc", 0, NULL);
		uaccess_checks();
		smp_checks();
		lse_smp_checks();
		excl_smp_checks();
		move_checks();
		jit_smp_checks();
		goto done;
	}
#endif

	write(1, msg, sizeof(msg) - 1);

	uname(&u);
	CHECK(!strcmp(u.machine, "aarch64"), "uname: %s %s %s", u.sysname, u.release, u.machine);
	CHECK(getpid() == 1 || getppid() > 0, "getpid = %d", getpid());
#ifdef __aarch64__
	isa_checks();
	isa_result_checks(argv[0]);
#endif

	/* brk/malloc and anonymous mmap */
	char *big = malloc(1 << 20);
	memset(big, 0x5a, 1 << 20);
	CHECK(big[12345] == 0x5a, "malloc 1 MiB");
	char *m = mmap(NULL, 3 * 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	CHECK(m != MAP_FAILED && m[4096] == 0, "mmap anon");
	strcpy(m + 4096, "cow");

	/* fork + COW + wait */
	int pipefd[2];
	pipe(pipefd);
	pid_t pid = fork();
	if (pid == 0) {
		strcpy(m + 4096, "child");
		write(pipefd[1], m + 4096, 6);
		_exit(42);
	}
	int status = 0;
	char buf[16] = { 0 };
	read(pipefd[0], buf, sizeof(buf));
	waitpid(pid, &status, 0);
	CHECK(WIFEXITED(status) && WEXITSTATUS(status) == 42, "fork/wait status %d", WEXITSTATUS(status));
	CHECK(!strcmp(buf, "child") && !strcmp(m + 4096, "cow"), "pipe '%s', COW kept parent '%s'", buf, m + 4096);

	/* signals */
	signal(SIGUSR1, on_usr1);
	kill(getpid(), SIGUSR1);
	CHECK(got_signal == SIGUSR1, "signal handler + sigreturn");

	/* floating point survives a signal */
	volatile double d = 1.5;
	kill(getpid(), SIGUSR1);
	d = d * 3.0;
	CHECK(d == 4.5, "fp %.2f", d);

	/* mprotect + SIGSEGV in a child */
	pid = fork();
	if (pid == 0) {
		mprotect(m, 4096, PROT_READ);
		m[0] = 1;
		_exit(0);
	}
	waitpid(pid, &status, 0);
	CHECK(WIFSIGNALED(status) && WTERMSIG(status) == SIGSEGV, "SIGSEGV on write to read-only page");

	/* threads: clone(CLONE_SETTLS | CLONE_CHILD_CLEARTID) argument order */
	pthread_t th;
	void *thr = NULL;
	tls_var = 1;
	int prc = pthread_create(&th, NULL, thread_fn, NULL);
	CHECK(prc == 0 && pthread_join(th, &thr) == 0 && thr == (void *)th && tls_var == 1,
	      "pthread: create/join, pthread_self and TLS in the thread");

	/* exec */
	pid = fork();
	if (pid == 0) {
		char *av[] = { argv[0], "child", NULL };
		execvp(argv[0], av);
		_exit(99);
	}
	waitpid(pid, &status, 0);
	CHECK(WIFEXITED(status) && WEXITSTATUS(status) == 7, "execve child exited %d", WEXITSTATUS(status));

	/*
	 * JIT tier: hot() in this process, in a thread and in a forked child
	 * (COW), while a 1 ms SIGALRM timer interrupts the compiled loops. Runs
	 * until at least 3 signals arrived.
	 */
	struct itimerval it = { { 0, 1000 }, { 0, 1000 } }, off = { 0 };
	pthread_t ht;
	void *hres = NULL;
	int runs = 0, bad = 0;

	signal(SIGALRM, on_alarm);
	setitimer(ITIMER_REAL, &it, NULL);
	prc = pthread_create(&ht, NULL, hot_thread, (void *)HOT_SEED);
	pid = fork();
	if (pid == 0)
		_exit(hot(HOT_SEED) == HOT_EXPECT ? 0 : 1);
	do {
		bad += hot(HOT_SEED) != HOT_EXPECT;
		runs++;
	} while ((alarms < 3 || runs < 2) && runs < 200);
	if (prc == 0)
		pthread_join(ht, &hres);
	waitpid(pid, &status, 0);
	setitimer(ITIMER_REAL, &off, NULL);
	CHECK(!bad && prc == 0 && (unsigned long)hres == HOT_EXPECT && WIFEXITED(status) && !WEXITSTATUS(status) && alarms >= 3,
	      "hot loops (JIT): %d runs, %d bad; thread %s, child %s; %d SIGALRMs", runs, bad,
	      (unsigned long)hres == HOT_EXPECT ? "ok" : "BAD", WIFEXITED(status) && !WEXITSTATUS(status) ? "ok" : "BAD", alarms);

	/* JIT tier, F/D: the FP hot loop twice (the second run is compiled) */
	unsigned long fp1 = fphot(HOT_SEED), fp2 = fphot(HOT_SEED);
	CHECK(fp1 == FPHOT_EXPECT && fp2 == FPHOT_EXPECT, "FP hot loop (JIT): %#lx %#lx, want %#lx", fp1, fp2, FPHOT_EXPECT);

#ifdef __aarch64__
	config_checks();
	seccomp_checks();
	ptrace_checks();
	net_config_checks();
	uaccess_checks();
	vaspace_checks();
	input_handler_checks();
	vsock_checks();
	ninep_checks();
	shm_checks();
	fb_checks();
	park_checks();
	smp_checks();
	lse_smp_checks();
	excl_smp_checks();
	move_checks();
	jit_smp_checks();
#endif

done:
	printf("kwtest: %d failure(s)\n", failures);
	fflush(stdout);
	if (getpid() == 1) {
		sync();
		reboot(failures ? RB_HALT_SYSTEM : RB_POWER_OFF);
	}
	return failures != 0;
}
