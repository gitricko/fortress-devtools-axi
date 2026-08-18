#!/usr/bin/env node
import { tryFastPath } from "axi-sdk-js/fast-path";
import { VERSION } from "../src/version.js";

// Default BROWSER_URL to Fortress endpoint (fortress fork behavior)
if (!process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL) {
  process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL = "http://127.0.0.1:9222";
}

if (!tryFastPath(process.argv.slice(2), { version: VERSION })) {
  const { main } = await import("../src/cli.js");
  await main(process.argv.slice(2));
}
