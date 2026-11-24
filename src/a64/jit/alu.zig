// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! A64 JIT, ALU family (emit.zig; stream "ALU and flags"). Semantics:
//! opexec.zig, field layout: ops.zig. Every kind of the family is
//! translated, each variant resolved at emit time (shift counts, masks and
//! the operation as constants): moves, ADD/SUB and the logical ops
//! (immediate, register, shifted, extended, ROR), their flag-setting forms,
//! CSEL and its aliases, CCMP/CCMN, ADC/SBC(S).
//!
//! NZCV (owned here; consumed by branch.zig, csel, ccmp, adc). The contract
//! the other files rely on:
//!  - common.zig's l_nzcv holds NZCV in bits 31..28 (as regs.nzcv) on every
//!    path that leaves straight-line code: the core calls `sync` before each
//!    exit, member transfer and self-loop back edge, and the epilogue stores
//!    l_nzcv to regs.nzcv when any op of the module has flags_write. So
//!    every exit and hand-back leaves regs.nzcv exact (an event, the next
//!    block or the interpreter may read it).
//!  - `beginMember` starts each block / member with nothing known but
//!    l_nzcv (a member is entered from other members and from `run`).
//!  - A consumer asks `cond(e, mask)` for a condition (`ops.condMask`: bit i
//!    = the condition holds for NZCV = i); anything that needs the whole
//!    word calls `nzcv(e)` (pushes it as an i64). Both emit an expression
//!    only (no state change), so either may be called on any path.
//!  - `sync` emits code only on the path it is called on and must not change
//!    the emit-time state of the path that continues.
//!  - `syncHead` (through emit.zig's, which the core calls instead of
//!    `sync` before a branch back to the start of the block or member being
//!    emitted: a self-loop's back edge) emits nothing when the block needs
//!    no flags at its start (`Ext.head_dead`): l_nzcv may then be stale
//!    there, because nothing reads it and nothing can leave before the
//!    block's first flag write.
//!
//! Lazy flags. A flag-setting op does not compute NZCV: it leaves its
//! operands and result in l_alu locals (A in l_fa, B in l_fb or the
//! constant `Ext.bk`, the result R in l_fr; W forms shifted left by 32, as
//! the interpreter computes their flags, so that 64-bit compares give the
//! 32-bit answers) and what they mean in `Ext` (`Kind`: NZCV of A - B, of
//! A + B, or N and Z of a logical result R; for CCMP/CCMN those if l_fc !=
//! 0, else its constant). A consumer computes its condition from them
//! directly (CMP + B.cond is one i64 compare, CSEL a compare and a select,
//! ADC's carry a compare). NZCV is materialised into l_nzcv by `sync` on
//! the path that leaves, or, when a producer's flags reach the end of its
//! member anyway (where it exits or hands back), once right after the
//! producer on the main path (`synced`: no copy on every exit path); not
//! in a block compiled as its own loop, whose back edge may skip them. A
//! backward scan in `beginMember` marks producers whose flags are
//! overwritten before anything reads them or the code can leave (`dead`):
//! they emit only their register result, or nothing (CMP, TST, CCMP).
//! ADCS/SBCS (a variable carry in) compute NZCV exactly into l_nzcv.

const std = @import("std");
const ops = @import("../ops.zig");
const jc = @import("../../emu/jitcore.zig");
const jit = @import("emit.zig");
const cm = @import("common.zig");
const Op = ops.Op;
const Use = jit.Use;
const Emit = jit.Emit;
const At = jit.At;
const W = jc.W;

pub const kinds = [_]ops.H{
    .nop,       .movi,   .movk,    .mov,     .add_i,     .adds_i, .logic_i, .ands_i, .addsub_r,
    .addsubs_r, .add_rr, .adds_rr, .logic_r, .logic_ror, .ands_r, .csel,    .ccmp,   .adc,
};

// The lazy-flag locals (common.zig: l_alu + 0..7).
const l_fa = cm.l_alu; // A
const l_fb = cm.l_alu + 1; // B (when not a constant)
const l_fr = cm.l_alu + 2; // R
const l_fc = cm.l_alu + 3; // CCMP/CCMN: its condition held (0 / 1)

/// What the flags are, as far as the emitter knows.
pub const Kind = enum(u8) {
    /// l_nzcv holds them.
    exact,
    /// NZCV of A + B (carry in 0: ADDS, CMN, CCMN).
    add,
    /// NZCV of A - B (A + ~B + 1: SUBS, CMP, CCMP).
    sub,
    /// N and Z of R, C = V = 0 (ANDS, BICS, TST).
    logic,
};

/// This family's part of the module's emission state (`e.x.alu`).
pub const Ext = struct {
    kind: Kind = .exact,
    /// .add / .sub: B is this constant (else it is in l_fb).
    bk: ?u64 = null,
    /// CCMP/CCMN: the flags are those of `kind` when l_fc != 0, else `def`
    /// (bits 3..0 = N, Z, C, V).
    ccmp: bool = false,
    def: u4 = 0,
    /// l_nzcv already holds the flags `kind` describes (sync: nothing to do).
    synced: bool = true,
    /// Bit k: the flags op k of the member writes are dead (overwritten
    /// before anything reads them or the code can leave).
    dead: u64 = 0,
    /// Bit k: no op after op k writes flags (op k's flags reach the
    /// member's end: an exit or a hand-back).
    last: u64 = 0,
    /// Nothing reads the flags or can leave before the member's first flag
    /// write: a branch back to its start need not materialise them.
    head_dead: bool = false,
};

pub fn supported(o: Op) bool {
    return jit.family(o.h) == .alu;
}

pub fn usage(o: Op) Use {
    const flags: Use = .{ .flags_write = true };
    return switch (o.h) {
        .nop => .{},
        .movi => cm.wr(o.a),
        .movk => cm.rd(o.a).with(cm.wr(o.a)),
        .mov, .add_i, .logic_i => cm.rd(o.b).with(cm.wr(o.a)),
        .adds_i, .ands_i => cm.rd(o.b).with(cm.wr(o.a)).with(flags),
        .addsub_r, .add_rr, .logic_r, .logic_ror => cm.abc(o),
        .addsubs_r, .adds_rr, .ands_r => cm.abc(o).with(flags),
        .csel => cm.abc(o).with(.{ .flags_read = true }),
        .ccmp => cm.rd(o.b).with(cm.rd(o.c)).with(.{ .flags_read = true, .flags_write = true }),
        .adc => cm.abc(o).with(.{ .flags_read = true, .flags_write = o.g & 2 != 0 }),
        else => unreachable,
    };
}

