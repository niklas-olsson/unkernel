// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//
// Workgroups wider than the device allows, with barriers or workgroup
// memory: each invocation runs K virtual invocations. llama.cpp's norm
// family (norm, rms_norm*_512, group_norm, l2_norm, soft_max_wg512, ...)
// reduces across 512 invocations through shared memory; SwiftShader and
// many mobile adapters allow 256. Splitting such a workgroup into smaller
// ones (fit_workgroup) would split its shared memory, so instead the
// workgroup keeps its shared memory and its count, with size X / K, and
// invocation i plays the virtual invocations i + v * (X / K), v < K, the
// way CPU implementations of OpenCL run work-groups ("work-item loops"):
//
//   - Statements that contain no barrier, in maximal runs, become a loop
//     over v ("region") in which each virtual invocation has its own
//     local_invocation_id (and index, global id), function variables
//     (every one becomes array<T, K>), private variables (saved and
//     restored around each v) and values: an expression computed in one
//     region and used in another is kept per v in array<T, K> (a pointer
//     is computed again from its parts).
//   - Barriers stay outside regions, run once by every real invocation,
//     so all K * (X / K) virtual invocations reach each barrier before any
//     goes past it, as in the original workgroup. An if, switch or loop
//     that contains a barrier stays too, with its condition taken from
//     the first virtual invocation that has not returned. That is exact
//     only when every invocation computes the same condition, which the
//     pass checks itself, conservatively (Uniformity below: constants,
//     workgroup ids and counts, uniform and read-only buffers, variables
//     only ever set from those under such control); it does not rest on
//     Vulkan's rule (control flow around a barrier must be dynamically
//     uniform: a barrier no invocation reaches may sit anywhere) nor on
//     the browser's analysis (Firefox's naga does not check barriers).
//   - A break or continue out of a region (to such a loop or switch) is
//     taken after the region when any virtual invocation took it. When the
//     check cannot show that all take it together, that is exact only if
//     nothing of its construct follows the region: a switch's break or a
//     loop's continue from the construct's tail (the early exit after the
//     last barrier that spv-in writes as a break out of `switch { default:
//     ... }`); else the pass refuses. A return marks its virtual invocation
//     finished: later regions skip it, and the real invocation returns
//     once all of its virtual ones have.
//
// Within a region the virtual invocations run one after another instead
// of side by side; with no barrier between them, a program without data
// races (Vulkan's requirement on workgroup memory between barriers)
// cannot tell. Every value is computed as the original computes it (the
// same reduction order over the same shared array), so results are those
// of a device with the full workgroup. Refused (the module is left alone,
// and the host refuses the pipeline as before): subgroup operations,
// workgroupUniformLoad, barriers in functions other than the entry point,
// splits other than of X by a power of two up to 8, constructs this pass
// does not know; the caller also keeps the unchanged module when the
// result does not validate.

use naga::{
	AddressSpace, ArraySize, Barrier, Block, BuiltIn, Binding, Expression, Function, Handle, Literal, LocalVariable, Module, Scalar, Span, Statement,
	Type, TypeInner, VectorSize,
};
use std::collections::{HashMap, HashSet};

type H = Handle<Expression>;

const SWITCH: u8 = 0;
const LOOP: u8 = 1;
const CONTINUING: u8 = 2;

// Operands of an expression with f applied (None: a kind this pass does
// not handle, or f refused one).
fn map_expr(e: &Expression, f: &mut dyn FnMut(H) -> Option<H>) -> Option<Expression> {
	use naga::{ImageQuery as Q, SampleLevel as L};
	let o = |h: &Option<H>, f: &mut dyn FnMut(H) -> Option<H>| -> Option<Option<H>> {
		match h {
			Some(x) => f(*x).map(Some),
			None => Some(None),
		}
	};
	Some(match e {
		Expression::Literal(_) | Expression::Constant(_) | Expression::Override(_) | Expression::ZeroValue(_) | Expression::FunctionArgument(_) | Expression::GlobalVariable(_) | Expression::LocalVariable(_) | Expression::CallResult(_) | Expression::AtomicResult { .. } => e.clone(),
		Expression::Compose { ty, components } => {
			let mut c = Vec::with_capacity(components.len());
			for x in components {
				c.push(f(*x)?);
			}
			Expression::Compose { ty: *ty, components: c }
		}
		Expression::Access { base, index } => Expression::Access { base: f(*base)?, index: f(*index)? },
		Expression::AccessIndex { base, index } => Expression::AccessIndex { base: f(*base)?, index: *index },
		Expression::Splat { size, value } => Expression::Splat { size: *size, value: f(*value)? },
		Expression::Swizzle { size, vector, pattern } => Expression::Swizzle { size: *size, vector: f(*vector)?, pattern: *pattern },
		Expression::Load { pointer } => Expression::Load { pointer: f(*pointer)? },
		Expression::ImageSample { image, sampler, gather, coordinate, array_index, offset, level, depth_ref, clamp_to_edge } => Expression::ImageSample {
			image: f(*image)?,
			sampler: f(*sampler)?,
			gather: *gather,
			coordinate: f(*coordinate)?,
			array_index: o(array_index, f)?,
			offset: o(offset, f)?,
			level: match level {
				L::Auto => L::Auto,
				L::Zero => L::Zero,
				L::Exact(x) => L::Exact(f(*x)?),
				L::Bias(x) => L::Bias(f(*x)?),
				L::Gradient { x, y } => L::Gradient { x: f(*x)?, y: f(*y)? },
			},
			depth_ref: o(depth_ref, f)?,
			clamp_to_edge: *clamp_to_edge,
		},
		Expression::ImageLoad { image, coordinate, array_index, sample, level } => {
			Expression::ImageLoad { image: f(*image)?, coordinate: f(*coordinate)?, array_index: o(array_index, f)?, sample: o(sample, f)?, level: o(level, f)? }
		}
		Expression::ImageQuery { image, query } => Expression::ImageQuery {
			image: f(*image)?,
			query: match query {
				Q::Size { level } => Q::Size { level: o(level, f)? },
				q => q.clone(),
			},
		},
		Expression::Unary { op, expr } => Expression::Unary { op: *op, expr: f(*expr)? },
		Expression::Binary { op, left, right } => Expression::Binary { op: *op, left: f(*left)?, right: f(*right)? },
		Expression::Select { condition, accept, reject } => Expression::Select { condition: f(*condition)?, accept: f(*accept)?, reject: f(*reject)? },
		Expression::Relational { fun, argument } => Expression::Relational { fun: *fun, argument: f(*argument)? },
		Expression::Math { fun, arg, arg1, arg2, arg3 } => Expression::Math { fun: *fun, arg: f(*arg)?, arg1: o(arg1, f)?, arg2: o(arg2, f)?, arg3: o(arg3, f)? },
		Expression::As { expr, kind, convert } => Expression::As { expr: f(*expr)?, kind: *kind, convert: *convert },
		Expression::ArrayLength(x) => Expression::ArrayLength(f(*x)?),
		_ => return None,
	})
}

fn expr_operands(e: &Expression) -> Option<Vec<H>> {
	let mut v = Vec::new();
	map_expr(e, &mut |h| {
		v.push(h);
		Some(h)
	})?;
	Some(v)
}

