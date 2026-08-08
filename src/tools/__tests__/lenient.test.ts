import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  lenientBoolean,
  lenientNumber,
  lenientPositiveNumber,
  lenientString,
} from '../lenient.js'

describe('lenientString', () => {
  it('passes strings through unchanged', () => {
    assert.equal(lenientString('abc'), 'abc')
    assert.equal(lenientString('  spaced  '), '  spaced  ')
    assert.equal(lenientString(''), '')
  })

  it('coerces numbers and booleans via String()', () => {
    assert.equal(lenientString(123), '123')
    assert.equal(lenientString(0), '0')
    assert.equal(lenientString(true), 'true')
    assert.equal(lenientString(false), 'false')
  })

  it('returns undefined for everything else', () => {
    assert.equal(lenientString(undefined), undefined)
    assert.equal(lenientString(null), undefined)
    assert.equal(lenientString({}), undefined)
    assert.equal(lenientString([]), undefined)
  })
})

describe('lenientNumber', () => {
  it('passes finite numbers through', () => {
    assert.equal(lenientNumber(3.5), 3.5)
    assert.equal(lenientNumber(10), 10)
    assert.equal(lenientNumber(0), 0)
    assert.equal(lenientNumber(-1), -1)
  })

  it('parses numeric strings (including decimals)', () => {
    assert.equal(lenientNumber('10'), 10)
    assert.equal(lenientNumber('3.5'), 3.5)
    assert.equal(lenientNumber('-2'), -2)
  })

  it('rejects non-finite numbers and non-numeric strings', () => {
    assert.equal(lenientNumber(Infinity), undefined)
    assert.equal(lenientNumber(-Infinity), undefined)
    assert.equal(lenientNumber(NaN), undefined)
    assert.equal(lenientNumber('abc'), undefined)
    assert.equal(lenientNumber('10x'), undefined)
  })

  it('rejects empty/blank strings (never coerces "" to 0)', () => {
    assert.equal(lenientNumber(''), undefined)
    assert.equal(lenientNumber('   '), undefined)
  })

  it('returns undefined for non-number-ish inputs', () => {
    assert.equal(lenientNumber(undefined), undefined)
    assert.equal(lenientNumber(null), undefined)
    assert.equal(lenientNumber(true), undefined)
    assert.equal(lenientNumber({}), undefined)
  })
})

describe('lenientPositiveNumber', () => {
  it('accepts numbers ≥ 1 (numbers and numeric strings)', () => {
    assert.equal(lenientPositiveNumber(10), 10)
    assert.equal(lenientPositiveNumber(1), 1)
    assert.equal(lenientPositiveNumber('5'), 5)
  })

  it('rejects 0 and negatives', () => {
    assert.equal(lenientPositiveNumber(0), undefined)
    assert.equal(lenientPositiveNumber(-1), undefined)
    assert.equal(lenientPositiveNumber('-1'), undefined)
  })

  it('rejects non-numeric input', () => {
    assert.equal(lenientPositiveNumber('abc'), undefined)
    assert.equal(lenientPositiveNumber(undefined), undefined)
  })
})

describe('lenientBoolean', () => {
  it('passes booleans through', () => {
    assert.equal(lenientBoolean(true), true)
    assert.equal(lenientBoolean(false), false)
  })

  it('accepts truthy string forms (case-insensitive)', () => {
    assert.equal(lenientBoolean('true'), true)
    assert.equal(lenientBoolean('1'), true)
    assert.equal(lenientBoolean('yes'), true)
    assert.equal(lenientBoolean('True'), true)
    assert.equal(lenientBoolean('YES'), true)
  })

  it('accepts falsy string forms', () => {
    assert.equal(lenientBoolean('false'), false)
    assert.equal(lenientBoolean('0'), false)
    assert.equal(lenientBoolean('no'), false)
  })

  it('returns undefined for everything else', () => {
    assert.equal(lenientBoolean('abc'), undefined)
    assert.equal(lenientBoolean(''), undefined)
    assert.equal(lenientBoolean(1), undefined)
    assert.equal(lenientBoolean(0), undefined)
    assert.equal(lenientBoolean(undefined), undefined)
    assert.equal(lenientBoolean(null), undefined)
  })
})
