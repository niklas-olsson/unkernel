// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//
// Uniform blocks whose Vulkan layout WGSL's uniform address space cannot
// express. Push constants are std430 (llama.cpp's rope: `float
// corr_dims[2]; int sections[4];`, arrays of stride 4), and HLSL cbuffers
// may pack a member into a struct's tail; WGSL wants arrays at 16-byte
// strides and offsets, structs at 16, a struct's rounded size before the
// next member, and column-major matrices (naga's spv-in transposes square
// row-major ones only). Only Chrome's uniform_buffer_standard_layout lifts
// the 16-byte rules (Firefox and Safari refuse such a module). Such a
// block (Uniform or PushConstant storage, Block-decorated) becomes
// `kw_words { w: array<vec4<u32>, N> }` over the same bytes: access chains
// into it turn into byte offsets (constant, or computed for dynamic
// indices) and each load into word loads, bitcast and recomposed into the
// loaded type, so values keep their Vulkan offsets. Blocks WGSL can
// express stay as they are. A block used other than through access chains
// and loads, or holding 8/16/64-bit or bool members, is left alone (naga's
// layout check then marks the module as needing
// uniform_buffer_standard_layout: lib.rs).

use std::collections::{BTreeMap, HashMap, HashSet};

const OP_NAME: u32 = 5;
const OP_MEMBER_NAME: u32 = 6;
const OP_TYPE_BOOL: u32 = 20;
const OP_TYPE_INT: u32 = 21;
const OP_TYPE_FLOAT: u32 = 22;
const OP_TYPE_VECTOR: u32 = 23;
const OP_TYPE_MATRIX: u32 = 24;
const OP_TYPE_ARRAY: u32 = 28;
const OP_TYPE_RUNTIME_ARRAY: u32 = 29;
const OP_TYPE_STRUCT: u32 = 30;
const OP_TYPE_POINTER: u32 = 32;
const OP_CONSTANT: u32 = 43;
const OP_FUNCTION: u32 = 54;
const OP_VARIABLE: u32 = 59;
const OP_LOAD: u32 = 61;
const OP_ACCESS_CHAIN: u32 = 65;
const OP_IN_BOUNDS_ACCESS_CHAIN: u32 = 66;
const OP_DECORATE: u32 = 71;
const OP_MEMBER_DECORATE: u32 = 72;
const OP_COMPOSITE_CONSTRUCT: u32 = 80;
const OP_BITCAST: u32 = 124;
const OP_IADD: u32 = 128;
const OP_IMUL: u32 = 132;
const OP_SHIFT_RIGHT_LOGICAL: u32 = 194;
const OP_BITWISE_AND: u32 = 199;
const DEC_BLOCK: u32 = 2;
const DEC_BUFFER_BLOCK: u32 = 3;
const DEC_ROW_MAJOR: u32 = 4;
const DEC_COL_MAJOR: u32 = 5;
const DEC_ARRAY_STRIDE: u32 = 6;
const DEC_MATRIX_STRIDE: u32 = 7;
const DEC_OFFSET: u32 = 35;
const SC_UNIFORM: u32 = 2;
const SC_PUSH_CONSTANT: u32 = 9;
const SC_STORAGE_BUFFER: u32 = 12;

// A load of a whole array/struct expands to this many word loads at most.
const MAX_WORDS: usize = 4096;

fn name(out: &mut Vec<u32>, op: u32, ids: &[u32], s: &str) {
	let mut b = s.as_bytes().to_vec();
	b.push(0);
	while b.len() % 4 != 0 {
		b.push(0);
	}
	let mut a = ids.to_vec();
	a.extend(b.chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])));
	inst(out, op, &a);
}

fn inst(out: &mut Vec<u32>, op: u32, operands: &[u32]) {
	out.push(((operands.len() as u32 + 1) << 16) | op);
	out.extend_from_slice(operands);
}

#[derive(Clone)]
enum Ty {
	Int { signed: bool, width: u32 },
	Float { width: u32 },
	Bool,
	Vec(u32, u32),
	Mat(u32, u32),
	Arr(u32, u32),
	Rt,
	Struct(Vec<u32>),
	Ptr(u32),
}

#[derive(Default)]
struct Info {
	ty: HashMap<u32, Ty>,
	consts: HashMap<u32, u32>,
	stride: HashMap<u32, u32>,
	off: HashMap<(u32, u32), u32>,
	mstride: HashMap<(u32, u32), u32>,
	row_major: HashSet<(u32, u32)>,
	block: HashSet<u32>,
	buffer_block: HashSet<u32>,
}