// The expression operands a statement reads directly (results it defines
// and nested blocks excluded); None: a statement this pass does not handle.
fn stmt_operands(s: &Statement) -> Option<Vec<H>> {
	Some(match s {
		Statement::Emit(_) | Statement::Block(_) | Statement::Break | Statement::Continue | Statement::Return { value: None } | Statement::ControlBarrier(_) | Statement::MemoryBarrier(_) => vec![],
		Statement::Return { value: Some(v) } => vec![*v],
		Statement::If { condition, .. } => vec![*condition],
		Statement::Switch { selector, .. } => vec![*selector],
		Statement::Loop { break_if, .. } => break_if.iter().copied().collect(),
		Statement::Store { pointer, value } => vec![*pointer, *value],
		Statement::ImageStore { image, coordinate, array_index, value } => {
			let mut v = vec![*image, *coordinate, *value];
			v.extend(array_index.iter().copied());
			v
		}
		Statement::Atomic { pointer, fun, value, .. } => {
			let mut v = vec![*pointer, *value];
			if let naga::AtomicFunction::Exchange { compare: Some(c) } = fun {
				v.push(*c);
			}
			v
		}
		Statement::Call { arguments, .. } => arguments.clone(),
		_ => return None,
	})
}

fn is_barrier(s: &Statement) -> bool {
	matches!(s, Statement::ControlBarrier(_) | Statement::MemoryBarrier(_))
}

fn has_barrier(b: &Block) -> bool {
	b.iter().any(stmt_has_barrier)
}

fn stmt_has_barrier(s: &Statement) -> bool {
	match s {
		_ if is_barrier(s) => true,
		Statement::Block(x) => has_barrier(x),
		Statement::If { accept, reject, .. } => has_barrier(accept) || has_barrier(reject),
		Statement::Switch { cases, .. } => cases.iter().any(|c| has_barrier(&c.body)),
		Statement::Loop { body, continuing, .. } => has_barrier(body) || has_barrier(continuing),
		_ => false,
	}
}

// A run that is only a jump (`else { break; }` of a loop whose condition
// is uniform): copied as it is.
fn bare_jump(run: &[&Statement]) -> bool {
	run.len() == 1 && matches!(run[0], Statement::Break | Statement::Continue | Statement::Return { value: None })
}

// Runs and barrier statements of a block, in order.
enum Part<'a> {
	Run(Vec<&'a Statement>),
	Stmt(&'a Statement),
}

fn parts(b: &Block) -> Vec<Part<'_>> {
	let mut out = Vec::new();
	let mut run: Vec<&Statement> = Vec::new();
	for s in b.iter() {
		if stmt_has_barrier(s) {
			if !run.is_empty() {
				out.push(Part::Run(std::mem::take(&mut run)));
			}
			out.push(Part::Stmt(s));
		} else {
			run.push(s);
		}
	}
	if !run.is_empty() {
		out.push(Part::Run(run));
	}
	out
}

#[derive(Default)]
struct RegionInfo {
	// expressions of other regions (or per-v ones) read here
	uses: Vec<H>,
	jumps_out: bool,
	breaks: bool,
	continues: bool,
	returns: bool,
}

// Where a run sits relative to the barrier-level construct a break or
// continue out of it reaches: a jump only some virtual invocations take is
// kept exact by "taken when any took it" only when nothing of that
// construct follows (a switch's break, a loop's continue, from its tail).
#[derive(Default, Clone, Copy)]
struct Tgt {
	brk_switch: bool,
	brk_tail: bool,
	cnt_tail: bool,
}

struct Analysis {
	nu: HashSet<usize>,
	nu_jump_bad: bool,
	def: HashMap<H, usize>,
	regions: Vec<RegionInfo>,
	// values computed in one region and read elsewhere
	spill: Vec<H>,
	// conditions read outside regions
	level_uses: Vec<H>,
}

struct Ctx<'a> {
	f: &'a Function,
}

impl Analysis {
	fn block(&mut self, c: &Ctx, b: &Block, tgt: Tgt) -> Option<()> {
		let ps = parts(b);
		let n = ps.len();
		for (pi, p) in ps.into_iter().enumerate() {
			let last = pi + 1 == n;
			let inner = Tgt { brk_tail: tgt.brk_tail && last, cnt_tail: tgt.cnt_tail && last, ..tgt };
			match p {
				Part::Run(run) if bare_jump(&run) => {}
				Part::Run(run) => {
					let r = self.regions.len();
					self.regions.push(RegionInfo::default());
					let mut used = Vec::new();
					for s in &run {
						self.run_stmt(c, s, r, &mut used, 0, 0, inner)?;
					}
					self.regions[r].uses = used;
				}
				Part::Stmt(s) => match s {
					_ if is_barrier(s) => {
						if let Statement::ControlBarrier(x) | Statement::MemoryBarrier(x) = s {
							if x.contains(Barrier::SUB_GROUP) {
								return None;
							}
						}
					}
					Statement::Block(x) => self.block(c, x, inner)?,
					Statement::If { condition, accept, reject } => {
						self.level_uses.push(*condition);
						self.block(c, accept, inner)?;
						self.block(c, reject, inner)?;
					}
					Statement::Switch { selector, cases } => {
						self.level_uses.push(*selector);
						for k in cases {
							self.block(c, &k.body, Tgt { brk_switch: true, brk_tail: !k.fall_through, cnt_tail: inner.cnt_tail && !k.fall_through })?;
						}
					}
					Statement::Loop { body, continuing, break_if } => {
						self.block(c, body, Tgt { brk_switch: false, brk_tail: false, cnt_tail: true })?;
						self.block(c, continuing, Tgt::default())?;
						self.level_uses.extend(break_if.iter().copied());
					}
					_ => return None,
				},
			}
		}
		Some(())
	}

	// loops / constructs: enclosing loops and loops-or-switches inside the region
	fn run_stmt(&mut self, c: &Ctx, s: &Statement, r: usize, used: &mut Vec<H>, loops: usize, constructs: usize, tgt: Tgt) -> Option<()> {
		for h in stmt_operands(s)? {
			used.push(h);
		}
		match s {
			Statement::Emit(range) => {
				for h in range.clone() {
					self.def.insert(h, r);
					used.extend(expr_operands(&c.f.expressions[h])?);
				}
			}
			Statement::Call { result: Some(h), .. } | Statement::Atomic { result: Some(h), .. } => {
				self.def.insert(*h, r);
			}
			Statement::Block(x) => {
				for t in x.iter() {
					self.run_stmt(c, t, r, used, loops, constructs, tgt)?;
				}
			}
			Statement::If { accept, reject, .. } => {
				for t in accept.iter().chain(reject.iter()) {
					self.run_stmt(c, t, r, used, loops, constructs, tgt)?;
				}
			}
			Statement::Switch { cases, .. } => {
				for k in cases {
					for t in k.body.iter() {
						self.run_stmt(c, t, r, used, loops, constructs + 1, tgt)?;
					}
				}
			}
			Statement::Loop { body, continuing, .. } => {
				for t in body.iter().chain(continuing.iter()) {
					self.run_stmt(c, t, r, used, loops + 1, constructs + 1, tgt)?;
				}
			}
			Statement::Break if constructs == 0 => {
				if self.nu.contains(&(s as *const Statement as usize)) && !(tgt.brk_switch && tgt.brk_tail) {
					self.nu_jump_bad = true;
				}
				self.regions[r].breaks = true;
				self.regions[r].jumps_out = true;
			}
			Statement::Continue if loops == 0 => {
				if self.nu.contains(&(s as *const Statement as usize)) && !tgt.cnt_tail {
					self.nu_jump_bad = true;
				}
				self.regions[r].continues = true;
				self.regions[r].jumps_out = true;
			}
			Statement::Return { .. } => {
				self.regions[r].returns = true;
				self.regions[r].jumps_out = true;
			}
			_ => {}
		}
		Some(())
	}
}

