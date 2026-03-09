# AGENTS

## Scope
This file defines repository-specific coding instructions for `grip-core`.

These same TypeScript rules should also be applied to TypeScript Glial modules in this repository, including:

- `glial-local-ts`
- `glial-net-ts`

## Design Rules
- Prefer plain functions and typed data shapes over classes when stateful objects are not required.
- When a class is the better fit, keep the public surface small and make state ownership explicit.
- Keep exported types complete and precise so IDE inference and cross-package contracts remain strong.

## Development Process (TDD)
Use a strict red/green/refactor workflow for all behavior changes.

1. Red: Add or update tests first to express the expected behavior, then run the smallest relevant test target and confirm it fails.
2. Green: Implement the minimal code change required to make the failing test pass.
3. Refactor: Improve structure and readability while preserving behavior.
4. Verify targeted scope: Re-run the focused test subset.
5. Verify full regression: Run the full test suite before finalizing.

## Test Commands
- Focused tests: `npx vitest run <test-path>`
- Full suite: `npm test -- --run`
