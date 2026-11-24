// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! A64 JIT, branch family (emit.zig; stream "branches and regions").
//! Semantics: opexec.zig. Every kind is translated: side exits (bcond_x,
//! cbz_x, tbz_x), conditional terminators (bcond, cbz, tbz), followed
//! branches (b_f, bl_f), b, bl, goto, and the indirect ones (br, blr).
//!
//! How each kind leaves (the core's Emit, jitcore.zig):
//!  - side exits: taken -> outside a region `e.exit(target, jc.code_side +
//!    at.k)` + `e.brExit()` (`run` refunds the rest of the block); in a
//!    region (`e.rg != null`) `e.regionSide(rg, target, at.k, at.b)`, which
//!    refunds the rest of the member and continues at a member (through its
//!    checked entry: poll, budget, decode and generation checks) or leaves;
//!  - terminators set l_npc and the code (`e.exit(target, jc.code_done)`, or
//!    a `select` between the target and b.end_pc for a conditional one, the
//!    register for br/blr) and fall through to the block's end; in a region
//!    the core then calls `memberTail`, which branches to the members the
//!    terminator may reach (br/blr compare l_npc with every member's pc; a
//!    target that is no member, misaligned or not,
//!    leaves to `run`, which raises what the interpreter would);
//!  - a terminator whose target is the block's start (`at.self_loop`; a
//!    block compiled on its own, or such a block as a region's guest) is
//!    `e.backEdge(at.b)`: poll (*irqp, and the code epoch where several CPUs
//!    exist), budget, charge, loop (in a region: the member's own loop); a
//!    conditional one only on the taken path, then it leaves to b.end_pc
//!    (in a region: `memberTail`);
//!  - b_f emits nothing, bl_f and bl set x30, blr sets x30 after reading
//!    its target (BLR X30 jumps to the old x30).
//! Conditions come from alu.zig's NZCV model, only through `alu.cond(e,
//! mask)` (a64/jit.md, NZCV); every exit path syncs it first
//! (`e.exit`, `e.backEdge`, `e.toMember` do; the select path calls
//! `jit.sync` itself).
//!
//! The region hooks below (`selfLoop`, `targets`, `memberTail`, `indirect`)
//! only describe where a block may continue.

const std = @import("std");
const ops = @import("../ops.zig");
const kwemu = @import("../../emu/kwemu.zig");
const jc = @import("../../emu/jitcore.zig");
const jit = @import("emit.zig");
const cm = @import("common.zig");
const Op = ops.Op;
const Use = jit.Use;
const Emit = jit.Emit;
const At = jit.At;
const Block = kwemu.Block;
const Region = jc.Region;
const W = jc.W;
const alu = @import("alu.zig");

pub const kinds = [_]ops.H{
    .bcond_x, .cbz_x, .tbz_x, .b_f, .bl_f, .bcond, .cbz, .tbz, .b, .bl, .br, .blr, .goto,
};

/// This family's part of the module's emission state (`e.x.branch`).
pub const Ext = struct {};

pub fn supported(o: Op) bool {
    return switch (o.h) {
        .bcond_x, .cbz_x, .tbz_x, .b_f, .bl_f, .bcond, .cbz, .tbz, .b, .bl, .br, .blr, .goto => true,
        else => false,
    };
}

pub fn usage(o: Op) Use {
    return switch (o.h) {
        .bcond_x, .bcond => .{ .flags_read = true },
        .cbz_x, .tbz_x, .cbz, .tbz => cm.rd(o.a),
        .b_f, .b, .goto => .{},
        .bl_f, .bl => cm.wr(30),
        .br => cm.rd(o.b),
        .blr => cm.rd(o.b).with(cm.wr(30)),
        else => unreachable,
    };
}

/// x30 of a followed BL: (imm & ~0xfff) + d:e (tier.zig, decode).
fn link(o: Op) u64 {
    return (o.imm & ~@as(u64, 0xfff)) +% (@as(u64, o.d) | (@as(u64, o.e) << 8));
}

/// B.cond's condition mask (ops.condMask), in d:e.
fn mask(o: Op) u16 {
    return @as(u16, o.d) | (@as(u16, o.e) << 8);
}

/// Push an i32, nonzero when conditional branch o (either form) is taken
/// (opexec.zig: B.cond, CBZ/CBNZ, TBZ/TBNZ).
fn taken(e: *Emit, o: Op) void {
    switch (o.h) {
        .bcond, .bcond_x => {
            // AL and NV (all 16 bits): taken whatever the flags.
            if (mask(o) == 0xffff) e.k32(1) else alu.cond(e, mask(o));
        },
        .cbz, .cbz_x => {
            // taken = (a & (~0 >> e)) == 0, inverted by d (CBNZ); e = 32: W
            cm.get(e, o.a);
            if (o.e == 32) {
                e.op(W.i32_wrap);
                e.op(W.i32_eqz);
            } else e.op(W.i64_eqz);
            if (o.d != 0) e.op(W.i32_eqz);
        },
        .tbz, .tbz_x => {
            // taken = bit d of a == e (TBZ: 0, TBNZ: 1)
            cm.get(e, o.a);
            e.k64(@as(u64, 1) << @intCast(o.d & 63));
            e.op(W.i64_and);
            e.op(W.i64_eqz);
            if (o.e != 0) e.op(W.i32_eqz);
        },
        else => unreachable,
    }
}