pub struct Limits {
	pub max: [u32; 4],
}

// What the original entry point reads per virtual invocation.
#[derive(Clone, Copy, PartialEq)]
enum PerV {
	Lid,
	Lidx,
	Gid,
}

pub fn virtualize(module: &mut Module, info: &naga::valid::ModuleInfo, l: &Limits) -> Result<bool, String> {
	if module.entry_points.len() != 1 || module.entry_points[0].stage != naga::ShaderStage::Compute {
		return Ok(false);
	}
	let size = module.entry_points[0].workgroup_size;
	let l = l.max;
	let fits = |s: [u32; 3]| s[0] <= l[0] && s[1] <= l[1] && s[2] <= l[2] && s[0] * s[1] * s[2] <= l[3];
	if fits(size) {
		return Ok(false);
	}
	let mut k = 2;
	while k <= 8 && !(size[0] % k == 0 && fits([size[0] / k, size[1], size[2]])) {
		k *= 2;
	}
	if k > 8 {
		return Err("no power of two up to 8 divides its X size to fit".into());
	}
	let uses_shared = module.global_variables.iter().any(|(_, g)| g.space == AddressSpace::WorkGroup);
	let f = &module.entry_points[0].function;
	if !uses_shared && !has_barrier(&f.body) {
		return Ok(false); // fit_workgroup splits it
	}
	// barriers only in the entry point; nothing this pass does not know
	for (_, hf) in module.functions.iter() {
		if has_barrier(&hf.body) || !known(&hf.body) || hf.expressions.iter().any(|(_, e)| expr_operands(e).is_none()) {
			return Err("a barrier in a function other than the entry point, or an operation this pass does not handle".into());
		}
	}
	// variables initialized with anything but a constant: refused
	if !known(&f.body) || f.local_variables.iter().any(|(_, lv)| lv.init.is_some_and(|i| !f.expressions[i].needs_pre_emit())) {
		return Err("an operation this pass does not handle, or a variable with an initializer".into());
	}
	let mut perv: Vec<(u32, PerV)> = Vec::new();
	for (i, a) in f.arguments.iter().enumerate() {
		match a.binding {
			Some(Binding::BuiltIn(BuiltIn::LocalInvocationId)) => perv.push((i as u32, PerV::Lid)),
			Some(Binding::BuiltIn(BuiltIn::LocalInvocationIndex)) => perv.push((i as u32, PerV::Lidx)),
			Some(Binding::BuiltIn(BuiltIn::GlobalInvocationId)) => perv.push((i as u32, PerV::Gid)),
			Some(Binding::BuiltIn(BuiltIn::WorkGroupId | BuiltIn::NumWorkGroups)) => {}
			_ => return Err(format!("builtin input {:?}", a.binding)),
		}
	}
	let fi = info.get_entry_point(0);
	let ptrs: Vec<bool> = f.expressions.iter().map(|(h, _)| matches!(fi[h].ty.inner_with(&module.types), TypeInner::Pointer { .. } | TypeInner::ValuePointer { .. })).collect();
	let is_ptr = move |h: H| ptrs[h.index()];
	let ctx = Ctx { f };
	// the body without its final return
	let mut body = f.body.clone();
	if matches!(body.last(), Some(Statement::Return { value: None })) {
		body.cull(body.len() - 1..);
	}
	let uargs: Vec<u32> = (0..f.arguments.len() as u32).filter(|i| !perv.iter().any(|p| p.0 == *i)).collect();
	let uni = Uniformity::new(module, f, &body, &uargs);
	let mut an = Analysis { def: HashMap::new(), regions: Vec::new(), spill: Vec::new(), level_uses: Vec::new(), nu: uni.nu.clone(), nu_jump_bad: false };
	if an.block(&ctx, &body, Tgt::default()).is_none() {
		return Err("an operation this pass does not handle".into());
	}
	if an.nu_jump_bad {
		return Err("a break or continue around barriers that may differ between invocations".into());
	}
	// classify foreign uses: values from another region are spilled, pointers recomputed
	let mut spill: HashSet<H> = HashSet::new();
	for (r, ri) in an.regions.iter().enumerate() {
		let mut stack: Vec<H> = ri.uses.clone();
		let mut seen = HashSet::new();
		while let Some(h) = stack.pop() {
			if !seen.insert(h) {
				continue;
			}
			match an.def.get(&h) {
				Some(&d) if d == r => {}
				Some(_) if is_ptr(h) => stack.extend(expr_operands(&f.expressions[h]).unwrap_or_default()),
				Some(_) => {
					spill.insert(h);
				}
				None if f.expressions[h].needs_pre_emit() => {}
				None => return Err("a value used across a barrier it cannot keep".into()),
			}
		}
	}
	for &h in &an.level_uses {
		match an.def.get(&h) {
			Some(_) if !is_ptr(h) => {
				spill.insert(h);
			}
			Some(_) => return Err("a pointer as a condition".into()),
			None => match f.expressions[h] {
				Expression::Literal(_) | Expression::Constant(_) | Expression::ZeroValue(_) => {}
				Expression::FunctionArgument(i) if !perv.iter().any(|p| p.0 == i) => {}
				_ => return Err("a condition around a barrier that depends on the invocation".into()),
			},
		}
	}
	// Taking virtual invocation 0's condition is exact only when every
	// invocation computes the same one: checked here, conservatively, so
	// that it does not rest on the browser's uniformity analysis (Firefox's
	// naga does not check barriers).
	if let Some(&h) = an.level_uses.iter().find(|&&h| !uni.value(h)) {
		return Err(format!("a condition around a barrier that may differ between invocations ([{}])", h.index()));
	}
	an.spill = spill.into_iter().collect();
	an.spill.sort_by_key(|h| h.index());
	let spill_ty: Vec<(H, naga::proc::TypeResolution)> = an.spill.iter().map(|&h| (h, fi[h].ty.clone())).collect();
	let has_returns = an.regions.iter().any(|r| r.returns);
	let privates: Vec<Handle<naga::GlobalVariable>> = module.global_variables.iter().filter(|(_, g)| g.space == AddressSpace::Private).map(|(h, _)| h).collect();

	// --- rebuild -------------------------------------------------------
	let old = module.entry_points[0].function.clone();
	let sx = size[0] / k;
	let u32t = module.types.insert(Type { name: None, inner: TypeInner::Scalar(Scalar::U32) }, Span::UNDEFINED);
	let boolt = module.types.insert(Type { name: None, inner: TypeInner::Scalar(Scalar::BOOL) }, Span::UNDEFINED);
	let v3 = module.types.insert(Type { name: None, inner: TypeInner::Vector { size: VectorSize::Tri, scalar: Scalar::U32 } }, Span::UNDEFINED);
	let mut b = Builder { module, k, ex: naga::Arena::new(), locals: old.local_variables.clone(), glob: HashMap::new(), lits: HashMap::new(), v3, layouter: naga::proc::Layouter::default() };
	// every function variable becomes one per virtual invocation
	let lhs: Vec<Handle<LocalVariable>> = b.locals.iter().map(|(h, _)| h).collect();
	for lh in lhs {
		let ty = b.locals[lh].ty;
		let Some(at) = b.array_of(ty) else { return Err("a type it cannot keep per invocation".into()) };
		b.locals.get_mut(lh).ty = at;
		// initialized per virtual invocation at the start instead (as at its declaration)
		b.locals.get_mut(lh).init = None;
	}
	let mut args = old.arguments.clone();
	let arg_of = |args: &mut Vec<naga::FunctionArgument>, bi: BuiltIn, name: &str| -> u32 {
		if let Some(i) = args.iter().position(|a| a.binding == Some(Binding::BuiltIn(bi))) {
			return i as u32;
		}
		args.push(naga::FunctionArgument { name: Some(name.into()), ty: v3, binding: Some(Binding::BuiltIn(bi)) });
		(args.len() - 1) as u32
	};
	let lid_arg = arg_of(&mut args, BuiltIn::LocalInvocationId, "kwvk_lid");
	let wid_arg = if perv.iter().any(|p| p.1 == PerV::Gid) { Some(arg_of(&mut args, BuiltIn::WorkGroupId, "kwvk_wid")) } else { None };
	// new locals
	let Some(kv) = b.local("kwvk_v", u32t) else { return Err("a type it cannot keep per invocation".into()) };
	let Some(kjump) = b.local("kwvk_jump", boolt) else { return Err("a type it cannot keep per invocation".into()) };
	let mut sp: HashMap<H, Handle<LocalVariable>> = HashMap::new();
	for (h, tr) in spill_ty {
		let t = match tr {
			naga::proc::TypeResolution::Handle(t) => t,
			naga::proc::TypeResolution::Value(inner) => b.module.types.insert(Type { name: None, inner }, Span::UNDEFINED),
		};
		let Some(at) = b.array_of(t) else { return Err("a type it cannot keep per invocation".into()) };
		let lh = b.locals.append(LocalVariable { name: Some(format!("kwvk_s{}", h.index())), ty: at, init: None }, Span::UNDEFINED);
		sp.insert(h, lh);
	}
	let mut ps: Vec<(Handle<naga::GlobalVariable>, Handle<LocalVariable>)> = Vec::new();
	for &g in &privates {
		let t = b.module.global_variables[g].ty;
		let Some(at) = b.array_of(t) else { return Err("a type it cannot keep per invocation".into()) };
		let lh = b.locals.append(LocalVariable { name: Some(format!("kwvk_p{}", g.index())), ty: at, init: None }, Span::UNDEFINED);
		ps.push((g, lh));
	}
	let exited = if has_returns {
		let Some(at) = b.array_of(boolt) else { return Err("a type it cannot keep per invocation".into()) };
		Some(b.locals.append(LocalVariable { name: Some("kwvk_done".into()), ty: at, init: None }, Span::UNDEFINED))
	} else {
		None
	};
	// per region with jumps out of it: whether some virtual invocation took them
	let mut flags: Vec<(Option<Handle<LocalVariable>>, Option<Handle<LocalVariable>>)> = Vec::new();
	for (i, ri) in an.regions.iter().enumerate() {
		let a = ri.breaks.then(|| b.locals.append(LocalVariable { name: Some(format!("kwvk_brk{}", i)), ty: boolt, init: None }, Span::UNDEFINED));
		let c = ri.continues.then(|| b.locals.append(LocalVariable { name: Some(format!("kwvk_cnt{}", i)), ty: boolt, init: None }, Span::UNDEFINED));
		flags.push((a, c));
	}
	// pre-emitted expressions first (old ones, then the new ones')
	for (h, e) in old.expressions.iter() {
		if e.needs_pre_emit() {
			let n = b.ex.append(e.clone(), Span::UNDEFINED);
			b.glob.insert(h, n);
		}
	}
	let mut lv: HashMap<Handle<LocalVariable>, H> = HashMap::new();
	for (lh, _) in b.locals.iter() {
		lv.insert(lh, b.ex.append(Expression::LocalVariable(lh), Span::UNDEFINED));
	}
	// old LocalVariable expressions now point at arrays; same handles
	for n in [0, 1, k, sx, size[0], size[1], size[2], size[0] * size[1]].into_iter().chain(0..k) {
		b.lit(n);
	}
	let t = b.ex.append(Expression::Literal(Literal::Bool(true)), Span::UNDEFINED);
	let fl = b.ex.append(Expression::Literal(Literal::Bool(false)), Span::UNDEFINED);
	let lid = b.ex.append(Expression::FunctionArgument(lid_arg), Span::UNDEFINED);
	let wid = wid_arg.map(|i| b.ex.append(Expression::FunctionArgument(i), Span::UNDEFINED));
	let gvx: HashMap<Handle<naga::GlobalVariable>, H> = ps.iter().map(|&(g, _)| (g, b.ex.append(Expression::GlobalVariable(g), Span::UNDEFINED))).collect();

	let mut rb = Rebuild {
		b,
		old: &old,
		an: &an,
		sp,
		ps,
		gvx,
		lv,
		perv,
		lid,
		wid,
		size,
		sx,
		kv,
		kjump,
		exited,
		flags,
		t,
		f: fl,
		region: 0,
		is_ptr: &is_ptr,
	};
	let mut out = Block::new();
	// variables with an initializer: each virtual invocation's copy gets it
	for (lh, lvar) in old.local_variables.iter() {
		let Some(init) = lvar.init else { continue };
		let Some(&v) = rb.b.glob.get(&init) else { return Err("a variable initializer it cannot copy".into()) };
		for i in 0..k {
			let st = rb.b.ex.len();
			let p = rb.b.ex.append(Expression::AccessIndex { base: rb.lv[&lh], index: i }, Span::UNDEFINED);
			out.push(Statement::Emit(rb.b.ex.range_from(st)), Span::UNDEFINED);
			out.push(Statement::Store { pointer: p, value: v }, Span::UNDEFINED);
		}
	}
	// private variables: every virtual invocation starts from their initial values
	let ps2 = rb.ps.clone();
	for (g, lh) in ps2 {
		for i in 0..k {
			let st = rb.b.ex.len();
			let gp = rb.gvx[&g];
			let val = rb.b.ex.append(Expression::Load { pointer: gp }, Span::UNDEFINED);
			let p = rb.b.ex.append(Expression::AccessIndex { base: rb.lv[&lh], index: i }, Span::UNDEFINED);
			out.push(Statement::Emit(rb.b.ex.range_from(st)), Span::UNDEFINED);
			out.push(Statement::Store { pointer: p, value: val }, Span::UNDEFINED);
		}
	}
	if rb.block(&body, &mut out).is_none() {
		return Err("an operation this pass does not handle".into());
	}
	out.push(Statement::Return { value: None }, Span::UNDEFINED);
	let Rebuild { b, .. } = rb;
	let Builder { ex, locals, module, .. } = b;
	let ep = &mut module.entry_points[0];
	ep.function = Function { name: old.name.clone(), arguments: args, result: None, local_variables: locals, expressions: ex, named_expressions: Default::default(), body: out, diagnostic_filter_leaf: old.diagnostic_filter_leaf };
	ep.workgroup_size = [sx, size[1], size[2]];
	Ok(true)
}

