import { test, expect, describe } from 'bun:test';
import { phaseFor, isAdminFrom } from '../../src/console/App.tsx';
import { signInError } from '../../src/console/pages/SignIn.tsx';
import { ApiError } from '../../src/console/api.ts';

/**
 * The console's front door. Every assertion here is a trust property rather than
 * a rendering detail: D1 shipped a bundle with no sign-in page at all, because
 * the screen chooser could not tell "this install is empty" apart from "you are
 * not signed in". `phaseFor` is that decision, and it is a pure function so the
 * decision is testable without a DOM.
 */

describe('the console door: the bootstrap form, the sign-in page, or the app (D1)', () => {
  test('a fresh install gets the bootstrap form, whatever the probe says', () => {
    // `bootstrapped: false` is the ONLY thing that earns the fresh-install form —
    // it is the one screen that can create an admin.
    expect(phaseFor(false, { status: 401 }, false)).toBe('bootstrap');
    expect(phaseFor(false, { status: 'unreachable' }, false)).toBe('bootstrap');
    expect(phaseFor(false, { status: 200, lifecycle: 'ready' }, false)).toBe('bootstrap');
  });

  test('bootstrapped and unsigned-in is the sign-in page, never the fresh-install form', () => {
    // The exact regression: the 401 from `GET /api/wizard/state` used to fall
    // into `catch { setPhase('bootstrap') }`, so a returning operator filled in a
    // create-admin form that answered `already_bootstrapped`.
    expect(phaseFor(true, { status: 401 }, false)).toBe('signin');
    expect(phaseFor(true, { status: 401 }, false)).not.toBe('bootstrap');
  });

  test('bootstrapped and signed in reaches the app', () => {
    expect(phaseFor(true, { status: 200, lifecycle: 'ready' }, false)).toBe('ready');
    // A half-finished install still goes to the wizard, not the app.
    expect(phaseFor(true, { status: 200, lifecycle: 'sources-added' }, false)).toBe('wizard');
  });

  test('a signed-in non-admin is not sent to sign in: a 403 is a session, not its absence', () => {
    // `GET /api/wizard/state` is admin-only, so a member gets 403 while holding a
    // valid session. Treating that as "signed out" would loop them through a
    // form that cannot fail.
    expect(phaseFor(true, { status: 403 }, true)).toBe('ready');
  });

  test('a failing probe never claims the install is empty', () => {
    expect(phaseFor(true, { status: 'unreachable' }, false)).toBe('signin');
    expect(phaseFor(true, { status: 500 }, false)).toBe('signin');
  });

  test('a 403 with no membership at all is noAccess, not ready', () => {
    expect(phaseFor(true, { status: 403 }, false)).toBe('noAccess');
  });

  test('a 403 with a membership stays ready (wrong role, not no access)', () => {
    expect(phaseFor(true, { status: 403 }, true)).toBe('ready');
  });
});

// `pageFromPath` and its cold-load-route tests were deleted along with the
// nav-and-page-switch `App.tsx` replaced (Task 8). Its property — "a
// bookmarked Sources page is not lost" — is not just preserved but
// strengthened in `test/unit/console-router.test.ts`, which asserts both the
// new `/settings/sources` route and the `/sources` -> `/settings/sources`
// redirect (and the same for `/schedules`, `/runs`, `/spend`, `/upgrades`,
// `/files`). See that file's `parseRoute`/`legacyRedirect` describe blocks.

describe('isAdminFrom: the only role signal the console client has', () => {
  // The regression to name: treating a non-admin as an admin would show them
  // four admin-only settings tabs whose every call answers 403. `phaseFor`
  // already draws this exact line for the phase gate; `isAdminFrom` draws it
  // for the shell's `isAdmin` prop, from the same probe.
  test('a 200 from the admin-only wizard probe is a session with the admin role', () => {
    expect(isAdminFrom({ status: 200, lifecycle: 'ready' })).toBe(true);
  });

  test('a 403 is a session without the admin role, not an error', () => {
    expect(isAdminFrom({ status: 403 })).toBe(false);
  });

  test('a 401 (no session at all) is never read as admin', () => {
    expect(isAdminFrom({ status: 401 })).toBe(false);
  });

  test('a 500 does not default to admin', () => {
    expect(isAdminFrom({ status: 500 })).toBe(false);
  });

  test('an unreachable probe does not default to admin', () => {
    expect(isAdminFrom({ status: 'unreachable' })).toBe(false);
  });
});

describe('a sign-in refusal an operator can read', () => {
  test('wrong credentials are named, not rendered as a raw status code', () => {
    // The real body: Better Auth answers `401 {message, code}`, which this
    // console's ApiError degrades to `HTTP 401`.
    const err = new ApiError('HTTP 401', 401, {
      message: 'Invalid email or password', code: 'INVALID_EMAIL_OR_PASSWORD',
    });
    const said = signInError(err);
    expect(said).toMatch(/do not match an account/i);
    expect(said).not.toContain('401');
    expect(said).not.toContain('INVALID_EMAIL_OR_PASSWORD');
  });

  test('rate limiting says to wait rather than to check the password', () => {
    expect(signInError(new ApiError('HTTP 429', 429))).toMatch(/wait a minute/i);
  });

  test('a refusal that is not about the password is never read as one', () => {
    // Better Auth answers 403 `Invalid origin` when it does not trust the
    // request's origin. Telling the operator to retype a correct password would
    // be a lie, so the server's own words survive.
    const origin = new ApiError('HTTP 403', 403, { message: 'Invalid origin', code: 'INVALID_ORIGIN' });
    expect(signInError(origin)).toBe('Invalid origin');
    expect(signInError(origin)).not.toMatch(/do not match an account/i);
  });

  test('anything else keeps whatever the server said', () => {
    expect(signInError(new ApiError('HTTP 500', 500, { error: 'internal_error' })))
      .toBe('internal_error');
    expect(signInError(new Error('Failed to fetch'))).toBe('Failed to fetch');
  });
});
