// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//
// 8- and 16-bit storage (VK_KHR_8bit_storage/16bit_storage, shaderInt8/
// Int16, float16_t) on WebGPU, which has no 8/16-bit integers and f16 only
// with the shader-f16 feature. A storage buffer holding such members (or
// bound through several differently typed views, as llama.cpp's packed16/
// packed32 views of one block array) becomes one `{ uint words[]; }`
// variable per binding, addressed in bytes from the SPIR-V Offset/
// ArrayStride decorations: loads read the word(s) and shift/mask (f16 via
// UnpackHalf2x16, i.e. unpack2x16float); 32-bit stores write words.
// Stores of 8/16-bit values into such a buffer are refused: a
// read-modify-write of a shared word would race with the neighbouring
// invocations the original shader does not race with. Elsewhere the 8/16-
// bit integer types become 32-bit (narrowing conversions mask or
// sign-extend), and without shader-f16 so does float16_t (arithmetic in
// f32; f16<->u16 bitcasts become pack/unpack).

use std::collections::HashMap;

fn inst(op: u32, operands: &[u32]) -> Vec<u32> {
	let mut v = vec![((operands.len() as u32 + 1) << 16) | op];
	v.extend_from_slice(operands);
	v
}

fn half_to_f32(h: u32) -> u32 {
	let s = (h >> 15) & 1;
	let e = (h >> 10) & 0x1f;
	let m = h & 0x3ff;
	let f = if e == 0 {
		(m as f32) * 2f32.powi(-24)
	} else if e == 31 {
		if m == 0 { f32::INFINITY } else { f32::NAN }
	} else {
		(1.0 + m as f32 / 1024.0) * 2f32.powi(e as i32 - 15)
	};
	(if s == 1 { -f } else { f }).to_bits()
}

#[derive(Clone)]
enum Ty {
	Int(u32, bool),
	Float(u32),
	Vec(u32, u32),
	Arr(u32, u32), // element, length constant id
	RArr(u32),
	Struct(Vec<u32>),
	Ptr(u32, u32),
	Mat(u32, u32), // column type, columns
	Other,
}

