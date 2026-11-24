#version 450
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// The fragment side of dynvary.vert: dynamic reads of an input array.
struct Rect { vec4 bounds; };
layout(location = 0) flat in vec4 corners[3];
layout(location = 3) flat in Rect a;
layout(location = 4) flat in Rect b;
layout(location = 0) out vec4 o;
void main() {
	int k = int(gl_FragCoord.x) % 3;
	o = corners[k] + a.bounds + b.bounds;
}