// ---- flag analysis ----------------------------------------------------------------

/// What an op of a translated prefix does to NZCV.
const Fx = enum {
    /// nothing, and it cannot leave
    none,
    /// writes all four flags, reads none
    write,
    /// CCMP/CCMN: reads them only when its own flags are live (else it
    /// emits nothing)
    ccmp,
    /// ADCS/SBCS: reads C whenever it emits anything, writes all four
    adcs,
    /// reads them (CSEL, ADC, B.cond, ...) or may leave the code (a memory
    /// op's hand-back, a side exit, a terminator), where they must be exact
    use,
};

fn effect(o: Op) Fx {
    return switch (jit.family(o.h)) {
        .bits => .none,
        .alu => switch (o.h) {
            .adds_i, .ands_i, .addsubs_r, .adds_rr, .ands_r => .write,
            .ccmp => .ccmp,
            .adc => if (o.g & 2 != 0) .adcs else .use,
            .csel => .use,
            else => .none,
        },
        // followed branches: no flags, no exit (ops.zig)
        .branch => if (o.h == .b_f or o.h == .bl_f) .none else .use,
        else => .use,
    };
}

pub fn beginMember(e: *Emit, o: []const Op) void {
    var x: Ext = .{};
    // Backward: is NZCV live after op k?
    var live = true; // the member ends in an exit or a hand-back
    var written = false;
    var k = o.len;
    while (k > 0) {
        k -= 1;
        const fx = effect(o[k]);
        if (fx == .none) continue;
        if (fx == .use or k >= 64) {
            live = true;
            continue;
        }
        const bit = @as(u64, 1) << @intCast(k);
        if (!live) x.dead |= bit;
        if (!written) x.last |= bit;
        written = true;
        live = switch (fx) {
            .write => false,
            .ccmp => live, // dead: it emits nothing and reads nothing
            .adcs => live or o[k].g & 4 != 0, // it reads C whenever it runs
            else => unreachable,
        };
    }
    // Forward: the first op that touches NZCV (or may leave) writes it.
    for (o) |op| switch (effect(op)) {
        .none => {},
        .write => {
            x.head_dead = true;
            break;
        },
        else => break,
    };
    e.x.alu = x;
}

fn isDead(e: *Emit, at: At) bool {
    return at.k < 64 and e.x.alu.dead & (@as(u64, 1) << @intCast(at.k)) != 0;
}

/// A live producer set the lazy state: materialise NZCV at once when its
/// flags reach the member's end (every way out would need them), unless the
/// block is compiled as its own loop (whose back edge may skip them,
/// `head_dead`). A self-loop that is a region's guest materialises them as
/// every member does: with lazy flags there, the A64 block fuzz found a stale
/// NZCV written back (seed 12899, KWEMU_JIT_SIMD=0).
fn produced(e: *Emit, at: At, kind: Kind, bk: ?u64, ccmp: bool, def: u4) void {
    e.x.alu.kind = kind;
    e.x.alu.bk = bk;
    e.x.alu.ccmp = ccmp;
    e.x.alu.def = def;
    e.x.alu.synced = kind == .exact;
    const last = at.k < 64 and e.x.alu.last & (@as(u64, 1) << @intCast(at.k)) != 0;
    if (last and (!at.self_loop or e.rg != null) and !e.x.alu.synced) {
        e.site = 3;
        materialise(e);
        e.set(cm.l_nzcv);
        e.x.alu.synced = true;
    }
}

/// l_nzcv holds NZCV now (a `generic` call loaded it from regs.nzcv).
pub fn exactNow(e: *Emit) void {
    e.x.alu.kind = .exact;
    e.x.alu.bk = null;
    e.x.alu.ccmp = false;
    e.x.alu.synced = true;
}

pub fn sync(e: *Emit) void {
    if (e.x.alu.synced) return;
    materialise(e);
    e.set(cm.l_nzcv);
}

/// `sync` before a branch back to the start of the block or member being
/// emitted (emit.zig `syncHead`).
pub fn syncHead(e: *Emit) void {
    if (!e.x.alu.head_dead) sync(e);
}

// ---- conditions and materialisation -----------------------------------------------

const cond_masks: [16]u16 = blk: {
    @setEvalBranchQuota(100_000);
    var t: [16]u16 = undefined;
    for (0..16) |i| t[i] = ops.condMask(@intCast(i));
    break :blk t;
};

fn condOf(mask: u16) ?u4 {
    for (cond_masks, 0..) |m, i| if (m == mask) return @intCast(i);
    return null;
}

fn pushB(e: *Emit) void {
    if (e.x.alu.bk) |k| e.k64(k) else e.get(l_fb);
}

/// Push V in bit 63: (A ^ B) & (A ^ R) for A - B, (A ^ R) & (B ^ R) for
/// A + B.
fn overflow(e: *Emit) void {
    if (e.x.alu.kind == .sub) {
        e.get(l_fa);
        pushB(e);
        e.op(W.i64_xor);
        e.get(l_fa);
        e.get(l_fr);
    } else {
        e.get(l_fa);
        e.get(l_fr);
        e.op(W.i64_xor);
        pushB(e);
        e.get(l_fr);
    }
    e.op(W.i64_xor);
    e.op(W.i64_and);
}

/// Push an i32: the sign bit of the i64 on the stack is set (`set`) or
/// clear.
fn sign(e: *Emit, set: bool) void {
    e.k64(0);
    e.op(if (set) W.i64_lt_s else W.i64_ge_s);
}

/// Push an i32: C of A + B (carry in 0) is set (`set`) or clear.
fn carryAdd(e: *Emit, set: bool) void {
    e.get(l_fr);
    e.get(l_fa);
    e.op(if (set) W.i64_lt_u else W.i64_ge_u);
}

/// Push an i32: R != 0 (`ne`) or R == 0.
fn zero(e: *Emit, ne: bool) void {
    e.get(l_fr);
    if (ne) {
        e.k64(0);
        e.op(W.i64_ne);
    } else e.op(W.i64_eqz);
}

