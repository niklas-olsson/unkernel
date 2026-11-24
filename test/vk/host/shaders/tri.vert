// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
#version 450
layout(location = 0) in vec2 pos;
layout(set = 0, binding = 0) uniform U { vec4 scale; } u;
void main() { gl_Position = vec4(pos * u.scale.xy, 0.0, 1.0); }
