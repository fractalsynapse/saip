# Changelog — @saip/training

## [Unreleased]
### Added
- Storage selection at the training root, fail-closed like inference, with the chosen provider named in boot output — the `jobs/` store (#197) and `r2Sync` (#198) are the consumers (#198).
- `SecretsService` now gets `defaultSecretsProvider(env)` instead of a bare `EnvSecrets`: the gateway could not read `SAIP_R2_ACCESS_KEY_ID` from the encrypted store, which the design record assumed it already could (#198).

- Service documentation and Docker Compose scaffold (#1)