// Conservative, flow-insensitive: whether every invocation of the
// workgroup computes the same value. Uniform: constants, workgroup_id and
// num_workgroups, loads from uniform and read-only storage buffers (and
// push constants) at uniform indices, function variables whose every
// store is of a uniform value at uniform indices under uniform control
// (enclosing conditions, and every way out of each enclosing loop) and
// whose address is never passed on, and pure operations on those.
// Anything else (workgroup and private memory, call and atomic results,
// texture loads...) is taken as differing.
struct Uniformity<'a> {
	m: &'a Module,
	f: &'a Function,
	args: &'a [u32],
	local: Vec<bool>,
	// break and continue statements (by address) some invocations may take and others not
	nu: HashSet<usize>,
}

impl<'a> Uniformity<'a> {
	fn new(m: &'a Module, f: &'a Function, body: &Block, args: &'a [u32]) -> Self {
		let mut u = Uniformity { m, f, args, local: vec![true; f.local_variables.len()], nu: HashSet::new() };
		loop {
			let mut bad = Vec::new();
			let _ = u.stores(body, true, &mut bad, &mut Vec::new());
			let before = u.local.clone();
			for l in bad {
				u.local[l] = false;
			}
			if u.local == before {
				break;
			}
		}
		let mut nu = Vec::new();
		let _ = u.stores(body, true, &mut Vec::new(), &mut nu);
		u.nu = nu.into_iter().collect();
		u
	}

