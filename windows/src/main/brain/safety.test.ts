import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkCommand } from './safety'

const cwd = join(homedir(), '.bol', 'workspace')
const blocked = (command: string) => checkCommand({ command, cwd }) != null

test('refuses the hard-block list', () => {
	for (const command of [
		'format D: /q',
		'powershell -Command "Format-Volume -DriveLetter E"',
		'Clear-Disk -Number 1 -RemoveData',
		'diskpart /s wipe.txt',
		'cipher /w:C:\\',
		'vssadmin delete shadows /all',
		'wmic shadowcopy delete',
		'bcdedit /delete {current}',
		'powershell Clear-RecycleBin -Force',
		'reg delete HKLM\\SOFTWARE /f',
		'reg delete "HKCU\\Software" /f',
		'reg delete HKEY_LOCAL_MACHINE /f',
		'Remove-Item -Recurse HKLM:\\SOFTWARE',
	])
		assert.ok(blocked(command), command)
})

test('refuses recursive deletes of protected folders', () => {
	for (const command of [
		'rm -rf ~',
		'rm -rf ~/',
		'rm -rf ~/Documents',
		'rm -r "$HOME/Desktop"',
		'Remove-Item -Recurse -Force $env:USERPROFILE\\Downloads',
		'rm -rf ~/Pictures/*',
	])
		assert.ok(blocked(command), command)
})

test('lets ordinary commands through', () => {
	for (const command of [
		'ls -la',
		'git status',
		'rm -rf node_modules',
		'rm -rf ./build',
		'rm -rf ~/projects/app/dist',
		'reg query HKLM\\SOFTWARE\\Microsoft',
		'reg delete HKCU\\Software\\MyApp\\Cache /f',
		'Remove-Item -Recurse .\\tmp',
		'cmd /c rd /s /q build',
		'echo format is fine',
		'Get-Volume',
	])
		assert.equal(checkCommand({ command, cwd }), null, command)
})

test('understands Windows spellings of protected folders', { skip: process.platform !== 'win32' }, () => {
	for (const command of [
		'rd /s /q C:\\',
		'rd /s /q C:\\Windows',
		'del /s /q C:\\*',
		'rm -rf /c/',
		'rm -rf /c/Users',
		'Remove-Item -Recurse -Force "C:\\Program Files"',
		'rm -rf /',
	])
		assert.ok(blocked(command), command)
})
