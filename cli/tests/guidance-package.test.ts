/** Acceptance checks for the instruction package agents actually discover (#203). */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { parse } from 'yaml'

const repoRoot = resolve(import.meta.dirname, '../..')
const skillsRoot = join(repoRoot, '.dsh/skills')

/** Check a skill's public metadata, prose-only body and filesystem references. */
function auditSkill(text: string, file: string): string[] {
  const problems: string[] = []
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!front) return ['missing frontmatter']
  try {
    const meta = parse(front[1]!) as { name?: unknown; description?: unknown } | null
    if (meta?.name !== basename(dirname(file))) problems.push('name does not match directory')
    if (typeof meta?.description !== 'string' || !meta.description.trim()) problems.push('missing description')
  } catch { problems.push('invalid YAML') }
  const body = text.slice(front[0].length)
  if (/^\s*(?:`{3,}|~{3,})|^(?: {4}|\t)\S/m.test(body)) problems.push('code example')
  problems.push(...missingLinks(body, file))
  return problems
}

/** Resolve local instruction links; network claims are outside this filesystem check. */
function missingLinks(text: string, file: string): string[] {
  const problems: string[] = []
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1]!
    if (/^[a-z][a-z\d+.-]*:/i.test(target)) continue
    const [path, anchor] = target.split('#')
    const destination = path ? resolve(dirname(file), path) : file
    if (!existsSync(destination)) { problems.push(`missing link: ${target}`); continue }
    if (anchor) {
      const headings = [...readFileSync(destination, 'utf8').matchAll(/^#+\s+(.+)$/gm)]
      const ids = headings.map((heading) => heading[1]!.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/ /g, '-'))
      if (!ids.includes(anchor)) problems.push(`missing anchor: ${target}`)
    }
  }
  return problems
}

describe('discoverable agent guidance package (#203)', () => {
  it('checks the installed collection and root links rather than sample text alone', () => {
    const skills = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, 'SKILL.md')))
      .map((entry) => join(skillsRoot, entry.name, 'SKILL.md'))
    expect(skills.length).toBeGreaterThan(10)
    expect(skills.some((file) => file.endsWith('/local-llm/SKILL.md'))).toBe(true)
    const problems = skills.flatMap((file) => auditSkill(readFileSync(file, 'utf8'), file).map((p) => `${file}: ${p}`))
    const root = join(repoRoot, 'AGENTS.md')
    problems.push(...missingLinks(readFileSync(root, 'utf8'), root))
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('rejects invalid metadata and missing resources with independent failure controls', () => {
    const file = join(skillsRoot, 'local-llm/SKILL.md')
    expect(auditSkill('no metadata', file)).toContain('missing frontmatter')
    expect(auditSkill('---\nname: [\n---\n', file)).toContain('invalid YAML')
    expect(auditSkill('---\nname: other\ndescription: ""\n---\n', file))
      .toEqual(['name does not match directory', 'missing description'])
    const valid = '---\nname: local-llm\ndescription: Operational guidance\n---\n'
    expect(auditSkill(valid + '[root](../../../AGENTS.md)', file)).toEqual([])
    expect(auditSkill(valid + '[resource](missing-resource-203.md)', file)).toContain('missing link: missing-resource-203.md')
    expect(auditSkill(valid + '[root](../../../AGENTS.md#missing-heading-203)', file))
      .toContain('missing anchor: ../../../AGENTS.md#missing-heading-203')
  })

  it('rejects fenced and indented code while allowing metadata and prose', () => {
    const file = join(skillsRoot, 'local-llm/SKILL.md')
    const valid = '---\nname: local-llm\ndescription: Operational guidance\n---\n'
    expect(auditSkill(valid + 'Read the project configuration.', file)).toEqual([])
    for (const code of ['```text\nexample\n```', '~~~\nexample\n~~~', '    example']) {
      expect(auditSkill(valid + code, file)).toContain('code example')
    }
  })
})