	fn value(&self, h: H) -> bool {
		self.value_d(h, 0)
	}

	fn value_d(&self, h: H, d: u32) -> bool {
		if d > 64 {
			return false;
		}
		match &self.f.expressions[h] {
			Expression::Literal(_) | Expression::Constant(_) | Expression::ZeroValue(_) | Expression::Override(_) => true,
			Expression::FunctionArgument(i) => self.args.contains(i),
			Expression::Load { pointer } => self.read(*pointer, d + 1),
			Expression::Compose { .. }
			| Expression::Access { .. }
			| Expression::AccessIndex { .. }
			| Expression::Splat { .. }
			| Expression::Swizzle { .. }
			| Expression::Unary { .. }
			| Expression::Binary { .. }
			| Expression::Select { .. }
			| Expression::Relational { .. }
			| Expression::Math { .. }
			| Expression::As { .. } => expr_operands(&self.f.expressions[h]).is_some_and(|ops| ops.iter().all(|&o| self.value_d(o, d + 1))),
			_ => false,
		}
	}

	// a load through this pointer
	fn read(&self, p: H, d: u32) -> bool {
		match &self.f.expressions[p] {
			Expression::Access { base, index } => self.value_d(*index, d + 1) && self.read(*base, d + 1),
			Expression::AccessIndex { base, .. } => self.read(*base, d + 1),
			Expression::GlobalVariable(g) => match self.m.global_variables[*g].space {
				AddressSpace::Uniform | AddressSpace::Immediate => true,
				AddressSpace::Storage { access } => !access.contains(naga::StorageAccess::STORE),
				_ => false,
			},
			Expression::LocalVariable(l) => self.local[l.index()],
			_ => false,
		}
	}

	// the function variable a pointer is into, and whether its indices are uniform
	fn root(&self, p: H) -> Option<(usize, bool)> {
		match &self.f.expressions[p] {
			Expression::Access { base, index } => self.root(*base).map(|(l, u)| (l, u && self.value(*index))),
			Expression::AccessIndex { base, .. } => self.root(*base),
			Expression::LocalVariable(l) => Some((l.index(), true)),
			_ => None,
		}
	}

	// Variables some store makes non-uniform. `cf`: control so far uniform.
	// Returns the jumps (break, continue, return) that may be taken by some
	// invocations only and leave the block, WGSL's way: after one, the rest
	// of the block is not uniform; one out of a loop's iteration makes the
	// whole loop not uniform (its later iterations differ); a break ends at
	// its switch or loop, a continue at its loop.
	fn stores(&self, b: &Block, cf: bool, bad: &mut Vec<usize>, nu: &mut Vec<usize>) -> Jumps {
		let mut cf = cf;
		let mut out = Jumps::default();
		for s in b.iter() {
			let j = match s {
				Statement::Store { pointer, value } => {
					if let Some((l, idx)) = self.root(*pointer) {
						if !(cf && idx && self.value(*value)) {
							bad.push(l);
						}
					}
					Jumps::default()
				}
				Statement::Call { arguments, .. } => {
					bad.extend(arguments.iter().filter_map(|&a| self.root(a)).map(|r| r.0));
					Jumps::default()
				}
				Statement::Atomic { pointer, .. } => {
					bad.extend(self.root(*pointer).map(|r| r.0));
					Jumps::default()
				}
				Statement::Break | Statement::Continue if !cf => {
					nu.push(s as *const Statement as usize);
					Jumps { brk: matches!(s, Statement::Break), cnt: matches!(s, Statement::Continue), ..Default::default() }
				}
				Statement::Return { .. } => Jumps { ret: !cf, ..Default::default() },
				Statement::Block(x) => self.stores(x, cf, bad, nu),
				Statement::If { condition, accept, reject } => {
					let c = cf && self.value(*condition);
					self.stores(accept, c, bad, nu).or(self.stores(reject, c, bad, nu))
				}
				Statement::Switch { selector, cases } => {
					let c = cf && self.value(*selector);
					let mut j = Jumps::default();
					for k in cases {
						j = j.or(self.stores(&k.body, c, bad, nu));
					}
					Jumps { brk: false, ..j }
				}
				Statement::Loop { body, continuing, break_if } => {
					let mut scratch = Vec::new();
					let j = self.stores(body, cf, &mut scratch, &mut Vec::new()).or(self.stores(continuing, cf, &mut scratch, &mut Vec::new()));
					let c = cf && !j.brk && !j.cnt && !j.ret && break_if.is_none_or(|h| self.value(h));
					let j = self.stores(body, c, bad, nu).or(self.stores(continuing, c, bad, nu));
					Jumps { brk: false, cnt: false, ret: j.ret }
				}
				_ => Jumps::default(),
			};
			if j.brk || j.cnt || j.ret {
				cf = false;
			}
			out = out.or(j);
		}
		out
	}
}

#[derive(Default, Clone, Copy)]
struct Jumps {
	brk: bool,
	cnt: bool,
	ret: bool,
}

impl Jumps {
	fn or(self, o: Jumps) -> Jumps {
		Jumps { brk: self.brk || o.brk, cnt: self.cnt || o.cnt, ret: self.ret || o.ret }
	}
}

// Statements and expressions this pass can copy.
fn known(b: &Block) -> bool {
	b.iter().all(|s| {
		stmt_operands(s).is_some()
			&& match s {
				Statement::Block(x) => known(x),
				Statement::If { accept, reject, .. } => known(accept) && known(reject),
				Statement::Switch { cases, .. } => cases.iter().all(|c| known(&c.body)),
				Statement::Loop { body, continuing, .. } => known(body) && known(continuing),
				_ => true,
			}
	})
}

struct Builder<'m> {
	module: &'m mut Module,
	k: u32,
	ex: naga::Arena<Expression>,
	locals: naga::Arena<LocalVariable>,
	glob: HashMap<H, H>,
	lits: HashMap<u32, H>,
	v3: Handle<Type>,
	layouter: naga::proc::Layouter,
}