pub fn emit(e: *Emit, o: Op, at: At) void {
    switch (o.h) {
        .bcond_x, .cbz_x, .tbz_x => {
            taken(e, o);
            e.open(W.@"if", W.void_t);
            if (e.rg) |rg| e.regionSide(rg, o.imm, at.k, at.b) else {
                e.exit(o.imm, jc.code_side + at.k);
                e.brExit();
            }
            e.close();
        },
        .bcond, .cbz, .tbz => {
            if (at.self_loop) {
                taken(e, o);
                e.open(W.@"if", W.void_t);
                e.backEdge(at.b);
                e.close();
                e.exit(at.b.end_pc, jc.code_done);
            } else {
                jit.sync(e);
                e.k64(o.imm);
                e.k64(at.b.end_pc);
                taken(e, o);
                e.op(W.select);
                e.set(cm.l_npc);
                e.k64(jc.code_done);
                e.set(cm.l_code);
            }
        },
        .b_f => {},
        .bl_f => {
            e.k64(link(o));
            cm.set(e, 30);
        },
        .b, .bl, .goto => {
            if (o.h == .bl) {
                e.k64(at.b.end_pc);
                cm.set(e, 30);
            }
            if (at.self_loop) e.backEdge(at.b) else e.exit(o.imm, jc.code_done);
        },
        .br, .blr => {
            jit.sync(e);
            // The target first: BLR X30 jumps to the old x30.
            cm.get(e, o.b);
            e.set(cm.l_npc);
            if (o.h == .blr) {
                e.k64(at.b.end_pc);
                cm.set(e, 30);
            }
            e.k64(jc.code_done);
            e.set(cm.l_code);
        },
        else => unreachable,
    }
}

pub fn beginMember(e: *Emit, o: []const Op) void {
    _ = .{ e, o };
}

pub fn sync(e: *Emit) void {
    _ = e;
}

// ---- region hooks (jitcore.zig, `Jit`) --------------------------------------------

/// b's terminator `last` branches to b's own start (the block keeps a module
/// of its own and becomes a wasm loop when compiled whole).
pub fn selfLoop(last: Op, b: *const Block) bool {
    return switch (last.h) {
        .bcond, .cbz, .tbz, .b, .bl, .goto => last.imm == b.pc,
        else => false,
    };
}

/// Where op o of block b may continue that could join b's region: branch
/// targets, the fall-through of a conditional terminator, call return sites.
pub fn targets(o: Op, b: *const Block) [2]?u64 {
    return switch (o.h) {
        .bcond_x, .cbz_x, .tbz_x, .b, .goto => .{ o.imm, null },
        .bcond, .cbz, .tbz, .bl => .{ o.imm, b.end_pc },
        .bl_f => .{ link(o), null },
        .blr => .{ b.end_pc, null },
        else => .{ null, null },
    };
}

/// After member b's terminator `last` (which set l_npc): continue at the
/// members it may reach (an indirect one compares with every member).
pub fn memberTail(e: *Emit, rg: *Region, b: *const Block, last: Op) void {
    switch (last.h) {
        .b, .bl, .goto => if (rg.memberAt(last.imm)) |t| e.toMember(rg, t),
        .bcond, .cbz, .tbz => {
            for ([_]u64{ last.imm, b.end_pc }) |pt| {
                if (rg.memberAt(pt)) |t| e.targetIf(rg, t);
            }
        },
        .br, .blr => for (0..rg.n) |t| e.targetIf(rg, t),
        else => {},
    }
}

/// Statistics: an indirect-jump terminator.
pub fn indirect(last: Op) bool {
    return last.h == .br or last.h == .blr;
}

// ---- tests (kindtest.zig) -----------------------------------------------------------

const kt = @import("kindtest.zig");

/// B or BL (`bl`) from pc to a random word of the second code page (all SVC):
/// a terminator.
fn far(r: std.Random, pc: u64, bl: bool) u32 {
    const t = kt.code_va + 4096 + 4 * r.uintLessThan(u64, 1024);
    const off: u32 = @truncate((t -% pc) >> 2);
    return (if (bl) @as(u32, 0x9400_0000) else 0x1400_0000) | (off & 0x3ff_ffff);
}
/// B or BL a few words forward in the same page: followed (b_f, bl_f).
fn near(r: std.Random, bl: bool) u32 {
    return (if (bl) @as(u32, 0x9400_0000) else 0x1400_0000) | (1 + r.uintLessThan(u32, 3));
}

