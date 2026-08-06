import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const agents = readFileSync(resolve(process.cwd(), 'AGENTS.md'), 'utf8')
const contract = readFileSync(resolve(process.cwd(), 'docs/agents/agent-delivery.md'), 'utf8')

describe('agent ticket delivery contract', () => {
  it('is discoverable from the repository instructions', () => {
    expect(agents).toContain('docs/agents/agent-delivery.md')
  })

  it('defines the issue-branch delivery lifecycle and handoff evidence', () => {
    expect(contract).toMatch(/its own issue branch/i)
    expect(contract).toMatch(/latest `origin\/main`/i)
    expect(contract).toMatch(/blockers?.+integrated.+verified/is)
    expect(contract).toMatch(/never.+reuse.+branch/is)
    expect(contract).toMatch(/never.+merge.+sibling/is)

    for (const field of [
      'Issue',
      'Branch',
      'Remote branch',
      'Base commit',
      'Head commit',
      'Change summary',
      'Verification results',
      'Push verification',
    ]) {
      expect(contract).toContain(`- ${field}:`)
    }

    expect(contract).toMatch(/integrator.+dependency order/is)
    expect(contract).toContain('test -z "$(git status --short)"')
    expect(contract).toContain('git push --set-upstream origin "$branch"')
    expect(contract).toContain('git ls-remote --exit-code origin "refs/heads/$branch"')
    expect(contract).toMatch(/local-only.+unpushed.+not ready/is)
    expect(contract).toMatch(/downstream.+blocked.+integration.+passes/is)
    expect(contract).toMatch(/cleanup/i)
  })
})
