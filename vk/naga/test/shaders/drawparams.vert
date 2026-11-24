#version 450
// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Shader draw parameters (vkd3d requires them): BaseVertex, BaseInstance
// and DrawIndex, which WGSL lacks, read as 0.
#extension GL_ARB_shader_draw_parameters : require
void main() { gl_Position = vec4(float(gl_BaseVertexARB + gl_BaseInstanceARB + gl_DrawIDARB)); }
