# Changelog — @saip/inference

## [Unreleased]
### Added
- **No silent memory storage**: `createApp()` resolves its provider through `storageProviderFor()` and fails startup naming `SAIP_R2_BUCKET` when the bucket is empty; `SAIP_STORAGE=memory` still works and prints `storage: EXPLICIT MEMORY — data dies at restart` (#198). `lib/backends.ts` re-exports the shared contract, so no import site changed.
- `env` / `secrets` on `CreateAppOptions`, threaded into the secrets chain too: previously `createApp({ env })` selected from one environment while credentials read `process.env`, so a test could pass against the developer's real `~/.saip` store (#198).
- Documents keep `source.<ext>` and `processed.md` as separate objects with both keys in the index entry, and `contentKeys()` resolves pre-#198 entries through the `content<ext>` fallback — no re-ingestion (#198, design record §1.4).

- Service documentation and Docker Compose scaffold (#1)