pub fn lower_small_storage(words: Vec<u32>, has_f16: bool) -> Result<Vec<u32>, String> {
	const OP_EXT_INST_IMPORT: u32 = 11;
	const OP_EXT_INST: u32 = 12;
	const OP_MEMORY_MODEL: u32 = 14;
	const OP_ENTRY_POINT: u32 = 15;
	const OP_NAME: u32 = 5;
	const OP_TYPE_INT: u32 = 21;
	const OP_TYPE_FLOAT: u32 = 22;
	const OP_TYPE_VECTOR: u32 = 23;
	const OP_TYPE_MATRIX: u32 = 24;
	const OP_TYPE_ARRAY: u32 = 28;
	const OP_TYPE_RUNTIME_ARRAY: u32 = 29;
	const OP_TYPE_STRUCT: u32 = 30;
	const OP_TYPE_POINTER: u32 = 32;
	const OP_CONSTANT: u32 = 43;
	const OP_SPEC_CONSTANT: u32 = 50;
	const OP_FUNCTION: u32 = 54;
	const OP_VARIABLE: u32 = 59;
	const OP_LOAD: u32 = 61;
	const OP_STORE: u32 = 62;
	const OP_ACCESS_CHAIN: u32 = 65;
	const OP_IN_BOUNDS_ACCESS_CHAIN: u32 = 66;
	const OP_ARRAY_LENGTH: u32 = 68;
	const OP_DECORATE: u32 = 71;
	const OP_MEMBER_DECORATE: u32 = 72;
	const OP_COMPOSITE_CONSTRUCT: u32 = 80;
	const OP_COMPOSITE_EXTRACT: u32 = 81;
	const OP_COPY_OBJECT: u32 = 83;
	const OP_UCONVERT: u32 = 113;
	const OP_SCONVERT: u32 = 114;
	const OP_FCONVERT: u32 = 115;
	const OP_BITCAST: u32 = 124;
	const OP_IADD: u32 = 128;
	const OP_ISUB: u32 = 130;
	const OP_IMUL: u32 = 132;
	const OP_UDIV: u32 = 134;
	const OP_SHR: u32 = 194;
	const OP_SAR: u32 = 195;
	const OP_SHL: u32 = 196;
	const OP_AND: u32 = 199;
	const DEC_BLOCK: u32 = 2;
	const DEC_ARRAY_STRIDE: u32 = 6;
	const DEC_BINDING: u32 = 33;
	const DEC_SET: u32 = 34;
	const DEC_OFFSET: u32 = 35;
	const SC_UNIFORM: u32 = 2;
	const SC_STORAGE: u32 = 12;
	const GLSL_PACK_HALF: u32 = 58;
	const GLSL_UNPACK_HALF: u32 = 62;

	let mut ty: HashMap<u32, Ty> = HashMap::new();
	let mut consts: HashMap<u32, u32> = HashMap::new();
	let mut stride: HashMap<u32, u32> = HashMap::new();
	let mut offset: HashMap<(u32, u32), u32> = HashMap::new();
	let mut binding: HashMap<u32, u32> = HashMap::new();
	let mut set: HashMap<u32, u32> = HashMap::new();
	let mut val_ty: HashMap<u32, u32> = HashMap::new();
	let mut vars: Vec<(u32, u32)> = Vec::new(); // (var, pointee) storage buffers
	let mut readonly: Vec<u32> = Vec::new();
	let mut buffer_block: Vec<u32> = Vec::new();
	let mut readonly_member: Vec<(u32, u32)> = Vec::new();
	let mut glsl = None;
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let o = words[i] & 0xffff;
		let a = &words[i + 1..i + n];
		match o {
			OP_EXT_INST_IMPORT if crate::spirv::read_string_pub(&a[1..]) == "GLSL.std.450" => glsl = Some(a[0]),
			OP_TYPE_INT => {
				ty.insert(a[0], Ty::Int(a[1], a[2] != 0));
			}
			OP_TYPE_FLOAT => {
				ty.insert(a[0], Ty::Float(a[1]));
			}
			OP_TYPE_VECTOR => {
				ty.insert(a[0], Ty::Vec(a[1], a[2]));
			}
			OP_TYPE_MATRIX => {
				ty.insert(a[0], Ty::Mat(a[1], a[2]));
			}
			26 | 25 | 27 | 20 | 19 | 33 => {
				ty.insert(a[0], Ty::Other);
			}
			OP_TYPE_ARRAY => {
				ty.insert(a[0], Ty::Arr(a[1], a[2]));
			}
			OP_TYPE_RUNTIME_ARRAY => {
				ty.insert(a[0], Ty::RArr(a[1]));
			}
			OP_TYPE_STRUCT => {
				ty.insert(a[0], Ty::Struct(a[1..].to_vec()));
			}
			OP_TYPE_POINTER => {
				ty.insert(a[0], Ty::Ptr(a[1], a[2]));
			}
			OP_CONSTANT | OP_SPEC_CONSTANT if a.len() >= 3 => {
				consts.insert(a[1], a[2]);
			}
			OP_DECORATE if a.len() >= 3 && a[1] == DEC_ARRAY_STRIDE => {
				stride.insert(a[0], a[2]);
			}
			OP_DECORATE if a.len() >= 3 && a[1] == DEC_BINDING => {
				binding.insert(a[0], a[2]);
			}
			OP_DECORATE if a.len() >= 3 && a[1] == DEC_SET => {
				set.insert(a[0], a[2]);
			}
			OP_MEMBER_DECORATE if a.len() >= 4 && a[2] == DEC_OFFSET => {
				offset.insert((a[0], a[1]), a[3]);
			}
			OP_DECORATE if a.len() >= 2 && a[1] == 24 => readonly.push(a[0]),
			OP_DECORATE if a.len() >= 2 && a[1] == 3 => buffer_block.push(a[0]),
			OP_MEMBER_DECORATE if a.len() >= 3 && a[2] == 24 => readonly_member.push((a[0], a[1])),
			OP_VARIABLE => {
				if let Some(Ty::Ptr(sc, p)) = ty.get(&a[0]) {
					// StorageBuffer, or SPIR-V 1.0's Uniform + BufferBlock.
					if *sc == SC_STORAGE || (*sc == SC_UNIFORM && buffer_block.contains(p)) {
						vars.push((a[1], *p));
					}
				}
				val_ty.insert(a[1], a[0]);
			}
			_ => {
				if n >= 3 && !(19..=39).contains(&o) && o != OP_DECORATE && o != OP_MEMBER_DECORATE && o != OP_NAME && o != 6 {
					val_ty.insert(a[1], a[0]);
				}
			}
		}
		i += n;
	}
	let narrow_ty = |t: u32| -> bool { matches!(ty.get(&t), Some(Ty::Int(8 | 16, _))) || (!has_f16 && matches!(ty.get(&t), Some(Ty::Float(16)))) };
	fn contains(ty: &HashMap<u32, Ty>, t: u32, f: &dyn Fn(u32) -> bool, depth: u32) -> bool {
		if depth > 16 {
			return false;
		}
		if f(t) {
			return true;
		}
		match ty.get(&t) {
			Some(Ty::Vec(c, _)) | Some(Ty::Mat(c, _)) => contains(ty, *c, f, depth + 1),
			Some(Ty::Arr(e, _)) | Some(Ty::RArr(e)) => contains(ty, *e, f, depth + 1),
			Some(Ty::Struct(ms)) => ms.iter().any(|m| contains(ty, *m, f, depth + 1)),
			_ => false,
		}
	}
	let small = |t: u32| matches!(ty.get(&t), Some(Ty::Int(8 | 16, _)) | Some(Ty::Float(16)));
	let any_narrow = ty.keys().any(|&t| narrow_ty(t));
	// Groups by binding.
	let slot = |v: u32| (set.get(&v).copied().unwrap_or(0), binding.get(&v).copied().unwrap_or(u32::MAX));
	let mut groups: HashMap<(u32, u32), Vec<(u32, u32)>> = HashMap::new();
	for &(v, p) in &vars {
		groups.entry(slot(v)).or_default().push((v, p));
	}
	// The element type of a `{ X[] }` buffer and whether a group is only
	// scalar/vector views of one type (merge_aliased_buffers handles it).
	let simple_elem = |p: u32| -> Option<u32> {
		let Some(Ty::Struct(ms)) = ty.get(&p) else { return None };
		if ms.len() != 1 {
			return None;
		}
		let Some(Ty::RArr(e)) = ty.get(&ms[0]) else { return None };
		Some(match ty.get(e) {
			Some(Ty::Vec(c, _)) => *c,
			_ => *e,
		})
	};
	let mut lowered: HashMap<u32, u32> = HashMap::new(); // original var -> group words var index
	let mut group_list: Vec<((u32, u32), Vec<u32>)> = Vec::new();
	for (k, g) in &groups {
		let needs_small = g.iter().any(|&(_, p)| contains(&ty, p, &|t| small(t) && (narrow_ty(t) || matches!(ty.get(&t), Some(Ty::Int(..))) || !has_f16), 0));
		let distinct: Vec<u32> = {
			let mut d: Vec<u32> = g.iter().map(|x| x.1).collect();
			d.sort();
			d.dedup();
			d
		};
		let simple_alias = distinct.len() > 1 && {
			let es: Vec<Option<u32>> = distinct.iter().map(|&p| simple_elem(p)).collect();
			es.iter().all(|e| e.is_some() && *e == es[0])
		};
		if needs_small || (distinct.len() > 1 && !simple_alias) {
			let idx = group_list.len();
			group_list.push((*k, g.iter().map(|x| x.0).collect()));
			for &(v, _) in g {
				lowered.insert(v, idx as u32);
			}
		}
	}
	if lowered.is_empty() && !any_narrow {
		return Ok(words);
	}
	// Groups some view of which is writable and holds 8/16-bit members:
	// every access to their words is atomic, so a sub-word store
	// (atomicAnd + atomicOr on the word) cannot race with a neighbour's.
	let writable = |v: u32, p: u32| -> bool {
		if readonly.contains(&v) {
			return false;
		}
		match ty.get(&p) {
			Some(Ty::Struct(ms)) => (0..ms.len() as u32).any(|k| !readonly_member.contains(&(p, k))),
			_ => true,
		}
	};
	let atomic_groups: Vec<bool> = group_list
		.iter()
		.map(|(_, vs)| vs.iter().any(|&v| { let p = vars.iter().find(|x| x.0 == v).unwrap().1; writable(v, p) && contains(&ty, p, &|t| small(t), 0) }))
		.collect();
	let pointee_of = |v: u32| vars.iter().find(|x| x.0 == v).map(|x| x.1).unwrap();

	let mut bound = words[3];
	let mut id = || {
		bound += 1;
		bound - 1
	};
	let u32t = id();
	let f32t = id();
	let v2f = id();
	let ra = id();
	let ws = id();
	let pw = id();
	let pu = id();
	let glsl_id = glsl.unwrap_or_else(&mut id);
	let wvars: Vec<u32> = group_list.iter().map(|_| id()).collect();
	let mut uconst: HashMap<u32, u32> = HashMap::new();
	let mut typed_const: HashMap<(u32, u32), u32> = HashMap::new();
	drop(id);
	let mut b = bound;
	let mut new_id = move || {
		b += 1;
		b - 1
	};
	let uc = |v: u32, uconst: &mut HashMap<u32, u32>, new_id: &mut dyn FnMut() -> u32| -> u32 { *uconst.entry(v).or_insert_with(|| new_id()) };


	// Byte pointers: id -> (words var, offset id (uint), pointee type)
	let mut vptr: HashMap<u32, (u32, u32, u32)> = HashMap::new();
	let mut body: Vec<u32> = Vec::with_capacity(words.len() * 2);
	let mut header_end = 0usize;
	let mut first_fn_at = None;

	macro_rules! op3 {
		($o:expr, $t:expr, $x:expr, $y:expr) => {{
			let r = new_id();
			body.extend(inst($o, &[$t, r, $x, $y]));
			r
		}};
	}
	// Offset arithmetic helpers.
	macro_rules! add_c {
		($off:expr, $c:expr) => {{
			if $c == 0 {
				$off
			} else {
				let c = uc($c, &mut uconst, &mut new_id);
				op3!(OP_IADD, u32t, $off, c)
			}
		}};
	}
	let mut i = 5;
	let mut zero_off = None;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let o = words[i] & 0xffff;
		let a = words[i + 1..i + n].to_vec();
		if o == OP_FUNCTION && first_fn_at.is_none() {
			first_fn_at = Some(body.len());
		}
		if o == OP_MEMORY_MODEL && glsl.is_none() {
			let mut s = vec![glsl_id];
			s.extend(crate::spirv::string_words_pub("GLSL.std.450"));
			body.extend(inst(OP_EXT_INST_IMPORT, &s));
		}
		match o {
			OP_TYPE_INT if a[1] == 8 || a[1] == 16 => body.extend(inst(o, &[a[0], 32, a[2]])),
			OP_TYPE_FLOAT if a[1] == 16 && !has_f16 => body.extend(inst(o, &[a[0], 32])),
			OP_CONSTANT | OP_SPEC_CONSTANT if !has_f16 && matches!(ty.get(&a[0]), Some(Ty::Float(16))) => {
				body.extend(inst(o, &[a[0], a[1], half_to_f32(a[2] & 0xffff)]));
			}
			OP_ENTRY_POINT => {
				let mut ops = Vec::new();
				let mut seen = Vec::new();
				for &x in &a {
					match lowered.get(&x) {
						Some(&g) => {
							if !seen.contains(&g) {
								seen.push(g);
								ops.push(wvars[g as usize]);
							}
						}
						None => ops.push(x),
					}
				}
				body.extend(inst(o, &ops));
			}
			// Layout decorations of types holding narrow members (only values
			// now) would overlap once those members are 32-bit.
			OP_MEMBER_DECORATE if a.len() >= 4 && a[2] == DEC_OFFSET && contains(&ty, a[0], &|t| narrow_ty(t), 0) => {}
			OP_DECORATE if a.len() >= 3 && a[1] == DEC_ARRAY_STRIDE && contains(&ty, a[0], &|t| narrow_ty(t), 0) => {}
			OP_NAME if lowered.contains_key(&a[0]) => {}
			OP_DECORATE if lowered.contains_key(&a[0]) => {
				// Binding/set go to the words variable (once, from the group's first view).
				let g = lowered[&a[0]] as usize;
				if group_list[g].1[0] == a[0] && (a[1] == DEC_BINDING || a[1] == DEC_SET) {
					let mut ops = a.clone();
					ops[0] = wvars[g];
					body.extend(inst(o, &ops));
					// Read-only when every view is (read-only-storage binding).
					if a[1] == DEC_BINDING && group_list[g].1.iter().all(|&v| !writable(v, vars.iter().find(|x| x.0 == v).unwrap().1)) {
						body.extend(inst(OP_DECORATE, &[wvars[g], 24]));
					}
				}
			}
			OP_VARIABLE if lowered.contains_key(&a[1]) => {
				let z = *zero_off.get_or_insert_with(|| uc(0, &mut uconst, &mut new_id));
				vptr.insert(a[1], (wvars[lowered[&a[1]] as usize], z, pointee_of(a[1])));
			}
			OP_ACCESS_CHAIN | OP_IN_BOUNDS_ACCESS_CHAIN if vptr.contains_key(&a[2]) => {
				let (w, mut off, mut cur) = vptr[&a[2]];
				for &ix in &a[3..] {
					match ty.get(&cur).cloned() {
						Some(Ty::Struct(ms)) => {
							let k = *consts.get(&ix).ok_or("non-constant struct index")? as usize;
							off = add_c!(off, offset.get(&(cur, k as u32)).copied().unwrap_or(0));
							cur = ms[k];
						}
						Some(Ty::Arr(e, _)) | Some(Ty::RArr(e)) => {
							let s = stride.get(&cur).copied().ok_or("array without ArrayStride in a lowered buffer")?;
							if let Some(&k) = consts.get(&ix) {
								off = add_c!(off, k * s);
							} else {
								let iu = new_id();
								body.extend(inst(OP_BITCAST, &[u32t, iu, ix]));
								let sc = uc(s, &mut uconst, &mut new_id);
								let m = op3!(OP_IMUL, u32t, iu, sc);
								off = op3!(OP_IADD, u32t, off, m);
							}
							cur = e;
						}
						Some(Ty::Vec(c, _)) => {
							let wdt = match ty.get(&c) {
								Some(Ty::Int(w, _)) | Some(Ty::Float(w)) => *w / 8,
								_ => 4,
							};
							if let Some(&k) = consts.get(&ix) {
								off = add_c!(off, k * wdt);
							} else {
								let iu = new_id();
								body.extend(inst(OP_BITCAST, &[u32t, iu, ix]));
								let sc = uc(wdt, &mut uconst, &mut new_id);
								let m = op3!(OP_IMUL, u32t, iu, sc);
								off = op3!(OP_IADD, u32t, off, m);
							}
							cur = c;
						}
						_ => return Err("unsupported access into a lowered 8/16-bit buffer (matrix?)".into()),
					}
				}
				vptr.insert(a[1], (w, off, cur));
			}
			OP_LOAD if vptr.contains_key(&a[2]) => {
				let (w, off, cur) = vptr[&a[2]];
				// Recursive typed load; the outermost value gets a[1].
				fn load(
					t: u32, off: u32, res: u32, w: u32, ctx: &mut (
						&HashMap<u32, Ty>, &HashMap<u32, u32>, &HashMap<(u32, u32), u32>, &HashMap<u32, u32>,
						&mut Vec<u32>, &mut dyn FnMut() -> u32, &mut HashMap<u32, u32>, [u32; 6], bool,
					),
				) -> Result<(), String> {
					let (ty, consts, offset, stride, _, _, _, ids, has_f16) = (ctx.0, ctx.1, ctx.2, ctx.3, (), (), (), ctx.7, ctx.8);
					let [u32t, f32t, v2f, pu, glsl, _] = ids;
					macro_rules! nid {
						() => {
							(ctx.5)()
						};
					}
					macro_rules! cst {
						($v:expr) => {{
							let v = $v;
							if let Some(&c) = ctx.6.get(&v) { c } else { let c = (ctx.5)(); ctx.6.insert(v, c); c }
						}};
					}
					macro_rules! emit {
						($($x:expr),*) => { ctx.4.extend(inst($($x),*)) };
					}
					let word = |ctx: &mut (_, _, _, _, &mut Vec<u32>, &mut dyn FnMut() -> u32, &mut HashMap<u32, u32>, [u32; 6], _), off: u32| -> u32 {
						let two = *ctx.6.entry(2).or_insert_with(|| (ctx.5)());
						let zero = *ctx.6.entry(0).or_insert_with(|| (ctx.5)());
						let (ix, p, v) = ((ctx.5)(), (ctx.5)(), (ctx.5)());
						ctx.4.extend(inst(OP_SHR, &[u32t, ix, off, two]));
						ctx.4.extend(inst(OP_ACCESS_CHAIN, &[pu, p, w, zero, ix]));
						if ctx.7[5] != 0 {
							let one = *ctx.6.entry(1).or_insert_with(|| (ctx.5)());
							ctx.4.extend(inst(227, &[u32t, v, p, one, zero])); // OpAtomicLoad, Device, Relaxed
						} else {
							ctx.4.extend(inst(OP_LOAD, &[u32t, v, p]));
						}
						v
					};
					match ty.get(&t).cloned() {
						Some(Ty::Int(32, _)) | Some(Ty::Float(32)) => {
							let v = word(ctx, off);
							emit!(OP_BITCAST, &[t, res, v]);
						}
						Some(Ty::Int(bits, _)) | Some(Ty::Float(bits)) if bits == 8 || bits == 16 => {
							let is_float = matches!(ty.get(&t), Some(Ty::Float(_)));
							let v = word(ctx, off);
							let three = cst!(3);
							let (s1, s2, sh, m) = (nid!(), nid!(), nid!(), nid!());
							let mask = cst!(if bits == 8 { 0xff } else { 0xffff });
							emit!(OP_AND, &[u32t, s1, off, three]);
							emit!(OP_SHL, &[u32t, s2, s1, three]);
							emit!(OP_SHR, &[u32t, sh, v, s2]);
							emit!(OP_AND, &[u32t, m, sh, mask]);
							if is_float {
								let (u2, f) = (nid!(), nid!());
								emit!(OP_EXT_INST, &[v2f, u2, glsl, GLSL_UNPACK_HALF, m]);
								emit!(OP_COMPOSITE_EXTRACT, &[f32t, f, u2, 0]);
								emit!(if has_f16 { OP_FCONVERT } else { OP_COPY_OBJECT }, &[t, res, f]);
							} else if matches!(ty.get(&t), Some(Ty::Int(_, true))) {
								let k = cst!(32 - bits);
								let (l, x) = (nid!(), nid!());
								emit!(OP_SHL, &[u32t, l, m, k]);
								emit!(OP_BITCAST, &[t, x, l]);
								emit!(OP_SAR, &[t, res, x, k]);
							} else {
								emit!(OP_BITCAST, &[t, res, m]);
							}
						}
						Some(Ty::Vec(c, n)) => {
							let wdt = match ty.get(&c) {
								Some(Ty::Int(w, _)) | Some(Ty::Float(w)) => *w / 8,
								_ => 4,
							};
							let mut parts = Vec::new();
							for k in 0..n {
								let o2 = if k == 0 { off } else { let c2 = cst!(k * wdt); let r = nid!(); emit!(OP_IADD, &[u32t, r, off, c2]); r };
								let r = nid!();
								load(c, o2, r, w, ctx)?;
								parts.push(r);
							}
							let mut ops = vec![t, res];
							ops.extend(parts);
							ctx.4.extend(inst(OP_COMPOSITE_CONSTRUCT, &ops));
						}
						Some(Ty::Mat(col, ncols)) => {
							let csz = match ty.get(&col) {
								Some(Ty::Vec(c, n)) => match ty.get(c) { Some(Ty::Int(w, _)) | Some(Ty::Float(w)) => (w / 8) * if *n == 3 { 4 } else { *n }, _ => 16 },
								_ => 16,
							};
							let mut parts = Vec::new();
							for k in 0..ncols {
								let o2 = if k == 0 { off } else { let c2 = cst!(k * csz); let r = nid!(); emit!(OP_IADD, &[u32t, r, off, c2]); r };
								let r = nid!();
								load(col, o2, r, w, ctx)?;
								parts.push(r);
							}
							let mut ops = vec![t, res];
							ops.extend(parts);
							ctx.4.extend(inst(OP_COMPOSITE_CONSTRUCT, &ops));
						}
						Some(Ty::Arr(e, len)) => {
							let s = *stride.get(&t).ok_or("array without ArrayStride")?;
							let n = *consts.get(&len).ok_or("array length")?;
							let mut parts = Vec::new();
							for k in 0..n {
								let o2 = if k == 0 { off } else { let c2 = cst!(k * s); let r = nid!(); emit!(OP_IADD, &[u32t, r, off, c2]); r };
								let r = nid!();
								load(e, o2, r, w, ctx)?;
								parts.push(r);
							}
							let mut ops = vec![t, res];
							ops.extend(parts);
							ctx.4.extend(inst(OP_COMPOSITE_CONSTRUCT, &ops));
						}
						Some(Ty::Struct(ms)) => {
							let mut parts = Vec::new();
							for (k, &m) in ms.iter().enumerate() {
								let d = offset.get(&(t, k as u32)).copied().unwrap_or(0);
								let o2 = if d == 0 { off } else { let c2 = cst!(d); let r = nid!(); emit!(OP_IADD, &[u32t, r, off, c2]); r };
								let r = nid!();
								load(m, o2, r, w, ctx)?;
								parts.push(r);
							}
							let mut ops = vec![t, res];
							ops.extend(parts);
							ctx.4.extend(inst(OP_COMPOSITE_CONSTRUCT, &ops));
						}
						_ => return Err("unsupported type loaded from a lowered 8/16-bit buffer".into()),
					}
					Ok(())
				}
				let atomic = atomic_groups[wvars.iter().position(|&x| x == w).unwrap()] as u32;
				let mut ctx = (&ty, &consts, &offset, &stride, &mut body, &mut new_id as &mut dyn FnMut() -> u32, &mut uconst, [u32t, f32t, v2f, pu, glsl_id, atomic], has_f16);
				load(cur, off, a[1], w, &mut ctx)?;
			}
			OP_STORE if vptr.contains_key(&a[0]) => {
				let (w, off, cur) = vptr[&a[0]];
				let atomic = atomic_groups[wvars.iter().position(|&x| x == w).unwrap()];
				// Flatten the stored value into (scalar type, byte offset, value id).
				let mut leaves: Vec<(u32, u32, u32)> = Vec::new();
				let mut stack: Vec<(u32, u32, u32)> = vec![(cur, off, a[1])];
				while let Some((t, o2, v)) = stack.pop() {
					let kids: Vec<(u32, u32)> = match ty.get(&t).cloned() {
						Some(Ty::Vec(c, n)) => {
							let wd = match ty.get(&c) { Some(Ty::Int(w, _)) | Some(Ty::Float(w)) => *w / 8, _ => 4 };
							(0..n).map(|k| (c, k * wd)).collect()
						}
						Some(Ty::Arr(e, len)) => {
							let s2 = stride.get(&t).copied().ok_or("array without ArrayStride")?;
							(0..*consts.get(&len).ok_or("array length")?).map(|k| (e, k * s2)).collect()
						}
						Some(Ty::Struct(ms)) => ms.iter().enumerate().map(|(k, &m)| (m, offset.get(&(t, k as u32)).copied().unwrap_or(0))).collect(),
						_ => {
							leaves.push((t, o2, v));
							continue;
						}
					};
					for (k, (kt, d)) in kids.into_iter().enumerate() {
						let e = new_id();
						body.extend(inst(OP_COMPOSITE_EXTRACT, &[kt, e, v, k as u32]));
						let o3 = add_c!(o2, d);
						stack.push((kt, o3, e));
					}
				}
				let two = uc(2, &mut uconst, &mut new_id);
				let zero = uc(0, &mut uconst, &mut new_id);
				let one = uc(1, &mut uconst, &mut new_id);
				for (t, o2, v) in leaves {
					let ix = op3!(OP_SHR, u32t, o2, two);
					let p = new_id();
					body.extend(inst(OP_ACCESS_CHAIN, &[pu, p, w, zero, ix]));
					match ty.get(&t).cloned() {
						Some(Ty::Int(32, _)) | Some(Ty::Float(32)) => {
							let bv = new_id();
							body.extend(inst(OP_BITCAST, &[u32t, bv, v]));
							if atomic {
								body.extend(inst(228, &[p, one, zero, bv])); // OpAtomicStore
							} else {
								body.extend(inst(OP_STORE, &[p, bv]));
							}
						}
						Some(Ty::Int(bits, _)) | Some(Ty::Float(bits)) if (bits == 8 || bits == 16) && atomic => {
							let is_float = matches!(ty.get(&t), Some(Ty::Float(_)));
							let raw = if is_float {
								// half bits: PackHalf2x16(vec2(v, 0)) (v as f32)
								let f = new_id();
								body.extend(inst(if has_f16 { OP_FCONVERT } else { OP_COPY_OBJECT }, &[f32t, f, v]));
								let zc = *typed_const.entry((f32t, 0)).or_insert_with(|| new_id());
								let v2 = new_id();
								body.extend(inst(OP_COMPOSITE_CONSTRUCT, &[v2f, v2, f, zc]));
								let u = new_id();
								body.extend(inst(OP_EXT_INST, &[u32t, u, glsl_id, GLSL_PACK_HALF, v2]));
								u
							} else {
								let u = new_id();
								body.extend(inst(OP_BITCAST, &[u32t, u, v]));
								u
							};
							let mask = uc(if bits == 8 { 0xff } else { 0xffff }, &mut uconst, &mut new_id);
							let three = uc(3, &mut uconst, &mut new_id);
							let m = op3!(OP_AND, u32t, raw, mask);
							let s1 = op3!(OP_AND, u32t, o2, three);
							let sh = op3!(OP_SHL, u32t, s1, three);
							let val = op3!(OP_SHL, u32t, m, sh);
							let mk = op3!(OP_SHL, u32t, mask, sh);
							let inv = new_id();
							body.extend(inst(200, &[u32t, inv, mk])); // OpNot
							let (r1, r2) = (new_id(), new_id());
							body.extend(inst(240, &[u32t, r1, p, one, zero, inv])); // OpAtomicAnd
							body.extend(inst(241, &[u32t, r2, p, one, zero, val])); // OpAtomicOr
						}
						_ => return Err("unsupported store into a lowered 8/16-bit storage buffer".into()),
					}
				}
			}
			OP_ARRAY_LENGTH if vptr.contains_key(&a[2]) => {
				let (w, _, cur) = vptr[&a[2]];
				let Some(Ty::Struct(ms)) = ty.get(&cur).cloned() else { return Err("OpArrayLength".into()) };
				let m = ms[a[3] as usize];
				let s = stride.get(&m).copied().unwrap_or(4);
				let d = offset.get(&(cur, a[3])).copied().unwrap_or(0);
				let l = new_id();
				body.extend(inst(OP_ARRAY_LENGTH, &[u32t, l, w, 0]));
				let four = uc(4, &mut uconst, &mut new_id);
				let bytes = op3!(OP_IMUL, u32t, l, four);
				let dc = uc(d, &mut uconst, &mut new_id);
				let avail = op3!(OP_ISUB, u32t, bytes, dc);
				let sc = uc(s, &mut uconst, &mut new_id);
				let cnt = op3!(OP_UDIV, u32t, avail, sc);
				body.extend(inst(OP_BITCAST, &[a[0], a[1], cnt]));
			}
			OP_UCONVERT | OP_SCONVERT if matches!(ty.get(&a[0]), Some(Ty::Int(8 | 16, _))) || matches!(ty.get(&a[0]), Some(Ty::Vec(c, _)) if matches!(ty.get(c), Some(Ty::Int(8 | 16, _)))) => {
				// Narrowing into a (now 32-bit) small type: mask or sign-extend.
				let scalar = match ty.get(&a[0]) { Some(Ty::Vec(c, _)) => *c, _ => a[0] };
				let Some(Ty::Int(bits, _)) = ty.get(&scalar).cloned() else { unreachable!() };
				let vec_n = match ty.get(&a[0]) { Some(Ty::Vec(_, n)) => Some(*n), _ => None };
				let tc = |v: u32, typed_const: &mut HashMap<(u32, u32), u32>, new_id: &mut dyn FnMut() -> u32| -> u32 { *typed_const.entry((scalar, v)).or_insert_with(|| new_id()) };
				let mk = |v: u32, body: &mut Vec<u32>, typed_const: &mut HashMap<(u32, u32), u32>, new_id: &mut dyn FnMut() -> u32| -> u32 {
					let c = tc(v, typed_const, new_id);
					match vec_n {
						None => c,
						Some(n) => {
							let r = new_id();
							let mut ops = vec![a[0], r];
							ops.extend(std::iter::repeat(c).take(n as usize));
							body.extend(inst(OP_COMPOSITE_CONSTRUCT, &ops));
							r
						}
					}
				};
				let tmp = new_id();
				body.extend(inst(o, &[a[0], tmp, a[2]]));
				if o == OP_UCONVERT {
					let m = mk(if bits == 8 { 0xff } else { 0xffff }, &mut body, &mut typed_const, &mut new_id);
					body.extend(inst(OP_AND, &[a[0], a[1], tmp, m]));
				} else {
					let k = mk(32 - bits, &mut body, &mut typed_const, &mut new_id);
					let l = new_id();
					body.extend(inst(OP_SHL, &[a[0], l, tmp, k]));
					body.extend(inst(OP_SAR, &[a[0], a[1], l, k]));
				}
			}
			OP_BITCAST if {
				let nv = |t: u32| matches!(ty.get(&t), Some(Ty::Vec(c, _)) if matches!(ty.get(c), Some(Ty::Int(8 | 16, _))));
				nv(a[0]) || val_ty.get(&a[2]).map_or(false, |&t| nv(t))
			} => {
				// unpack8/pack8, unpack16/pack16: a 32-bit word <-> 4 bytes / 2 halves,
				// the small components now being 32-bit.
				let src_t = val_ty.get(&a[2]).copied().unwrap_or(0);
				let vec_of = |t: u32| match ty.get(&t) { Some(Ty::Vec(c, n)) => match ty.get(c) { Some(Ty::Int(w, sg)) => Some((*c, *n, *w, *sg)), _ => None }, _ => None };
				if let Some((c, n, w, sg)) = vec_of(a[0]) {
					let u = new_id();
					body.extend(inst(OP_BITCAST, &[u32t, u, a[2]]));
					let mask = uc(if w == 8 { 0xff } else { 0xffff }, &mut uconst, &mut new_id);
					let mut parts = Vec::new();
					for k in 0..n {
						let sh = uc(k * w, &mut uconst, &mut new_id);
						let x = op3!(OP_SHR, u32t, u, sh);
						let m = op3!(OP_AND, u32t, x, mask);
						let r = new_id();
						if sg {
							let k2 = uc(32 - w, &mut uconst, &mut new_id);
							let l = op3!(OP_SHL, u32t, m, k2);
							let b2 = new_id();
							body.extend(inst(OP_BITCAST, &[c, b2, l]));
							body.extend(inst(OP_SAR, &[c, r, b2, k2]));
						} else {
							body.extend(inst(OP_BITCAST, &[c, r, m]));
						}
						parts.push(r);
					}
					let mut ops = vec![a[0], a[1]];
					ops.extend(parts);
					body.extend(inst(OP_COMPOSITE_CONSTRUCT, &ops));
				} else if let Some((c, n, w, _)) = vec_of(src_t) {
					let mask = uc(if w == 8 { 0xff } else { 0xffff }, &mut uconst, &mut new_id);
					let mut acc = None;
					for k in 0..n {
						let e = new_id();
						body.extend(inst(OP_COMPOSITE_EXTRACT, &[c, e, a[2], k]));
						let eu = new_id();
						body.extend(inst(OP_BITCAST, &[u32t, eu, e]));
						let m = op3!(OP_AND, u32t, eu, mask);
						let sh = uc(k * w, &mut uconst, &mut new_id);
						let p = op3!(OP_SHL, u32t, m, sh);
						acc = Some(match acc { None => p, Some(q) => op3!(197, u32t, q, p) });
					}
					body.extend(inst(OP_BITCAST, &[a[0], a[1], acc.unwrap()]));
				} else {
					body.extend(inst(o, &a));
				}
			}
			OP_BITCAST if !has_f16 || matches!(ty.get(&a[0]), Some(Ty::Float(16))) || matches!(ty.get(&a[0]), Some(Ty::Vec(c, 2)) if matches!(ty.get(c), Some(Ty::Float(16)))) => {
				// f16 <-> 16/32-bit integer reinterpretations.
				let src_t = val_ty.get(&a[2]).copied().unwrap_or(0);
				let is_h = |t: u32| matches!(ty.get(&t), Some(Ty::Float(16)));
				let is_h2 = |t: u32| matches!(ty.get(&t), Some(Ty::Vec(c, 2)) if is_h(*c));
				let dst = a[0];
				if is_h(dst) || is_h2(dst) {
					// int bits -> half(s)
					let (u, v) = (new_id(), new_id());
					body.extend(inst(OP_BITCAST, &[u32t, u, a[2]]));
					body.extend(inst(OP_EXT_INST, &[v2f, v, glsl_id, GLSL_UNPACK_HALF, u]));
					let src = if is_h(dst) {
						let f = new_id();
						body.extend(inst(OP_COMPOSITE_EXTRACT, &[f32t, f, v, 0]));
						f
					} else { v };
					body.extend(inst(if has_f16 { OP_FCONVERT } else { OP_COPY_OBJECT }, &[dst, a[1], src]));
				} else if is_h(src_t) || is_h2(src_t) {
					// half(s) -> int bits
					let v2 = if is_h(src_t) {
						let (f, z, v) = (new_id(), new_id(), new_id());
						body.extend(inst(if has_f16 { OP_FCONVERT } else { OP_COPY_OBJECT }, &[f32t, f, a[2]]));
						body.extend(inst(43, &[f32t, z, 0]).into_iter().take(0));
						let zc = *typed_const.entry((f32t, 0)).or_insert_with(|| new_id());
						body.extend(inst(OP_COMPOSITE_CONSTRUCT, &[v2f, v, f, zc]));
						let _ = z;
						v
					} else {
						let v = new_id();
						body.extend(inst(if has_f16 { OP_FCONVERT } else { OP_COPY_OBJECT }, &[v2f, v, a[2]]));
						v
					};
					let u = new_id();
					body.extend(inst(OP_EXT_INST, &[u32t, u, glsl_id, GLSL_PACK_HALF, v2]));
					body.extend(inst(OP_BITCAST, &[dst, a[1], u]));
				} else {
					body.extend(inst(o, &a));
				}
			}
			_ => {
				// Any other use of a byte pointer is unsupported.
				let skip = if o == OP_STORE { 0 } else { 2 };
				if a.iter().skip(skip).any(|x| vptr.contains_key(x)) && o != OP_NAME && o != OP_DECORATE {
					return Err(format!("unsupported use (opcode {}) of a lowered 8/16-bit storage buffer", o));
				}
				body.extend(inst(o, &a));
			}
		}
		if o == OP_MEMORY_MODEL {
			header_end = body.len();
		}
		i += n;
	}
	let _ = header_end;
	// Declarations before the first function: types, constants, words vars.
	let mut decl: Vec<u32> = Vec::new();
	decl.extend(inst(OP_TYPE_INT, &[u32t, 32, 0]));
	decl.extend(inst(OP_TYPE_FLOAT, &[f32t, 32]));
	decl.extend(inst(OP_TYPE_VECTOR, &[v2f, f32t, 2]));
	decl.extend(inst(OP_TYPE_RUNTIME_ARRAY, &[ra, u32t]));
	decl.extend(inst(OP_TYPE_STRUCT, &[ws, ra]));
	decl.extend(inst(OP_TYPE_POINTER, &[pw, SC_STORAGE, ws]));
	decl.extend(inst(OP_TYPE_POINTER, &[pu, SC_STORAGE, u32t]));
	let mut cs: Vec<(u32, u32)> = uconst.iter().map(|(&v, &i)| (v, i)).collect();
	cs.sort();
	for (v, i) in cs {
		decl.extend(inst(OP_CONSTANT, &[u32t, i, v]));
	}
	for (&(t, v), &i) in &typed_const {
		decl.extend(inst(OP_CONSTANT, &[t, i, v]));
	}
	for &w in &wvars {
		decl.extend(inst(OP_VARIABLE, &[pw, w, SC_STORAGE]));
	}
	let at = first_fn_at.ok_or("no function")?;
	body.splice(at..at, decl);
	// Decorations for the new types: after the last existing decoration.
	let mut dec: Vec<u32> = Vec::new();
	dec.extend(inst(OP_DECORATE, &[ra, DEC_ARRAY_STRIDE, 4]));
	dec.extend(inst(OP_DECORATE, &[ws, DEC_BLOCK]));
	dec.extend(inst(OP_MEMBER_DECORATE, &[ws, 0, DEC_OFFSET, 0]));
	let mut k = 0;
	let mut last_dec = None;
	while k < body.len() {
		let n = (body[k] >> 16) as usize;
		if matches!(body[k] & 0xffff, OP_DECORATE | OP_MEMBER_DECORATE) {
			last_dec = Some(k + n);
		}
		if body[k] & 0xffff == OP_FUNCTION {
			break;
		}
		k += n.max(1);
	}
	let at = last_dec.unwrap_or(at);
	body.splice(at..at, dec);
	let _ = SC_UNIFORM;
	let mut out = words[..5].to_vec();
	out.extend(body);
	out[3] = new_id();
	Ok(out)
}
