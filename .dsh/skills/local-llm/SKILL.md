---
name: local-llm
description: Use when operating or diagnosing SAIP inference/training stacks, GPU profiles, engine configuration or adapter loading.
---

# SAIP local model operations

Follow the [project instructions](../../../AGENTS.md), including infrastructure authority,
secret handling and evidence requirements. Inspect the selected host and current state before
starting/stopping services; diagnostics do not authorize changes to live stacks.

## Resolve the actual configuration

SAIP owns separate inference and training Compose stacks. The CLI is the supported operator
surface; use its documented awake, sleep, down and status behavior rather than guessing Compose
operations. The gateway is the normal client surface so adapter routing and recording apply;
the engine's direct endpoint is for scoped diagnosis. Verify actual ports and selected images
in the stack files instead of copying defaults or checkpoint revisions into this skill.

The selected checkpoint, revision, quantization, profiles and adapter names come from
[saip.yaml](../../../saip.yaml). Hardware-dependent engine knobs belong to the active service
profile. Derive memory utilization from the profile's ceiling and measured total/free memory;
do not commit a universal utilization constant. Profile resolution fails closed when no tier
fits; do not raise a ceiling merely to suppress refusal or OOM symptoms.

Render engine arguments before bringing inference up. The generated engine-argument environment
file is local output, not committed configuration; regenerate it after relevant profile changes.
The [inference stack](../../../inference/docker-compose.yml) records the generate-before-start
contract, gateway-to-engine network address, cache volumes, health windows and runtime adapter
support. The [engine image](../../../inference/vllm.Dockerfile) owns startup/parser arguments and
its pinned base; remeasure affected profile claims before changing that pin. An incompatible
adapter is a compile/load contract defect, not permission to bypass engine checks. Retain the
stack's restrictions on DoRA and embedding/head modules.

## Diagnose within the user's scope

Inspect resolved arguments and engine logs for startup failures; distinguish memory refusal,
missing/generated configuration, cold loading and health-check timing. Do not assume every
restart is OOM. Offline model loading requires an already populated cache; an empty cache is
a missing prerequisite. Preserve cache and model/adapter data during troubleshooting.
Use [systematic-debugging](../systematic-debugging/SKILL.md) and report the configuration and
observed result rather than declaring a universal runtime limitation.

## Canonical references

- [Local deployment](../../../docs/src/content/docs/guides/deploy-local.mdx): prerequisites,
  operator commands, credentials and stack lifecycle.
- [CLI reference](../../../docs/src/content/docs/guides/cli-reference.mdx): actual options/output.
- [Hardware profiles](../../../docs/src/content/docs/reference/hardware-profiles.mdx): measured
  tiers, memory constraints, checkpoint and adapter compatibility, version drift.
- [Inference ownership](../../../inference/README.md) and
  [training stack](../../../training/docker-compose.yml): service boundaries and configuration.

Use those maintained references for command/configuration examples. This skill preserves
operational decisions without duplicating recipes or installing a model/runtime dependency.
