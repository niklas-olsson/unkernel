// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//
// Uniform compute builtins read through private copies. spv-in copies each
// builtin input (gl_NumWorkGroups, gl_WorkGroupID, ...) into a module-scope
// private variable at the entry point, and helper functions read that
// variable. WGSL's uniformity analysis treats every load of a private
// variable as non-uniform, so in SPIR-V that spirv-opt did not inline
// (llama.cpp's generator skips -O for names with bf16, rope or dot2) a
// barrier inside
//
//   for (samp = gl_WorkGroupID.z; samp < n; samp += gl_NumWorkGroups.z)
//
// in a helper (rms_norm.comp's rms_norm()) is refused by Tint, although
// both builtins are uniform across the workgroup. For the builtins WGSL
// takes as uniform (num_workgroups, workgroup_id), when the private copy
// is provably the builtin everywhere it is read:
//
//   - the entry point stores the builtin argument into it among its first
//     statements (only stores of arguments and loads-free emits before),
//   - nothing else ever stores to it, through any access chain, and no
//     pointer to it is passed to a call or used otherwise,
//
// each function that reads it, and every function that calls one of
// those, gets the builtin as one more by-value argument (the entry point
// passes its own builtin argument, the others their new argument), copied
// into a function-local variable that replaces the private one in that
// function's expressions (Tint tracks function variables by flow, and a
// parameter by its call sites). Loads read the same value as before; no
// other statement changes. Anything else is left alone, and the caller
// keeps the unchanged module when the result does not validate.

use naga::{Block, BuiltIn, Binding, Expression, Function, GlobalVariable, Handle, Module, Statement};

pub fn uniform_builtins(module: &mut Module) -> bool {
	if module.entry_points.len() != 1 {
		return false;
	}
	let mut changed = false;
	for (g, arg) in candidates(module) {
		if only_the_entry_store(module, g) {
			changed |= thread(module, g, arg);
		}
	}
	changed
}

// (private variable, entry argument index) pairs the entry point's leading
// statements set from num_workgroups or workgroup_id.
fn candidates(module: &Module) -> Vec<(Handle<GlobalVariable>, u32)> {
	let f = &module.entry_points[0].function;
	let mut out = Vec::new();
	for s in f.body.iter() {
		match s {
			Statement::Store { pointer, value } => {
				let Expression::FunctionArgument(i) = f.expressions[*value] else { break };
				match f.expressions[*pointer] {
					Expression::GlobalVariable(g) => {
						let a = &f.arguments[i as usize];
						let gv = &module.global_variables[g];
						let uniform = matches!(a.binding, Some(Binding::BuiltIn(BuiltIn::NumWorkGroups | BuiltIn::WorkGroupId)));
						if uniform && gv.space == naga::AddressSpace::Private && gv.init.is_none() && gv.ty == a.ty && !out.iter().any(|c: &(Handle<GlobalVariable>, u32)| c.0 == g) {
							out.push((g, i));
						}
					}
					Expression::LocalVariable(_) => {}
					_ => break,
				}
			}
			Statement::Emit(r) if r.clone().all(|h| !matches!(f.expressions[h], Expression::Load { .. })) => {}
			_ => break,
		}
	}
	out
}

// Every statement of a block, nested ones included.
fn visit(b: &Block, f: &mut impl FnMut(&Statement)) {
	for s in b.iter() {
		f(s);
		match s {
			Statement::Block(x) => visit(x, f),
			Statement::If { accept, reject, .. } => {
				visit(accept, f);
				visit(reject, f);
			}
			Statement::Switch { cases, .. } => {
				for c in cases {
					visit(&c.body, f);
				}
			}
			Statement::Loop { body, continuing, .. } => {
				visit(body, f);
				visit(continuing, f);
			}
			_ => {}
		}
	}
}

// Pointers into g in a function: g itself and access chains on it (an
// operand always precedes its user in the arena).
fn pointers(f: &Function, g: Handle<GlobalVariable>) -> Vec<bool> {
	let mut p = vec![false; f.expressions.len()];
	for (h, e) in f.expressions.iter() {
		p[h.index()] = match *e {
			Expression::GlobalVariable(x) => x == g,
			Expression::Access { base, .. } | Expression::AccessIndex { base, .. } => p[base.index()],
			_ => false,
		};
	}
	p
}

