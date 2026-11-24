#version 450
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A std140 float array (stride 16) in a UBO and a std430-style push block.
layout(std140, set = 0, binding = 0) uniform W { float weights[4]; vec3 dir; float bias; } w;
layout(push_constant) uniform P { vec2 offset; float scale; uint mode; } p;
layout(location = 0) out vec4 o;
void main() {
	float s = 0.0;
	for (int i = 0; i < 4; i++) s += w.weights[i];
	o = vec4(w.dir * s + w.bias, p.scale + float(p.mode)) + p.offset.xyxy;
}
