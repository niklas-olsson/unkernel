#version 450
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Specialization constants (float, int, bool) and a set-1 UBO.
layout(constant_id = 0) const float scale = 1.0;
layout(constant_id = 1) const int count = 2;
layout(constant_id = 2) const bool invert = false;
layout(set = 1, binding = 2) uniform U { vec4 tint; } u;
layout(location = 0) in vec4 color;
layout(location = 0) out vec4 outColor;
void main() {
	vec4 c = color * scale * float(count) * u.tint;
	outColor = invert ? 1.0 - c : c;
}
