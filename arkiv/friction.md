## What should we improve today to make Arkiv better?

1. **Keep documentation aligned with published SDK versions.** With our pinned `@arkiv-network/sdk@1.0.1`, the [column-types page](https://docs.arkiv.network/schemas/column-types/) lists `ne`, and the [API navigation](https://docs.arkiv.network/reference/query-language/) lists `ne` and `not`, but neither is exported by that SDK. Version-labelled references and import checks against the published package would prevent this mismatch.

2. **Add indexed lists and membership queries.** Our router needs “ready pools that serve model X.” The [documented column types](https://docs.arkiv.network/schemas/column-types/) and SDK 1.0.1 provide no array type or `contains` helper. We implemented indexed `model0`–`model3` columns, an OR query across them, and cleanup of unused slots when updating a pool. If it had native membership queries, that would have removed that code and our workaround's four-model cap. See [our encoding and query](src/schema.ts) and [update cleanup](src/writer.ts).

## When something broke, what did you expect, what happened, and how can we reproduce it?

**Documentation/SDK mismatch, reproduced locally with SDK 1.0.1:**

- **Expected:** The documented `ne` and `not` query helpers could be imported.
- **Actual:** Node rejects each named import before any RPC call with `SyntaxError: The requested module '@arkiv-network/sdk/query' does not provide an export named 'ne'` (or `'not'`).
- **Reproduce:** From the repository root, with dependencies installed:

  ```sh
  cd arkiv
  node --input-type=module -e 'import { ne } from "@arkiv-network/sdk/query"'
  node --input-type=module -e 'import { not } from "@arkiv-network/sdk/query"'
  ```

- **Suggested fix:** Remove unsupported helpers from the reference for 1.0.1, or identify the SDK version that provides them.
