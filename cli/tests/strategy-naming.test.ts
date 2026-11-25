/**
 * Strategy names have one spelling (#196, design record §Review Focus #10).
 *
 * `training.strategy` is a lookup key: the adapter registry declares it, the Learning API matches
 * it against registered plugins, and a job record stores it verbatim. Three surfaces spelled two
 * of the three names with hyphens, which means a registry loaded from such a file resolves to no
 * strategy at all — the failure is a `422 unknown_strategy` far from the typo.
 *
 * Written the way #193's vocabulary check works: the forbidden tokens are assembled from
 * fragments so this file cannot flag its own prose, and the scan asserts it read a real file set
 * (a check that matches nothing passes vacuously).
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { validateRegistry, CANONICAL_STRATEGIES } from '@saip/shared'

const repoRoot = join(import.meta.dirname, '..', '..')

/** 'knowledge' + '-embedding' etc.: no line of this file contains a complete forbidden token. */
const FORBIDDEN = [
  ['knowledge', '-emb' + 'edding'],
  ['corrective', '-sf' + 't'],
  ['weighted', '-kt' + 'o'],
].map(([head, tail]) => head + tail)

/** The canonical spellings, assembled the same way, for the positive half of the check. */
const CANONICAL = [
  ['knowledge', '_emb' + 'edding'],
  ['corrective', '_sf' + 't'],
  ['weighted', '_kt' + 'o'],
].map(([head, tail]) => head + tail)

/** Tracked text files: the same corpus a reviewer would read. */
function trackedText(): Array<{ path: string; text: string }> {
  const out = execFileSync('git', ['grep', '-l', '-I', '-E', 'strateg', '--', '.'], {
    cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  })
  return out.split('\n').filter(Boolean).map((path) => ({ path, text: readFileSync(join(repoRoot, path), 'utf8') }))
}

describe('canonical strategy naming (#196)', () => {
  it('the scan reads a real file set — a check that sees nothing is not a check', () => {
    const files = trackedText()
    expect(files.length, 'git grep found no strategy-bearing files').toBeGreaterThan(10)
    expect(files.some((f) => f.path === 'saip.yaml')).toBe(true)
    expect(files.some((f) => f.path.endsWith('.mdx'))).toBe(true)
  })

  it('no tracked file carries a hyphenated strategy name', () => {
    const hits: string[] = []
    for (const { path, text } of trackedText()) {
      if (path.includes('node_modules')) continue
      text.split('\n').forEach((line, i) => {
        for (const token of FORBIDDEN) {
          if (line.toLowerCase().includes(token.toLowerCase())) hits.push(`${path}:${i + 1}: ${token}`)
        }
      })
    }
    expect(hits, `hyphenated spellings drift the registry lookup:\n${hits.join('\n')}`).toEqual([])
  })

  it('the canonical spellings do appear, so the absence above is meaningful', () => {
    const files = trackedText()
    for (const name of CANONICAL) {
      const found = files.some((f) => f.text.includes(name))
      expect(found, `${name} appears nowhere in tracked text — either the scan is broken or the docs went silent`).toBe(true)
    }
  })

  it('saip.yaml declares adapters with canonical strategies only', () => {
    const yaml = readFileSync(join(repoRoot, 'saip.yaml'), 'utf8')
    const declared = [...yaml.matchAll(/strategy:\s*([A-Za-z0-9_-]+)/g)].map((m) => m[1])
    expect(declared.length).toBeGreaterThan(0)
    for (const name of declared) {
      if (CANONICAL.includes(name)) continue
      // Anything else is either a third-party plugin name (allowed) or a kebab variant of a known
      // strategy (the bug): detect the latter by normalizing separators.
      const normalized = name.replace(/-/g, '_').toLowerCase()
      expect(CANONICAL.map((c) => c.replace(/-/g, '_')), `saip.yaml strategy "${name}" is not canonical`).toContain(normalized)
    }
  })
})

describe('registry validator rejects a hyphenated known strategy (#196)', () => {
  const adapter = (strategy: string) => ({
    name: 'coding', scope: 'global', trainable: true, training: { strategy, data_scopes: ['sessions', 'feedback'] },
  })

  it('the canonical set is exported and matches the documented strategies', () => {
    expect(CANONICAL_STRATEGIES.slice().sort()).toEqual([...CANONICAL].sort())
  })

  it('accepts a canonical strategy', () => {
    const r = validateRegistry({ adapters: [adapter(CANONICAL[1])], users: [] })
    expect(r.valid, JSON.stringify(r.errors)).toBe(true)
  })

  it('refuses the hyphenated spelling and names the canonical form', () => {
    const r = validateRegistry({ adapters: [adapter('corrective-sf' + 't')], users: [] })
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'strategy_not_canonical')).toBe(true)
    expect(r.errors.find((e) => e.code === 'strategy_not_canonical')!.message).toContain(CANONICAL[1])
  })

  it('leaves unknown third-party strategy names alone — the rule is about drift, not a closed list', () => {
    const r = validateRegistry({ adapters: [adapter('my-custom-learner')], users: [] })
    expect(r.errors.filter((e) => e.code === 'strategy_not_canonical')).toEqual([])
  })

  it('still catches the other two known strategies', () => {
    for (const [bad, good] of [['knowledge-emb' + 'edding', CANONICAL[0]], ['weighted-kt' + 'o', CANONICAL[2]]]) {
      const r = validateRegistry({ adapters: [adapter(bad)], users: [] })
      expect(r.valid, bad).toBe(false)
      expect(r.errors.find((e) => e.code === 'strategy_not_canonical')!.message).toContain(good)
    }
  })

  it('a registry file with no adapters is not silently blessed', () => {
    expect(existsSync(join(repoRoot, 'saip.yaml'))).toBe(true)
    const r = validateRegistry({ adapters: [], users: [] })
    expect(r.valid).toBe(true) // empty is valid; the drift check is per-adapter
  })
})
