import { test, expect, describe } from 'bun:test';
import { mcpPaste } from '../../src/console/pages/Mcp.tsx';

/**
 * The page renders whatever this returns. A handoff with no secret must not
 * come back as a blank document an agent could be told to paste.
 */

const payload = {
  mcp_url: 'https://brain.example/mcp',
  harness: 'generic',
  credentials: {
    version: 1,
    mcp_url: 'https://brain.example/mcp',
    client_id: 'gbrain_cl_example',
    client_secret: 'secret-value-not-empty',
  },
  snippet: 'Copy/paste this MCP config fragment into the harness.',
};

describe('mcpPaste: the three strings a successful payload becomes', () => {
  test('URL, credential JSON, and snippet are the three strings', () => {
    const paste = mcpPaste(payload);
    expect(paste).toEqual({
      endpoint: 'https://brain.example/mcp',
      credentialJson: JSON.stringify(payload.credentials, null, 2),
      snippet: payload.snippet,
    });
    expect(paste!.credentialJson).toContain('gbrain_cl_example');
    expect(paste!.credentialJson).toContain('secret-value-not-empty');
  });

  test('a missing secret is not rendered as an empty config', () => {
    const { client_secret: _secret, ...withoutSecret } = payload.credentials;
    const missing = mcpPaste({ ...payload, credentials: withoutSecret });
    const emptySecret = mcpPaste({
      ...payload,
      credentials: { ...payload.credentials, client_secret: '' },
    });
    const emptyObject = mcpPaste({ ...payload, credentials: {} });
    const noCredentials = mcpPaste({ ...payload, credentials: null });

    for (const result of [missing, emptySecret, emptyObject, noCredentials]) {
      expect(result).toBeNull();
      expect(result).not.toEqual({ endpoint: '', credentialJson: '', snippet: '' });
      expect(result).not.toEqual({ endpoint: '', credentialJson: '{}', snippet: '' });
      expect(result).not.toEqual({
        endpoint: payload.mcp_url,
        credentialJson: '{}',
        snippet: payload.snippet,
      });
    }
  });
});