test "a64 jit branch: b_f" {
    try kt.kind(.b_f, struct {
        fn g(r: std.Random, out: []u32, pc: u64) usize {
            _ = pc;
            out[0] = if (r.boolean()) near(r, false) else kt.movi(r);
            return 1;
        }
    }.g, .{});
}
test "a64 jit branch: bl_f" {
    try kt.kind(.bl_f, struct {
        fn g(r: std.Random, out: []u32, pc: u64) usize {
            _ = pc;
            out[0] = if (r.boolean()) near(r, true) else kt.movi(r);
            return 1;
        }
    }.g, .{});
}
test "a64 jit branch: b" {
    try kt.kind(.b, struct {
        fn g(r: std.Random, out: []u32, pc: u64) usize {
            out[0] = if (r.uintLessThan(u32, 8) == 0) far(r, pc, false) else kt.movi(r);
            return 1;
        }
    }.g, .{});
}
test "a64 jit branch: bl" {
    try kt.kind(.bl, struct {
        fn g(r: std.Random, out: []u32, pc: u64) usize {
            out[0] = if (r.uintLessThan(u32, 8) == 0) far(r, pc, true) else kt.movi(r);
            return 1;
        }
    }.g, .{});
}
test "a64 jit branch: goto (blocks cut at max_block instructions)" {
    try kt.kind(.goto, struct {
        fn g(r: std.Random, out: []u32, pc: u64) usize {
            _ = pc;
            out[0] = kt.movi(r);
            return 1;
        }
    }.g, .{ .words = 150 });
}

// ---- encodings (tests) ----------------------------------------------------------------

fn off19(pc: u64, t: u64) u32 {
    return @as(u32, @truncate((t -% pc) >> 2)) & 0x7ffff;
}
fn encBcond(cond: u32, pc: u64, t: u64) u32 {
    return 0x5400_0000 | (off19(pc, t) << 5) | cond;
}
fn encCbz(sf: bool, nz: bool, rt: u32, pc: u64, t: u64) u32 {
    return (@as(u32, @intFromBool(sf)) << 31) | 0x3400_0000 | (@as(u32, @intFromBool(nz)) << 24) | (off19(pc, t) << 5) | rt;
}
fn encTbz(bit: u32, nz: bool, rt: u32, pc: u64, t: u64) u32 {
    const off14 = @as(u32, @truncate((t -% pc) >> 2)) & 0x3fff;
    return ((bit >> 5) << 31) | 0x3600_0000 | (@as(u32, @intFromBool(nz)) << 24) | ((bit & 31) << 19) | (off14 << 5) | rt;
}
fn encAdr(rd: u32, pc: u64, t: u64) u32 {
    const d: u32 = @truncate(t -% pc);
    return 0x1000_0000 | ((d & 3) << 29) | (((d >> 2) & 0x7ffff) << 5) | rd;
}
fn encB(pc: u64, t: u64) u32 {
    return 0x1400_0000 | (@as(u32, @truncate((t -% pc) >> 2)) & 0x3ff_ffff);
}
fn encBl(pc: u64, t: u64) u32 {
    return 0x9400_0000 | (@as(u32, @truncate((t -% pc) >> 2)) & 0x3ff_ffff);
}
fn encBr(rn: u32) u32 {
    return 0xd61f_0000 | (rn << 5);
}
fn encBlr(rn: u32) u32 {
    return 0xd63f_0000 | (rn << 5);
}
fn encRet(rn: u32) u32 {
    return 0xd65f_0000 | (rn << 5);
}
fn movz(rd: u32, imm: u32) u32 {
    return 0xd280_0000 | ((imm & 0xffff) << 5) | rd;
}
const svc = @import("../machine.zig").svc0;

// ---- per-kind tests -----------------------------------------------------------------

/// ADDS/SUBS (immediate), CMP/CMN among them: changes NZCV inside a program
/// (handed back while alu.zig does not translate it).
fn flagsWord(r: std.Random) u32 {
    const rd: u32 = if (r.boolean()) 31 else kt.dst(r);
    return 0x3100_0000 | kt.sf(r) | (r.uintLessThan(u32, 2) << 30) | (r.uintLessThan(u32, 4096) << 10) | (kt.anyReg(r) << 5) | rd;
}
/// Mostly movi; nop, a flag-setting op, a followed BL now and then.
fn filler(r: std.Random) u32 {
    return switch (r.uintLessThan(u32, 16)) {
        0 => flagsWord(r),
        1 => kt.nop(r),
        2 => near(r, true),
        else => kt.movi(r),
    };
}
/// Target of a conditional branch at pc: the program start (a loop: the
/// first block's terminator), a few words ahead or back, the second code
/// page (all SVC). Side exits and terminators both occur.
fn condTarget(r: std.Random, pc: u64) u64 {
    return switch (r.uintLessThan(u32, 8)) {
        0, 1 => kt.code_va,
        2, 3, 4 => pc +% 4 * (1 + r.uintLessThan(u64, 8)),
        5 => if (pc >= kt.code_va + 16) pc - 4 * (1 + r.uintLessThan(u64, 4)) else pc + 8,
        else => kt.code_va + 4096 + 4 * r.uintLessThan(u64, 1024),
    };
}
/// One conditional branch of family f (0 B.cond, 1 CBZ/CBNZ, 2 TBZ/TBNZ)
/// in four words, else filler.
fn CondGen(comptime f: u2) kt.Gen {
    return struct {
        fn g(r: std.Random, out: []u32, pc: u64) usize {
            if (r.uintLessThan(u32, 4) != 0) {
                out[0] = filler(r);
                return 1;
            }
            const t = condTarget(r, pc);
            out[0] = switch (f) {
                0 => encBcond(r.uintLessThan(u32, 16), pc, t),
                1 => encCbz(r.boolean(), r.boolean(), kt.anyReg(r), pc, t),
                else => encTbz(r.uintLessThan(u32, 64), r.boolean(), kt.anyReg(r), pc, t),
            };
            return 1;
        }
    }.g;
}

