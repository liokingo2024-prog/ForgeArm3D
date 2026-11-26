# Security Specification & Payload-First TDD (`firestore.rules`)

## 1. Data Invariants
1. **Strict Owner Isolation (No Public PII)**: `users/{userId}` contains `email`, `displayName`, and `photoURL`. Only the verified owner (`request.auth.uid == userId && request.auth.token.email_verified == true`) may `get`, `create`, or `update` their own profile. Collection `list` queries on `/users` are permanently denied.
2. **Master Gate on Subcollections**: Every build document under `/users/{userId}/builds/{buildId}` requires its parent `/users/{userId}` document to exist with `uid == request.auth.uid` on read/write (non-list) operations, and strictly enforces `ownerId == request.auth.uid` on `list` queries via `resource.data` without extra `get()` lookups.
3. **Immutable Identity & Server Timestamps**: `uid`, `ownerId`, `id`, and `createdAt` cannot change after creation. `createdAt == request.time` on create; `updatedAt == request.time` on create and update.
4. **Strict Payload Boundaries (Zero Shadow Fields)**: Both `create` and `update` enforce `keys().hasAll(...)` / `keys().hasOnly(...)` / `affectedKeys().hasOnly(...)`, regex-guarded document IDs (`^[a-zA-Z0-9_-]+$`, max 128 chars), and bounded string/map sizes.

## 2. The "Dirty Dozen" Attack Payloads
1. **Unauthenticated Account Creation**: Anonymous/signed-out client attempts `create /users/attacker1` -> `PERMISSION_DENIED`.
2. **Unverified Email Spoofing**: Authenticated token with `email_verified: false` attempts `create /users/u1` -> `PERMISSION_DENIED`.
3. **UID Spoofing on Profile**: Signed-in user `u1` sends `uid: "u2"` inside `/users/u1` -> `PERMISSION_DENIED`.
4. **Ghost Field / Privilege Escalation**: Signed-in user `u1` adds `"isAdmin": true` or `"role": "admin"` to `/users/u1` -> `PERMISSION_DENIED` (`hasOnly` rejection).
5. **Cross-User PII Read**: Signed-in user `u1` attempts `get /users/u2` -> `PERMISSION_DENIED`.
6. **User Enumeration / Collection Scrape**: Signed-in user `u1` attempts `list /users` -> `PERMISSION_DENIED`.
7. **Oversized Document ID Poisoning**: Signed-in user `u1` writes `/users/u1/builds/<150-char-id>` or invalid chars (`../`) -> `PERMISSION_DENIED` (`isValidId` rejection).
8. **Orphaned Build Without Parent Profile**: Signed-in user `u1` attempts `create /users/u1/builds/b1` before `/users/u1` exists -> `PERMISSION_DENIED` (Master Gate `get()` fails).
9. **Build Owner Hijack**: Signed-in user `u1` sends `ownerId: "u2"` in `/users/u1/builds/b1` -> `PERMISSION_DENIED`.
10. **Client-Forged Timestamp / Immutable Field Mutation**: User updates `createdAt` or sends client `Date.now()` instead of `request.time` -> `PERMISSION_DENIED`.
11. **Export Count Inflation Jump**: User updates `/users/u1` with `exportCount: 999999` instead of `+1` step -> `PERMISSION_DENIED`.
12. **Unscoped List Query Scraping**: User `u1` queries `collectionGroup('builds')` or `list /users/u2/builds` without `ownerId == request.auth.uid` -> `PERMISSION_DENIED`.