/// Push an i32: condition c (0..13) holds for the lazy state's own flags
/// (CCMP's default aside).
fn inner(e: *Emit, c: u4) void {
    const pos = c & 1 == 0; // even: the condition, odd: its negation
    if (c >> 1 == 2) { // MI / PL: N, the sign of R, whatever the kind
        e.get(l_fr);
        return sign(e, pos);
    }
    switch (e.x.alu.kind) {
        .exact => unreachable,
        .sub => switch (c >> 1) {
            3 => { // VS / VC
                overflow(e);
                sign(e, pos);
            },
            else => { // compares of A and B
                e.get(l_fa);
                pushB(e);
                e.op(switch (c) {
                    0 => W.i64_eq,
                    1 => W.i64_ne,
                    2 => W.i64_ge_u, // CS: no borrow
                    3 => W.i64_lt_u,
                    8 => W.i64_gt_u, // HI: C & !Z
                    9 => W.i64_le_u,
                    10 => W.i64_ge_s, // GE: N == V
                    11 => W.i64_lt_s,
                    12 => W.i64_gt_s,
                    13 => W.i64_le_s,
                    else => unreachable,
                });
            },
        },
        .add => switch (c >> 1) {
            0 => zero(e, !pos), // EQ / NE
            1 => carryAdd(e, pos), // CS / CC
            3 => { // VS / VC
                overflow(e);
                sign(e, pos);
            },
            4 => { // HI: C & !Z; LS: !C | Z
                carryAdd(e, pos);
                zero(e, pos);
                e.op(if (pos) W.i32_and else W.i32_or);
            },
            5, 6 => { // GE: N == V; LT; GT: GE & !Z; LE: LT | Z
                e.get(l_fr);
                overflow(e);
                e.op(W.i64_xor);
                sign(e, !pos);
                if (c >> 1 == 6) {
                    zero(e, pos);
                    e.op(if (pos) W.i32_and else W.i32_or);
                }
            },
            else => unreachable,
        },
        .logic => switch (c >> 1) {
            0 => zero(e, !pos), // EQ / NE
            1, 3, 4 => e.k32(if (pos) 0 else 1), // C = V = 0: CS, VS, HI never; CC, VC, LS always
            5 => { // GE: N == 0; LT
                e.get(l_fr);
                sign(e, !pos);
            },
            6 => { // GT: R > 0; LE
                e.get(l_fr);
                e.k64(0);
                e.op(if (pos) W.i64_gt_s else W.i64_le_s);
            },
            else => unreachable,
        },
    }
}

/// Push (mask >> (NZCV >> 28)) & 1 (an i32); `exact`: NZCV from l_nzcv,
/// else `nzcv`. Uses no local but those (a consumer may hold l_t).
fn testMask(e: *Emit, mask: u16, exact: bool) void {
    e.k64(mask);
    if (exact) e.get(cm.l_nzcv) else nzcv(e);
    e.k64(28);
    e.op(W.i64_shr_u);
    e.op(W.i64_shr_u);
    e.op(W.i32_wrap);
    e.k32(1);
    e.op(W.i32_and);
}

/// Push an i32: 1 if the condition with mask `mask` (ops.condMask) holds
/// for the current flags, else 0.
pub fn cond(e: *Emit, mask: u16) void {
    const x = &e.x.alu;
    if (mask == 0xffff) return e.k32(1);
    const c = condOf(mask) orelse {
        // Not a condition code's mask: test it against the whole word.
        return testMask(e, mask, false);
    };
    if (x.kind == .exact) return testMask(e, mask, true);
    inner(e, c);
    if (x.ccmp) {
        e.k32(@intCast((mask >> x.def) & 1));
        e.get(l_fc);
        e.op(W.i32_wrap);
        e.op(W.select);
    }
}

/// Push the current NZCV word (bits 31..28) as an i64.
pub fn nzcv(e: *Emit) void {
    if (e.x.alu.synced) return e.get(cm.l_nzcv);
    materialise(e);
}

/// Push NZCV (bits 31..28, an i64) computed from the lazy state.
fn materialise(e: *Emit) void {
    const x = &e.x.alu;
    if (x.kind == .exact) return e.get(cm.l_nzcv);
    e.statInc(jc.Jx.sync_site + e.site);
    e.site = 0; // a sync no caller named is an exit
    // N: bit 63 of R to bit 31
    e.get(l_fr);
    e.k64(32);
    e.op(W.i64_shr_u);
    e.k64(0x8000_0000);
    e.op(W.i64_and);
    // Z
    e.get(l_fr);
    e.op(W.i64_eqz);
    e.op(W.i64_ext_u);
    e.k64(30);
    e.op(W.i64_shl);
    e.op(W.i64_or);
    if (x.kind != .logic) {
        // C
        if (x.kind == .sub) {
            e.get(l_fa);
            pushB(e);
            e.op(W.i64_ge_u);
        } else carryAdd(e, true);
        e.op(W.i64_ext_u);
        e.k64(29);
        e.op(W.i64_shl);
        e.op(W.i64_or);
        // V
        overflow(e);
        e.k64(63);
        e.op(W.i64_shr_u);
        e.k64(28);
        e.op(W.i64_shl);
        e.op(W.i64_or);
    }
    if (x.ccmp) {
        e.k64(@as(u64, x.def) << 28);
        e.get(l_fc);
        e.op(W.i32_wrap);
        e.op(W.select);
    }
}

// ---- operands ---------------------------------------------------------------------

const ones: u64 = std.math.maxInt(u64);

/// Push ((slot << s1) >>a s2) & mask (ops.zig's operand-2 transform).
fn op2(e: *Emit, slot: u8, s1: u8, s2: u8, mask: u64) void {
    if (slot == ops.zr) return e.k64(0);
    cm.get(e, slot);
    if (s1 != 0) {
        e.k64(s1);
        e.op(W.i64_shl);
    }
    if (s2 != 0) {
        e.k64(s2);
        e.op(W.i64_shr_s);
    }
    if (mask != ones) {
        e.k64(mask);
        e.op(W.i64_and);
    }
}

