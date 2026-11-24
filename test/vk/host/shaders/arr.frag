// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
#version 450
layout(set = 0, binding = 1) uniform sampler2D texs[2];
layout(location = 0) in vec2 vuv;
layout(location = 0) out vec4 o;
void main() { o = texture(texs[1], vuv) * 0.5 + texture(texs[0], vuv) * 0.5; }
