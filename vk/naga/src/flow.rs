// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//
// Loop continues that make a later barrier non-uniform for WGSL. llama.cpp's
// mul_mat_vec_q2_k/q3_k/q6_k (calc_superblock with all_threads false) do,
// in a loop whose own condition is uniform:
//
//   loop { ...; workgroupBarrier(); if (i >= n) { continue; } REST; }
//
// where i depends on the invocation. Vulkan only needs every invocation of
// the workgroup to reach the barrier, which they do; WGSL's uniformity
// analysis treats everything after a non-uniform continue as non-uniform,
// the next iteration's barrier included, and Tint refuses the shader. In
// loops that may execute a control barrier (directly, in a nested
// statement or through a call), two exact rewrites:
//
//   if (c) { A; continue; } REST  ->  if (c) { A; continue; } else { REST }
//
// (A ends in a continue, so REST ran only when c was false; the mirror
// image too, with the continue in the else branch), and a continue in tail
// position of the loop body (nothing of the body runs after it: the jump is
// the fall-through into the continuing block) is dropped. The loop above
// becomes
//
//   loop { ...; workgroupBarrier(); if (i >= n) { } else { REST } }
//
// whose if falls through on both sides, so WGSL takes the code after it,
// and the next iteration, as uniform again. No statement is added,
// reordered or evaluated differently; only the continues that are
// fall-throughs go, so the WGSL computes what the SPIR-V does. Continues
// inside a switch, or under an if that more statements of the body follow,
// stay (the shader is then refused as before). The caller keeps the
// unchanged module when the result does not validate (an expression the
// continuing block uses moved into a branch).

use naga::{Block, Function, Handle, Module, Statement};

// Functions that may execute a control barrier (a handful at most).
type Set = Vec<Handle<Function>>;

pub fn uniform_loop_continues(module: &mut Module) -> bool {
	// Functions that may execute a control barrier, transitively.
	let mut bar: Set = Vec::new();
	loop {
		let add: Vec<Handle<Function>> = module.functions.iter().filter(|(h, f)| !bar.contains(h) && has_barrier(&f.body, &bar)).map(|(h, _)| h).collect();
		if add.is_empty() {
			break;
		}
		bar.extend(add);
	}
	let mut changed = false;
	for (_, f) in module.functions.iter_mut() {
		changed |= walk(&mut f.body, &bar);
	}
	for ep in module.entry_points.iter_mut() {
		changed |= walk(&mut ep.function.body, &bar);
	}
	changed
}

// Whether the block may execute a control barrier (or a
// workgroupUniformLoad, which WGSL also wants in uniform control flow).
fn has_barrier(b: &Block, bar: &Set) -> bool {
	b.iter().any(|s| match s {
		Statement::ControlBarrier(_) | Statement::WorkGroupUniformLoad { .. } => true,
		Statement::Call { function, .. } => bar.contains(function),
		Statement::Block(x) => has_barrier(x, bar),
		Statement::If { accept, reject, .. } => has_barrier(accept, bar) || has_barrier(reject, bar),
		Statement::Switch { cases, .. } => cases.iter().any(|c| has_barrier(&c.body, bar)),
		Statement::Loop { body, continuing, .. } => has_barrier(body, bar) || has_barrier(continuing, bar),
		_ => false,
	})
}

// Every loop in the block, nested ones included.
fn walk(b: &mut Block, bar: &Set) -> bool {
	let mut changed = false;
	for s in b.iter_mut() {
		match s {
			Statement::Loop { body, continuing, .. } => {
				if has_barrier(body, bar) || has_barrier(continuing, bar) {
					changed |= restructure(body, true);
				}
				changed |= walk(body, bar);
				changed |= walk(continuing, bar);
			}
			Statement::Block(x) => changed |= walk(x, bar),
			Statement::If { accept, reject, .. } => {
				changed |= walk(accept, bar);
				changed |= walk(reject, bar);
			}
			Statement::Switch { cases, .. } => {
				for c in cases.iter_mut() {
					changed |= walk(&mut c.body, bar);
				}
			}
			_ => {}
		}
	}
	changed
}

fn ends_in_continue(b: &Block) -> bool {
	matches!(b.last(), Some(Statement::Continue))
}

// A block whose last statement jumps: what follows it is unreachable.
fn ends_in_jump(b: &Block) -> bool {
	matches!(b.last(), Some(Statement::Continue | Statement::Break | Statement::Return { .. } | Statement::Kill))
}

fn split_off(b: &mut Block, at: usize) -> Block {
	let mut head = Block::new();
	let mut tail = Block::new();
	for (i, (s, sp)) in std::mem::take(b).span_into_iter().enumerate() {
		if i < at {
			head.push(s, sp);
		} else {
			tail.push(s, sp);
		}
	}
	*b = head;
	tail
}

// A block of the loop body outside nested loops and switches (a continue
// there belongs to this loop); `tail`: nothing of the body runs after it.
fn restructure(b: &mut Block, tail: bool) -> bool {
	let mut changed = false;
	let mut i = 0;
	while i + 1 < b.len() {
		let target = match &b[i] {
			Statement::If { accept, reject, .. } if ends_in_continue(accept) && !ends_in_jump(reject) => Some(false),
			Statement::If { accept, reject, .. } if ends_in_continue(reject) && !ends_in_jump(accept) => Some(true),
			_ => None,
		};
		if let Some(into_accept) = target {
			let rest = split_off(b, i + 1);
			if let Statement::If { accept, reject, .. } = &mut b[i] {
				if into_accept { accept } else { reject }.extend_block(rest);
			}
			changed = true;
			break;
		}
		i += 1;
	}
	let n = b.len();
	for (j, s) in b.iter_mut().enumerate() {
		let t = tail && j + 1 == n;
		match s {
			Statement::If { accept, reject, .. } => {
				changed |= restructure(accept, t);
				changed |= restructure(reject, t);
			}
			Statement::Block(x) => changed |= restructure(x, t),
			_ => {}
		}
	}
	if tail && ends_in_continue(b) {
		b.cull(b.len() - 1..);
		changed = true;
	}
	changed
}
