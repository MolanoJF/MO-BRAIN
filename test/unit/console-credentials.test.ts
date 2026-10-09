import { describe, expect, test } from 'bun:test';
import {
  anthropicKeyError, credentialStatusText, githubSaveText, githubTokenError, openaiKeyError,
} from '../../src/console/pages/Credentials.tsx';

describe('credentialStatusText', () => {
  test('not set', () => {
    expect(credentialStatusText({ configured: false, updatedAt: null, version: null })).toBe('Not set');
  });
  test('configured shows date and version, nothing of the value', () => {
    expect(credentialStatusText({ configured: true, updatedAt: '2026-10-09T12:00:00.000Z', version: 2 }))
      .toBe('Configured · updated 2026-10-09 · v2');
  });
  test('configured with no usable date still reads cleanly', () => {
    expect(credentialStatusText({ configured: true, updatedAt: 'garbage', version: null })).toBe('Configured');
  });
});

describe('validation', () => {
  test('github token', () => {
    expect(githubTokenError('')).not.toBeNull();
    expect(githubTokenError('a b')).not.toBeNull();
    expect(githubTokenError(' ghp_abc ')).toBeNull();
  });
  test('anthropic key must start with sk-ant-', () => {
    expect(anthropicKeyError('sk-proj-1')).toMatch(/sk-ant-/);
    expect(anthropicKeyError('')).not.toBeNull();
    expect(anthropicKeyError('sk-ant-oat01-xyz')).toBeNull();
  });
  test('openai key', () => {
    expect(openaiKeyError('')).not.toBeNull();
    expect(openaiKeyError('sk-abc')).toBeNull();
  });
});

describe('githubSaveText', () => {
  test('plain save', () => {
    expect(githubSaveText({ refreshed: [], failed: [] })).toBe('Saved.');
  });
  test('reports refreshed and failed remotes', () => {
    const t = githubSaveText({ refreshed: ['a', 'b'], failed: [{ sourceId: 'c', error: 'boom' }] });
    expect(t).toMatch(/2 Sources/);
    expect(t).toMatch(/c \(boom\)/);
  });
});