fn round16(n: u32) -> u32 {
	(n + 15) & !15
}

impl Info {
	fn scalar32(&self, t: u32) -> bool {
		matches!(self.ty.get(&t), Some(Ty::Int { width: 32, .. }) | Some(Ty::Float { width: 32 }))
	}

	// A member's matrix layout (RowMajor, MatrixStride), for matrices and
	// arrays of them.
	fn mat_of(&self, st: u32, k: u32) -> Option<(bool, u32)> {
		self.mstride.get(&(st, k)).map(|&ms| (self.row_major.contains(&(st, k)), ms))
	}

	// Bytes the type covers in its Vulkan layout (None: not 32-bit data).
	fn size(&self, t: u32, mat: Option<(bool, u32)>) -> Option<u32> {
		match self.ty.get(&t)? {
			Ty::Int { width: 32, .. } | Ty::Float { width: 32 } => Some(4),
			Ty::Vec(c, n) if self.scalar32(*c) => Some(4 * n),
			Ty::Mat(col, n) => {
				let (rm, ms) = mat?;
				let Some(Ty::Vec(_, r)) = self.ty.get(col) else { return None };
				Some(if rm { (r - 1) * ms + 4 * n } else { (n - 1) * ms + 4 * r })
			}
			Ty::Arr(el, len) => {
				let n = *self.consts.get(len)?;
				let s = *self.stride.get(&t)?;
				Some(if n == 0 { 0 } else { (n - 1) * s + self.size(*el, mat)? })
			}
			Ty::Struct(ms) => {
				let mut end = 0;
				for (k, &m) in ms.iter().enumerate() {
					let o = *self.off.get(&(t, k as u32))?;
					end = end.max(o + self.size(m, self.mat_of(t, k as u32))?);
				}
				Some(end)
			}
			_ => None,
		}
	}

	fn align(&self, t: u32) -> u32 {
		match self.ty.get(&t) {
			Some(Ty::Vec(_, 2)) => 8,
			Some(Ty::Vec(..)) => 16,
			Some(Ty::Mat(col, _)) => self.align(*col),
			Some(Ty::Arr(..)) | Some(Ty::Struct(_)) => 16,
			_ => 4,
		}
	}

	// WGSL's natural size of a non-struct type (the stride its arrays get).
	fn natural(&self, t: u32) -> Option<u32> {
		match self.ty.get(&t)? {
			Ty::Int { width: 32, .. } | Ty::Float { width: 32 } => Some(4),
			Ty::Vec(_, 3) => Some(16),
			Ty::Vec(_, n) => Some(4 * n),
			Ty::Mat(col, n) => Some(n * self.natural(*col)?),
			Ty::Arr(_, len) => Some(self.consts.get(len)? * self.stride.get(&t)?),
			_ => None,
		}
	}

	// Whether WGSL's uniform address space lays the type out at offset `o`
	// as Vulkan does; None for types this pass cannot repack.
	fn fits(&self, t: u32, o: u32, mat: Option<(bool, u32)>) -> Option<bool> {
		Some(match self.ty.get(&t)? {
			Ty::Int { width: 32, .. } | Ty::Float { width: 32 } => o % 4 == 0,
			Ty::Vec(c, _) if self.scalar32(*c) => o % self.align(t) == 0,
			Ty::Mat(col, _) => {
				let (rm, ms) = mat?;
				let Some(Ty::Vec(c, r)) = self.ty.get(col) else { return None };
				if !self.scalar32(*c) {
					return None;
				}
				let Some(Ty::Mat(_, n)) = self.ty.get(&t) else { return None };
				// naga's spv-in loads a square row-major matrix transposed.
				let nat = if *r == 2 { 8 } else { 16 };
				(!rm || r == n) && ms == nat && o % self.align(t) == 0
			}
			Ty::Arr(el, _) => {
				let s = *self.stride.get(&t)?;
				let el_fits = self.fits(*el, 0, mat)?;
				let stride_ok = if let Some(Ty::Struct(_)) = self.ty.get(el) { s >= round16(self.size(*el, None)?) } else { s == self.natural(*el)? };
				el_fits && stride_ok && s % 16 == 0 && o % 16 == 0
			}
			Ty::Struct(ms) => {
				let mut order: Vec<(u32, u32, u32)> = Vec::new();
				for (k, &m) in ms.iter().enumerate() {
					order.push((*self.off.get(&(t, k as u32))?, k as u32, m));
				}
				order.sort();
				let mut ok = o % 16 == 0;
				for (j, &(mo, k, m)) in order.iter().enumerate() {
					ok &= self.fits(m, mo, self.mat_of(t, k))?;
					if let Some(Ty::Struct(_)) = self.ty.get(&m) {
						// The next member starts past the struct's rounded size.
						if let Some(&(next, _, _)) = order.get(j + 1) {
							ok &= next >= mo + round16(self.size(m, None)?);
						}
					}
				}
				ok
			}
			_ => return None,
		})
	}
}

