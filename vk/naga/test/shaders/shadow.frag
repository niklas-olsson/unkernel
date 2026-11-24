#version 450
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A depth comparison sampler (sampler2DShadow) next to a plain one.
layout(set = 0, binding = 0) uniform sampler2DShadow shadowMap;
layout(set = 0, binding = 1) uniform sampler2D albedo;
layout(location = 0) in vec4 shadowCoord;
layout(location = 1) in vec2 uv;
layout(location = 0) out vec4 outColor;
void main() {
	float lit = texture(shadowMap, shadowCoord.xyz);
	outColor = texture(albedo, uv) * mix(0.2, 1.0, lit);
}
