#!/usr/bin/env tsx

import { runTilionBridge } from "../src/tilion-bridge.js";
import { getErrorMessage } from "../src/bridge.js";

runTilionBridge().catch((error) => {
  process.stderr.write(
    `[chrome-devtools-axi] Fatal: ${getErrorMessage(error)}\n`,
  );
  process.exit(1);
});