// A pointer into a repacked block: the pointee type at byte `off` (+ the
// u32 id `dyn` when indices were dynamic); vector components `vstride`
// apart (a row-major matrix's column: MatrixStride).
#[derive(Clone)]
struct Ptr {
	var: u32,
	sc: u32,
	ty: u32,
	off: u32,
	dyn_: Option<u32>,
	vstride: u32,
	mat: Option<(bool, u32)>,
}

struct Gen {
	bound: u32,
	uint: u32,
	consts: BTreeMap<u32, u32>,
	ptr_uint: HashMap<u32, u32>,
	words: usize,
}

impl Gen {
	fn id(&mut self) -> u32 {
		self.bound += 1;
		self.bound - 1
	}
	fn c(&mut self, v: u32) -> u32 {
		if let Some(&id) = self.consts.get(&v) {
			return id;
		}
		let id = self.id();
		self.consts.insert(v, id);
		id
	}
	fn op(&mut self, out: &mut Vec<u32>, op: u32, ty: u32, args: &[u32]) -> u32 {
		let r = self.id();
		let mut a = vec![ty, r];
		a.extend_from_slice(args);
		inst(out, op, &a);
		r
	}
	// p.dyn_ += idx * stride (idx a constant or an integer id).
	fn index(&mut self, out: &mut Vec<u32>, info: &Info, p: &mut Ptr, idx: u32, stride: u32) {
		if let Some(&v) = info.consts.get(&idx) {
			p.off = p.off.wrapping_add(v.wrapping_mul(stride));
			return;
		}
		let u = self.uint;
		let b = self.op(out, OP_BITCAST, u, &[idx]);
		let m = if stride == 1 { b } else { let s = self.c(stride); self.op(out, OP_IMUL, u, &[b, s]) };
		p.dyn_ = Some(match p.dyn_ {
			None => m,
			Some(d) => self.op(out, OP_IADD, u, &[d, m]),
		});
	}