impl Builder<'_> {
	fn array_of(&mut self, base: Handle<Type>) -> Option<Handle<Type>> {
		self.layouter.update(self.module.to_ctx()).ok()?;
		let l = self.layouter[base];
		let stride = l.alignment.round_up(l.size);
		let size = ArraySize::Constant(std::num::NonZeroU32::new(self.k)?);
		Some(self.module.types.insert(Type { name: None, inner: TypeInner::Array { base, size, stride } }, Span::UNDEFINED))
	}
	fn local(&mut self, name: &str, ty: Handle<Type>) -> Option<Handle<LocalVariable>> {
		Some(self.locals.append(LocalVariable { name: Some(name.into()), ty, init: None }, Span::UNDEFINED))
	}
	fn lit(&mut self, n: u32) -> H {
		if let Some(&h) = self.lits.get(&n) {
			return h;
		}
		let h = self.ex.append(Expression::Literal(Literal::U32(n)), Span::UNDEFINED);
		self.lits.insert(n, h);
		h
	}
}

struct Rebuild<'a, 'm> {
	b: Builder<'m>,
	old: &'a Function,
	an: &'a Analysis,
	sp: HashMap<H, Handle<LocalVariable>>,
	ps: Vec<(Handle<naga::GlobalVariable>, Handle<LocalVariable>)>,
	gvx: HashMap<Handle<naga::GlobalVariable>, H>,
	lv: HashMap<Handle<LocalVariable>, H>,
	perv: Vec<(u32, PerV)>,
	lid: H,
	wid: Option<H>,
	size: [u32; 3],
	sx: u32,
	kv: Handle<LocalVariable>,
	kjump: Handle<LocalVariable>,
	exited: Option<Handle<LocalVariable>>,
	flags: Vec<(Option<Handle<LocalVariable>>, Option<Handle<LocalVariable>>)>,
	t: H,
	f: H,
	region: usize,
	is_ptr: &'a dyn Fn(H) -> bool,
}

// Per region while copying it.
struct RegionCopy {
	map: HashMap<H, H>,
	vv: H,
	brk: Option<Handle<LocalVariable>>,
	cnt: Option<Handle<LocalVariable>>,
	wrapped: bool,
}

impl Rebuild<'_, '_> {
	fn add(&mut self, e: Expression) -> H {
		self.b.ex.append(e, Span::UNDEFINED)
	}
	fn emit_from(&mut self, out: &mut Block, st: usize) {
		if self.b.ex.len() > st {
			out.push(Statement::Emit(self.b.ex.range_from(st)), Span::UNDEFINED);
		}
	}
	fn store_local(&mut self, out: &mut Block, l: Handle<LocalVariable>, v: H) {
		out.push(Statement::Store { pointer: self.lv[&l], value: v }, Span::UNDEFINED);
	}

	fn block(&mut self, b: &Block, out: &mut Block) -> Option<()> {
		for p in parts(b) {
			match p {
				Part::Run(run) if bare_jump(&run) => out.push(run[0].clone(), Span::UNDEFINED),
				Part::Run(run) => self.region_loop(&run, out)?,
				Part::Stmt(s) => match s {
					_ if is_barrier(s) => out.push(s.clone(), Span::UNDEFINED),
					Statement::Block(x) => {
						let mut nb = Block::new();
						self.block(x, &mut nb)?;
						out.push(Statement::Block(nb), Span::UNDEFINED);
					}
					Statement::If { condition, accept, reject } => {
						let c = self.level_value(*condition, out)?;
						let (mut a, mut r) = (Block::new(), Block::new());
						self.block(accept, &mut a)?;
						self.block(reject, &mut r)?;
						out.push(Statement::If { condition: c, accept: a, reject: r }, Span::UNDEFINED);
					}
					Statement::Switch { selector, cases } => {
						let c = self.level_value(*selector, out)?;
						let mut nc = Vec::new();
						for k in cases {
							let mut nb = Block::new();
							self.block(&k.body, &mut nb)?;
							nc.push(naga::SwitchCase { value: k.value, body: nb, fall_through: k.fall_through });
						}
						out.push(Statement::Switch { selector: c, cases: nc }, Span::UNDEFINED);
					}
					Statement::Loop { body, continuing, break_if } => {
						let (mut nb, mut nc) = (Block::new(), Block::new());
						self.block(body, &mut nb)?;
						self.block(continuing, &mut nc)?;
						let bi = match break_if {
							Some(h) => Some(self.level_value(*h, &mut nc)?),
							None => None,
						};
						out.push(Statement::Loop { body: nb, continuing: nc, break_if: bi }, Span::UNDEFINED);
					}
					_ => return None,
				},
			}
		}
		Some(())
	}

	// A condition outside regions: virtual invocation 0's value.
	// (the first virtual invocation that has not returned: the same value as
	// the others', and one that computed it)
	fn level_value(&mut self, h: H, out: &mut Block) -> Option<H> {
		if let Some(&l) = self.sp.get(&h) {
			let st = self.b.ex.len();
			let k = self.b.k;
			let mut v = None;
			for i in (0..k).rev() {
				let p = self.add(Expression::AccessIndex { base: self.lv[&l], index: i });
				let x = self.add(Expression::Load { pointer: p });
				v = Some(match (v, self.exited) {
					(None, _) => x,
					(Some(later), Some(ex)) => {
						let dp = self.add(Expression::AccessIndex { base: self.lv[&ex], index: i });
						let d = self.add(Expression::Load { pointer: dp });
						self.add(Expression::Select { condition: d, accept: later, reject: x })
					}
					(Some(_), None) => x,
				});
			}
			self.emit_from(out, st);
			return v;
		}
		self.b.glob.get(&h).copied()
	}

