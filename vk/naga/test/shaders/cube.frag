#version 400
#extension GL_ARB_separate_shader_objects : enable
#extension GL_ARB_shading_language_420pack : enable
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// vkcube's fragment shader: a combined image sampler and derivatives.
layout(binding = 1) uniform sampler2D tex;
layout(location = 0) in vec4 texcoord;
layout(location = 1) in vec3 frag_pos;
layout(location = 0) out vec4 uFragColor;
void main() {
	const vec3 light = normalize(vec3(-0.2, 1.0, 0.8));
	vec3 n = normalize(cross(dFdx(frag_pos), dFdy(frag_pos)));
	float d = max(dot(n, light), 0.3);
	if (texcoord.z > 0.5) discard;
	uFragColor = texture(tex, texcoord.xy) * d;
}