	// The value of type `t` at p, built from word loads; `want` names the
	// final result.
	fn load(&mut self, out: &mut Vec<u32>, info: &Info, t: u32, p: &Ptr, want: Option<u32>) -> Option<u32> {
		let ty = info.ty.get(&t)?.clone();
		let construct = |g: &mut Gen, out: &mut Vec<u32>, parts: Vec<u32>| {
			let r = want.unwrap_or_else(|| g.id());
			let mut a = vec![t, r];
			a.extend(parts);
			inst(out, OP_COMPOSITE_CONSTRUCT, &a);
			r
		};
		match ty {
			Ty::Int { width: 32, .. } | Ty::Float { width: 32 } => {
				self.words += 1;
				if self.words > MAX_WORDS {
					return None;
				}
				let u = self.uint;
				let (i0, i1) = match p.dyn_ {
					None => (self.c(p.off / 16), self.c(p.off % 16 / 4)),
					Some(d) => {
						let total = if p.off == 0 { d } else { let c = self.c(p.off); self.op(out, OP_IADD, u, &[d, c]) };
						let (c4, c2, c3) = (self.c(4), self.c(2), self.c(3));
						let i0 = self.op(out, OP_SHIFT_RIGHT_LOGICAL, u, &[total, c4]);
						let w = self.op(out, OP_SHIFT_RIGHT_LOGICAL, u, &[total, c2]);
						(i0, self.op(out, OP_BITWISE_AND, u, &[w, c3]))
					}
				};
				let pu = self.ptr_uint[&p.sc];
				let c0 = self.c(0);
				let ptr = self.op(out, OP_ACCESS_CHAIN, pu, &[p.var, c0, i0, i1]);
				let r = want.unwrap_or_else(|| self.id());
				if matches!(ty, Ty::Int { signed: false, .. }) {
					inst(out, OP_LOAD, &[t, r, ptr]);
				} else {
					let w = self.op(out, OP_LOAD, u, &[ptr]);
					inst(out, OP_BITCAST, &[t, r, w]);
				}
				Some(r)
			}
			Ty::Vec(c, n) => {
				let mut parts = Vec::new();
				for j in 0..n {
					let q = Ptr { ty: c, off: p.off + j * p.vstride, ..p.clone() };
					parts.push(self.load(out, info, c, &q, None)?);
				}
				Some(construct(self, out, parts))
			}
			Ty::Mat(col, n) => {
				let (rm, ms) = p.mat?;
				let mut parts = Vec::new();
				for j in 0..n {
					let q = if rm { Ptr { ty: col, off: p.off + 4 * j, vstride: ms, mat: None, ..p.clone() } } else { Ptr { ty: col, off: p.off + ms * j, vstride: 4, mat: None, ..p.clone() } };
					parts.push(self.load(out, info, col, &q, None)?);
				}
				Some(construct(self, out, parts))
			}
			Ty::Arr(el, len) => {
				let n = *info.consts.get(&len)?;
				let s = *info.stride.get(&t)?;
				let mut parts = Vec::new();
				for i in 0..n {
					let q = Ptr { ty: el, off: p.off + i * s, ..p.clone() };
					parts.push(self.load(out, info, el, &q, None)?);
				}
				Some(construct(self, out, parts))
			}
			Ty::Struct(ms) => {
				let mut parts = Vec::new();
				for (k, &m) in ms.iter().enumerate() {
					let q = Ptr { ty: m, off: p.off + info.off.get(&(t, k as u32))?, vstride: 4, mat: info.mat_of(t, k as u32), ..p.clone() };
					parts.push(self.load(out, info, m, &q, None)?);
				}
				Some(construct(self, out, parts))
			}
			_ => None,
		}
	}
}

pub fn repack_uniform_blocks(words: Vec<u32>) -> Vec<u32> {
	repack(&words).unwrap_or(words)
}

