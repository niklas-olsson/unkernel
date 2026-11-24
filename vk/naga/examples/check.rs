// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
//
// Parses and validates WGSL files the way Firefox does (naga's WGSL front
// end, WebGPU's capabilities: kwvk_naga::webgpu_capabilities), so the
// translator's output can be checked against a second WGSL compiler
// without a browser. Without --uniformity, naga's uniformity analysis is
// skipped (Tint's differs; the translator leaves it to the browser).
//
//   cargo run --release --features check --example check -- [--uniformity] FILE.wgsl|DIR...

use std::path::{Path, PathBuf};

fn walk(p: &Path, out: &mut Vec<PathBuf>) {
	if p.is_dir() {
		let mut es: Vec<PathBuf> = std::fs::read_dir(p).map(|d| d.filter_map(|e| e.ok().map(|e| e.path())).collect()).unwrap_or_default();
		es.sort();
		for e in es {
			walk(&e, out);
		}
	} else if p.extension().is_some_and(|e| e == "wgsl") {
		out.push(p.to_path_buf());
	}
}

fn main() {
	let mut uniformity = false;
	let mut files = Vec::new();
	for a in std::env::args().skip(1) {
		if a == "--uniformity" {
			uniformity = true;
		} else {
			walk(Path::new(&a), &mut files);
		}
	}
	let mut flags = naga::valid::ValidationFlags::all();
	if !uniformity {
		flags &= !naga::valid::ValidationFlags::CONTROL_FLOW_UNIFORMITY;
	}
	let (mut ok, mut bad, mut skipped) = (0, 0, 0);
	for f in &files {
		let src = std::fs::read_to_string(f).unwrap_or_default();
		if src.contains("enable subgroups;") {
			// naga 30's WGSL front end refuses the extension; kwvk offers
			// no subgroup operations, so no app picks such a variant.
			skipped += 1;
			continue;
		}
		let res = naga::front::wgsl::parse_str(&src).map_err(|e| e.emit_to_string(&src)).and_then(|m| {
			naga::valid::Validator::new(flags, kwvk_naga::webgpu_capabilities())
				.validate(&m)
				.map(|_| ())
				.map_err(|e| e.emit_to_string(&src))
		});
		match res {
			Ok(()) => ok += 1,
			Err(e) => {
				bad += 1;
				let first: Vec<&str> = e.lines().filter(|l| !l.trim().is_empty()).take(4).collect();
				println!("{}: {}", f.display(), first.join(" | "));
			}
		}
	}
	println!("{} valid, {} invalid, {} skipped (subgroups)", ok, bad, skipped);
	if bad > 0 {
		std::process::exit(1);
	}
}