fn shl(e: *Emit, n: u64) void {
    if (n == 0) return;
    e.k64(n);
    e.op(W.i64_shl);
}
fn shrU(e: *Emit, n: u64) void {
    if (n == 0) return;
    e.k64(n);
    e.op(W.i64_shr_u);
}
/// & 0xffffffff for a W form.
fn low32(e: *Emit, w: bool) void {
    if (!w) return;
    e.k64(0xffff_ffff);
    e.op(W.i64_and);
}
fn not(e: *Emit) void {
    e.k64(ones);
    e.op(W.i64_xor);
}

/// The wasm op of a logical operation selector (logic_i's e, logic_r's g
/// bits 0..1): 1 AND, 2 EOR, 3 ORR.
fn logicOp(m: u8) u8 {
    return switch (m & 3) {
        1 => W.i64_and,
        2 => W.i64_xor,
        3 => W.i64_or,
        else => unreachable, // the decoder never makes 0
    };
}

/// A flag-setting add or subtract: A (already shifted for a W form) is on
/// the stack, B is `bk` or on the stack above A. Leaves A, B and R in the
/// lazy locals; `dst` (unless XZR) = R >> cw. `ccmp`: CCMP/CCMN with
/// default `def` (l_fc already set).
fn addsFlags(e: *Emit, at: At, sub: bool, bk: ?u64, cw: u6, dst: u8, ccmp: bool, def: u4) void {
    if (bk) |k| {
        e.tee(l_fa);
        e.k64(if (sub) 0 -% k else k);
        e.op(W.i64_add);
    } else {
        e.set(l_fb);
        e.tee(l_fa);
        e.get(l_fb);
        e.op(if (sub) W.i64_sub else W.i64_add);
    }
    if (dst != ops.zr) {
        e.tee(l_fr);
        shrU(e, cw);
        cm.set(e, dst);
    } else e.set(l_fr);
    produced(e, at, if (sub) .sub else .add, bk, ccmp, def);
}

/// The unshifted result v of a logical op is on the stack: R = v << cw in
/// l_fr; `dst` (unless XZR) = v, its low half for a W form.
fn logicFlags(e: *Emit, at: At, cw: u6, dst: u8) void {
    if (dst != ops.zr) {
        e.tee(cm.l_t);
        low32(e, cw != 0);
        cm.set(e, dst);
        e.get(cm.l_t);
    }
    shl(e, cw);
    e.set(l_fr);
    produced(e, at, .logic, null, false, 0);
}

/// Push slot rotated right by n (1..63; W: its low half by 1..31,
/// zero-extended).
fn ror(e: *Emit, slot: u8, n: u8, w: bool) void {
    if (slot == ops.zr) return e.k64(0);
    cm.get(e, slot);
    if (w) {
        e.op(W.i32_wrap);
        e.k32(n);
        e.op(W.i32_rotr);
        e.op(W.i64_ext_u);
    } else {
        e.k64(n);
        e.op(W.i64_rotr);
    }
}

pub fn emit(e: *Emit, o: Op, at: At) void {
    switch (o.h) {
        .nop => {},
        .movi => {
            e.k64(o.imm);
            cm.set(e, o.a);
        },
        .movk => {
            cm.get(e, o.a);
            e.k64(o.imm);
            e.op(W.i64_and);
            e.k64((@as(u64, o.e) | (@as(u64, o.f) << 8)) << @intCast(o.d));
            e.op(W.i64_or);
            cm.set(e, o.a);
        },
        .mov => {
            cm.get(e, o.b);
            if (o.imm != ones) {
                e.k64(o.imm);
                e.op(W.i64_and);
            }
            cm.set(e, o.a);
        },
        .add_i => {
            cm.get(e, o.b);
            e.k64(o.imm);
            e.op(W.i64_add);
            if (o.d != 0) {
                e.k64(ones >> @intCast(o.d));
                e.op(W.i64_and);
            }
            cm.set(e, o.a);
        },
        .adds_i => {
            // flags of (b << d) + imm + e; a = result >> d (f: Rd is not XZR)
            const cw: u6 = @intCast(o.d);
            if (isDead(e, at)) {
                if (o.f == 0) return;
                // imm + e is + B or - B, shifted: its low half is 0 for W
                cm.get(e, o.b);
                e.k64((o.imm +% o.e) >> cw);
                e.op(W.i64_add);
                low32(e, cw != 0);
                cm.set(e, o.a);
                return;
            }
            const sub = o.e != 0;
            cm.get(e, o.b);
            shl(e, cw);
            addsFlags(e, at, sub, if (sub) ~o.imm else o.imm, cw, if (o.f != 0) o.a else ops.zr, false, 0);
        },
        .logic_i => {
            cm.get(e, o.b);
            e.k64(o.imm);
            e.op(logicOp(o.e));
            if (o.d != 0) {
                e.k64(ones >> @intCast(o.d));
                e.op(W.i64_and);
            }
            cm.set(e, o.a);
        },
        .ands_i => {
            // N, Z of b & imm (at d = 0 or 32); a = b & imm (f)
            const dst: u8 = if (o.f != 0) o.a else ops.zr;
            const dead = isDead(e, at);
            if (dead and dst == ops.zr) return;
            cm.get(e, o.b);
            e.k64(o.imm);
            e.op(W.i64_and);
            if (dead) return cm.set(e, dst);
            logicFlags(e, at, @intCast(o.d), dst);
        },
        .addsub_r, .add_rr => {
            // g: bit 0 SUB, bit 3 W
            cm.get(e, o.b);
            if (o.h == .add_rr) cm.get(e, o.c) else op2(e, o.c, o.d, o.e, o.imm);
            e.op(if (o.g & 1 != 0) W.i64_sub else W.i64_add);
            low32(e, o.g & 8 != 0);
            cm.set(e, o.a);
        },
        .addsubs_r, .adds_rr => {
            // g: bit 0 SUB, bit 1 write a, bit 3 W
            const g = o.g;
            const cw: u6 = if (g & 8 != 0) 32 else 0;
            const sub = g & 1 != 0;
            const dst: u8 = if (g & 2 != 0) o.a else ops.zr;
            if (isDead(e, at)) {
                if (dst == ops.zr) return;
                cm.get(e, o.b);
                if (o.h == .adds_rr) cm.get(e, o.c) else op2(e, o.c, o.d, o.e, o.imm);
                e.op(if (sub) W.i64_sub else W.i64_add);
                low32(e, cw != 0);
                cm.set(e, dst);
                return;
            }
            cm.get(e, o.b);
            shl(e, cw);
            if (o.c == ops.zr) return addsFlags(e, at, sub, 0, cw, dst, false, 0);
            if (o.h == .adds_rr) cm.get(e, o.c) else op2(e, o.c, o.d, o.e, o.imm);
            shl(e, cw);
            addsFlags(e, at, sub, null, cw, dst, false, 0);
        },
        .logic_r, .logic_ror => {
            // g: bits 0..1 the operation, bit 2 invert operand 2, bit 3 W
            const g = o.g;
            const w = g & 8 != 0;
            cm.get(e, o.b);
            if (o.h == .logic_r) op2(e, o.c, o.d, o.e, o.imm) else ror(e, o.c, o.d, w);
            if (g & 4 != 0) not(e);
            e.op(logicOp(g));
            low32(e, w);
            cm.set(e, o.a);
        },
        .ands_r => {
            // g: bit 1 write a, bit 2 invert operand 2, bit 3 W
            const g = o.g;
            const w = g & 8 != 0;
            const dst: u8 = if (g & 2 != 0) o.a else ops.zr;
            const dead = isDead(e, at);
            if (dead and dst == ops.zr) return;
            cm.get(e, o.b);
            op2(e, o.c, o.d, o.e, o.imm);
            if (g & 4 != 0) not(e);
            e.op(W.i64_and);
            if (dead) {
                low32(e, w);
                return cm.set(e, dst);
            }
            logicFlags(e, at, if (w) 32 else 0, dst);
        },
        .csel => {
            // a = cond ? b : (c ^ inv) + inc; imm: 0..15 mask, 16 inc, 17 inv, 18 W
            cm.get(e, o.b);
            cm.get(e, o.c);
            if (o.imm & (1 << 17) != 0) not(e);
            if (o.imm & (1 << 16) != 0) {
                e.k64(1);
                e.op(W.i64_add);
            }
            cond(e, @truncate(o.imm));
            e.op(W.select);
            low32(e, o.imm & (1 << 18) != 0);
            cm.set(e, o.a);
        },
        .ccmp => {
            // if cond: flags of (b << d) - ((c + imm5) << d) (or +), else the
            // default; imm: 0..15 mask, 16..19 default, 20 SUB, 24..28 imm5
            if (isDead(e, at)) return;
            const cw: u6 = @intCast(o.d);
            const sub = o.imm & (1 << 20) != 0;
            const imm5 = (o.imm >> 24) & 31;
            const def: u4 = @intCast((o.imm >> 16) & 15);
            // The condition first: it reads the state this op replaces.
            cond(e, @truncate(o.imm));
            e.op(W.i64_ext_u);
            e.set(l_fc);
            cm.get(e, o.b);
            shl(e, cw);
            if (o.c == ops.zr) return addsFlags(e, at, sub, imm5 << cw, cw, ops.zr, true, def);
            cm.get(e, o.c);
            if (imm5 != 0) {
                e.k64(imm5);
                e.op(W.i64_add);
            }
            shl(e, cw);
            addsFlags(e, at, sub, null, cw, ops.zr, true, def);
        },
        .adc => adc(e, o, at),
        else => unreachable,
    }
}

