// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
#version 450
layout(location = 1) flat in vec4 col;
layout(location = 0) out vec4 o;
void main() { o = col; }
