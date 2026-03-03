import { describe, expect, it } from 'vitest'

import { extractAssemblyUrl, getAssemblyState, getSignature } from '../src/index.ts'

describe('getSignature', () => {
  it('creates a sha1 hmac signature', () => {
    const signature = getSignature('foo_secret', '{"ok":"ASSEMBLY_COMPLETED"}')
    expect(signature).toBe('9c31e806b2f3ac4d7cf69d7c29ccf6806b9ee073')
  })
})

describe('extractAssemblyUrl', () => {
  it('extracts assembly_url from proxy payload', () => {
    expect(extractAssemblyUrl('{"assembly_url":"https://example.test/a/123"}')).toBe(
      'https://example.test/a/123',
    )
  })

  it('returns null for invalid payloads', () => {
    expect(extractAssemblyUrl('nope')).toBeNull()
    expect(extractAssemblyUrl('{"foo":"bar"}')).toBeNull()
  })
})

describe('getAssemblyState', () => {
  it('accepts known states', () => {
    expect(getAssemblyState({ ok: 'ASSEMBLY_COMPLETED' })).toBe('ASSEMBLY_COMPLETED')
    expect(getAssemblyState({ ok: 'ASSEMBLY_CANCELED' })).toBe('ASSEMBLY_CANCELED')
    expect(getAssemblyState({ ok: 'REQUEST_ABORTED' })).toBe('REQUEST_ABORTED')
    expect(getAssemblyState({ ok: 'ASSEMBLY_UPLOADING' })).toBe('ASSEMBLY_UPLOADING')
    expect(getAssemblyState({ ok: 'ASSEMBLY_EXECUTING' })).toBe('ASSEMBLY_EXECUTING')
    expect(getAssemblyState({ ok: 'ASSEMBLY_REPLAYING' })).toBe('ASSEMBLY_REPLAYING')
  })

  it('rejects unknown states', () => {
    expect(() => getAssemblyState({ ok: 'UNKNOWN' })).toThrow('Unknown Assembly state found')
  })

  it('rejects malformed payloads', () => {
    expect(() => getAssemblyState(null)).toThrow('No ok field found')
  })
})
