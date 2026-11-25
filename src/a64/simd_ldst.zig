// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//! AdvSIMD load/store structures: multiple structures (LD1..LD4,
//! ST1..ST4 with 1 to 4 registers), single structure (LD1..LD4 and
//! ST1..ST4 to one lane, LD1R..LD4R replicate), each with and without
//! post-index (immediate or register). Encodings
//! `0 Q 0011 0 0 P L 0 Rm opcode size Rn Rt` (multiple) and
//! `0 Q 0011 0 1 P L R Rm opcode S size Rn Rt` (single), P = post-index
//! (Rm = 31: by the bytes transferred, else by Xm; without P, the Rm field
//! must be 0).
//!
//! Complete for ARMv8.0. Faults are precise: loads read everything into
//! locals before any register is written (base writeback included);
//! stores probe the whole range (at most 64 bytes, so at most two pages)
//! before the first write. Register lists wrap from V31 to V0. No
//! alignment checks (SCTLR_EL1.A = 0 under Linux).

const std = @import("std");
const c = @import("common.zig");
const mv = @import("simd_move.zig");

pub fn exec(s: c.St, inst: u32) c.Error!c.Exit {
    if (c.bit(inst, 24)) return single(s, inst);
    return multiple(s, inst);
}

/// The base after a post-indexed access: + Xm, or + `imm` (the bytes
/// transferred) for Rm = 31.
inline fn postBase(s: c.St, inst: u32, base: u64, imm: u64) u64 {
    const m = c.rm(inst);
    return base +% (if (m == 31) imm else c.xr(s, m));
}

// ---- multiple structures -------------------------------------------------------

/// LD1-LD4 / ST1-ST4 (multiple structures). Memory moves as 64-bit words
/// (8 or 16 bytes per register), (de)interleaved for LD2-LD4/ST2-ST4.
fn multiple(s: c.St, inst: u32) c.Error!c.Exit {
    const post = c.bit(inst, 23);
    if (if (post) c.bit(inst, 21) else c.bits(inst, 21, 16) != 0) return c.ill(s, inst);
    const q = c.bit(inst, 30);
    const size: u2 = @intCast(c.bits(inst, 11, 10));
    // registers = rpt * selem (structure elements)
    const rpt: u32, const selem: u32 = switch (c.bits(inst, 15, 12)) {
        0b0000 => .{ 1, 4 }, // LD4/ST4
        0b0010 => .{ 4, 1 }, // LD1/ST1, 4 registers
        0b0100 => .{ 1, 3 }, // LD3/ST3
        0b0110 => .{ 3, 1 }, // LD1/ST1, 3 registers
        0b0111 => .{ 1, 1 }, // LD1/ST1, 1 register
        0b1000 => .{ 1, 2 }, // LD2/ST2
        0b1010 => .{ 2, 1 }, // LD1/ST1, 2 registers
        else => return c.ill(s, inst),
    };
    if (size == 3 and !q and selem != 1) return c.ill(s, inst); // LD2-4/ST2-4 .1d
    const nregs = rpt * selem;
    const per: u32 = if (q) 2 else 1; // words per register
    const words = nregs * per;
    const n = c.rn(inst);
    const t = c.rd(inst);
    const base = c.xsp(s, n);
    // memory as 64-bit words (no aggregate copies of buf: on wasm those
    // become memory.copy)
    var buf: [8]u64 = undefined;
    if (c.bit(inst, 22)) {
        for (0..8) |i| {
            if (i >= words) break;
            buf[i] = try c.load(s, u64, base +% 8 * i);
        }
        if (post) c.setXsp(s, n, postBase(s, inst, base, 8 * @as(u64, words)));
        for (0..4) |r| {
            if (r >= nregs) break;
            const v: u128 = if (selem != 1)
                fromStructs(size, q, selem, &buf, r)
            else if (q) c.v128(buf[2 * r], buf[2 * r + 1]) else buf[r];
            c.setVq(s, (t + @as(u32, @intCast(r))) & 31, v);
        }
    } else {
        for (0..4) |r| {
            if (r >= nregs) break;
            const v = c.vq(s, (t + @as(u32, @intCast(r))) & 31);
            if (selem != 1) {
                toStructs(size, q, selem, &buf, r, v);
            } else {
                const h = c.lanes(u64, v);
                buf[per * r] = h[0];
                if (q) buf[2 * r + 1] = h[1];
            }
        }
        try c.probeWrite(s, base, 8 * @as(u64, words));
        for (0..8) |i| {
            if (i >= words) break;
            try c.store(s, u64, base +% 8 * i, buf[i]);
        }
        if (post) c.setXsp(s, n, postBase(s, inst, base, 8 * @as(u64, words)));
    }
    return .next;
}

