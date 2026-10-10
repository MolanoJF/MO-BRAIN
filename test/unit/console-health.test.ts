import { describe, expect, test } from 'bun:test';
import { pinText, runnerText } from '../../src/console/pages/Health.tsx';

describe('health rows', () => {
  test('the pin is green only when the running gbrain matches', () => {
    expect(pinText({ declared: '0.60.115.0', observed: '0.60.115.0', matches: true }, null))
      .toEqual({ tone: 'ok', text: '0.60.115.0 (running)' });
    expect(pinText({ declared: '0.60.115.0', observed: '0.50.5.0', matches: false }, null))
      .toEqual({ tone: 'danger', text: 'expects 0.60.115.0, running 0.50.5.0' });
    expect(pinText({ declared: '0.60.115.0', observed: null, matches: null }, null).tone).toBe('warning');
  });

  test('the runner is off by default, green only when connected', () => {
    expect(runnerText({ state: 'disabled', lastSeenAt: null, version: null })).toEqual({ tone: 'neutral', text: 'off' });
    expect(runnerText({ state: 'connected', lastSeenAt: null, version: '2.1.274' }))
      .toEqual({ tone: 'ok', text: 'connected (2.1.274)' });
    expect(runnerText({ state: 'never_claimed', lastSeenAt: null, version: null }))
      .toEqual({ tone: 'warning', text: 'never claimed' });
  });
});
