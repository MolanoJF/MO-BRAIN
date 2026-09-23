import { test, expect } from 'bun:test';
import { groupByZone } from '../../src/console/shell/zones.ts';

const s = (sourceId: string, zone: 'personal' | 'company') =>
  ({ id: sourceId, sourceId, name: sourceId, access: 'write' as const, zone });

test('My Brain first, then Company, empty groups omitted', () => {
  expect(groupByZone([s('kb', 'company'), s('mine', 'personal')])).toEqual([
    { label: 'My Brain', spaces: [s('mine', 'personal')] },
    { label: 'Company', spaces: [s('kb', 'company')] },
  ]);
  expect(groupByZone([s('mine', 'personal')])).toEqual([{ label: 'My Brain', spaces: [s('mine', 'personal')] }]);
});