	fn region_loop(&mut self, run: &[&Statement], out: &mut Block) -> Option<()> {
		let r = self.region;
		self.region += 1;
		let ri = &self.an.regions[r];
		let (brk, cnt) = self.flags[r];
		let f = self.f;
		if let Some(l) = brk {
			self.store_local(out, l, f);
		}
		if let Some(l) = cnt {
			self.store_local(out, l, f);
		}
		let zero = self.b.lit(0);
		self.store_local(out, self.kv, zero);
		// loop body: v = kv; stop at K
		let mut body = Block::new();
		let st = self.b.ex.len();
		let kvp = self.lv[&self.kv];
		let vv = self.add(Expression::Load { pointer: kvp });
		let kk = self.b.lit(self.b.k);
		let done = self.add(Expression::Binary { op: naga::BinaryOperator::GreaterEqual, left: vv, right: kk });
		self.emit_from(&mut body, st);
		body.push(Statement::If { condition: done, accept: Block::from_vec(vec![Statement::Break]), reject: Block::new() }, Span::UNDEFINED);
		let mut rc = RegionCopy { map: HashMap::new(), vv, brk, cnt, wrapped: ri.jumps_out };
		// per-v builtins, variables, spilled values, recomputed pointers
		let st = self.b.ex.len();
		let mut lidv = None;
		for &(i, kind) in &self.perv.clone() {
			let l = *lidv.get_or_insert_with(|| self.lid_v(vv));
			let v = match kind {
				PerV::Lid => l,
				PerV::Lidx => self.lidx_v(l),
				PerV::Gid => self.gid_v(l)?,
			};
			let old_arg = self.old.expressions.iter().filter(|(_, e)| matches!(e, Expression::FunctionArgument(j) if *j == i)).map(|(h, _)| h).collect::<Vec<_>>();
			for h in old_arg {
				rc.map.insert(h, v);
			}
		}
		for (h, e) in self.old.expressions.iter() {
			if let Expression::LocalVariable(l) = e {
				let p = self.add(Expression::Access { base: self.lv[l], index: vv });
				rc.map.insert(h, p);
			}
		}
		let uses = self.an.regions[r].uses.clone();
		for h in uses {
			self.materialize(h, r, &mut rc)?;
		}
		self.emit_from(&mut body, st);
		if self.an.regions[r].jumps_out {
			let f = self.f;
			self.store_local(&mut body, self.kjump, f);
		}
		// restore the private variables of this virtual invocation
		for (g, l) in self.ps.clone() {
			let st = self.b.ex.len();
			let p = self.add(Expression::Access { base: self.lv[&l], index: vv });
			let v = self.add(Expression::Load { pointer: p });
			self.emit_from(&mut body, st);
			body.push(Statement::Store { pointer: self.gvx[&g], value: v }, Span::UNDEFINED);
		}
		let mut inner = Block::new();
		let mut stack: Vec<u8> = Vec::new(); // constructs inside the region: SWITCH, LOOP, CONTINUING
		for s in run {
			self.copy_stmt(s, r, &mut rc, &mut inner, &mut stack)?;
		}
		let inner = if rc.wrapped {
			inner.push(Statement::Break, Span::UNDEFINED);
			Block::from_vec(vec![Statement::Loop { body: inner, continuing: Block::new(), break_if: None }])
		} else {
			inner
		};
		if let Some(ex) = self.exited {
			let st = self.b.ex.len();
			let p = self.add(Expression::Access { base: self.lv[&ex], index: vv });
			let d = self.add(Expression::Load { pointer: p });
			self.emit_from(&mut body, st);
			body.push(Statement::If { condition: d, accept: Block::new(), reject: inner }, Span::UNDEFINED);
		} else {
			body.extend_block(inner);
		}
		// save them back
		for (g, l) in self.ps.clone() {
			let st = self.b.ex.len();
			let p = self.add(Expression::Access { base: self.lv[&l], index: vv });
			let v = self.add(Expression::Load { pointer: self.gvx[&g] });
			self.emit_from(&mut body, st);
			body.push(Statement::Store { pointer: p, value: v }, Span::UNDEFINED);
		}
		let mut cont = Block::new();
		let st = self.b.ex.len();
		let v2 = self.add(Expression::Load { pointer: kvp });
		let one = self.b.lit(1);
		let inc = self.add(Expression::Binary { op: naga::BinaryOperator::Add, left: v2, right: one });
		self.emit_from(&mut cont, st);
		cont.push(Statement::Store { pointer: kvp, value: inc }, Span::UNDEFINED);
		out.push(Statement::Loop { body, continuing: cont, break_if: None }, Span::UNDEFINED);
		// jumps out of the region: taken when any virtual invocation took them
		let ri = &self.an.regions[r];
		let (breaks, continues, returns) = (ri.breaks, ri.continues, ri.returns);
		if breaks {
			let st = self.b.ex.len();
			let v = self.add(Expression::Load { pointer: self.lv[&brk?] });
			self.emit_from(out, st);
			out.push(Statement::If { condition: v, accept: Block::from_vec(vec![Statement::Break]), reject: Block::new() }, Span::UNDEFINED);
		}
		if continues {
			let st = self.b.ex.len();
			let v = self.add(Expression::Load { pointer: self.lv[&cnt?] });
			self.emit_from(out, st);
			out.push(Statement::If { condition: v, accept: Block::from_vec(vec![Statement::Continue]), reject: Block::new() }, Span::UNDEFINED);
		}
		if returns {
			let ex = self.exited?;
			let st = self.b.ex.len();
			let mut all = None;
			for i in 0..self.b.k {
				let p = self.add(Expression::AccessIndex { base: self.lv[&ex], index: i });
				let d = self.add(Expression::Load { pointer: p });
				all = Some(match all {
					None => d,
					Some(a) => self.add(Expression::Binary { op: naga::BinaryOperator::LogicalAnd, left: a, right: d }),
				});
			}
			self.emit_from(out, st);
			out.push(Statement::If { condition: all?, accept: Block::from_vec(vec![Statement::Return { value: None }]), reject: Block::new() }, Span::UNDEFINED);
		}
		Some(())
	}

	fn lid_v(&mut self, vv: H) -> H {
		let sx = self.b.lit(self.sx);
		let x = self.add(Expression::AccessIndex { base: self.lid, index: 0 });
		let y = self.add(Expression::AccessIndex { base: self.lid, index: 1 });
		let z = self.add(Expression::AccessIndex { base: self.lid, index: 2 });
		let off = self.add(Expression::Binary { op: naga::BinaryOperator::Multiply, left: vv, right: sx });
		let x2 = self.add(Expression::Binary { op: naga::BinaryOperator::Add, left: x, right: off });
		self.add(Expression::Compose { ty: self.b.v3, components: vec![x2, y, z] })
	}
	fn lidx_v(&mut self, l: H) -> H {
		let (a, b) = (self.b.lit(self.size[0]), self.b.lit(self.size[0] * self.size[1]));
		let x = self.add(Expression::AccessIndex { base: l, index: 0 });
		let y = self.add(Expression::AccessIndex { base: l, index: 1 });
		let z = self.add(Expression::AccessIndex { base: l, index: 2 });
		let ya = self.add(Expression::Binary { op: naga::BinaryOperator::Multiply, left: y, right: a });
		let zb = self.add(Expression::Binary { op: naga::BinaryOperator::Multiply, left: z, right: b });
		let s = self.add(Expression::Binary { op: naga::BinaryOperator::Add, left: x, right: ya });
		self.add(Expression::Binary { op: naga::BinaryOperator::Add, left: s, right: zb })
	}
	fn gid_v(&mut self, l: H) -> Option<H> {
		let w = self.wid?;
		let (a, b, c) = (self.b.lit(self.size[0]), self.b.lit(self.size[1]), self.b.lit(self.size[2]));
		let s = self.add(Expression::Compose { ty: self.b.v3, components: vec![a, b, c] });
		let m = self.add(Expression::Binary { op: naga::BinaryOperator::Multiply, left: w, right: s });
		Some(self.add(Expression::Binary { op: naga::BinaryOperator::Add, left: m, right: l }))
	}

	// An expression from outside the region, made available at its start.
	fn materialize(&mut self, h: H, r: usize, rc: &mut RegionCopy) -> Option<H> {
		if let Some(&n) = rc.map.get(&h) {
			return Some(n);
		}
		let n = match self.an.def.get(&h) {
			Some(&d) if d == r => return Some(h), // copied with the region's statements
			Some(_) if (self.is_ptr)(h) => {
				let e = self.old.expressions[h].clone();
				let ops = expr_operands(&e)?;
				for o in ops {
					self.materialize(o, r, rc)?;
				}
				let m = &rc.map;
				let g = &self.b.glob;
				let ne = map_expr(&e, &mut |o| m.get(&o).or_else(|| g.get(&o)).copied())?;
				self.add(ne)
			}
			Some(_) => {
				let l = *self.sp.get(&h)?;
				let p = self.add(Expression::Access { base: self.lv[&l], index: rc.vv });
				self.add(Expression::Load { pointer: p })
			}
			None => *self.b.glob.get(&h)?,
		};
		rc.map.insert(h, n);
		Some(n)
	}

