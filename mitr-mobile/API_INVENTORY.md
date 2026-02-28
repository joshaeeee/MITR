# MITR Mobile API Inventory

This audit is based on the imported MITR-APP scaffold and current backend routes.

## 1) Pages in frontend

- `app/welcome.tsx`
- `app/(tabs)/(home)/index.tsx`
- `app/(tabs)/insights/index.tsx`
- `app/(tabs)/connect/index.tsx`
- `app/(tabs)/care-plan/index.tsx`
- `app/(tabs)/settings/index.tsx`
- `app/alerts.tsx`
- `app/alert-detail.tsx`
- `app/family-members.tsx`
- `app/device-details.tsx`

## 2) Interaction -> API mapping (implemented now)

### Welcome
- Pre-auth bootstrap (dev mode):
  - `POST /auth/email/login`
  - fallback `POST /auth/email/signup`

### Home
- Load current user: `GET /auth/me`
- Load elder profile: `GET /elder/profile`
- Load status/device snapshot: `GET /elder/device/status`
- Load alerts for bell and cards: `GET /alerts`
- Build timeline data from:
  - `GET /nudges/history`
  - `GET /care/reminders`

### Insights
- Load insight overview: `GET /insights/overview`
- Load period trend data: `GET /insights/timeline?range=7d|30d`

### Connect
- Load nudge history: `GET /nudges/history`
- Send text/voice nudge: `POST /nudges/send`

### Care Plan
- Load reminders: `GET /care/reminders`
- Toggle/edit reminder: `PATCH /care/reminders/:id`
- Load routines: `GET /care/routines`
- Toggle/edit routine: `PATCH /care/routines/:id`

### Settings
- Current user: `GET /auth/me`
- Elder profile: `GET /elder/profile`
- Family count/list: `GET /family/members`
- Escalation policy snapshot: `GET /escalation/policy`
- Sign out: `POST /auth/logout`

### Alerts list/detail
- List alerts: `GET /alerts`
- Alert detail: `GET /alerts/:id`
- Acknowledge: `POST /alerts/:id/ack`
- Resolve: `POST /alerts/:id/resolve`

### Family Members
- List members: `GET /family/members`
- Invite member: `POST /family/invite`
- Change role: `PATCH /family/members/:id/role`
- Remove member: `DELETE /family/members/:id`

### Device Details
- Device status: `GET /device/status`
- Unlink device: `POST /device/unlink`

---

## 3) APIs still missing (or existing API shape not sufficient)

These are the gaps required to fully match UI semantics without client-side synthetic data.

## A) Home/Cockpit aggregation

### Missing
1. `GET /home/overview`
- Should return a single payload for:
  - user greeting name
  - elder profile summary
  - status card metrics (`todayInteractions`, `activeMinutesToday`, `moodIndicator`, `confidenceLevel`)
  - open alerts count

2. `GET /home/timeline?date=today`
- Should return canonical timeline events already formatted as domain events (`interaction|reminder|nudge|alert|routine`).

### Why
- Current home uses multiple calls and synthesizes timeline from unrelated endpoints.

## B) Device diagnostics depth

### Missing or incomplete fields on `GET /device/status`
- `batteryLevel`
- `connectivityStatus` (`connected|intermittent|disconnected`)
- `wifiStrength`
- `diagnosticStatus` (`healthy|warning|error`)
- `lastHeartbeat` formatted timestamp
- `linkedAt`

### Why
- Device details screen currently derives several values client-side.

## C) Family invite lifecycle

### Missing
1. `POST /family/invite-link`
- Generate invite token/link (instead of immediate auto-member creation).

2. `GET /family/invites`
- Show pending invites and status.

3. `POST /family/invites/:id/resend`

4. `DELETE /family/invites/:id`

### Why
- UI has concept of pending invites; backend currently models invite as accepted member immediately.

## D) Alert action timeline

### Missing
1. `GET /alerts/:id/actions`
- Return actual timeline actions (`alert_actions` table exists).

2. Optional `POST /alerts/:id/note`
- Family note/audit enrichment.

### Why
- Alert detail currently fabricates timeline steps from minimal alert fields.

## E) Insights semantics for UI

### Missing or weak
1. Server-calculated trend direction:
- `moodTrend: improving|stable|declining`
- `engagementTrend: improving|stable|declining`

2. Topic frequencies (count, not just score)
3. Concern occurrences + firstDetected
4. Recommendation action metadata

### Why
- Insights tab currently computes/guesses trend and counts client-side.

## F) Care plan richness

### Missing fields for reminders
- `days[]`
- `category`
- `adherenceRate`
- `lastCompleted`

### Missing fields for routines
- `timeSlot`
- `category`
- `completedToday`

### Why
- Care Plan screen currently uses placeholders for these values.

## G) Settings preferences endpoints

### Missing
1. `GET /settings/preferences`
2. `PATCH /settings/preferences`
- language, display density, notification toggles

3. Optional legal/support endpoints:
- `GET /legal/privacy`
- `GET /legal/terms`
- `POST /support/contact`

### Why
- Settings actions exist in UI but are currently non-functional placeholders.

## H) Voice note pipeline completion

### Recommended additions
1. `POST /voice-notes/complete`
- confirm upload completion + metadata

2. `GET /voice-notes/history`
- dedicated voice-note history (if needed separately from nudges)

### Why
- Current connect screen sends simplified placeholder voice URL.

---

## 4) Existing backend APIs available (already implemented)

- Auth:
  - `POST /auth/otp/start`
  - `POST /auth/otp/verify`
  - `POST /auth/email/signup`
  - `POST /auth/email/login`
  - `POST /auth/oauth/apple`
  - `POST /auth/oauth/google`
  - `POST /auth/session/refresh`
  - `POST /auth/logout`
  - `GET /auth/me`

- Family/Elder/Device:
  - `GET /family/me`
  - `GET /family/members`
  - `POST /family/invite`
  - `PATCH /family/members/:id/role`
  - `DELETE /family/members/:id`
  - `GET /elder/profile`
  - `PATCH /elder/profile`
  - `GET /elder/device/status`
  - `POST /elder/device/link`
  - `POST /elder/device/unlink`
  - `GET /device/status`
  - `POST /device/link`
  - `POST /device/unlink`

- Connect:
  - `POST /nudges/send`
  - `POST /nudges/schedule`
  - `GET /nudges/history`
  - `POST /voice-notes/upload-url`
  - `POST /voice-notes/send`

- Insights/Alerts/Care:
  - `GET /insights/overview`
  - `GET /insights/timeline`
  - `GET /insights/topics`
  - `GET /insights/concerns`
  - `GET /insights/sessions`
  - `GET /alerts`
  - `GET /alerts/:id`
  - `POST /alerts/:id/ack`
  - `POST /alerts/:id/resolve`
  - `GET /escalation/policy`
  - `PATCH /escalation/policy`
  - `GET /care/reminders`
  - `POST /care/reminders`
  - `PATCH /care/reminders/:id`
  - `DELETE /care/reminders/:id`
  - `GET /care/routines`
  - `PATCH /care/routines/:id`
