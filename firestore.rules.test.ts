import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getInitialWeaponConfig, SLOT_ORDER } from './src/data/catalog';
import {
  ALLOWED_WEAPON_CATEGORIES,
  DIMENSION_KEYS,
  isValidFirestoreId,
  MAX_BUILD_NAME_LEN,
  sanitizeAccountCreatePayload,
  sanitizeAccountIdentityPatch,
  sanitizeBuildCreatePayload,
  sanitizeBuildUpdatePatch,
} from './src/utils/cloudPayload';

const RULES_PATH = path.resolve('firestore.rules');
const BLUEPRINT_PATH = path.resolve('firebase-blueprint.json');

const rulesText = fs.readFileSync(RULES_PATH, 'utf8');
const blueprint = JSON.parse(fs.readFileSync(BLUEPRINT_PATH, 'utf8'));

test('firestore.rules enforces Eight Pillars security structure', () => {
  assert.match(rulesText, /rules_version\s*=\s*'2'/);
  // Default-deny global catch-all
  assert.match(rulesText, /match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;/);
  // Email verification gate for writes
  assert.match(rulesText, /request\.auth\.token\.email_verified\s*==\s*true/);
  // Strict ID validation
  assert.match(rulesText, /function isValidId\(id\)/);
  assert.match(rulesText, /\^\[a-zA-Z0-9_\\\\-\]\+\$/);
  // Private PII isolation: list permanently blocked on /users
  assert.match(rulesText, /match \/users\/\{userId\}[\s\S]*allow list: if false;/);
  assert.match(rulesText, /match \/users\/\{userId\}[\s\S]*allow delete: if false;/);
  // Master gate exists on /builds non-list ops, and zero get()/exists() inside allow list
  assert.match(rulesText, /function parentAccountMatchesOwner\(userId\)/);
  const buildsBlockMatch = rulesText.match(/match \/builds\/\{buildId\}[\s\S]*$/);
  assert.ok(buildsBlockMatch, 'builds subcollection match block should exist');
  const buildsListMatch = buildsBlockMatch[0].match(/allow list:[\s\S]*?;/);
  assert.ok(buildsListMatch, 'builds allow list rule should exist');
  assert.equal(/get\(|exists\(/.test(buildsListMatch[0]), false);
  assert.match(buildsListMatch[0], /resource\.data\.ownerId\s*==\s*request\.auth\.uid/);
  // Server timestamps enforced
  assert.match(rulesText, /incoming\(\)\.createdAt\s*==\s*request\.time/);
  assert.match(rulesText, /incoming\(\)\.updatedAt\s*==\s*request\.time/);
  // Action-based exportCount increment limited to +1
  assert.match(rulesText, /incoming\(\)\.exportCount\s*==\s*existing\(\)\.exportCount \+ 1/);
});

test('Dirty Dozen: invalid document IDs are rejected by isValidFirestoreId and firestore.rules', () => {
  assert.equal(isValidFirestoreId(''), false);
  assert.equal(isValidFirestoreId('a'.repeat(129)), false);
  assert.equal(isValidFirestoreId('../etc/passwd'), false);
  assert.equal(isValidFirestoreId('user/sub'), false);
  assert.equal(isValidFirestoreId('valid_user-123'), true);
});

test('Dirty Dozen: account payloads have zero shadow fields and valid bounded identity fields', () => {
  const created = sanitizeAccountCreatePayload({
    uid: 'user_abc123',
    displayName: '   ',
    email: 'creator@example.com',
    photoURL: null,
  });

  assert.equal(created.uid, 'user_abc123');
  assert.equal(created.displayName, 'creator');
  assert.equal(created.email, 'creator@example.com');
  assert.equal(created.exportCount, 0);
  assert.equal('photoURL' in created, false);
  assert.deepEqual(
    Object.keys(created).sort(),
    ['displayName', 'email', 'exportCount', 'uid']
  );

  const patch = sanitizeAccountIdentityPatch({
    displayName: 'X'.repeat(200),
    email: 'ops@example.com',
    photoURL: 'https://example.com/a.png',
  });
  assert.equal(patch.displayName.length, 120);
  assert.deepEqual(Object.keys(patch).sort(), ['displayName', 'email', 'photoURL']);

  assert.throws(() =>
    sanitizeAccountCreatePayload({
      uid: 'bad/id',
      displayName: 'Bad',
      email: 'a@b.co',
    })
  );
  assert.throws(() =>
    sanitizeAccountCreatePayload({
      uid: 'valid_uid',
      displayName: 'NoEmail',
      email: '',
    })
  );
});

test('SavedWeaponBuild payload keys stay in exact sync with firestore.rules and firebase-blueprint.json', () => {
  const cfg = getInitialWeaponConfig();
  cfg.name = 'Z'.repeat(MAX_BUILD_NAME_LEN + 30);

  const createPayload = sanitizeBuildCreatePayload({
    buildId: 'ak_build_1',
    ownerId: 'uid_123',
    config: cfg,
    category: 'assault_rifle',
    lengthCm: 500, // should clamp to 250
  });

  assert.ok(createPayload.name.length >= 1 && createPayload.name.length <= MAX_BUILD_NAME_LEN);
  assert.equal(createPayload.lengthCm, 250);
  assert.deepEqual(Object.keys(createPayload.parts).sort(), [...SLOT_ORDER].sort());
  assert.deepEqual(Object.keys(createPayload.paints).sort(), [...SLOT_ORDER].sort());
  assert.deepEqual(
    Object.keys(createPayload.dimensions).sort(),
    [...DIMENSION_KEYS].sort()
  );

  // Check rules contain every dimension key
  for (const key of DIMENSION_KEYS) {
    assert.ok(
      rulesText.includes(`'${key}'`),
      `firestore.rules isValidDimensionMap must include ${key}`
    );
  }

  // Check update patch contains only mutable fields permitted by affectedKeys().hasOnly(...)
  const updatePatch = sanitizeBuildUpdatePatch({
    config: cfg,
    category: 'sniper',
    lengthCm: 4, // should clamp to 10
  });
  assert.equal(updatePatch.lengthCm, 10);
  assert.deepEqual(
    Object.keys(updatePatch).sort(),
    ['category', 'dimensions', 'lengthCm', 'name', 'paints', 'parts']
  );

  // Check blueprint enum sync
  assert.deepEqual(
    blueprint.entities.SavedWeaponBuild.properties.category.enum,
    [...ALLOWED_WEAPON_CATEGORIES]
  );
});
