import { describe, expect, it } from 'vitest'

import { Works } from '../../collections/Works'

describe('Work collection edit view registration', () => {
  it('registers the unified Work media editor as the default edit view', () => {
    const component = Works.admin?.components?.views?.edit?.default?.Component
    expect(component).toBe('@/admin/work-editor/WorkEditView#WorkEditView')
  })
})
