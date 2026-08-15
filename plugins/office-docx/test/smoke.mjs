// office-docx smoke test: docx_create → docx_read round-trip + error paths.
// Run: node test/smoke.mjs

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tools } from '../index.js'

const byName = Object.fromEntries(tools.map(t => [t.definition.name, t]))
let passed = 0
let failed = 0

function check(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'office-docx-smoke-'))

try {
  console.log('1. docx_create generates a document')
  const created = await byName.docx_create.execute({
    destination_path: join(dir, 'doc.docx'),
    title: 'Smoke Report',
    content: [
      { type: 'heading', text: 'Summary' },
      { type: 'paragraph', text: 'Body text' },
      { type: 'table', headers: ['A', 'B'], rows: [['1', '2']] },
      { type: 'list', items: ['x', 'y'] },
    ],
  })
  check('docx_create succeeded', !created.isError && existsSync(join(dir, 'doc.docx')), created.content)

  console.log('2. docx_read round-trips content')
  const read = await byName.docx_read.execute({ file_path: join(dir, 'doc.docx') })
  check('docx_read extracts title/heading/table', !read.isError
    && read.content.includes('Smoke Report')
    && read.content.includes('Summary')
    && read.content.includes('1'), read.content?.slice(0, 60))

  console.log('3. error paths')
  const missing = await byName.docx_read.execute({ file_path: join(dir, 'nope.docx') })
  check('docx_read missing file isError', missing.isError, missing.content)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${failed === 0 ? '✅' : '❌'} office-docx smoke: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