test "a64 jit branch: bcond_x" {
    try kt.kind(.bcond_x, CondGen(0), .{ .budget = 20_000 });
}
test "a64 jit branch: bcond" {
    try kt.kind(.bcond, CondGen(0), .{ .budget = 20_000 });
}
test "a64 jit branch: cbz_x" {
    try kt.kind(.cbz_x, CondGen(1), .{ .budget = 20_000 });
}
test "a64 jit branch: cbz" {
    try kt.kind(.cbz, CondGen(1), .{ .budget = 20_000 });
}
test "a64 jit branch: tbz_x" {
    try kt.kind(.tbz_x, CondGen(2), .{ .budget = 20_000 });
}
test "a64 jit branch: tbz" {
    try kt.kind(.tbz, CondGen(2), .{ .budget = 20_000 });
}

/// Target of an indirect branch whose ADR is at pc: the program start, any
/// word of the program, ahead, the second page, a misaligned address.
fn indTarget(r: std.Random, pc: u64) u64 {
    return switch (r.uintLessThan(u32, 8)) {
        0 => kt.code_va,
        1, 2 => kt.code_va + 4 * r.uintLessThan(u64, 24),
        3, 4 => pc + 8 + 4 * r.uintLessThan(u64, 8),
        5 => kt.code_va + 4096 + 4 * r.uintLessThan(u64, 1024),
        6 => pc + 9 + r.uintLessThan(u64, 3), // misaligned
        else => if (pc >= kt.code_va + 16) pc - 4 * (1 + r.uintLessThan(u64, 4)) else pc + 8,
    };
}
/// `adr xN, T; br/blr xN` (x16, or x30: BLR X30 jumps to the old x30), RET
/// (x30 random or a link), BR to an unmapped page (x23) or to XZR, else
/// filler (which has followed BLs, so RET also returns to links).
fn genIndirect(r: std.Random, out: []u32, pc: u64) usize {
    switch (r.uintLessThan(u32, 16)) {
        0...3 => {
            const rn: u32 = if (r.boolean()) 16 else 30;
            out[0] = encAdr(rn, pc, indTarget(r, pc));
            out[1] = if (r.boolean()) encBr(rn) else encBlr(rn);
            return 2;
        },
        4 => out[0] = encRet(30),
        5 => out[0] = if (r.boolean()) encBr(23) else encBlr(31),
        else => out[0] = filler(r),
    }
    return 1;
}

test "a64 jit branch: br" {
    try kt.kind(.br, genIndirect, .{ .budget = 20_000 });
}
test "a64 jit branch: blr" {
    try kt.kind(.blr, genIndirect, .{ .budget = 20_000 });
}

// ---- exhaustive conditions, loops, budgets, interrupts, the code epoch ---------------

const mach = @import("../machine.zig");
const Machine = mach.Machine;
const Regs = mach.Regs;
const tier = @import("../tier.zig");
const jt = @import("tests.zig");
const tt = std.testing;
const R: u64 = 2;
const Wr: u64 = 4;
const X: u64 = 8;

