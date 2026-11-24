#version 450
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A fragment push range at offset 64 (the vertex stage owns 0..63) and a
// UBO with explicit member offsets.
layout(push_constant) uniform P { layout(offset = 64) vec4 color; layout(offset = 96) float k; } pc;
layout(std140, set = 0, binding = 0) uniform U { vec4 a; layout(offset = 48) vec4 b; layout(offset = 80) float c; } u;
layout(location = 0) out vec4 o;
void main() {
	o = pc.color * pc.k + u.a + u.b * u.c;
}