/// ADC, ADCS, SBC, SBCS: b + (c ^ -sub) + C; g: bit 0 SUB, bit 1 set
/// flags, bit 2 write a, bit 3 W. The flags are computed exactly (the
/// carry in is not known at emit time).
fn adc(e: *Emit, o: Op, at: At) void {
    const g = o.g;
    const w = g & 8 != 0;
    const cw: u6 = if (w) 32 else 0;
    const flags = g & 2 != 0 and !isDead(e, at);
    const write = g & 4 != 0;
    if (!flags and !write) return;
    const t_cin = cm.l_t;
    const t_a = cm.l_t + 1;
    const t_b = cm.l_t + 2;
    const t_s = cm.l_t + 3;
    const t_r = cm.l_t + 4;
    cond(e, cond_masks[2]); // CS: the carry in
    e.op(W.i64_ext_u);
    e.set(t_cin);
    if (!flags) {
        cm.get(e, o.b);
        cm.get(e, o.c);
        if (g & 1 != 0) not(e);
        e.op(W.i64_add);
        e.get(t_cin);
        e.op(W.i64_add);
        low32(e, w);
        cm.set(e, o.a);
        return;
    }
    // As opexec: the flags of (b << cw) + ((c ^ -sub) << cw) + (cin << cw).
    cm.get(e, o.b);
    shl(e, cw);
    e.set(t_a);
    cm.get(e, o.c);
    if (g & 1 != 0) not(e);
    shl(e, cw);
    e.tee(t_b);
    e.get(t_a);
    e.op(W.i64_add);
    e.tee(t_s);
    e.get(t_cin);
    shl(e, cw);
    e.op(W.i64_add);
    e.set(t_r);
    // N
    e.get(t_r);
    e.k64(32);
    e.op(W.i64_shr_u);
    e.k64(0x8000_0000);
    e.op(W.i64_and);
    // Z
    e.get(t_r);
    e.op(W.i64_eqz);
    e.op(W.i64_ext_u);
    e.k64(30);
    e.op(W.i64_shl);
    e.op(W.i64_or);
    // C = (s < a) | (r < s)
    e.get(t_s);
    e.get(t_a);
    e.op(W.i64_lt_u);
    e.get(t_r);
    e.get(t_s);
    e.op(W.i64_lt_u);
    e.op(W.i32_or);
    e.op(W.i64_ext_u);
    e.k64(29);
    e.op(W.i64_shl);
    e.op(W.i64_or);
    // V = ((a ^ r) & (b ^ r)) >> 63
    e.get(t_a);
    e.get(t_r);
    e.op(W.i64_xor);
    e.get(t_b);
    e.get(t_r);
    e.op(W.i64_xor);
    e.op(W.i64_and);
    e.k64(63);
    e.op(W.i64_shr_u);
    e.k64(28);
    e.op(W.i64_shl);
    e.op(W.i64_or);
    e.set(cm.l_nzcv);
    produced(e, at, .exact, null, false, 0);
    if (write) {
        e.get(t_r);
        shrU(e, cw);
        cm.set(e, o.a);
    }
}