/// Two machines, one running kw_run (the JIT with an eager host in the
/// wasm64 unit tests), one the reference loop; code pages at 0x10000 and
/// 0x20000 (unused words SVC), a data page at 0x40000.
const Pair = struct {
    m: [2]Machine,

    fn init() !Pair {
        var p: Pair = .{ .m = .{ try Machine.init(tt.allocator), try Machine.init(tt.allocator) } };
        for (&p.m) |*m| {
            m.map(0x10000, m.frame(), R | X);
            m.map(0x20000, m.frame(), R | X);
            m.mapData(0x40000, 1);
            // Regions grow along the first exit towards another page.
            if (jc.enabled) m.cpu.priv.jit.grow_threshold = 1;
        }
        return p;
    }
    fn deinit(p: *Pair) void {
        for (&p.m) |*m| m.deinit();
    }
    /// New code at 0x10000 and 0x20000 (the rest SVC); drops what was
    /// decoded and compiled.
    fn load(p: *Pair, page0: []const u32, page1: []const u32) void {
        for (&p.m) |*m| {
            for ([_]u64{ 0x10000, 0x20000 }, [_][]const u32{ page0, page1 }) |va, w| {
                const words: []align(1) u32 = std.mem.bytesAsSlice(u32, m.at(va)[0..4096]);
                @memset(words, svc);
                @memcpy(words[0..w.len], w);
            }
            m.cpu.resetCache();
            m.cpu.flushAll();
        }
    }
    /// Run both from `regs`; event, icount, registers, event details and
    /// memory must match. Returns the event.
    fn go(p: *Pair, regs: Regs, budget: u64) !u32 {
        for (&p.m) |*m| {
            m.regs = regs;
            m.cpu.icount = 0;
        }
        const T = &p.m[0];
        const Rf = &p.m[1];
        const et = T.run(budget);
        const er = Rf.runRef(budget);
        var bad = et != er or T.cpu.icount != Rf.cpu.icount or !std.mem.eql(u8, std.mem.asBytes(&T.regs), std.mem.asBytes(&Rf.regs));
        if (et != mach.EV_BUDGET and !std.mem.eql(u8, std.mem.asBytes(&T.cpu.ev), std.mem.asBytes(&Rf.cpu.ev))) bad = true;
        if (!std.mem.eql(u8, T.mem[0..@intCast(T.next)], Rf.mem[0..@intCast(Rf.next)])) bad = true;
        if (bad) {
            std.debug.print("budget {d}: kw_run event {d} icount {d} pc 0x{x}, reference {d} icount {d} pc 0x{x}\n", .{ budget, et, T.cpu.icount, T.regs.pc, er, Rf.cpu.icount, Rf.regs.pc });
            for (0..31) |k| if (T.regs.x[k] != Rf.regs.x[k]) std.debug.print("  x{d}: 0x{x} vs 0x{x}\n", .{ k, T.regs.x[k], Rf.regs.x[k] });
            if (T.regs.nzcv != Rf.regs.nzcv) std.debug.print("  nzcv: 0x{x} vs 0x{x}\n", .{ T.regs.nzcv, Rf.regs.nzcv });
            return error.TestUnexpectedResult;
        }
        return et;
    }
};

/// Whether some module of m's CPU holds a region of several members.
fn regionFormed(m: *Machine) bool {
    if (!jc.enabled) return false;
    const st = &m.cpu.priv.jit;
    for (st.owner, st.members) |o, ms| {
        if (o != 0 and ms[1] != 0) return true;
    }
    return false;
}

/// A conditional branch for `forms`: B.cond `cond`, CB(N)Z `sf` `rt`, or
/// TB(N)Z bit `bit` of `rt`.
const CondB = struct {
    h: enum { bcond, cbz, tbz },
    cond: u32 = 0,
    sf: bool = true,
    nz: bool = false,
    rt: u32 = 5,
    bit: u32 = 0,

    fn at(c: CondB, pc: u64, t: u64) u32 {
        return switch (c.h) {
            .bcond => encBcond(c.cond, pc, t),
            .cbz => encCbz(c.sf, c.nz, c.rt, pc, t),
            .tbz => encTbz(c.bit, c.nz, c.rt, pc, t),
        };
    }
};

