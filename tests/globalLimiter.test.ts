import './setup';
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasOwnLimiter } from '../src/middlewares/rateLimit';

/**
 * Staff in one office share a public address. Once the admin screens had spent
 * the general per-address budget (300 per 15 minutes in production), the sign-in
 * screen itself answered "Too many requests" (2026-11-10). The routes for getting
 * in have stricter limiters of their own, so they no longer spend that budget.
 */
test('the routes for getting in are limited by their own limiters only', () => {
  for (const [method, path] of [
    ['POST', '/auth/login'],
    ['POST', '/auth/otp/request'],
    ['POST', '/auth/otp/verify'],
    ['POST', '/auth/password/forgot'],
    ['POST', '/auth/password/reset'],
    ['GET', '/auth/google'],
    ['POST', '/auth/session'],
    ['POST', '/auth/refresh'],
    ['post', '/AUTH/Login/'],
  ]) {
    assert.equal(hasOwnLimiter({ method, path }), true, `${method} ${path}`);
  }
});

test('everything else still spends the general budget', () => {
  for (const [method, path] of [
    ['GET', '/auth/me'],
    ['POST', '/auth/logout'],
    ['GET', '/auth/login'],
    ['POST', '/auth/login/extra'],
    ['POST', '/auth'],
    ['GET', '/dashboard/stats'],
    ['POST', '/uploads/document'],
    ['POST', '/public/contact'],
  ]) {
    assert.equal(hasOwnLimiter({ method, path }), false, `${method} ${path}`);
  }
});
