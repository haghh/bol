import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCombo } from './keys'

test('parses combos, modifiers first', () => {
	assert.deepEqual(parseCombo({ text: 'ctrl+shift+t' }).vks, [0x11, 0x10, 0x54])
	assert.deepEqual(parseCombo({ text: 'alt+F4' }).vks, [0x12, 0x73])
	assert.deepEqual(parseCombo({ text: 'win+d' }).vks, [0x5b, 0x44])
	assert.deepEqual(parseCombo({ text: 'Enter' }).vks, [0x0d])
	assert.deepEqual(parseCombo({ text: 'page_down' }).vks, [0x22])
	assert.deepEqual(parseCombo({ text: 'ctrl++' }).vks, [0x11, 0xbb])
})

test('maps Mac habits to Windows', () => {
	assert.deepEqual(parseCombo({ text: 'cmd+c' }).vks, [0x11, 0x43])
	assert.deepEqual(parseCombo({ text: 'return' }).vks, [0x0d])
})

test('reports unknown keys, and asks the layout for punctuation', () => {
	assert.deepEqual(parseCombo({ text: 'ctrl+banana' }).unknown, ['banana'])
	assert.deepEqual(parseCombo({ text: 'ctrl+/' }).unknown, ['/'])
	assert.deepEqual(parseCombo({ text: 'ctrl+/', lookup: () => 0xbf }).vks, [0x11, 0xbf])
})
