#version 450
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// A separate texture and sampler at the same binding (what DXC emits for
// HLSL Texture2D + SamplerState, SDL 3's GPU API): one combined descriptor.
layout(set = 2, binding = 0) uniform texture2D t0;
layout(set = 2, binding = 0) uniform sampler s0;
layout(location = 0) in vec2 uv;
layout(location = 0) out vec4 o;
void main() {
	o = texture(sampler2D(t0, s0), uv);
}
