#version 450
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// SPIR-V 1.6 (Vulkan 1.3): demote to helper invocation, and OpCopyLogical
// from a std140 struct into a function-local one.
#extension GL_EXT_demote_to_helper_invocation : require
struct L { vec4 a; float b[2]; };
layout(std140, set = 0, binding = 0) uniform U { L l; } u;
layout(location = 0) in vec2 uv;
layout(location = 0) out vec4 o;
void main() {
	if (uv.x < 0.0) demote;
	L copy = u.l;
	o = copy.a * copy.b[1];
}
