import test from 'node:test';
import assert from 'node:assert/strict';
import {compute,lookup} from './api.mjs';
test('number conversion', () => assert.equal(compute('2'),3));
test('query binds user input', () => assert.equal(lookup('a').query,'SELECT id FROM users WHERE id = ?'));