fn repack(words: &[u32]) -> Option<Vec<u32>> {
	let mut info = Info::default();
	let mut i = 5;
	let mut vars: Vec<(u32, u32, u32)> = Vec::new(); // (var, sc, block struct)
	let mut buffers: Vec<u32> = Vec::new(); // StorageBuffer variables' types
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let a = &words[i + 1..i + n];
		match words[i] & 0xffff {
			OP_TYPE_BOOL => {
				info.ty.insert(a[0], Ty::Bool);
			}
			OP_TYPE_INT if a.len() >= 3 => {
				info.ty.insert(a[0], Ty::Int { width: a[1], signed: a[2] != 0 });
			}
			OP_TYPE_FLOAT if a.len() >= 2 => {
				info.ty.insert(a[0], Ty::Float { width: a[1] });
			}
			OP_TYPE_VECTOR if a.len() >= 3 => {
				info.ty.insert(a[0], Ty::Vec(a[1], a[2]));
			}
			OP_TYPE_MATRIX if a.len() >= 3 => {
				info.ty.insert(a[0], Ty::Mat(a[1], a[2]));
			}
			OP_TYPE_ARRAY if a.len() >= 3 => {
				info.ty.insert(a[0], Ty::Arr(a[1], a[2]));
			}
			OP_TYPE_RUNTIME_ARRAY => {
				info.ty.insert(a[0], Ty::Rt);
			}
			OP_TYPE_STRUCT => {
				info.ty.insert(a[0], Ty::Struct(a[1..].to_vec()));
			}
			OP_TYPE_POINTER if a.len() >= 3 => {
				info.ty.insert(a[0], Ty::Ptr(a[2]));
			}
			OP_CONSTANT if a.len() >= 3 => {
				if let Some(Ty::Int { width: 32, .. }) = info.ty.get(&a[0]) {
					info.consts.insert(a[1], a[2]);
				}
			}
			OP_DECORATE if a.len() >= 2 => match a[1] {
				DEC_BLOCK => {
					info.block.insert(a[0]);
				}
				DEC_BUFFER_BLOCK => {
					info.buffer_block.insert(a[0]);
				}
				DEC_ARRAY_STRIDE if a.len() >= 3 => {
					info.stride.insert(a[0], a[2]);
				}
				_ => {}
			},
			OP_MEMBER_DECORATE if a.len() >= 3 => match a[2] {
				DEC_OFFSET if a.len() >= 4 => {
					info.off.insert((a[0], a[1]), a[3]);
				}
				DEC_MATRIX_STRIDE if a.len() >= 4 => {
					info.mstride.insert((a[0], a[1]), a[3]);
				}
				DEC_ROW_MAJOR => {
					info.row_major.insert((a[0], a[1]));
				}
				_ => {}
			},
			OP_VARIABLE if a.len() >= 3 && (a[2] == SC_UNIFORM || a[2] == SC_PUSH_CONSTANT) => {
				if let Some(&Ty::Ptr(to)) = info.ty.get(&a[0]) {
					vars.push((a[1], a[2], to));
				}
			}
			OP_VARIABLE if a.len() >= 3 && a[2] == SC_STORAGE_BUFFER => {
				if let Some(&Ty::Ptr(to)) = info.ty.get(&a[0]) {
					buffers.push(to);
				}
			}
			_ => {}
		}
		i += n;
	}
	// var -> (sc, struct, words of the new array)
	let mut targets: HashMap<u32, (u32, u32, u32)> = HashMap::new();
	for &(v, sc, st) in &vars {
		if !matches!(info.ty.get(&st), Some(Ty::Struct(_))) || !info.block.contains(&st) || info.buffer_block.contains(&st) {
			continue;
		}
		if info.fits(st, 0, None) != Some(false) {
			continue;
		}
		let Some(size) = info.size(st, None) else { continue };
		targets.insert(v, (sc, st, (size + 15) / 16));
	}
	if targets.is_empty() {
		return None;
	}
	// The old block types stay declared, and naga's spv-in refuses some
	// matrix layouts even unused (a non-square row-major matrix): their
	// matrix decorations go, unless a buffer that keeps its type shares
	// the struct.
	fn reach(info: &Info, t: u32, set: &mut HashSet<u32>) {
		match info.ty.get(&t) {
			Some(Ty::Struct(ms)) => {
				if set.insert(t) {
					for &m in ms {
						reach(info, m, set);
					}
				}
			}
			Some(Ty::Arr(el, _)) => reach(info, *el, set),
			_ => {}
		}
	}
	let (mut gone, mut kept) = (HashSet::new(), HashSet::new());
	for &(v, _, st) in &vars {
		reach(&info, st, if targets.contains_key(&v) { &mut gone } else { &mut kept });
	}
	for t in &buffers {
		reach(&info, *t, &mut kept);
	}
	let drop_mat: HashSet<u32> = gone.difference(&kept).copied().collect();

	let mut g = Gen { bound: words[3], uint: 0, consts: BTreeMap::new(), ptr_uint: HashMap::new(), words: 0 };
	g.uint = g.id();
	let uvec4 = g.id();
	let mut new_ty: HashMap<u32, (u32, u32, u32)> = HashMap::new(); // var -> (array, struct, pointer)
	let mut tv: Vec<u32> = targets.keys().copied().collect();
	tv.sort();
	for &v in &tv {
		let (sc, _, _) = targets[&v];
		if !g.ptr_uint.contains_key(&sc) {
			let p = g.id();
			g.ptr_uint.insert(sc, p);
		}
		let ids = (g.id(), g.id(), g.id());
		new_ty.insert(v, ids);
	}

	let mut out: Vec<u32> = Vec::with_capacity(words.len() + 256);
	out.extend_from_slice(&words[..5]);
	let mut ptrs: HashMap<u32, Ptr> = HashMap::new();
	let (mut dec_at, mut var_at) = (None, None);
	let mut in_fn = false;
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let o = words[i] & 0xffff;
		let a = &words[i + 1..i + n];
		i += n;
		if o == OP_FUNCTION {
			in_fn = true;
		}
		match o {
			OP_MEMBER_DECORATE if a.len() >= 3 && drop_mat.contains(&a[0]) && matches!(a[2], DEC_ROW_MAJOR | DEC_COL_MAJOR | DEC_MATRIX_STRIDE) => {}
			OP_DECORATE | OP_MEMBER_DECORATE if dec_at.is_none() => {
				dec_at = Some(out.len());
				inst(&mut out, o, a);
			}
			OP_VARIABLE if a.len() >= 3 && targets.contains_key(&a[1]) => {
				if var_at.is_none() {
					var_at = Some(out.len());
				}
				let (sc, st, _) = targets[&a[1]];
				ptrs.insert(a[1], Ptr { var: a[1], sc, ty: st, off: 0, dyn_: None, vstride: 4, mat: None });
				let mut ops = a.to_vec();
				ops[0] = new_ty[&a[1]].2;
				inst(&mut out, o, &ops);
			}
			OP_ACCESS_CHAIN | OP_IN_BOUNDS_ACCESS_CHAIN if a.len() >= 3 && ptrs.contains_key(&a[2]) => {
				let mut p = ptrs[&a[2]].clone();
				for &idx in &a[3..] {
					match info.ty.get(&p.ty)?.clone() {
						Ty::Struct(ms) => {
							let k = *info.consts.get(&idx)?;
							p.off += *info.off.get(&(p.ty, k))?;
							p.mat = info.mat_of(p.ty, k).or(p.mat);
							p.ty = *ms.get(k as usize)?;
						}
						Ty::Arr(el, _) => {
							let s = *info.stride.get(&p.ty)?;
							g.index(&mut out, &info, &mut p, idx, s);
							p.ty = el;
						}
						Ty::Mat(col, _) => {
							let (rm, ms) = p.mat?;
							if rm {
								g.index(&mut out, &info, &mut p, idx, 4);
								p.vstride = ms;
							} else {
								g.index(&mut out, &info, &mut p, idx, ms);
								p.vstride = 4;
							}
							p.ty = col;
							p.mat = None;
						}
						Ty::Vec(c, _) => {
							let s = p.vstride;
							g.index(&mut out, &info, &mut p, idx, s);
							p.ty = c;
						}
						_ => return None,
					}
				}
				ptrs.insert(a[1], p);
			}
			OP_LOAD if a.len() >= 3 && ptrs.contains_key(&a[2]) => {
				let p = ptrs[&a[2]].clone();
				g.words = 0;
				g.load(&mut out, &info, a[0], &p, Some(a[1]))?;
			}
			_ => {
				// Any other use of a repacked pointer: leave the module alone.
				if in_fn && a.iter().any(|w| ptrs.contains_key(w)) {
					return None;
				}
				inst(&mut out, o, a);
			}
		}
	}
	let (dec_at, var_at) = (dec_at?, var_at?);
	let mut decl = Vec::new();
	inst(&mut decl, OP_TYPE_INT, &[g.uint, 32, 0]);
	let lens: Vec<u32> = tv.iter().map(|v| g.c(targets[v].2)).collect();
	for (&v, &id) in g.consts.iter() {
		inst(&mut decl, OP_CONSTANT, &[g.uint, id, v]);
	}
	inst(&mut decl, OP_TYPE_VECTOR, &[uvec4, g.uint, 4]);
	// Names (the debug section ends where the annotations start).
	let mut decs = Vec::new();
	for &v in &tv {
		let st = new_ty[&v].1;
		name(&mut decs, OP_NAME, &[st], "kw_words");
		name(&mut decs, OP_MEMBER_NAME, &[st, 0], "w");
	}
	for (j, &v) in tv.iter().enumerate() {
		let (arr, st, ptr) = new_ty[&v];
		inst(&mut decl, OP_TYPE_ARRAY, &[arr, uvec4, lens[j]]);
		inst(&mut decl, OP_TYPE_STRUCT, &[st, arr]);
		inst(&mut decl, OP_TYPE_POINTER, &[ptr, targets[&v].0, st]);
		inst(&mut decs, OP_DECORATE, &[arr, DEC_ARRAY_STRIDE, 16]);
		inst(&mut decs, OP_DECORATE, &[st, DEC_BLOCK]);
		inst(&mut decs, OP_MEMBER_DECORATE, &[st, 0, DEC_OFFSET, 0]);
	}
	let mut sp: Vec<(u32, u32)> = g.ptr_uint.iter().map(|(&sc, &id)| (sc, id)).collect();
	sp.sort();
	for (sc, id) in sp {
		inst(&mut decl, OP_TYPE_POINTER, &[id, sc, g.uint]);
	}
	out.splice(var_at..var_at, decl);
	out.splice(dec_at..dec_at, decs);
	out[3] = g.bound;
	Some(out)
}