/// Run conditional branch `c` from `regs` (taken or not: `taken`) in every
/// shape the JIT emits: a side exit, a self-loop's terminator, a terminator
/// that is a block's last instruction (`max_block`; the select), a side
/// exit and a last-instruction terminator in a region on one page (A: movz;
/// br x20 -> B, which branches back to A when taken, else on to C: svc),
/// each against the reference and the expected outcome.
fn forms(p: *Pair, c: CondB, regs0: Regs, is_taken: bool) !void {
    var regs = regs0;
    regs.pc = 0x10000;
    regs.x[20] = 0x10100;
    regs.x[21] = 0x10200;
    var w: [80]u32 = undefined;
    // 0: side exit: taken -> x0 = 2, else x0 = 1.
    p.load(&.{ c.at(0x10000, 0x1000c), movz(0, 1), svc, movz(0, 2), svc }, &.{});
    try tt.expectEqual(@as(u32, mach.EV_SYSCALL), try p.go(regs, 1000));
    try tt.expectEqual(@as(u64, if (is_taken) 2 else 1), p.m[0].regs.x[0]);
    // 1: a self-loop: L: movz x1, #3; cond L; movz x0, #1; svc.
    p.load(&.{ movz(1, 3), c.at(0x10004, 0x10000), movz(0, 1), svc }, &.{});
    try tt.expectEqual(@as(u32, if (is_taken) mach.EV_BUDGET else mach.EV_SYSCALL), try p.go(regs, 101));
    // 2: max_block - 1 movz, then the branch as the block's last
    // instruction (a terminator that is no loop) to 0x10200: taken -> x0 = 2.
    const last = tier.max_block - 1;
    for (0..last) |k| w[k] = movz(1, @intCast(k));
    w[last] = c.at(0x10000 + last * 4, 0x10200);
    w[last + 1] = movz(0, 1);
    w[last + 2] = svc;
    var page: [0x90]u32 = @splat(svc);
    @memcpy(page[0 .. last + 3], w[0 .. last + 3]);
    page[0x80] = movz(0, 2);
    p.load(&page, &.{});
    try tt.expectEqual(@as(u32, mach.EV_SYSCALL), try p.go(regs, 1000));
    try tt.expectEqual(@as(u64, if (is_taken) 2 else 1), p.m[0].regs.x[0]);
    // 3: a region: A (0x10000): movz x1, #1; br x20. B (0x10100): cond A
    // (a side exit); br x21. C (0x10200): svc.
    page = @splat(svc);
    page[0] = movz(1, 1);
    page[1] = encBr(20);
    page[0x40] = c.at(0x10100, 0x10000);
    page[0x41] = encBr(21);
    p.load(&page, &.{});
    try tt.expectEqual(@as(u32, if (is_taken) mach.EV_BUDGET else mach.EV_SYSCALL), try p.go(regs, 301));
    if (is_taken and jc.enabled) try tt.expect(regionFormed(&p.m[0]));
    // 4: the same with B = max_block - 1 movz, then the branch to A as its
    // last instruction (a terminator in a region, through memberTail).
    var big: [0x90]u32 = @splat(svc);
    big[0] = movz(1, 1);
    big[1] = encBr(20);
    for (0..last) |k| big[0x40 + k] = movz(2, @intCast(k));
    big[0x40 + last] = c.at(0x10100 + last * 4, 0x10000);
    p.load(&big, &.{});
    try tt.expectEqual(@as(u32, if (is_taken) mach.EV_BUDGET else mach.EV_SYSCALL), try p.go(regs, 1001));
    if (is_taken and jc.enabled) try tt.expect(regionFormed(&p.m[0]));
}

test "a64 jit branch: B.cond, every condition against every NZCV value" {
    var p = try Pair.init();
    defer p.deinit();
    for (0..16) |cond| {
        const m = ops.condMask(@intCast(cond));
        for (0..16) |f| {
            var regs: Regs = .{};
            regs.nzcv = @as(u32, @intCast(f)) << 28;
            try forms(&p, .{ .h = .bcond, .cond = @intCast(cond) }, regs, (m >> @intCast(f)) & 1 != 0);
        }
    }
}

test "a64 jit branch: CBZ/CBNZ, W and X, on edge values" {
    var p = try Pair.init();
    defer p.deinit();
    const vals = [_]u64{ 0, 1, 0x8000_0000, 0xffff_ffff, 1 << 32, 0xffff_ffff_0000_0000, 1 << 63, ~@as(u64, 0) };
    for ([_]bool{ false, true }) |sf| for ([_]bool{ false, true }) |nz| {
        for (vals) |v| {
            var regs: Regs = .{};
            regs.x[5] = v;
            const zero = (if (sf) v else v & 0xffff_ffff) == 0;
            try forms(&p, .{ .h = .cbz, .sf = sf, .nz = nz }, regs, zero != nz);
        }
        // XZR: always zero.
        try forms(&p, .{ .h = .cbz, .sf = sf, .nz = nz, .rt = 31 }, .{}, !nz);
    };
}

test "a64 jit branch: TBZ/TBNZ, every bit index" {
    var p = try Pair.init();
    defer p.deinit();
    for (0..64) |bit| for ([_]bool{ false, true }) |nz| {
        const one = @as(u64, 1) << @intCast(bit);
        for ([_]u64{ one, ~one, 0, ~@as(u64, 0) }) |v| {
            var regs: Regs = .{};
            regs.x[5] = v;
            try forms(&p, .{ .h = .tbz, .bit = @intCast(bit), .nz = nz }, regs, (v & one != 0) == nz);
        }
        if (bit % 16 == 0) try forms(&p, .{ .h = .tbz, .bit = @intCast(bit), .nz = nz, .rt = 31 }, .{}, !nz);
    };
}

/// Loops for the budget, interrupt and epoch tests: page 0, page 1, the
/// registers they start from.
const Loop = struct { p0: []const u32, p1: []const u32, regs: Regs };

