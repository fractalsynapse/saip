# Agent guidance migration

Issue: #203. The user approved adopting the completed starter procedures while
preserving SAIP-specific directives. This document records the intended change,
directive mapping and validation; it is development documentation, not runtime policy.

## Source and scope

Use the starter at commit 92cf2d08fa28a7f4383bd34f4500193bcdfdb31a from
[its canonical repository](https://github.com/fractalsynapse/scaffold).
Import its twelve self-contained skills into SAIP's existing .dsh/skills location,
preserving root references and adding no agent-host dependency. Keep the SAIP local-model
skill as the thirteenth entry. Adapt root links to this directory; never copy the
starter repository's maintenance policy, CI exception, branch state or license decision.

Application architecture, runtime code, manifests, lockfiles, CI definitions and live
services are outside this change. Existing provenance/vocabulary tests may be adapted
where they depend on a removed helper or assume an installed skill is unavailable.
Preserve positive/negative controls and the scope of those guards. Add an instruction
package check to the existing test runner for metadata, references and code-free skills.

## Directive preservation matrix

The following destinations refer to sections in the revised root AGENTS.md. Incidents
and issue references are retained here as evidence without copying their implementations.

| Existing directive | Revised destination and treatment |
| --- | --- |
| Development-only scope; target projects have their own private instructions. | Scope and authority: retain runtime independence and fixture isolation; explicitly allow development-only instruction validation and intentional context-pack generation. |
| Load release procedure at start and before PR; issue before edits; branch from current staging; no direct staging/main work. | Development and integration: retain gates for changes; explicitly exclude read-only audits. |
| Agent staging integration; no agent approval/main merge; CI, acceptance and review gates. | Development and integration: retain all gates, including unavailable required CI as outstanding. No inherited CI waiver. |
| Delete merged branch remotely/locally; prune/read back; check other open PRs; squash caveat. | Development and integration: retain, restricted to task-owned branch with unchanged head and verified merge/worktree checks. |
| Issue closure at release; derive closing list from shipping PRs; hold unchecked criteria. | Releases and changelogs: retain, pin candidate/range and check real acceptance; empty criteria are insufficient. |
| Plan/issue, documentation committed before behavior code, tests outside-in, implementation, review/CI. | Development and integration / Testing and documented contracts: retain for behavior changes. Pure guidance/prose uses artifact-specific checks, not invented application tests. |
| Documented options/output are executable contracts; no invented transcripts. | Testing and documented contracts: retain built-program parity and proposed-vs-shipped distinction; evidence #114, #149, #162, #179. |
| Every injectable seam needs default production construction; run programs as programs. | Testing and documented contracts: retain all production paths, actual installation/entry behavior and artifact evidence; no fake-only acceptance. |
| Every new documented capability needs a failing observable test before implementation. | Testing and documented contracts: retain. Existing behavior and prose corrections do not require artificial failures. |
| Hermetic tests; shared ambient-variable isolation; explicitly supplied environment. | Testing and documented contracts: retain actual isolation file and failure diagnosis; evidence #138. |
| Unit/integration, clean build, CI and assembled smoke are distinct gates. | Testing and documented contracts: retain for executable changes; report missing, failed, skipped and inapplicable separately. |
| Process review for escapes, repeated mistakes, unchecked delivered promises or skippable steps. | Research and process improvement: retain pattern/cost/cheapest check and separate issue; no unrelated process expansion. |
| Research before uncertain external claims/limits; record exact negative configuration; untrusted search input. | Research and process improvement: retain, using available tools rather than fixed host tool names; evidence #71, #88, #103. |
| Unreleased changelog per visible PR, issue reference, independently versioned package ownership and root cross-cutting entries. | Releases and changelogs: retain, one entry per PR and actual ownership; no version bump for this guidance change. |
| Internal and wrapped monorepo projects share process, retain package-specific toolchains and tests. | Architecture and ownership: retain both categories and ownership. |
| CLI/shared/inference/training compose via Cordis; capabilities are plugins/injectable services. | Architecture and ownership: retain existing architecture, provider seams and extension rule. |
| Deployment/auth/monitoring seams; hosts schema/registry; secrets by name; billable infrastructure gate; authenticated API/MCP. | Security and infrastructure: retain every restriction, including fail-closed behavior and explicit provisioning authority. |
| Load relevant context pack; verify source commit; regenerate stale packs and check generation after significant docs changes. | Documentation and context packs: retain, distinguish intentionally exported development context from a runtime dependency; never commit generated packs. |
| HTTPS-only remote, authentication recovery without SSH fallback. | Development and integration: retain protocol; use verified canonical repository identity. |
| Three equivalent failed attempts trigger diagnosis/change of approach; polling excluded. | Research and process improvement: retain and communicate the change of approach. |

The generic root's architecture-neutral opening is not copied over SAIP's chosen
architecture. Root policy remains authoritative over skill procedures. Repeated
approval workshops and verification per conversation message are removed; existing
authorization and still-valid evidence are reused without weakening the gates above.

## Delivery plan

1. Commit this intent and mapping before changing guidance or tests.
2. Record baseline reader scenarios and run existing provenance/vocabulary checks.
   Add failing artifact checks for the instruction-package contract before implementation.
3. Refresh shared skills from the pinned source, reconcile root policy, shorten local-model
   guidance to operational decisions and canonical references, and remove obsolete resources.
4. Adapt guards with regression controls for legitimate installed skills and removed-helper
   independence. Keep the historical foreign-vocabulary list and exemption narrow.
5. Validate metadata/links/code-free skills, artifact checks, package tests and documentation
   build/context packs. Review SAIP-specific decisions and the complete preservation matrix.
6. Open an issue-linked staging PR with results. Hosted checks and required review remain
   integration gates; do not merge or waive them merely because the starter had an exception.

## Decision scenarios

Evaluate an approved prose correction, a new provider, an external API reference update,
environment contamination with unrelated edits, provisioning without billable authorization,
a one-PR CI inspection, an advancing release candidate and setup in an existing project.
The review must preserve architecture, user work and actual authority, retain meaningful
behavior tests, and avoid redundant approval loops. Reader walkthroughs establish proposed
decisions, not downstream execution or universal agent compliance.
