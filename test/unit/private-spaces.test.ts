import { test, expect, describe } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { privateSpaceSourceId } from '../../src/control/privateSpaces.ts';

describe('privateSpaceSourceId', () => {
  test('is deterministic', () => {
    const membershipId = randomUUID();
    expect(privateSpaceSourceId(membershipId)).toBe(privateSpaceSourceId(membershipId));
  });

  test('is my-space- plus the first 8 hex chars of the membership id', () => {
    const membershipId = randomUUID();
    const sourceId = privateSpaceSourceId(membershipId);
    expect(sourceId).toMatch(/^my-space-[0-9a-f]{8}$/);
    expect(sourceId).toBe(`my-space-${membershipId.slice(0, 8).toLowerCase()}`);
  });

  test('differs for distinct memberships', () => {
    expect(privateSpaceSourceId(randomUUID())).not.toBe(privateSpaceSourceId(randomUUID()));
  });
});