/// A self-loop with a side exit that is not taken: L: movz x0, #1; tbnz
/// x5, #0, out; movz x1, #2; cbz x9, L (x5 = x9 = 0).
const self_loop: Loop = .{ .p0 = &.{ movz(0, 1), encTbz(0, true, 5, 0x10004, 0x10100), movz(1, 2), encCbz(true, false, 9, 0x1000c, 0x10000) }, .p1 = &.{}, .regs = .{ .pc = 0x10000 } };
/// A call loop over two pages: A: movz x0, #0; bl F. C (A's return site):
/// movz x2, #3; cbz x0, A (a side exit back to A); svc. F (0x20000):
/// movz x9, #1; ret. A region of A, C and F (BL, RET's member compare, a
/// side exit to a member).
const call_loop: Loop = .{ .p0 = &.{ movz(0, 0), encBl(0x10004, 0x20000), movz(2, 3), encCbz(true, false, 0, 0x1000c, 0x10000), svc }, .p1 = &.{ movz(9, 1), encRet(30) }, .regs = .{ .pc = 0x10000 } };
/// Two blocks on one page that jump to each other: A: movz x1, #1; br x20.
/// B (0x10100): movz x2, #2; br x21 (x20 = B, x21 = A).
const br_loop: Loop = .{ .p0 = &(.{ movz(1, 1), encBr(20) } ++ [_]u32{svc} ** 62 ++ .{ movz(2, 2), encBr(21) }), .p1 = &.{}, .regs = blk: {
    var r: Regs = .{ .pc = 0x10000 };
    r.x[20] = 0x10100;
    r.x[21] = 0x10000;
    break :blk r;
} };

test "a64 jit branch: the budget ends at every position of compiled loops" {
    var p = try Pair.init();
    defer p.deinit();
    for ([_]Loop{ self_loop, call_loop, br_loop }, 0..) |l, i| {
        p.load(l.p0, l.p1);
        // Warm up: compiled, and the regions grown.
        try tt.expectEqual(@as(u32, mach.EV_BUDGET), try p.go(l.regs, 5000));
        if (i > 0 and jc.enabled) try tt.expect(regionFormed(&p.m[0]));
        for (1..100) |budget| _ = try p.go(l.regs, budget);
        for ([_]u64{ 997, 998, 999, 1000, 1001, 4096 }) |budget| _ = try p.go(l.regs, budget);
        if (jc.enabled) try tt.expectEqual(@as(u64, 0), p.m[0].cpu.priv.jit.handbacks);
    }
}

/// A self-loop entered from a region: A: movz x3, #3; cbz x9, L. L
/// (0x10100): subs x3, x3, #1; b.ne L. M (L's end): movz x1, #2; cbz x9, A
/// (x9 = 0). L keeps a module of its own and joins A's region as a guest
/// along A's exits to it (`noteHot`).
const guest_loop: Loop = .{ .p0 = &(.{ movz(3, 3), encCbz(true, false, 9, 0x10004, 0x10100) } ++ [_]u32{svc} ** 62 ++
    .{ 0xf100_0463, encBcond(1, 0x10104, 0x10100), movz(1, 2), encCbz(true, false, 9, 0x1010c, 0x10000) }), .p1 = &.{}, .regs = .{ .pc = 0x10000 } };

/// Whether the block at pc runs as a guest of some region of m's CPU (its
/// code copied into a module that is not its home).
fn guestAt(m: *Machine, pc: u64) bool {
    if (!jc.enabled) return false;
    const st = &m.cpu.priv.jit;
    for (&m.cpu.priv.blocks, 0..) |*b, i| {
        if (b.pc != pc or b.jx.st < jc.compiled) continue;
        const home = b.jx.st & 0xffff;
        for (st.owner, st.members, 0..) |o, ms, s| {
            if (o == 0 or s == home) continue;
            for (ms) |x| if (x == i + 1) return true;
        }
    }
    return false;
}

test "a64 jit branch: a self-loop runs inside a region as a guest: exact budgets, epoch stops" {
    var p = try Pair.init();
    defer p.deinit();
    p.load(guest_loop.p0, guest_loop.p1);
    try tt.expectEqual(@as(u32, mach.EV_BUDGET), try p.go(guest_loop.regs, 5000));
    if (jc.enabled) try tt.expect(guestAt(&p.m[0], 0x10100));
    for (1..100) |budget| _ = try p.go(guest_loop.regs, budget);
    for ([_]u64{ 997, 998, 999, 1000, 1001, 4096 }) |budget| _ = try p.go(guest_loop.regs, budget);
    if (!jc.enabled) return;
    try tt.expectEqual(@as(u64, 0), p.m[0].cpu.priv.jit.handbacks);
    // Most passes stay in the region: few entries per 10000 instructions.
    const before = p.m[0].cpu.priv.jit.entries;
    _ = try p.go(guest_loop.regs, 10000);
    try tt.expect(p.m[0].cpu.priv.jit.entries - before < 50);
    // A changed code epoch (a stand-in compiled code reads; `run` reads the
    // real one): every poll stops, and the budget still ends exactly.
    var fake: u64 = p.m[0].cpu.priv.a64.seen_epoch +% 1;
    p.m[0].cpu.priv.a64.epoch_ptr = @intFromPtr(&fake);
    for ([_]u64{ 1, 2, 7, 100, 1000 }) |budget| _ = try p.go(guest_loop.regs, budget);
}

