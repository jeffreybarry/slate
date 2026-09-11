import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { npmShimEntry, resolveCli } from '../src/main/brain'

describe('brain CLI resolution', () => {
  it('reads the JS entry point out of an npm Windows shim', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-shim-'))
    mkdirSync(join(dir, 'node_modules', 'fake-cli'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'fake-cli', 'cli.js'), '// stub\n')
    writeFileSync(
      join(dir, 'fake.cmd'),
      '@ECHO off\r\nSET dp0=%~dp0\r\n"%_prog%"  "%dp0%\\node_modules\\fake-cli\\cli.js" %*\r\n'
    )
    expect(npmShimEntry(join(dir, 'fake.cmd'))).toBe(join(dir, 'node_modules', 'fake-cli', 'cli.js'))
  })

  it('returns null for a shim that is not an npm wrapper', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-shim-'))
    writeFileSync(join(dir, 'other.cmd'), '@ECHO off\r\necho hi\r\n')
    expect(npmShimEntry(join(dir, 'other.cmd'))).toBeNull()
  })

  it('falls back to the bare name when nothing is installed', () => {
    const r = resolveCli('definitely-not-a-real-cli-xyz')
    expect(r.file).toBe('definitely-not-a-real-cli-xyz')
    expect(r.args).toEqual([])
  })

  it.runIf(process.platform === 'win32')('resolves an installed claude shim to node + cli.js on Windows', () => {
    const r = resolveCli('claude')
    // Only meaningful when Claude Code is installed via npm on this machine.
    if (r.file === 'claude') return
    expect(r.file.toLowerCase()).toMatch(/node(\.exe)?$/)
    expect(r.args[0]).toMatch(/cli\.js$/)
  })
})