// Whether g is stored exactly once (the entry point's store, found by
// candidates()) and its pointers are otherwise only loaded or indexed.
fn only_the_entry_store(module: &Module, g: Handle<GlobalVariable>) -> bool {
	let mut stores = 0;
	let mut ok = true;
	let fns = module.functions.iter().map(|(_, f)| f).chain(std::iter::once(&module.entry_points[0].function));
	for f in fns {
		let p = pointers(f, g);
		let isp = |h: &Handle<Expression>| p[h.index()];
		// (a vector or scalar builtin: loads and access chains are its
		// only expression users; ArrayLength is the other pointer operand)
		for (_, e) in f.expressions.iter() {
			if let Expression::ArrayLength(x) = e {
				ok &= !isp(x);
			}
		}
		visit(&f.body, &mut |s| match s {
			Statement::Store { pointer, .. } if isp(pointer) => stores += 1,
			Statement::Atomic { pointer, .. } | Statement::WorkGroupUniformLoad { pointer, .. } if isp(pointer) => ok = false,
			Statement::Call { arguments, .. } if arguments.iter().any(isp) => ok = false,
			_ => {}
		});
	}
	ok && stores == 1
}

// Pass g's builtin down as an argument to every function that reads g
// (and to their callers, up to the entry point).
fn thread(module: &mut Module, g: Handle<GlobalVariable>, arg: u32) -> bool {
	let reads = |f: &Function| f.expressions.iter().any(|(_, e)| matches!(*e, Expression::GlobalVariable(x) if x == g));
	let mut set: Vec<Handle<Function>> = module.functions.iter().filter(|(_, f)| reads(f)).map(|(h, _)| h).collect();
	loop {
		let add: Vec<Handle<Function>> = module
			.functions
			.iter()
			.filter(|(h, f)| !set.contains(h) && calls_any(&f.body, &set))
			.map(|(h, _)| h)
			.collect();
		if add.is_empty() {
			break;
		}
		set.extend(add);
	}
	if set.is_empty() {
		return false;
	}
	let ty = module.global_variables[g].ty;
	let name = module.global_variables[g].name.clone();
	// the new argument's index in each function of the set
	let mut idx: Vec<(Handle<Function>, u32)> = Vec::new();
	for &fh in &set {
		let f = &mut module.functions[fh];
		let a = f.arguments.len() as u32;
		f.arguments.push(naga::FunctionArgument { name: name.as_ref().map(|n| format!("{}_arg", n)), ty, binding: None });
		let l = f.local_variables.append(naga::LocalVariable { name: name.clone(), ty, init: None }, naga::Span::UNDEFINED);
		for (_, e) in f.expressions.iter_mut() {
			if matches!(*e, Expression::GlobalVariable(x) if x == g) {
				*e = Expression::LocalVariable(l);
			}
		}
		let av = f.expressions.append(Expression::FunctionArgument(a), naga::Span::UNDEFINED);
		let lp = f.expressions.append(Expression::LocalVariable(l), naga::Span::UNDEFINED);
		let mut b = Block::from_vec(vec![Statement::Store { pointer: lp, value: av }]);
		b.extend_block(std::mem::take(&mut f.body));
		f.body = b;
		idx.push((fh, a));
	}
	// Call sites: the entry point passes its builtin argument, a function of
	// the set its new argument.
	for &(fh, a) in &idx {
		let f = &mut module.functions[fh];
		let v = f.expressions.append(Expression::FunctionArgument(a), naga::Span::UNDEFINED);
		add_argument(&mut f.body, &set, v);
	}
	let f = &mut module.entry_points[0].function;
	let v = f.expressions.append(Expression::FunctionArgument(arg), naga::Span::UNDEFINED);
	add_argument(&mut f.body, &set, v);
	true
}

fn calls_any(b: &Block, set: &[Handle<Function>]) -> bool {
	let mut hit = false;
	visit(b, &mut |s| {
		if let Statement::Call { function, .. } = s {
			hit |= set.contains(function);
		}
	});
	hit
}

fn add_argument(b: &mut Block, set: &[Handle<Function>], v: Handle<Expression>) {
	for s in b.iter_mut() {
		match s {
			Statement::Call { function, arguments, .. } if set.contains(function) => arguments.push(v),
			Statement::Block(x) => add_argument(x, set, v),
			Statement::If { accept, reject, .. } => {
				add_argument(accept, set, v);
				add_argument(reject, set, v);
			}
			Statement::Switch { cases, .. } => {
				for c in cases.iter_mut() {
					add_argument(&mut c.body, set, v);
				}
			}
			Statement::Loop { body, continuing, .. } => {
				add_argument(body, set, v);
				add_argument(continuing, set, v);
			}
			_ => {}
		}
	}
}
