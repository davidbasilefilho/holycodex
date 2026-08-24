// SPDX-License-Identifier: Apache-2.0

import { runDaemon } from "./run-daemon.ts";
if (process.argv[2] === "daemon") await runDaemon();
else process.stderr.write("Usage: holycodex-lsp-daemon daemon\n");