/// Register `k` of an LD2-LD4: element k of each `selem`-element
/// structure in `mem` (8 << size bit elements, 8 or 16 bytes per register).
pub fn fromStructs(size: u2, q: bool, selem: u32, mem: *const [8]u64, k: usize) u128 {
    return switch (size) {
        0 => gather(u8, q, selem, mem, k),
        1 => gather(u16, q, selem, mem, k),
        2 => gather(u32, q, selem, mem, k),
        3 => gather(u64, q, selem, mem, k),
    };
}
/// Store register `k` of an ST2-ST4 into its place in each structure.
pub fn toStructs(size: u2, q: bool, selem: u32, mem: *[8]u64, k: usize, v: u128) void {
    switch (size) {
        0 => scatter(u8, q, selem, mem, k, v),
        1 => scatter(u16, q, selem, mem, k, v),
        2 => scatter(u32, q, selem, mem, k, v),
        3 => scatter(u64, q, selem, mem, k, v),
    }
}
fn gather(comptime T: type, q: bool, selem: u32, mem: *const [8]u64, k: usize) u128 {
    const L = 16 / @sizeOf(T);
    const src: *const [64 / @sizeOf(T)]T = @ptrCast(mem);
    var r: [L]T = @splat(0);
    for (0..L) |e| {
        if (!q and e >= L / 2) break;
        r[e] = src[e * selem + k];
    }
    return c.fromLanes(T, r);
}
fn scatter(comptime T: type, q: bool, selem: u32, mem: *[8]u64, k: usize, v: u128) void {
    const L = 16 / @sizeOf(T);
    const dst: *[64 / @sizeOf(T)]T = @ptrCast(mem);
    const l = c.lanes(T, v);
    for (0..L) |e| {
        if (!q and e >= L / 2) break;
        dst[e * selem + k] = l[e];
    }
}

// ---- single structure ----------------------------------------------------------

/// LD1-LD4 / ST1-ST4 (single structure), LD1R-LD4R.
fn single(s: c.St, inst: u32) c.Error!c.Exit {
    const post = c.bit(inst, 23);
    if (!post and c.bits(inst, 20, 16) != 0) return c.ill(s, inst);
    const q = c.bit(inst, 30);
    const load = c.bit(inst, 22);
    const opcode = c.bits(inst, 15, 13);
    const sbit = c.bits(inst, 12, 12);
    const size = c.bits(inst, 11, 10);
    const selem: u32 = (((opcode & 1) << 1) | c.bits(inst, 21, 21)) + 1;
    const replicate = opcode >> 1 == 3;
    const qb: u32 = @intFromBool(q);
    // element size (log2 bytes) and lane
    var scale: u2 = undefined;
    var index: u32 = 0;
    switch (opcode >> 1) {
        0 => {
            scale = 0;
            index = (qb << 3) | (sbit << 2) | size;
        },
        1 => {
            if (size & 1 != 0) return c.ill(s, inst);
            scale = 1;
            index = (qb << 2) | (sbit << 1) | (size >> 1);
        },
        2 => {
            if (size == 0) {
                scale = 2;
                index = (qb << 1) | sbit;
            } else {
                if (size != 1 or sbit != 0) return c.ill(s, inst);
                scale = 3;
                index = qb;
            }
        },
        3 => {
            if (!load or sbit != 0) return c.ill(s, inst);
            scale = @intCast(size);
        },
        else => unreachable,
    }
    const ebytes = @as(u64, 1) << scale;
    const n = c.rn(inst);
    const t = c.rd(inst);
    const base = c.xsp(s, n);
    var el: [4]u64 = @splat(0);
    if (load) {
        for (0..4) |k| {
            if (k >= selem) break;
            el[k] = try loadN(s, scale, base +% ebytes * k);
        }
        if (post) c.setXsp(s, n, postBase(s, inst, base, ebytes * selem));
        for (0..4) |k| {
            if (k >= selem) break;
            const tk = (t + @as(u32, @intCast(k))) & 31;
            if (replicate) {
                c.setVec(s, tk, q, mv.dup(scale, el[k]));
            } else c.setVq(s, tk, mv.setElem(c.vq(s, tk), scale, index, el[k]));
        }
    } else {
        for (0..4) |k| {
            if (k >= selem) break;
            el[k] = mv.elem(c.vq(s, (t + @as(u32, @intCast(k))) & 31), scale, index);
        }
        if (selem > 1) try c.probeWrite(s, base, ebytes * selem);
        for (0..4) |k| {
            if (k >= selem) break;
            try storeN(s, scale, base +% ebytes * k, el[k]);
        }
        if (post) c.setXsp(s, n, postBase(s, inst, base, ebytes * selem));
    }
    return .next;
}

fn loadN(s: c.St, size: u2, va: u64) c.Error!u64 {
    return switch (size) {
        0 => try c.load(s, u8, va),
        1 => try c.load(s, u16, va),
        2 => try c.load(s, u32, va),
        3 => try c.load(s, u64, va),
    };
}
fn storeN(s: c.St, size: u2, va: u64, v: u64) c.Error!void {
    switch (size) {
        0 => try c.store(s, u8, va, @truncate(v)),
        1 => try c.store(s, u16, va, @truncate(v)),
        2 => try c.store(s, u32, va, @truncate(v)),
        3 => try c.store(s, u64, va, v),
    }
}
