/**
 * The config schema is a claim, so it gets checked (#196).
 *
 * `saip.schema.yaml` opens by calling itself the "NORMATIVE SHAPE of the platform config" and warns
 * that `additionalProperties: false` means a new top-level key must be added there at the same time
 * it is implemented. Nothing had ever parsed the file: it contained a plain scalar with an inner
 * colon (`(reference: QuantTrio/…)`) that makes it unparseable YAML, and no test, script or runtime
 * path in any package referenced it. So the drift rule in its own header was unenforceable, and the
 * "add `libraries:` when you add `libraries:`" instruction was advice nobody could follow by
 * checking anything.
 *
 * These assertions do not pretend to be a JSON-Schema validator — the header is explicit that whole-
 * document validation does not exist. What they guarantee is the part that is cheap and load-bearing:
 * the file parses, the shipped config's keys are declared, the required keys are actually shipped,
 * and every declared section explains itself in a description a human can read.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml' // workspace dep: shared declares it; vitest resolves it from the root

const repoRoot = join(import.meta.dirname, '..', '..')
const schemaPath = join(repoRoot, 'saip.schema.yaml')
const configPath = join(repoRoot, 'saip.yaml')

const schema = parse(readFileSync(schemaPath, 'utf8')) as {
  required?: string[]
  properties?: Record<string, { description?: string; type?: string; properties?: Record<string, unknown> }>
  additionalProperties?: boolean
}
const config = parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>

describe('saip.schema.yaml is a real artifact (#196)', () => {
  it('parses as YAML — an unparseable normative shape is decoration', () => {
    expect(schema).toBeTypeOf('object')
    expect(schema.properties, 'no properties block').toBeTruthy()
  })

  it('every top-level key the shipped config uses is declared in the schema', () => {
    const declared = Object.keys(schema.properties ?? {})
    const used = Object.keys(config)
    const missing = used.filter((k) => !declared.includes(k))
    // This is the rule the file's own header states. It fails the moment someone adds a section to
    // saip.yaml and forgets the schema — which is how `libraries` would have slipped through.
    expect(missing, `saip.yaml keys absent from schema: ${missing.join(', ')}`).toEqual([])
  })

  it('every required schema key is actually present in the shipped config', () => {
    const required = schema.required ?? []
    expect(required.length).toBeGreaterThan(0)
    for (const key of required) {
      expect(config, `required key "${key}" missing from saip.yaml`).toHaveProperty(key)
    }
  })

  it('no declared section is left without a description', () => {
    const bare = Object.entries(schema.properties ?? {})
      .filter(([, def]) => !def?.description || !String(def.description).trim())
      .map(([k]) => k)
    expect(bare, `undocumented top-level sections: ${bare.join(', ')}`).toEqual([])
  })

  it('the schema keeps its closed-shape stance, so the key check above has teeth', () => {
    // If someone flips this to true, the drift assertion above stops meaning anything. Fail loudly
    // here instead of letting the guard rot quietly.
    expect(schema.additionalProperties).toBe(false)
  })
})

describe('libraries section (#196)', () => {
  it('declares the shape the docs describe', () => {
    const libs = schema.properties?.libraries as { items?: { properties?: Record<string, unknown>; required?: string[] } }
    expect(libs, 'schema has no `libraries` section').toBeTruthy()
    expect(libs.items?.required).toContain('name')
    expect(Object.keys(libs.items?.properties ?? {})).toEqual(expect.arrayContaining(['name', 'filter', 'description']))
    const filter = (libs.items?.properties as any)?.filter
    expect(Object.keys(filter?.properties ?? {})).toEqual(expect.arrayContaining(['tags', 'source_type', 'ids']))
  })

  it('is optional, so existing configs keep loading (#64 B3 non-breaking requirement)', () => {
    expect((schema.required ?? []).includes('libraries')).toBe(false)
    // And the shipped config does not use it yet — no breaking change to saip.yaml.
    expect(config).not.toHaveProperty('libraries')
  })
})