	fn lookup(&self, rc: &RegionCopy, h: H) -> Option<H> {
		rc.map.get(&h).or_else(|| self.b.glob.get(&h)).copied()
	}

	// Leave the region (its wrapper loop) from inside `stack` constructs.
	fn exit_region(&mut self, out: &mut Block, stack: &[u8]) {
		if !stack.is_empty() {
			let t = self.t;
			self.store_local(out, self.kjump, t);
		}
		out.push(Statement::Break, Span::UNDEFINED);
	}

	fn after_construct(&mut self, out: &mut Block, stack: &[u8]) {
		// a jump out of the region left the construct just closed: go on leaving
		// (none can leave a continuing block, where WGSL has no break)
		if stack.contains(&CONTINUING) {
			return;
		}
		let st = self.b.ex.len();
		let v = self.add(Expression::Load { pointer: self.lv[&self.kjump] });
		self.emit_from(out, st);
		let mut a = Block::new();
		self.exit_region(&mut a, stack);
		out.push(Statement::If { condition: v, accept: a, reject: Block::new() }, Span::UNDEFINED);
	}

	fn copy_block(&mut self, b: &Block, r: usize, rc: &mut RegionCopy, stack: &mut Vec<u8>) -> Option<Block> {
		let mut nb = Block::new();
		for s in b.iter() {
			self.copy_stmt(s, r, rc, &mut nb, stack)?;
		}
		Some(nb)
	}

	fn copy_stmt(&mut self, s: &Statement, r: usize, rc: &mut RegionCopy, out: &mut Block, stack: &mut Vec<u8>) -> Option<()> {
		let in_loop = stack.iter().any(|&l| l != SWITCH);
		match s {
			Statement::Emit(range) => {
				let st = self.b.ex.len();
				let mut spilled = Vec::new();
				for h in range.clone() {
					let e = map_expr(&self.old.expressions[h], &mut |o| rc.map.get(&o).or_else(|| self.b.glob.get(&o)).copied())?;
					let n = self.add(e);
					rc.map.insert(h, n);
					if self.sp.contains_key(&h) {
						spilled.push(h);
					}
				}
				self.emit_from(out, st);
				for h in spilled {
					self.spill_store(h, rc, out);
				}
			}
			Statement::Store { pointer, value } => out.push(Statement::Store { pointer: self.lookup(rc, *pointer)?, value: self.lookup(rc, *value)? }, Span::UNDEFINED),
			Statement::ImageStore { image, coordinate, array_index, value } => {
				let ai = match array_index {
					Some(x) => Some(self.lookup(rc, *x)?),
					None => None,
				};
				out.push(Statement::ImageStore { image: self.lookup(rc, *image)?, coordinate: self.lookup(rc, *coordinate)?, array_index: ai, value: self.lookup(rc, *value)? }, Span::UNDEFINED)
			}
			Statement::Atomic { pointer, fun, value, result } => {
				let fun = match fun {
					naga::AtomicFunction::Exchange { compare: Some(c) } => naga::AtomicFunction::Exchange { compare: Some(self.lookup(rc, *c)?) },
					f => f.clone(),
				};
				let res = match result {
					Some(h) => {
						let n = self.add(self.old.expressions[*h].clone());
						rc.map.insert(*h, n);
						Some(n)
					}
					None => None,
				};
				out.push(Statement::Atomic { pointer: self.lookup(rc, *pointer)?, fun, value: self.lookup(rc, *value)?, result: res }, Span::UNDEFINED);
				if let Some(h) = result {
					if self.sp.contains_key(h) {
						self.spill_store(*h, rc, out);
					}
				}
			}
			Statement::Call { function, arguments, result } => {
				let mut a = Vec::new();
				for x in arguments {
					a.push(self.lookup(rc, *x)?);
				}
				let res = match result {
					Some(h) => {
						let n = self.add(self.old.expressions[*h].clone());
						rc.map.insert(*h, n);
						Some(n)
					}
					None => None,
				};
				out.push(Statement::Call { function: *function, arguments: a, result: res }, Span::UNDEFINED);
				if let Some(h) = result {
					if self.sp.contains_key(h) {
						self.spill_store(*h, rc, out);
					}
				}
			}
			Statement::Block(x) => {
				let nb = self.copy_block(x, r, rc, stack)?;
				out.push(Statement::Block(nb), Span::UNDEFINED);
			}
			Statement::If { condition, accept, reject } => {
				let c = self.lookup(rc, *condition)?;
				let a = self.copy_block(accept, r, rc, stack)?;
				let b = self.copy_block(reject, r, rc, stack)?;
				out.push(Statement::If { condition: c, accept: a, reject: b }, Span::UNDEFINED);
			}
			Statement::Switch { selector, cases } => {
				let c = self.lookup(rc, *selector)?;
				stack.push(SWITCH);
				let mut nc = Vec::new();
				for k in cases {
					let nb = self.copy_block(&k.body, r, rc, stack)?;
					nc.push(naga::SwitchCase { value: k.value, body: nb, fall_through: k.fall_through });
				}
				stack.pop();
				out.push(Statement::Switch { selector: c, cases: nc }, Span::UNDEFINED);
				if rc.wrapped {
					self.after_construct(out, stack);
				}
			}
			Statement::Loop { body, continuing, break_if } => {
				stack.push(LOOP);
				let nb = self.copy_block(body, r, rc, stack)?;
				stack.push(CONTINUING);
				let nc = self.copy_block(continuing, r, rc, stack)?;
				stack.pop();
				stack.pop();
				let bi = match break_if {
					Some(h) => Some(self.lookup(rc, *h)?),
					None => None,
				};
				out.push(Statement::Loop { body: nb, continuing: nc, break_if: bi }, Span::UNDEFINED);
				if rc.wrapped {
					self.after_construct(out, stack);
				}
			}
			Statement::Break if !stack.is_empty() => out.push(Statement::Break, Span::UNDEFINED),
			Statement::Continue if in_loop => out.push(Statement::Continue, Span::UNDEFINED),
			Statement::Break => {
				let t = self.t;
				self.store_local(out, rc.brk?, t);
				self.exit_region(out, stack);
			}
			Statement::Continue => {
				let t = self.t;
				self.store_local(out, rc.cnt?, t);
				self.exit_region(out, stack);
			}
			Statement::Return { value: None } => {
				let ex = self.exited?;
				let st = self.b.ex.len();
				let p = self.add(Expression::Access { base: self.lv[&ex], index: rc.vv });
				self.emit_from(out, st);
				let t = self.t;
				out.push(Statement::Store { pointer: p, value: t }, Span::UNDEFINED);
				self.exit_region(out, stack);
			}
			_ if is_barrier(s) => return None,
			_ => return None,
		}
		Some(())
	}

	fn spill_store(&mut self, h: H, rc: &RegionCopy, out: &mut Block) {
		let l = self.sp[&h];
		let st = self.b.ex.len();
		let p = self.add(Expression::Access { base: self.lv[&l], index: rc.vv });
		self.emit_from(out, st);
		out.push(Statement::Store { pointer: p, value: rc.map[&h] }, Span::UNDEFINED);
	}
}