// ---- tests (kindtest.zig) -----------------------------------------------------------

const kt = @import("kindtest.zig");

/// A source register or XZR / SP (31).
fn src(r: std.Random) u32 {
    return kt.anyReg(r);
}
/// A destination, or 31 (XZR: CMP, CMN, TST) now and then.
fn dstz(r: std.Random) u32 {
    return if (r.uintLessThan(u32, 3) == 0) 31 else kt.dst(r);
}
/// A 12-bit immediate, small half of the time (equal operands).
fn imm12(r: std.Random) u32 {
    return if (r.boolean()) r.uintLessThan(u32, 4) else r.uintLessThan(u32, 4096);
}
/// A shift amount for sf (bit 31): 0 half of the time.
fn amount(r: std.Random, sf: u32) u32 {
    return if (r.boolean()) 0 else r.uintLessThan(u32, if (sf != 0) 64 else 32);
}

/// One word making xm a relative of xn: its low half, xn with one bit or the
/// whole high half flipped, xn + 1, xn - 1, a copy.
pub fn relate(r: std.Random, n: u32, m: u32) u32 {
    return switch (r.uintLessThan(u32, 7)) {
        0 => 0x2a00_03e0 | (n << 16) | m, // mov wm, wn
        1 => 0xd241_0000 | (n << 5) | m, // eor xm, xn, #1 << 63
        2 => 0xd260_0000 | (n << 5) | m, // eor xm, xn, #1 << 32
        3 => 0xd260_7c00 | (n << 5) | m, // eor xm, xn, #0xffffffff00000000
        4 => 0x9100_0400 | (n << 5) | m, // add xm, xn, #1
        5 => 0xd100_0400 | (n << 5) | m, // sub xm, xn, #1
        else => 0xaa00_03e0 | (n << 16) | m, // mov xm, xn
    };
}

/// A word maker given its two source registers.
pub const Word = fn (std.Random, u32, u32) u32;

/// Words from f, a third of them after `relate` made the second source a
/// relative of the first (edge operands: equal low halves, ...).
pub fn Rel(comptime f: Word) kt.Gen {
    return struct {
        fn g(r: std.Random, out: []u32, pc: u64) usize {
            _ = pc;
            if (r.uintLessThan(u32, 3) != 0) {
                out[0] = f(r, src(r), src(r));
                return 1;
            }
            const n = kt.dst(r);
            const m = kt.dst(r);
            out[0] = relate(r, n, m);
            out[1] = if (r.boolean()) f(r, n, m) else f(r, m, n);
            return 2;
        }
    }.g;
}

/// Words from f half of the time, else from the flag soup (producers,
/// consumers, hand-backs, side exits).
fn Mix(comptime f: Word) kt.Gen {
    return struct {
        fn g(r: std.Random, out: []u32, pc: u64) usize {
            if (r.boolean()) return Rel(f)(r, out, pc);
            return soup(r, out, pc);
        }
    }.g;
}

