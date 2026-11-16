import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseTitle, defaultNotes } from '../scripts/release-copy.mjs';

test('Stable release title and notes distinguish version status from Windows signing', () => {
  assert.equal(releaseTitle('1.0.0'), 'Bongo Cat Chat 1.0.0');
  assert.equal(releaseTitle('1.0.1'), 'Bongo Cat Chat 1.0.1');
  const notes = defaultNotes('1.0.0', 'a'.repeat(40), 'approved-v1.0.0-123-1', '123');
  assert.ok(notes.startsWith('# Bongo Cat Chat 1.0.0\n'));
  assert.ok(!notes.includes('개발판'));
  assert.ok(notes.includes('Windows Authenticode 미서명'));
  assert.ok(notes.includes('Ed25519'));
  assert.ok(notes.includes('approved-v1.0.0-123-1'));
});

test('Development titles remain explicit and invalid versions are rejected', () => {
  assert.equal(releaseTitle('0.1.0.dev34'), 'Bongo Cat Chat 0.1.0.dev34 개발판');
  assert.throws(() => releaseTitle('../1.0.0'));
});
