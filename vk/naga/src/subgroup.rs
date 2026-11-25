// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//
// Subgroup builtins without subgroup operations, lowered to the local
// invocation index (a SPIR-V pass run before naga). The ICD reports a
// subgroup size S that the host agreed on in the hello (vk/PROTOCOL.md,
// Amendments, "Subgroup size") and offers no subgroup operation
// (supportedStages 0), yet apps size workgroups by S and some shaders read
// the builtins anyway: llama.cpp's gated_delta_net (shmem variant) indexes
// shared memory by gl_SubgroupInvocationID in a workgroup of S
// invocations, its ssm_scan derives the invocation from gl_SubgroupID and
// gl_SubgroupInvocationID. WebGPU's own subgroups need the `subgroups`
// feature (Firefox, older Safari lack it) and their width is the
// adapter's (SwiftShader 4, Intel 8 to 32, AMD 32 or 64), not S. In a
// compute module that uses no subgroup operation, the builtins become
// what a device whose subgroups are exactly S wide, filled in local index
// order, gives:
//
//   gl_SubgroupSize          -> S
//   gl_SubgroupInvocationID  -> gl_LocalInvocationIndex % S
//   gl_SubgroupID            -> gl_LocalInvocationIndex / S
//   gl_NumSubgroups          -> ceil(local size X * Y * Z / S)
//
// (a last subgroup may be partial, as Vulkan allows). Without subgroup
// operations, barriers or memory scoped to a subgroup nothing else can
// tell subgroups apart, so these values are a conformant implementation of
// what the module asks. Each OpLoad of such a builtin variable becomes the
// arithmetic, the variable goes (declaration, decorations, names, entry
// point interfaces) and gl_LocalInvocationIndex is declared where the
// module lacks it. The later passes see only the local index: a split
// workgroup derives it from the global id and the original size
// (fit_workgroup), virtual invocations give each its own (virt.rs).
//
// Left alone (the module keeps the real WebGPU subgroups, as before):
// any subgroup operation, group operation or subgroup-scoped barrier, the
// capabilities for them, the mask builtins (gl_SubgroupEqMask, ...), a
// non-compute entry point, a builtin used other than by OpLoad or not a
// 32-bit unsigned integer, gl_NumSubgroups without a known local size.

use std::collections::{HashMap, HashSet};

const SUBGROUP_SIZE: u32 = 36;
const NUM_SUBGROUPS: u32 = 38;
const SUBGROUP_ID: u32 = 40;
const SUBGROUP_LOCAL_INVOCATION_ID: u32 = 41;
const LOCAL_INVOCATION_INDEX: u32 = 29;

fn inst(out: &mut Vec<u32>, op: u32, a: &[u32]) {
	out.push(((a.len() as u32 + 1) << 16) | op);
	out.extend_from_slice(a);
}

// Operand words of an instruction inside a function that may be ids
// (literals skipped where the opcode has them, so that a literal equal to
// a builtin's id does not count as a use; everything else counts).
fn id_words(op: u32, a: &[u32]) -> &[u32] {
	let upto = |n: usize| &a[..n.min(a.len())];
	match op {
		8 => upto(1),            // OpLine: file string
		12 => upto(3),           // OpExtInst: type, result, set (then the instruction number, ids)
		79 | 82 => upto(4),      // OpVectorShuffle, OpCompositeInsert
		81 => upto(3),           // OpCompositeExtract
		246 => upto(2),          // OpLoopMerge
		247 => upto(1),          // OpSelectionMerge
		249 => upto(3),          // OpBranchConditional (branch weights)
		251 => upto(2),          // OpSwitch (literal, label pairs)
		61 => upto(3),           // OpLoad (memory operands)
		62 => upto(2),           // OpStore (memory operands)
		_ => a,
	}
}

