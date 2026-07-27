import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sandboxIncompatibleCommand } from '../sandbox-incompatible.js'

describe('sandboxIncompatibleCommand', () => {
  const incompatible: ReadonlyArray<[string, string]> = [
    ['sudo rm -rf /var/log/old', 'sudo'],
    ['brew install ripgrep', 'brew'],
    ['docker build -t app .', 'docker'],
    ['podman compose up -d', 'docker'],
    ['npm install -g tsx', 'npm-global'],
    ['pnpm add --global vercel', 'npm-global'],
    ['codesign --force --sign - ./app', 'codesign'],
    ['xcrun notarytool submit app.zip', 'notarize'],
    ['softwareupdate --install-rosetta', 'system-update'],
    ['nvm install 24', 'version-manager'],
    ['echo hi && sudo tee /etc/hosts', 'sudo'],
  ]
  for (const [cmd, id] of incompatible) {
    it(`flags ${JSON.stringify(cmd)} as ${id}`, () => {
      const m = sandboxIncompatibleCommand(cmd)
      assert.ok(m, 'expected a match')
      assert.equal(m.id, id)
      assert.ok(m.reason.length > 0)
    })
  }

  const compatible: readonly string[] = [
    'npm run build',
    'npm install',              // local install is coverable
    'cargo build --release',
    'docker --version',         // read-only invocation
    'git commit -m "x"',
    'echo sudo is a word here', // not at a command position
    'pnpm add lodash',          // local add, no --global
    'ls -la',
  ]
  for (const cmd of compatible) {
    it(`leaves ${JSON.stringify(cmd)} to the sandbox`, () => {
      assert.equal(sandboxIncompatibleCommand(cmd), null)
    })
  }
})
