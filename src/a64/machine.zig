// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! A minimal machine for running raw A64 words through kw_run's Zig
//! entry (`run.run`): a struct kw_cpu, a few MiB of "physical memory" at
//! pa 0x8000_0000, page tables built on demand. Used by the unit tests
//! (tests.zig) and the coverage classifier (classify.zig).
//!
//!   var m = try Machine.init(allocator);
//!   defer m.deinit();
//!   m.mapData(0x20000, 1);                     // one RW page
//!   m.code(0x10000, &.{ 0xd2800540, svc0 });   // mov x0, #42; svc #0
//!   try expectEqual(EV_SYSCALL, m.run(100));

const std = @import("std");
const kwemu = @import("../emu/kwemu.zig");
const jc = @import("../emu/jitcore.zig");
const run_mod = @import("run.zig");
pub const Regs = run_mod.Regs;
const Cpu = kwemu.Cpu;

pub const pa_base: u64 = 0x8000_0000;
const V = 1;
const R = 2;
const W = 4;
const X = 8;
const U = 16;
const A = 64;
const D = 128;

pub const EV_BUDGET = 0;
pub const EV_SYSCALL = 1;
pub const EV_FAULT = 2;
pub const EV_ILLEGAL = 3;
pub const EV_BREAKPOINT = 4;
pub const EV_MISALIGNED = 5;
pub const EV_INTERRUPT = 6;

/// svc #0
pub const svc0: u32 = 0xd400_0001;

pub const Machine = struct {
    gpa: std.mem.Allocator,
    mem: []align(4096) u8,
    next: u64 = 0,
    root: u64 = 0,
    cpu: *Cpu,
    regs: Regs = .{},

    pub fn init(gpa: std.mem.Allocator) !Machine {
        return initSize(gpa, 2 << 20);
    }
    pub fn initSize(gpa: std.mem.Allocator, size: usize) !Machine {
        const mem = try gpa.alignedAlloc(u8, .fromByteUnits(4096), size);
        @memset(mem, 0);
        const cpu_mem = try gpa.alignedAlloc(u8, .fromByteUnits(8), kwemu.cpu_size);
        const cpu: *Cpu = @ptrCast(cpu_mem.ptr);
        run_mod.cpuInit(cpu);
        var m: Machine = .{ .gpa = gpa, .mem = mem, .cpu = cpu };
        cpu.phys_base = @intFromPtr(mem.ptr) -% pa_base;
        m.root = m.frame();
        kwemu.setPgd(cpu, m.root);
        return m;
    }
    pub fn deinit(m: *Machine) void {
        m.cpu.resetCache(); // gives compiled code back to the JIT host
        m.gpa.free(m.mem);
        const p: [*]align(8) u8 = @ptrCast(m.cpu);
        const sl: []align(8) u8 = p[0..kwemu.cpu_size];
        m.gpa.free(sl);
    }
    /// A fresh zeroed frame (bump allocator).
    pub fn frame(m: *Machine) u64 {
        const pa = pa_base + m.next;
        m.next += 4096;
        return pa;
    }
    pub fn bytes(m: *Machine, pa: u64) []u8 {
        return m.mem[@intCast(pa - pa_base)..][0..4096];
    }
    fn tbl(m: *Machine, pa: u64) *[512]u64 {
        return @ptrCast(@alignCast(m.bytes(pa).ptr));
    }
    fn slot(m: *Machine, va: u64) *u64 {
        var tb = m.root;
        var level: u6 = 3;
        while (level > 0) : (level -= 1) {
            const e = &m.tbl(tb)[@intCast((va >> (12 + 9 * level)) & 511)];
            if (e.* & V == 0) e.* = ((m.frame() >> 12) << 10) | V;
            tb = (e.* >> 10) << 12;
        }
        return &m.tbl(tb)[@intCast((va >> 12) & 511)];
    }
    /// Map the page at `va` to `pa` with Sv48 flags (R, W, X; U, A, D and V
    /// are added).
    pub fn map(m: *Machine, va: u64, pa: u64, prot: u64) void {
        m.slot(va).* = ((pa >> 12) << 10) | prot | U | A | D | V;
        m.cpu.flushAll();
    }
    pub fn unmap(m: *Machine, va: u64) void {
        m.slot(va).* = 0;
        m.cpu.flushAll();
    }
    /// `pages` fresh read-write pages at `va`.
    pub fn mapData(m: *Machine, va: u64, pages: usize) void {
        for (0..pages) |i| m.map(va + i * 4096, m.frame(), R | W);
    }
    /// A read-execute page at `va` holding `words`; pc = va.
    pub fn code(m: *Machine, va: u64, words: []const u32) void {
        const pa = m.frame();
        @memcpy(m.bytes(pa)[0 .. words.len * 4], std.mem.sliceAsBytes(words));
        m.map(va, pa, R | X);
        m.regs.pc = va;
    }
    /// Host bytes of the mapped page at `va` (page offset onwards).
    pub fn at(m: *Machine, va: u64) []u8 {
        const e = m.slot(va).*;
        const pa = ((e >> 10) & ((1 << 44) - 1)) << 12;
        return m.bytes(pa)[@intCast(va & 4095)..];
    }
    pub fn run(m: *Machine, budget: u64) u32 {
        m.cpu.budget = budget;
        return run_mod.run(m.cpu, &m.regs);
    }
    /// The reference loop (run.runRef) instead of kw_run's tier.
    pub fn runRef(m: *Machine, budget: u64) u32 {
        m.cpu.budget = budget;
        return run_mod.runRef(m.cpu, &m.regs);
    }
    /// Another CPU on the same memory and page table (free with freeCpu).
    /// It never compiles (-Dkwemu-jit): kwemu's slot pool is per wasm
    /// instance (its stubs in the one function table), and in a kernel each
    /// CPU is an instance of its own, while here both share this one.
    pub fn newCpu(m: *Machine) !*Cpu {
        const cpu_mem = try m.gpa.alignedAlloc(u8, .fromByteUnits(8), kwemu.cpu_size);
        const cpu: *Cpu = @ptrCast(cpu_mem.ptr);
        run_mod.cpuInit(cpu);
        if (jc.enabled) cpu.priv.jit.threshold = jc.never;
        cpu.phys_base = m.cpu.phys_base;
        kwemu.setPgd(cpu, m.root);
        return cpu;
    }
    pub fn freeCpu(m: *Machine, cpu: *Cpu) void {
        cpu.resetCache();
        const p: [*]align(8) u8 = @ptrCast(cpu);
        const sl: []align(8) u8 = p[0..kwemu.cpu_size];
        m.gpa.free(sl);
    }
    /// The physical address mapped at `va` (0 if none).
    pub fn paOf(m: *Machine, va: u64) u64 {
        const e = m.slot(va).*;
        if (e & V == 0) return 0;
        return ((e >> 10) & ((1 << 44) - 1)) << 12;
    }
};