fn wMovk(r: std.Random, n: u32, m: u32) u32 {
    _ = .{ n, m };
    const sf = kt.sf(r);
    return 0x7280_0000 | sf | (r.uintLessThan(u32, if (sf != 0) 4 else 2) << 21) | (r.int(u16) << 5) | kt.dst(r);
}
fn wMov(r: std.Random, n: u32, m: u32) u32 {
    return switch (r.uintLessThan(u32, 4)) {
        0 => 0x2a00_03e0 | kt.sf(r) | (m << 16) | kt.dst(r), // mov (register)
        1 => 0xd53b_d040 | kt.dst(r), // mrs tpidr_el0
        2 => 0xd51b_d040 | n, // msr tpidr_el0
        else => blk: { // extr #0
            const sf = kt.sf(r);
            break :blk 0x1380_0000 | sf | (sf >> 9) | (m << 16) | (n << 5) | kt.dst(r);
        },
    };
}
fn wAddI(r: std.Random, n: u32, m: u32) u32 { // ADD/SUB (immediate), SP forms
    _ = m;
    return 0x1100_0000 | kt.sf(r) | (r.uintLessThan(u32, 2) << 30) | (r.uintLessThan(u32, 2) << 22) | (imm12(r) << 10) | (n << 5) | kt.dst(r);
}
fn wAddsI(r: std.Random, n: u32, m: u32) u32 { // ADDS/SUBS/CMP/CMN (immediate)
    _ = m;
    return 0x3100_0000 | kt.sf(r) | (r.uintLessThan(u32, 2) << 30) | (r.uintLessThan(u32, 2) << 22) | (imm12(r) << 10) | (n << 5) | dstz(r);
}
fn wLogicI(r: std.Random, n: u32, m: u32) u32 { // AND/ORR/EOR (immediate); some reserved
    _ = m;
    const sf = kt.sf(r);
    return 0x1200_0000 | sf | (r.uintLessThan(u32, 3) << 29) | (if (sf != 0) r.uintLessThan(u32, 2) << 22 else 0) | (r.uintLessThan(u32, 64) << 16) | (r.uintLessThan(u32, 64) << 10) | (n << 5) | kt.dst(r);
}
fn wAndsI(r: std.Random, n: u32, m: u32) u32 { // ANDS/TST (immediate)
    _ = m;
    const sf = kt.sf(r);
    return 0x7200_0000 | sf | (if (sf != 0) r.uintLessThan(u32, 2) << 22 else 0) | (r.uintLessThan(u32, 64) << 16) | (r.uintLessThan(u32, 64) << 10) | (n << 5) | dstz(r);
}
/// ADD/SUB (shifted register), `s` = with flags; amount 0 (add_rr) half of
/// the time.
fn shifted(r: std.Random, n: u32, m: u32, s: u32) u32 {
    const sf = kt.sf(r);
    return 0x0b00_0000 | sf | (r.uintLessThan(u32, 2) << 30) | (s << 29) | (r.uintLessThan(u32, 3) << 22) | (m << 16) | (amount(r, sf) << 10) | (n << 5) | (if (s != 0) dstz(r) else kt.dst(r));
}
/// ADD/SUB (extended register), every option and shift 0..4.
fn extended(r: std.Random, n: u32, m: u32, s: u32) u32 {
    return 0x0b20_0000 | kt.sf(r) | (r.uintLessThan(u32, 2) << 30) | (s << 29) | (m << 16) | (r.uintLessThan(u32, 8) << 13) | (r.uintLessThan(u32, 5) << 10) | (n << 5) | (if (s != 0) dstz(r) else kt.dst(r));
}
fn wAddSubR(r: std.Random, n: u32, m: u32) u32 {
    return if (r.boolean()) shifted(r, n, m, 0) else extended(r, n, m, 0);
}
fn wAddSubsR(r: std.Random, n: u32, m: u32) u32 {
    return if (r.boolean()) shifted(r, n, m, 1) else extended(r, n, m, 1);
}
fn wAddRR(r: std.Random, n: u32, m: u32) u32 {
    return shifted(r, n, m, 0) & ~@as(u32, 0xfc00 | (3 << 22)); // LSL #0
}
fn wAddsRR(r: std.Random, n: u32, m: u32) u32 {
    return shifted(r, n, m, 1) & ~@as(u32, 0xfc00 | (3 << 22));
}
/// Logical (shifted register): opc (3 = ANDS), shift type, N.
fn logical(r: std.Random, n: u32, m: u32, opc: u32, typ: u32) u32 {
    const sf = kt.sf(r);
    const amt = if (typ == 3) 1 + r.uintLessThan(u32, if (sf != 0) 63 else 31) else amount(r, sf);
    return 0x0a00_0000 | sf | (opc << 29) | (typ << 22) | (r.uintLessThan(u32, 2) << 21) | (m << 16) | (amt << 10) | (n << 5) | (if (opc == 3) dstz(r) else kt.dst(r));
}
fn wLogicR(r: std.Random, n: u32, m: u32) u32 {
    return logical(r, n, m, r.uintLessThan(u32, 3), r.uintLessThan(u32, 3));
}
fn wLogicRor(r: std.Random, n: u32, m: u32) u32 {
    return logical(r, n, m, r.uintLessThan(u32, 3), 3);
}
fn wAndsR(r: std.Random, n: u32, m: u32) u32 {
    return logical(r, n, m, 3, r.uintLessThan(u32, 3));
}
fn wCsel(r: std.Random, n: u32, m: u32) u32 { // CSEL, CSINC, CSINV, CSNEG (CSET, CINC, CNEG, ...)
    return 0x1a80_0000 | kt.sf(r) | (r.uintLessThan(u32, 2) << 30) | (m << 16) | (r.uintLessThan(u32, 16) << 12) | (r.uintLessThan(u32, 2) << 10) | (n << 5) | kt.dst(r);
}
fn wCcmp(r: std.Random, n: u32, m: u32) u32 { // CCMP/CCMN, register and immediate
    const imm = r.boolean();
    const f = if (imm) (if (r.boolean()) r.uintLessThan(u32, 4) else r.uintLessThan(u32, 32)) else m;
    return 0x3a40_0000 | kt.sf(r) | (r.uintLessThan(u32, 2) << 30) | (f << 16) | (r.uintLessThan(u32, 16) << 12) | (@as(u32, @intFromBool(imm)) << 11) | (n << 5) | r.uintLessThan(u32, 16);
}
fn wAdc(r: std.Random, n: u32, m: u32) u32 { // ADC, ADCS, SBC, SBCS
    const s = r.uintLessThan(u32, 2);
    return 0x1a00_0000 | kt.sf(r) | (r.uintLessThan(u32, 2) << 30) | (s << 29) | (m << 16) | (n << 5) | (if (s != 0) dstz(r) else kt.dst(r));
}

/// Flag producers, consumers and what lies between them: hand-backs (MRS and
/// MSR NZCV, an FP op), side exits (B.cond), a fault (a load from x23's
/// unmapped page, rarely: it ends the program).
pub fn soup(r: std.Random, out: []u32, pc: u64) usize {
    _ = pc;
    const n = src(r);
    const m = src(r);
    out[0] = switch (r.uintLessThan(u32, 40)) {
        0...3 => wAddsI(r, n, m),
        4...6 => wAddSubsR(r, n, m),
        7...8 => wAddsRR(r, n, m),
        9...10 => wAndsI(r, n, m),
        11...12 => wAndsR(r, n, m),
        13...17 => wCcmp(r, n, m),
        18...23 => wCsel(r, n, m),
        24...26 => wAdc(r, n, m),
        27...29 => wAddI(r, n, m),
        30 => 0xd53b_4200 | kt.dst(r), // mrs xd, nzcv
        31 => 0xd51b_4200 | n, // msr nzcv, xn
        32 => 0x1e60_2800 | (r.uintLessThan(u32, 32) << 16) | (r.uintLessThan(u32, 32) << 5) | r.uintLessThan(u32, 32), // fadd d
        33...35 => 0x5400_0000 | ((1 + r.uintLessThan(u32, 3)) << 5) | r.uintLessThan(u32, 16), // b.cond a few words on
        36 => if (r.uintLessThan(u32, 8) == 0) 0xf940_0000 | (23 << 5) | kt.dst(r) else wLogicR(r, n, m), // ldr xd, [x23]: faults
        else => wLogicR(r, n, m),
    };
    return 1;
}

