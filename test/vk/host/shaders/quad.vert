// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
#version 450
layout(location = 0) in vec3 pos;
layout(location = 1) in vec2 uv;
layout(location = 0) out vec2 vuv;
void main() { vuv = uv; gl_Position = vec4(pos, 1.0); }
