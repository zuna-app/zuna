// Builds the test server once for the whole run, rather than once for every test file
// that starts one. TestServer uses it when ZUNA_TEST_SERVER_BINARY says where it is.

import { buildServer } from "./server-binary";

export function setup(): void {
  process.env.ZUNA_TEST_SERVER_BINARY = buildServer();
}
