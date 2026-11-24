# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Compiles a subset of llama.cpp's ggml-vulkan compute shaders the way its
# vulkan-shaders-gen does (glslc -fshader-stage=compute
# --target-env=vulkan1.2 -O -DKEY=VALUE...), with glslangValidator and
# spirv-opt: every simple string_to_spv("name", "file.comp", {...}) call of
# the generator (literal name, a literal or base_dict-merged define list),
# plus mul_mat_vec and matmul for f32/f16/q4_0/q8_0/q4_k.
#   python3 -I llama-shaders.py SHADER_DIR OUT_DIR
import os, re, subprocess, sys

src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
gen = open(os.path.join(src, "vulkan-shaders-gen.cpp")).read()
base = {"FLOAT_TYPE": "float", "FLOAT_TYPEV2": "vec2"}
jobs = []
for m in re.finditer(r'string_to_spv\("([A-Za-z0-9_]+)",\s*"([a-z0-9_]+\.comp)",\s*(merge_maps\(base_dict,\s*)?(\{\{.*?\}\})\)?\);', gen):
    name, f, merged, d = m.groups()
    defs = dict(re.findall(r'\{"([A-Za-z0-9_]+)",\s*"([^"]*)"\}', d))
    if merged:
        defs = {**base, **defs}
    jobs.append((name, f, defs))
for t in ["f32", "f16", "q4_0", "q8_0", "q4_k"]:
    sh = "mul_mat_vec_q4_k.comp" if t == "q4_k" else "mul_mat_vec.comp"
    d = {**base, "DATA_A_" + t.upper(): "1", "B_TYPE": "float", "B_TYPEV2": "vec2", "B_TYPEV4": "vec4", "D_TYPE": "float"}
    jobs.append((f"mul_mat_vec_{t}_f32_f32", sh, d))
    jobs.append((f"mul_mat_vec_{t}_f32_f32_subgroup", sh, {**d, "USE_SUBGROUP_ADD": "1"}))
    acc = {"ACC_TYPE": "float", "ACC_TYPEV2": "vec2", "ACC_TYPE_VEC4": "vec4"}
    lv = "1" if t.startswith("q") else "4"
    # fp32 (no shaderFloat16) and fp16 (FLOAT16) matmul, unaligned and aligned B
    for fp16 in (False, True):
        ft = ("float16_t", "f16vec2", "f16vec4", "f16mat2x4") if fp16 else ("float", "vec2", "vec4", "mat2x4")
        mm = {**acc, "FLOAT_TYPE": ft[0], "FLOAT_TYPEV2": ft[1], "FLOAT_TYPEV4": ft[2], "FLOAT_TYPEV8": ft[3],
              "DATA_A_" + t.upper(): "1", "LOAD_VEC_A": lv, "LOAD_VEC_B": "4", "B_TYPE": "mat2x4" if fp16 else "vec4", "B_TYPE_SCALAR": "float", "B_TYPEV4": "vec4", "D_TYPE": "float"}
        if fp16:
            mm["FLOAT16"] = "1"
        jobs.append((f"matmul_{t}_f32{'_fp16' if fp16 else ''}_aligned", "mul_mm.comp", mm))
        jobs.append((f"matmul_{t}_f32{'_fp16' if fp16 else ''}", "mul_mm.comp", {**mm, "LOAD_VEC_A": "1", "LOAD_VEC_B": "1", "B_TYPE": "float"}))
# glslc enables #include; glslangValidator needs the extension: a patched
# copy of the sources.
tmp = os.path.join(out, "src")
os.makedirs(tmp, exist_ok=True)
for f in os.listdir(src):
    if f.endswith((".comp", ".glsl")):
        t = open(os.path.join(src, f)).read()
        if f.endswith(".comp"):
            t = re.sub(r"^(#version[^\n]*\n)", r"\1#extension GL_GOOGLE_include_directive : require\n", t, count=1, flags=re.M)
        open(os.path.join(tmp, f), "w").write(t)
src = tmp
ok = 0
for name, f, defs in jobs:
    spv = os.path.join(out, name + ".comp.spv")
    cmd = ["glslangValidator", "-V", "--target-env", "vulkan1.2", "-S", "comp", "-I" + src, "-o", spv + ".raw", os.path.join(src, f)] + [f"-D{k}={v}" for k, v in defs.items()]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        print("compile failed", name, (r.stdout + r.stderr).strip().splitlines()[-1:])
        continue
    if subprocess.run(["spirv-opt", "-O", spv + ".raw", "-o", spv]).returncode:
        os.replace(spv + ".raw", spv)
    else:
        os.remove(spv + ".raw")
    ok += 1
print(f"{ok}/{len(jobs)} compiled")
