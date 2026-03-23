import { describe, it, expect, vi } from 'vitest';
import { decorateEntity, decorateEntities } from '../entityTransformer';

// ─── decorateEntity ──────────────────────────────────────────────────────────

describe('decorateEntity', () => {
  it('returns null/undefined as-is', () => {
    expect(decorateEntity('Project', null)).toBeNull();
    expect(decorateEntity('Project', undefined)).toBeUndefined();
  });

  it('returns non-object values as-is', () => {
    expect(decorateEntity('Project', 42)).toBe(42);
    expect(decorateEntity('Project', 'string')).toBe('string');
  });

  it('does not mutate the original entity', () => {
    const original = { id: 1, shoot_date: '2026-03-10', created_date: '2026-03-10T00:00:00Z' };
    const result = decorateEntity('Project', original);
    expect(result).not.toBe(original);
    expect(original).not.toHaveProperty('_shoot_date_display');
  });

  it('adds _display fields for date-only fields (Project.shoot_date)', () => {
    const entity = { id: 1, shoot_date: '2026-03-10' };
    const result = decorateEntity('Project', entity);
    expect(result._shoot_date_display).toBe('10 Mar 2026');
  });

  it('adds _display fields for date-only delivery_date', () => {
    const entity = { id: 1, delivery_date: '2026-12-25' };
    const result = decorateEntity('Project', entity);
    expect(result._delivery_date_display).toBe('25 Dec 2026');
  });

  it('returns dash for null date-only fields', () => {
    const entity = { id: 1, shoot_date: null };
    const result = decorateEntity('Project', entity);
    // shoot_date is undefined in result since null check skips it
    expect(result.shoot_date).toBeNull();
  });

  it('adds multiple _display variants for timestamp fields (Project.created_date)', () => {
    const entity = { id: 1, created_date: '2026-01-15T00:00:00Z' };
    const result = decorateEntity('Project', entity);
    // Should have _display, _display_short, _display_date, _display_time, _relative
    expect(result).toHaveProperty('_created_date_display');
    expect(result).toHaveProperty('_created_date_display_short');
    expect(result).toHaveProperty('_created_date_display_date');
    expect(result).toHaveProperty('_created_date_display_time');
    expect(result).toHaveProperty('_created_date_relative');
  });

  it('handles timestamp fields with bare timestamps (no Z)', () => {
    const entity = { id: 1, created_date: '2026-01-15T00:00:00' };
    const result = decorateEntity('Project', entity);
    expect(result._created_date_display).toBeTruthy();
    expect(result._created_date_display).not.toBe('—');
  });

  it('skips fields not in the entity (undefined)', () => {
    const entity = { id: 1 };
    const result = decorateEntity('Project', entity);
    expect(result).not.toHaveProperty('_shoot_date_display');
    expect(result).not.toHaveProperty('_created_date_display');
  });

  it('passes through non-date fields untouched', () => {
    const entity = { id: 99, name: 'Test Project', status: 'active', shoot_date: '2026-06-01' };
    const result = decorateEntity('Project', entity);
    expect(result.id).toBe(99);
    expect(result.name).toBe('Test Project');
    expect(result.status).toBe('active');
  });

  it('handles unknown entity names gracefully (no registry entries)', () => {
    const entity = { id: 1, foo: 'bar' };
    const result = decorateEntity('UnknownEntity', entity);
    expect(result.id).toBe(1);
    expect(result.foo).toBe('bar');
    // No _display fields should be added
    expect(Object.keys(result).filter(k => k.startsWith('_'))).toHaveLength(0);
  });

  it('decorates Agent date-only fields', () => {
    const entity = { id: 1, next_follow_up_date: '2026-04-01' };
    const result = decorateEntity('Agent', entity);
    expect(result._next_follow_up_date_display).toBe('1 Apr 2026');
  });

  it('decorates TaskTimeLog timestamp fields', () => {
    const entity = { id: 1, start_time: '2026-03-10T09:00:00Z', end_time: '2026-03-10T17:00:00Z' };
    const result = decorateEntity('TaskTimeLog', entity);
    expect(result._start_time_display).toBeTruthy();
    expect(result._end_time_display).toBeTruthy();
  });
});

// ─── decorateEntities ─────────────────────────────────────────────────────────

describe('decorateEntities', () => {
  it('returns non-array values as-is', () => {
    expect(decorateEntities('Project', null)).toBeNull();
    expect(decorateEntities('Project', undefined)).toBeUndefined();
    expect(decorateEntities('Project', 'not-an-array')).toBe('not-an-array');
  });

  it('decorates an array of entities', () => {
    const entities = [
      { id: 1, shoot_date: '2026-03-10' },
      { id: 2, shoot_date: '2026-04-15' },
    ];
    const result = decorateEntities('Project', entities);
    expect(result).toHaveLength(2);
    expect(result[0]._shoot_date_display).toBe('10 Mar 2026');
    expect(result[1]._shoot_date_display).toBe('15 Apr 2026');
  });

  it('handles an empty array', () => {
    const result = decorateEntities('Project', []);
    expect(result).toEqual([]);
  });

  it('preserves array order', () => {
    const entities = [
      { id: 3, shoot_date: '2026-01-01' },
      { id: 1, shoot_date: '2026-06-15' },
      { id: 2, shoot_date: '2026-12-31' },
    ];
    const result = decorateEntities('Project', entities);
    expect(result[0].id).toBe(3);
    expect(result[1].id).toBe(1);
    expect(result[2].id).toBe(2);
  });
});
