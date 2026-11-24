// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>

import { workerData } from "node:worker_threads";
import { runSampler } from "../core/sampler.ts";

runSampler(workerData);
