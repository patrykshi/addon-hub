# Security Specification — StreamHub Lite Firestore Rules

## 1. Data Invariants
1. **Owner-Only PII Isolation (`/users/{userId}`)**: User account documents containing `email`, `displayName`, and `photoURL` are readable and writable strictly by the verified owner (`request.auth.uid == userId && request.auth.token.email_verified == true`). `allow list` is disabled (`false`).
2. **Owner-Only Secrets (`/users/{userId}/secrets/{secretId}`)**: Optional `tmdbApiKey` values are stored exclusively in `/users/{userId}/secrets/tmdb` and require both path ownership and `exists(/users/$(userId))` Master Gate checks; never exposed to non-owners or external manifest lookups.
3. **Profile Ownership & Non-Enumerability (`/profiles/{profileId}`)**:
   - Every profile document requires an unguessable `profileId` (`^[a-zA-Z0-9_-]{20,64}$`).
   - `list` queries are strictly restricted to `resource.data.ownerId == request.auth.uid` (no cross-user enumeration).
   - `create`, `update`, and `delete` require verified authentication and strict `ownerId == request.auth.uid` matching (plus `ownerId` and `createdAt` immutability).
   - `get` by exact 20–64 char `profileId` is permitted solely on `/profiles/{profileId}` (which stores zero PII and zero API keys) so external Stremio/Nuvio clients can resolve `/p/:profileId/manifest.json` and `/p/:profileId/stream/:type/:id.json`.
4. **Strict Payload Boundaries**: Every string, array (`addons <= 40`, `resolutions <= 4`), numeric range (`timeoutMs` 1000..30000), enum (`languageMode`), key allowlist (`hasAll` + `hasOnly` + `affectedKeys().hasOnly()`), and server timestamp (`request.time`) is validated on create and update.

## 2. The "Dirty Dozen" Attack Payloads (All Must Return PERMISSION_DENIED)
1. **Unauthenticated user read on `/users/{uid}`**: `get(/users/alice)` with `auth = null` -> DENIED.
2. **Cross-user PII read on `/users/{uid}`**: `get(/users/alice)` with `auth.uid = 'bob'` -> DENIED.
3. **Shadow field injection on `/users/{uid}`**: `create` with `{ uid, email, displayName, createdAt, updatedAt, isAdmin: true }` -> DENIED (`hasOnly` rejects `isAdmin`).
4. **Unverified email write**: `create` `/profiles/{id}` when `request.auth.token.email_verified == false` -> DENIED.
5. **Owner spoofing on profile create**: `create` `/profiles/{id}` with `ownerId = 'alice'` while `auth.uid = 'bob'` -> DENIED.
6. **Immutable ownerId hijack on profile update**: `update` `/profiles/{id}` attempting to change `ownerId` -> DENIED.
7. **Immutable createdAt tampering on update**: `update` `/profiles/{id}` attempting to alter `createdAt` -> DENIED.
8. **Client-forged updatedAt timestamp**: `update` `/profiles/{id}` with `updatedAt != request.time` -> DENIED.
9. **Cross-user profile list scraping**: `list(/profiles)` without `where('ownerId', '==', auth.uid)` -> DENIED.
10. **Short/poisoned profileId**: `create` `/profiles/short` (< 20 chars) or 1.5KB string -> DENIED (`isValidProfileId`).
11. **Oversized addon list DoS**: `create` `/profiles/{id}` with `addons.size() > 40` -> DENIED.
12. **Secret exfiltration on `/users/alice/secrets/tmdb`**: `get` by `auth.uid = 'bob'` -> DENIED.
