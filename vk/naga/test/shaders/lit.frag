#version 450
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Mesa's vkcube fragment shader, plus a flat int input.
layout(location = 0) in vec4 vVaryingColor;
layout(location = 1) flat in int vId;
layout(location = 0) out vec4 f_color;
void main() {
	f_color = vVaryingColor * float(vId + 1);
}