pub fn lower_subgroup_builtins(words: Vec<u32>, size: u32) -> Vec<u32> {
	if size == 0 {
		return words;
	}
	// --- scan ---
	let mut caps: HashSet<u32> = HashSet::new();
	let mut builtin: HashMap<u32, u32> = HashMap::new();
	let mut ints: HashMap<u32, (u32, u32)> = HashMap::new(); // type -> (width, signedness)
	let mut ptrs: HashMap<u32, (u32, u32)> = HashMap::new(); // pointer type -> (storage class, pointee)
	let mut vars: HashMap<u32, u32> = HashMap::new(); // global variable -> pointer type
	let mut consts: HashMap<u32, u32> = HashMap::new();
	let mut scopes: Vec<u32> = Vec::new();
	let mut models: Vec<u32> = Vec::new();
	let mut local_size: Vec<[u32; 3]> = Vec::new();
	let mut bad = false;
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let op = words[i] & 0xffff;
		let a = &words[i + 1..i + n];
		match op {
			17 if !a.is_empty() => {
				caps.insert(a[0]);
			}
			15 if !a.is_empty() => models.push(a[0]),
			16 if a.len() == 5 && a[1] == 17 => local_size.push([a[2], a[3], a[4]]),
			71 if a.len() >= 3 && a[1] == 11 => {
				builtin.insert(a[0], a[2]);
			}
			// a subgroup builtin as a block member (not GLSL's): left alone
			72 if a.len() >= 4 && a[2] == 11 && matches!(a[3], SUBGROUP_SIZE | NUM_SUBGROUPS | SUBGROUP_ID | SUBGROUP_LOCAL_INVOCATION_ID | 4416..=4420) => bad = true,
			21 if a.len() >= 3 => {
				ints.insert(a[0], (a[1], a[2]));
			}
			32 if a.len() >= 3 => {
				ptrs.insert(a[0], (a[1], a[2]));
			}
			59 if a.len() >= 3 && a[2] != 7 => {
				vars.insert(a[1], a[0]);
			}
			43 if a.len() == 3 => {
				consts.insert(a[1], a[2]);
			}
			// OpControlBarrier (execution and memory scope), OpMemoryBarrier (memory scope)
			224 if a.len() >= 2 => scopes.extend_from_slice(&a[..2]),
			225 if !a.is_empty() => scopes.push(a[0]),
			// group and subgroup operations: OpGroup* (Groups), OpGroupNonUniform*,
			// the KHR/AMD/INTEL subgroup instructions
			259..=271 | 333..=366 | 4421..=4432 | 5000..=5007 | 5571..=5582 | 6142 => bad = true,
			_ => {}
		}
		i += n;
	}
	// Groups, GroupNonUniform{Vote,Arithmetic,Ballot,Shuffle,ShuffleRelative,Clustered,Quad},
	// SubgroupBallotKHR, SubgroupVoteKHR, GroupNonUniformPartitionedNV, the INTEL subgroup
	// capabilities, GroupNonUniformRotateKHR
	if bad || caps.iter().any(|c| matches!(c, 18 | 62..=68 | 4423 | 4431 | 5297 | 5568..=5570 | 5579 | 6026)) {
		return words;
	}
	if models.is_empty() || models.iter().any(|&m| m != 5) || builtin.values().any(|b| (4416..=4420).contains(b)) {
		return words;
	}
	// a subgroup scope (3), or a scope that is not a plain constant
	if scopes.iter().any(|s| consts.get(s).is_none_or(|&v| v == 3)) {
		return words;
	}
	let uint_of = |var: u32| -> Option<u32> {
		let &(sc, ty) = ptrs.get(vars.get(&var)?)?;
		(sc == 1 && *ints.get(&ty)? == (32, 0)).then_some(ty)
	};
	// the builtin input variables to lower, with their integer type
	let mut cands: HashMap<u32, (u32, u32)> = HashMap::new(); // var -> (builtin, int type)
	for (&id, &b) in &builtin {
		if matches!(b, SUBGROUP_SIZE | NUM_SUBGROUPS | SUBGROUP_ID | SUBGROUP_LOCAL_INVOCATION_ID) {
			match uint_of(id) {
				Some(t) => {
					cands.insert(id, (b, t));
				}
				None => return words,
			}
		}
	}
	if cands.is_empty() {
		return words;
	}
	let ty = cands.values().next().unwrap().1;
	if cands.values().any(|c| c.1 != ty) {
		return words;
	}
	let need_count = cands.values().any(|c| c.0 == NUM_SUBGROUPS);
	let need_index = cands.values().any(|c| matches!(c.0, SUBGROUP_ID | SUBGROUP_LOCAL_INVOCATION_ID));
	let count = if need_count {
		match local_size.first() {
			Some(&[x, y, z]) if local_size.iter().all(|s| *s == [x, y, z]) => x.saturating_mul(y).saturating_mul(z).div_ceil(size),
			_ => return words,
		}
	} else {
		0
	};
	// every use is an OpLoad (decorations, names and interfaces aside)
	let mut i = 5;
	let mut in_fn = false;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let op = words[i] & 0xffff;
		let a = &words[i + 1..i + n];
		if op == 54 {
			in_fn = true;
		}
		let ids: &[u32] = match op {
			61 if in_fn && a.len() >= 3 && cands.contains_key(&a[2]) => &a[..2],
			_ if in_fn => id_words(op, a),
			// group decorations and decorations with id operands
			74 | 75 | 332 | 5632 | 5633 => a,
			_ => &[],
		};
		if ids.iter().any(|x| cands.contains_key(x)) {
			return words;
		}
		i += n;
	}
	// gl_LocalInvocationIndex: the module's, or a new one
	let lidx_old = builtin.iter().find(|&(&id, &b)| b == LOCAL_INVOCATION_INDEX && uint_of(id) == Some(ty)).map(|(&id, _)| id);
	if need_index && lidx_old.is_none() && builtin.values().any(|&b| b == LOCAL_INVOCATION_INDEX) {
		return words; // declared with another type
	}
	let mut bound = words[3];
	let mut fresh = || {
		bound += 1;
		bound - 1
	};
	let input_ptr = ptrs.iter().find(|&(_, &(sc, p))| sc == 1 && p == ty).map(|(&id, _)| id);
	let (lidx, new_lidx, new_ptr) = match (need_index, lidx_old) {
		(false, _) => (0, false, None),
		(true, Some(v)) => (v, false, None),
		(true, None) => {
			let p = match input_ptr {
				Some(p) => (p, false),
				None => (fresh(), true),
			};
			(fresh(), true, Some(p))
		}
	};
	let c_size = fresh();
	let c_count = if need_count { fresh() } else { 0 };

	// --- rewrite ---
	let mut out: Vec<u32> = Vec::with_capacity(words.len() + 32);
	out.extend_from_slice(&words[..5]);
	let mut decorated = !new_lidx;
	let mut declared = false;
	let mut i = 5;
	while i < words.len() {
		let n = (words[i] >> 16) as usize;
		let op = words[i] & 0xffff;
		let a = &words[i + 1..i + n];
		match op {
			// OpEntryPoint model id "name" interface...: the builtins out, the local index in
			15 if a.len() >= 2 => {
				let mut k = 2;
				while k < a.len() {
					let w = a[k];
					k += 1;
					if w.to_le_bytes().contains(&0) {
						break;
					}
				}
				let mut ops: Vec<u32> = a[..k].to_vec();
				ops.extend(a[k..].iter().copied().filter(|x| !cands.contains_key(x)));
				if new_lidx {
					ops.push(lidx);
				}
				inst(&mut out, 15, &ops);
			}
			// OpName, OpMemberName, OpDecorate, OpMemberDecorate of a builtin variable
			5 | 6 | 71 | 72 if !a.is_empty() && cands.contains_key(&a[0]) => {
				if !decorated && op == 71 {
					inst(&mut out, 71, &[lidx, 11, LOCAL_INVOCATION_INDEX]);
					decorated = true;
				}
			}
			59 if a.len() >= 2 && cands.contains_key(&a[1]) => {}
			54 if !declared => {
				declared = true;
				if let Some((p, true)) = new_ptr {
					inst(&mut out, 32, &[p, 1, ty]);
				}
				if let Some((p, _)) = new_ptr {
					inst(&mut out, 59, &[p, lidx, 1]);
				}
				inst(&mut out, 43, &[ty, c_size, size]);
				if need_count {
					inst(&mut out, 43, &[ty, c_count, count]);
				}
				out.extend_from_slice(&words[i..i + n]);
			}
			61 if a.len() >= 3 && cands.contains_key(&a[2]) => {
				let (b, _) = cands[&a[2]];
				let (rt, r) = (a[0], a[1]);
				match b {
					SUBGROUP_SIZE => inst(&mut out, 83, &[rt, r, c_size]),
					NUM_SUBGROUPS => inst(&mut out, 83, &[rt, r, c_count]),
					_ => {
						let t = fresh();
						inst(&mut out, 61, &[rt, t, lidx]);
						// OpUMod, OpUDiv
						inst(&mut out, if b == SUBGROUP_LOCAL_INVOCATION_ID { 137 } else { 134 }, &[rt, r, t, c_size]);
					}
				}
			}
			_ => out.extend_from_slice(&words[i..i + n]),
		}
		i += n;
	}
	if !decorated || !declared {
		return words;
	}
	out[3] = bound;
	out
}
