import { test, expect, describe } from 'bun:test';
import {
  ASSIGNABLE_SLOTS, assignSlot, footprintsCollide, snapToSlot, isSubHourly, SUB_HOURLY_SECONDS,
  type CalendarFootprint,
} from '../../src/scheduler/stagger.ts';

const fp = (slotMinute: number, hour: number, daysOfWeek: number[] | null = null): CalendarFootprint =>
  ({ slotMinute, hour, daysOfWeek });

describe('the slot grid', () => {
  test('is upstream\'s ten slots — :00 and :55 are never assignable', () => {
    expect([...ASSIGNABLE_SLOTS]).toEqual([5, 10, 15, 20, 25, 30, 35, 40, 45, 50]);
    expect(ASSIGNABLE_SLOTS).not.toContain(0);
    expect(ASSIGNABLE_SLOTS).not.toContain(55);
  });

  test('snapToSlot rounds UP to the next assignable slot and clamps the tail', () => {
    expect(snapToSlot(0)).toBe(5);
    expect(snapToSlot(5)).toBe(5);
    expect(snapToSlot(6)).toBe(10);
    expect(snapToSlot(47)).toBe(50);
    expect(snapToSlot(51)).toBe(50);
    expect(snapToSlot(59)).toBe(50);
  });
});

describe('footprint collisions', () => {
  test('different slot minutes never collide', () => {
    expect(footprintsCollide(fp(5, 2), fp(10, 2))).toBe(false);
  });

  test('different hours never collide even on the same slot', () => {
    expect(footprintsCollide(fp(5, 2), fp(5, 3))).toBe(false);
  });

  test('same slot and hour on every-day footprints collide', () => {
    expect(footprintsCollide(fp(5, 2), fp(5, 2))).toBe(true);
  });

  test('a null (every-day) footprint collides with any weekday footprint', () => {
    expect(footprintsCollide(fp(10, 6, null), fp(10, 6, [1]))).toBe(true);
    expect(footprintsCollide(fp(10, 6, [1]), fp(10, 6, null))).toBe(true);
  });

  test('disjoint weekday sets on the same slot and hour do NOT collide', () => {
    expect(footprintsCollide(fp(10, 6, [1, 3]), fp(10, 6, [2, 4]))).toBe(false);
    expect(footprintsCollide(fp(10, 6, [1, 3]), fp(10, 6, [3, 5]))).toBe(true);
  });
});

describe('slot assignment', () => {
  test('an uncontested request is granted at its snapped slot', () => {
    expect(assignSlot(5, 2, null, [])).toEqual({ ok: true, slotMinute: 5 });
    expect(assignSlot(7, 2, null, [])).toEqual({ ok: true, slotMinute: 10 });
  });

  test('a collision is REFUSED and the next free slot is offered', () => {
    const decision = assignSlot(5, 2, null, [fp(5, 2)]);
    expect(decision).toEqual({ ok: false, nextFree: 10 });
  });

  test('the next-free search wraps past :50 back to :05', () => {
    const taken = [fp(50, 2), fp(5, 2)];
    expect(assignSlot(50, 2, null, taken)).toEqual({ ok: false, nextFree: 10 });
  });

  test('when all ten slots in the hour are taken there is no next free slot', () => {
    const taken = ASSIGNABLE_SLOTS.map((m) => fp(m, 2));
    expect(assignSlot(5, 2, null, taken)).toEqual({ ok: false, nextFree: null });
  });

  test('a collision in a DIFFERENT hour does not block the request', () => {
    expect(assignSlot(5, 2, null, [fp(5, 3), fp(5, 4)])).toEqual({ ok: true, slotMinute: 5 });
  });

  test('disjoint weekdays share a slot without collision', () => {
    expect(assignSlot(10, 6, [2], [fp(10, 6, [1])])).toEqual({ ok: true, slotMinute: 10 });
  });
});

describe('sub-hourly exemption', () => {
  test('anything under an hour is sub-hourly', () => {
    expect(SUB_HOURLY_SECONDS).toBe(3600);
    expect(isSubHourly(300)).toBe(true);
    expect(isSubHourly(1800)).toBe(true);
    expect(isSubHourly(3600)).toBe(false);
    expect(isSubHourly(86_400)).toBe(false);
  });
});
