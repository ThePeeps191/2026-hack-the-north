// The unit test for ./generation.ts lives at src/main/voice/playback-gate.test.ts.
//
// It is deliberately not next to this file: tsconfig.web.json (the renderer
// project) has no Node types, so a `node:test` import inside src/renderer/src
// would break `tsc -p tsconfig.web.json`, and the renderer bundle must stay free
// of test-only Node imports. The module under test is DOM-free, so the main
// process' test run covers it.