test "a64 jit alu: nop" {
    try kt.kind(.nop, kt.one(kt.nop), .{});
}
test "a64 jit alu: movi" {
    try kt.kind(.movi, kt.one(kt.movi), .{});
}
test "a64 jit alu: movk" {
    try kt.kind(.movk, Rel(wMovk), .{});
}
test "a64 jit alu: mov (register, TPIDR_EL0, EXTR #0)" {
    try kt.kind(.mov, Rel(wMov), .{});
}
test "a64 jit alu: add_i" {
    try kt.kind(.add_i, Rel(wAddI), .{});
}
test "a64 jit alu: adds_i" {
    try kt.kind(.adds_i, Mix(wAddsI), .{});
}
test "a64 jit alu: logic_i" {
    try kt.kind(.logic_i, Rel(wLogicI), .{});
}
test "a64 jit alu: ands_i" {
    try kt.kind(.ands_i, Mix(wAndsI), .{});
}
test "a64 jit alu: addsub_r" {
    try kt.kind(.addsub_r, Rel(wAddSubR), .{});
}
test "a64 jit alu: add_rr" {
    try kt.kind(.add_rr, Rel(wAddRR), .{});
}
test "a64 jit alu: addsubs_r" {
    try kt.kind(.addsubs_r, Mix(wAddSubsR), .{});
}
test "a64 jit alu: adds_rr" {
    try kt.kind(.adds_rr, Mix(wAddsRR), .{});
}
test "a64 jit alu: logic_r" {
    try kt.kind(.logic_r, Rel(wLogicR), .{});
}
test "a64 jit alu: logic_ror" {
    try kt.kind(.logic_ror, Rel(wLogicRor), .{});
}
test "a64 jit alu: ands_r" {
    try kt.kind(.ands_r, Mix(wAndsR), .{});
}
test "a64 jit alu: csel" {
    try kt.kind(.csel, Mix(wCsel), .{});
}
test "a64 jit alu: ccmp" {
    try kt.kind(.ccmp, Mix(wCcmp), .{});
}
test "a64 jit alu: adc" {
    try kt.kind(.adc, Mix(wAdc), .{});
}

// ---- lazy flags ---------------------------------------------------------------------

/// A flag producer of any kind.
fn producer(r: std.Random, n: u32, m: u32) u32 {
    return switch (r.uintLessThan(u32, 6)) {
        0 => wAddsI(r, n, m),
        1 => wAddSubsR(r, n, m),
        2 => wAddsRR(r, n, m),
        3 => wAndsI(r, n, m),
        4 => wAndsR(r, n, m),
        else => wCcmp(r, n, m),
    };
}
/// A flag consumer that writes a register.
fn consumer(r: std.Random, n: u32, m: u32) u32 {
    return if (r.uintLessThan(u32, 4) == 0) wAdc(r, n, m) else wCsel(r, n, m);
}
/// An op that neither reads nor writes flags.
fn other(r: std.Random, n: u32, m: u32) u32 {
    return switch (r.uintLessThan(u32, 4)) {
        0 => wAddI(r, n, m),
        1 => wLogicR(r, n, m),
        2 => 0xd340_0000 | (r.uintLessThan(u32, 64) << 16) | (r.uintLessThan(u32, 64) << 10) | (n << 5) | kt.dst(r), // ubfm x
        else => wAddSubR(r, n, m),
    };
}

/// Producer, then `mid`, then a consumer (and its flags at the end).
fn Between(comptime mid: fn (std.Random, []u32) usize) kt.Gen {
    return struct {
        fn g(r: std.Random, out: []u32, pc: u64) usize {
            _ = pc;
            out[0] = producer(r, src(r), src(r));
            const k = 1 + mid(r, out[1..]);
            out[k] = consumer(r, src(r), src(r));
            return k + 1;
        }
    }.g;
}

test "a64 jit alu: flags consumed after an intervening op, or overwritten unread" {
    try kt.kind(.adds_i, Between(struct {
        fn f(r: std.Random, out: []u32) usize {
            out[0] = if (r.boolean()) other(r, src(r), src(r)) else producer(r, src(r), src(r));
            return 1;
        }
    }.f), .{ .rounds = 400 });
}
test "a64 jit alu: flags live across a hand-back (MRS/MSR NZCV, FP)" {
    try kt.kind(.ccmp, Between(struct {
        fn f(r: std.Random, out: []u32) usize {
            out[0] = switch (r.uintLessThan(u32, 3)) {
                0 => 0xd53b_4200 | kt.dst(r), // mrs xd, nzcv
                1 => 0xd51b_4200 | src(r), // msr nzcv, xn
                else => 0x1e60_2800 | (r.uintLessThan(u32, 32) << 16) | (r.uintLessThan(u32, 32) << 5) | r.uintLessThan(u32, 32), // fadd d
            };
            return 1;
        }
    }.f), .{});
}
test "a64 jit alu: flags live across an exit (B to the next page) and a side exit" {
    try kt.kind(.adds_rr, Between(struct {
        fn f(r: std.Random, out: []u32) usize {
            out[0] = if (r.boolean())
                0x1400_0000 | (1024 + r.uintLessThan(u32, 512)) // b into the SVC page
            else
                0x5400_0000 | ((1 + r.uintLessThan(u32, 3)) << 5) | r.uintLessThan(u32, 16); // b.cond
            return 1;
        }
    }.f), .{});
}
test "a64 jit alu: a fault between producer and consumer" {
    try kt.kind(.ands_r, Between(struct {
        fn f(r: std.Random, out: []u32) usize {
            out[0] = 0xf940_0000 | (r.uintLessThan(u32, 8) << 10) | (23 << 5) | kt.dst(r); // ldr xd, [x23, #8k]
            return 1;
        }
    }.f), .{ .words = 4 });
}

/// At the program's start a self-loop (`b` back to it: runs until the
/// budget ends; or `b.cond`, which may end): producer first (no flags
/// live at its start) or a consumer first (flags live at the back edge).
fn selfLoop(r: std.Random, out: []u32, pc: u64) usize {
    if (pc != kt.code_va) return soup(r, out, pc);
    var i: usize = 0;
    if (r.boolean()) {
        out[i] = consumer(r, src(r), src(r));
        i += 1;
    }
    out[i] = if (r.boolean()) 0xf100_0400 | (kt.dst(r) * 0x21) else producer(r, src(r), src(r)); // subs xk, xk, #1
    i += 1;
    for (0..r.uintLessThan(usize, 3)) |_| {
        out[i] = if (r.boolean()) consumer(r, src(r), src(r)) else other(r, src(r), src(r));
        i += 1;
    }
    const back: u32 = @truncate(-%@as(u64, i));
    out[i] = if (r.uintLessThan(u32, 3) == 0)
        0x5400_0000 | ((back & 0x7ffff) << 5) | r.uintLessThan(u32, 14) // b.cond back
    else
        0x1400_0000 | (back & 0x3ff_ffff); // b back
    return i + 1;
}

test "a64 jit alu: flags in a self-loop" {
    try kt.kind(.adds_i, selfLoop, .{ .rounds = 300, .words = 12, .budget = 1000 });
    try kt.kind(.adds_i, selfLoop, .{ .rounds = 100, .words = 12, .budget = 54_321, .seed = 2 });
}