/// The compile hook's stand-in for another CPU (jt.hook.call): at compile
/// number `at`, raise the interrupt (irq), or store `word` at `va` and
/// execute IC IVAU there on CPU `other` (the code epoch).
const Other = struct {
    var at: u32 = 0;
    var irq: u32 = 0;
    var m: ?*Machine = null;
    var other: ?*kwemu.Cpu = null;
    var va: u64 = 0;
    var word: u32 = 0;

    fn call(n: u32) void {
        if (n != at) return;
        if (m) |mm| {
            const p: *align(1) u32 = @ptrCast(mm.at(va).ptr);
            p.* = word;
            tier.icIvau(other.?, va);
        } else irq = 1;
    }
};

test "a64 jit branch: an interrupt raised during a compile stops compiled loops at the next poll" {
    if (!jc.enabled) return error.SkipZigTest;
    defer jt.hook = .{};
    // The self-loop: compile 1 raises it, the first back edge stops.
    // The BR loop: compile 2 (B, which takes A into its region) raises it:
    // B runs once, A's checked entry stops.
    for ([_]Loop{ self_loop, br_loop }, [_]u64{ 4, 4 }) |l, want| {
        var m = try Machine.init(tt.allocator);
        defer m.deinit();
        m.cpu.irq_pending = &Other.irq;
        m.map(0x10000, m.frame(), R | X);
        @memcpy(m.at(0x10000)[0 .. l.p0.len * 4], std.mem.sliceAsBytes(l.p0));
        m.regs = l.regs;
        Other.irq = 0;
        Other.m = null;
        Other.at = if (l.p0.len == 4) 1 else 2;
        jt.hook = .{ .call = &Other.call };
        try tt.expectEqual(@as(u32, mach.EV_INTERRUPT), m.run(100_000));
        try tt.expectEqual(want, m.cpu.icount);
        try tt.expectEqual(@as(u64, 0x10000), m.regs.pc);
    }
    // The call loop: an interrupt raised during any of its compiles is seen
    // within one member (or by `run`) after it.
    for (1..8) |at| {
        var m = try Machine.init(tt.allocator);
        defer m.deinit();
        m.cpu.priv.jit.grow_threshold = 1;
        m.cpu.irq_pending = &Other.irq;
        m.map(0x10000, m.frame(), R | X);
        m.map(0x20000, m.frame(), R | X);
        @memcpy(m.at(0x10000)[0 .. call_loop.p0.len * 4], std.mem.sliceAsBytes(call_loop.p0));
        @memcpy(m.at(0x20000)[0 .. call_loop.p1.len * 4], std.mem.sliceAsBytes(call_loop.p1));
        m.regs = call_loop.regs;
        Other.irq = 0;
        Other.m = null;
        Other.at = @intCast(at);
        jt.hook = .{ .call = &Other.call };
        const ev = m.run(100_000);
        if (jt.hook.compiles < at) {
            try tt.expectEqual(@as(u32, mach.EV_BUDGET), ev);
            continue;
        }
        try tt.expectEqual(@as(u32, mach.EV_INTERRUPT), ev);
        try tt.expect(m.cpu.icount < 64);
    }
}

test "a64 jit branch: compiled loops leave when another CPU rewrites their code (code epoch)" {
    if (!jc.enabled) return error.SkipZigTest;
    defer {
        jt.hook = .{};
        Other.m = null;
    }
    // The other CPU stores SVC over the loop's first instruction and
    // executes IC IVAU during compile `at`; this CPU is then inside the
    // compiled loop, which must see the epoch at its next back edge or
    // checked member entry and leave, so that the SVC runs (pc past it).
    // Without the poll the loop runs until the budget.
    const unconditional: Loop = .{ .p0 = &.{ movz(0, 7), encB(0x10004, 0x10000) }, .p1 = &.{}, .regs = .{ .pc = 0x10000 } };
    for ([_]Loop{ self_loop, unconditional, br_loop }, [_]u32{ 1, 1, 2 }, [_]u64{ 4 + 1, 2 + 1, 4 + 1 }) |l, at, want| {
        var m = try Machine.init(tt.allocator);
        defer m.deinit();
        const other = try m.newCpu();
        defer m.freeCpu(other);
        m.map(0x10000, m.frame(), R | X);
        other.flushAll();
        @memcpy(m.at(0x10000)[0 .. l.p0.len * 4], std.mem.sliceAsBytes(l.p0));
        m.regs = l.regs;
        Other.m = &m;
        Other.other = other;
        Other.va = 0x10000;
        Other.word = svc;
        Other.at = at;
        jt.hook = .{ .call = &Other.call };
        try tt.expectEqual(@as(u32, mach.EV_SYSCALL), m.run(100_000));
        try tt.expectEqual(want, m.cpu.icount);
        try tt.expectEqual(@as(u64, 0x10004), m.regs.pc);
        if (l.p0.len > 4) try tt.expect(regionFormed(&m));
    }
}
