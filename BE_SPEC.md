# Lumina BE 구현 명세 — 주차장 사고 증거 매칭 데모 MVP

작성일: 2026-09-09  
기준 문서: `MVP_PARKING_INCIDENT_EVIDENCE.md`(제품 원칙), `MVP_scope.txt`(데모 범위). 두 문서와 이 명세가 충돌하면 **`MVP_scope.txt`의 데모 범위**를 우선하고, 범위에 없는 항목은 `MVP_PARKING_INCIDENT_EVIDENCE.md`의 원칙을 따른다.  
대상 독자: 백엔드 구현 에이전트/개발자. 이 문서는 계획서가 아니라 **그대로 구현·검증해야 하는 작업 명세**다.

---

## 0. 한 줄 목표

> X가 사고 요청과 피해 차량 사진을 등록하면 → 같은 장소·시간대의 방문 기록을 가진 Y에게 인앱 알림이 생기고 → Y가 약 20초 블랙박스 MP4를 올리면 → 서버가 TwelveLabs Analyze API로 **실제 분석**해 사고 후보 타임스탬프를 돌려주고 → 보험사 채택·보상 예정 상태(Mock)까지 상태 전이를 제공한다.

---

## 1. 기술 스택과 기본 결정

| 항목 | 결정 | 비고 |
|---|---|---|
| 런타임 | Node.js 20 LTS, TypeScript(strict), ESM | |
| HTTP 프레임워크 | Express 5 (Hono/Fastify도 허용, 단 API 계약은 동일) | prefix `/api/v1`, 포트 `3001` |
| 인증 | **Supabase Auth** | FE가 받은 Supabase JWT를 `Authorization: Bearer`로 전달, 서버가 검증 |
| DB | **Supabase Postgres** | 도메인 데이터의 원본. RLS는 켜되 서버는 service role로 접근 |
| 파일 저장 | **Supabase Storage** (private bucket) | 사진·영상. FE는 서버가 발급한 signed upload URL로 직접 업로드 |
| AI | **TwelveLabs Analyze API** (`POST https://api.twelvelabs.io/v1.3/analyze`, `model_name=pegasus1.5`) | 서버에서만 호출. 브라우저는 API 키·공급자 API를 절대 직접 호출하지 않음 |
| 작업 처리 | 프로세스 내 작업 큐(단일 인스턴스 전제) | 분석은 202로 접수 후 폴링 |
| 문서 | OpenAPI 3.1 (`openapi.yaml`) | FE와 계약 공유 |
| 검증 | zod(런타임 입력 검증) | |

Firebase는 사용하지 않는다. Auth/DB/Storage가 필요한 모든 곳에 Supabase를 사용한다.

### 1.1 실제 / Mock 경계 (변경 금지)

| 기능 | 실제 | Mock |
|---|---|---|
| X 사고 요청 저장, 피해 차량 사진 업로드 | O | |
| Y 방문 이력 | | `A주차장 13:58~14:12` seed |
| 장소·시간 겹침 → Y 인앱 알림 생성 | O (로직 실제) | 이력만 Mock |
| Y 영상 업로드 | O (실제 업로드) | 영상 파일은 Mock |
| TwelveLabs 영상 분석 | O | 공급자 장애 시에만 `사전 분석 결과` |
| 보험사 채택 상태 변경 | | 발표자 버튼 |
| 에스크로 예치·보상 예정 | | 상태값만 |
| 모바일 푸시, GPS 수집, PG·송금, 경찰·보험사 연동 | 범위 밖 | |

### 1.2 권장 디렉터리 구조

```text
server/
  src/
    index.ts                 # bootstrap
    app.ts                   # express app, routers
    config/env.ts            # env 로딩·검증(zod), 시작 시 실패
    lib/{supabase,logger,errors,response}.ts
    middleware/{auth,requestId,errorHandler,rateLimit}.ts
    modules/
      config/                # F0
      me/                    # F1
      places/                # F2
      incidents/             # F3
      matching/              # F4 (방문 이력 겹침 → 알림)
      notifications/         # F4, F7
      uploads/               # F3, F5 (signed URL)
      submissions/           # F5
      analysis/              # F6 (TwelveLabs adapter + job)
      candidates/            # F7
      insurer/               # F8
      settlement/            # F9
      demo/                  # F10 (reset/seed, DEMO_MODE 전용)
    adapters/twelvelabs/{client,prompt,schema,parse}.ts
    jobs/analysisQueue.ts
  supabase/
    migrations/*.sql
    seed/demo.sql
  fixtures/                  # MOCK_DATA_AND_ASSETS.md 참고
  openapi.yaml
  .env.example (루트 .env.example과 동일 키 사용)
```

---

## 2. 공통 규약

### 2.1 응답 형식

```json
// 성공
{ "data": { }, "meta": { "requestId": "uuid" } }
// 실패
{ "error": { "code": "VALIDATION_ERROR", "message": "…", "fieldErrors": { "field": "reason" }, "retryable": false }, "meta": { "requestId": "uuid" } }
```

- 생성 `201`, 비동기 작업 접수 `202`, 조회·수정 `200`.
- ID는 UUID, 시각은 ISO-8601 UTC, JSON 키는 camelCase.
- 타인의 비공개 리소스 접근은 `404 NOT_FOUND`로 통일한다(존재 여부 노출 금지).

### 2.2 오류 코드

| HTTP | code | 상황 |
|---|---|---|
| 400 | `VALIDATION_ERROR` | 입력 검증 실패 |
| 401 | `UNAUTHENTICATED` | 토큰 없음/만료/서명 불일치 |
| 403 | `FORBIDDEN_ROLE` | 역할 불일치(예: X 계정이 영상 업로드) |
| 404 | `NOT_FOUND` | 리소스 없음 또는 타인 소유 |
| 409 | `INVALID_STATE` | 상태 전이 불가 |
| 409 | `ALREADY_EXISTS` | 동일 제보 중복 등 |
| 413 | `FILE_TOO_LARGE` | 업로드 상한 초과 |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | MP4/JPEG/PNG/WebP 이외 |
| 422 | `VIDEO_UNANALYZABLE` | 4초 미만·해상도 미달 등 TwelveLabs 입력 조건 위반 |
| 429 | `RATE_LIMITED` | |
| 503 | `PROVIDER_UNAVAILABLE` | TwelveLabs 장애·타임아웃 |

### 2.3 인증 미들웨어

1. `Authorization: Bearer <supabase_access_token>`을 읽는다.
2. `supabase.auth.getUser(jwt)`(service role 클라이언트) 또는 프로젝트 JWKS(`{SUPABASE_URL}/auth/v1/.well-known/jwks.json`)로 서명·만료·issuer를 검증한다. **payload만 디코드해서 신뢰하지 않는다.**
3. `auth.users.id` → `profiles` 행을 조회(없으면 생성)해 `req.user = { id, role, displayName }`을 설정한다.
4. 클라이언트가 보낸 `userId`, `role`, `status` 등은 권한 근거로 쓰지 않는다.

`DEMO_MODE=true`일 때도 인증은 동일하다. 데모 계정(X, Y)은 Supabase Auth에 실제로 존재하는 이메일/비밀번호 계정이며, FE의 "계정 전환"은 두 계정을 실제로 로그인 전환하는 것이다.

### 2.4 로깅·감사

- 모든 요청에 `requestId`, `actorId`, 경로, 소요시간, 결과 코드를 남긴다.
- 원본 영상·사진에 대한 signed URL 발급, 분석 호출, 채택 상태 변경은 `audit_logs`에 기록한다.
- 로그·오류 응답에 Supabase service role key, TwelveLabs API key, signed URL 전체를 남기지 않는다.

---

## 3. 데이터 모델 (Supabase Postgres)

모든 테이블은 `id uuid primary key default gen_random_uuid()`, `created_at timestamptz default now()`, `updated_at timestamptz`를 가진다. 아래는 핵심 컬럼만 적는다. 실제 DDL은 `supabase/migrations/`에 둔다.

| 테이블 | 핵심 컬럼 | 제약 |
|---|---|---|
| `profiles` | `id`(= auth.users.id), `role` (`REQUESTER`/`WITNESS`/`OPERATOR`), `display_name`, `notification_consent bool`, `payout_ready bool` | |
| `places` | `name`, `kind` (`PARKING_LOT`/`APARTMENT`/`BUILDING`), `address`, `lat`, `lng` | 데모 seed: `A주차장` |
| `visits` | `user_id`, `place_id`, `entered_at`, `exited_at`, `source` (`SEED`/`MANUAL`), `retain_until` | 데모 seed: Y, A주차장 13:58~14:12 |
| `incidents` | `requester_id`, `place_id`, `type` (`HIT_AND_RUN`/`CONTACT`/`DAMAGE`/`OTHER`), `occurred_from`, `occurred_to`, `vehicle_color`, `vehicle_model`, `damage_area`, `description`, `status`, `matched_witness_count int`, `published_at` | `occurred_from < occurred_to` CHECK |
| `incident_photos` | `incident_id`, `object_path`, `mime`, `bytes`, `width`, `height`, `sha256`, `position` | UNIQUE(`incident_id`,`position`), 최대 2장 |
| `notifications` | `user_id`, `type` (`WITNESS_REQUEST`/`CANDIDATE_FOUND`/`ADOPTION_UPDATED`/`REWARD_SCHEDULED`), `incident_id`, `submission_id?`, `title`, `body`, `read_at` | UNIQUE(`user_id`,`type`,`incident_id`,`submission_id`) 중복 알림 방지 |
| `evidence_submissions` | `incident_id`, `witness_id`, `object_path`, `mime`, `bytes`, `duration_sec`, `width`, `height`, `sha256`, `recorded_at?`, `status`, `upload_completed_at` | UNIQUE(`incident_id`,`witness_id`) — 데모에서는 1인 1제보 |
| `analyses` | `submission_id`, `status`, `source` (`LIVE`/`PRERECORDED`), `provider`='twelvelabs', `model`, `prompt_version`, `request_payload_hash`, `raw_response jsonb`, `result jsonb`, `error_code`, `error_message`, `attempts`, `started_at`, `finished_at` | UNIQUE(`submission_id`) |
| `insurer_reviews` | `submission_id`, `incident_id`, `status` (`REVIEWING`/`ADOPTED`/`REJECTED`), `submitted_at`, `decided_at`, `decided_by`, `note` | UNIQUE(`submission_id`) |
| `settlements` | `incident_id`, `deposit_amount int`, `platform_fee int`, `witness_reward int`, `status`, `payout_user_id?`, `payout_scheduled_at?`, `dedupe_key` | UNIQUE(`incident_id`), UNIQUE(`dedupe_key`) |
| `audit_logs` | `actor_id`, `action`, `target_type`, `target_id`, `metadata jsonb` | |

### 3.1 Storage 버킷 (private)

| 버킷 | 경로 규칙 | 제한 |
|---|---|---|
| `incident-photos` | `incidents/{incidentId}/{position}.{ext}` | JPEG/PNG/WebP, 장당 10MB, 요청당 최대 2장 |
| `evidence-videos` | `incidents/{incidentId}/submissions/{submissionId}/original.mp4` | `video/mp4`, 기본 상한 200MB(`MAX_VIDEO_BYTES`), 4초 이상 |

- 사용자 파일명을 경로로 사용하지 않는다.
- 조회는 항상 짧은 TTL의 signed URL로 발급하고 발급 이력을 `audit_logs`에 남긴다.
- 버킷 전체를 public으로 열지 않는다.

### 3.2 RLS

- 서버는 service role로 접근하므로 RLS를 우회한다. 그러나 FE가 supabase-js로 Storage에 직접 업로드하므로 **Storage 정책**은 반드시 둔다: 서버가 발급한 signed upload URL 이외의 경로로는 `insert`가 불가능해야 한다(anon/authenticated 직접 insert 정책을 만들지 않는다).
- 테이블에는 "본인 행만 select" 정책을 기본으로 두어 anon key 노출 시에도 타인 데이터가 읽히지 않게 한다. 도메인 mutation은 서버 API만 수행한다.

---

## 4. 상태 머신

### 4.1 사고 요청 `incidents.status`

```
DRAFT → OPEN → COLLECTING → REVIEWING → ADOPTED | CLOSED_NO_EVIDENCE | CANCELLED
```

- 데모에서는 `POST /incidents` 성공 시 곧바로 `OPEN`으로 저장하고 매칭을 실행한다(플랫폼 검토 단계는 자동 승인으로 대체, 응답에 `reviewMode: "AUTO_DEMO"` 표기).
- 첫 제보 영상 업로드 완료 시 `COLLECTING`, 보험사 제출 시 `REVIEWING`, 채택 시 `ADOPTED`.

### 4.2 영상 제보 `evidence_submissions.status`

```
UPLOADING → UPLOADED → ANALYZING → READY → SUBMITTED → ADOPTED | REJECTED
                                 ↘ ANALYSIS_FAILED (재시도 가능 → ANALYZING)
```

- `READY`는 원칙 문서의 "사람 검토 대기 → 후보 전달"을 데모에서 하나로 합친 상태다. 응답 DTO에 `humanReviewed: false`를 명시한다.

### 4.3 분석 `analyses.status`

```
QUEUED → ANALYZING → FINALIZING → READY | FAILED
```

FE가 단계 표시(`업로드 완료 → AI 분석 중 → 결과 정리 중`)에 그대로 사용한다.

### 4.4 정산 `settlements.status` (Mock)

```
DEPOSIT_PENDING → DEPOSITED → ADOPTION_PENDING → PAYOUT_SCHEDULED
```

데모는 `PAYOUT_SCHEDULED`에서 끝난다. `PAID`, `REFUNDED`, `PAYOUT_FAILED`, `DISPUTED`는 enum에만 예약하고 전이 API는 만들지 않는다.

---

## 5. 기능별 명세

각 기능은 **목적 → API → 처리 규칙 → 검증 시나리오** 순서로 적는다.

---

### F0. 공통 인프라 (설정·헬스)

**API**

| Method/Path | 접근 | 설명 |
|---|---|---|
| `GET /api/v1/config` | 공개 | `{ demoMode, aiMode: "live", provider: "twelvelabs", model, limits: { photoMaxBytes, photoMaxCount, videoMaxBytes, videoMinSeconds, videoMaxSeconds }, features: { prerecordedFallback } }` |
| `GET /api/v1/health` | 공개 | liveness |
| `GET /api/v1/ready` | 내부 | Supabase 연결, 필수 env, 마이그레이션 상태 |

**처리 규칙**

- 시작 시 `config/env.ts`가 필수 env(`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TWELVELABS_API_KEY`)를 검증한다. 누락 시 프로세스를 종료하고 어떤 키가 없는지 출력한다. `AI_MODE=live`가 기본이며 키 부재를 Mock으로 조용히 대체하지 않는다.
- CORS는 `CORS_ORIGINS`에 나열된 origin만 허용한다.
- body 크기 상한(JSON 1MB), 요청 타임아웃, 사용자별 rate limit(분당 60)을 둔다.

---

### F1. 인증·프로필·데모 계정

**API**

| Method/Path | 접근 | 설명 |
|---|---|---|
| `GET /api/v1/me` | 로그인 | `{ id, role, displayName, notificationConsent, payoutReady, unreadNotificationCount }` |
| `PATCH /api/v1/me` | 로그인 | `notificationConsent`만 수정 가능 |

**처리 규칙**

- 첫 요청 시 `profiles` 행이 없으면 생성한다. 기본 role은 `REQUESTER`. 데모 seed는 X=`REQUESTER`, Y=`WITNESS`로 고정한다.
- 역할 검증: 사고 요청 생성은 `REQUESTER`, 영상 제보는 `WITNESS`, 채택 상태 변경은 `OPERATOR` 또는 `DEMO_MODE=true`일 때 발표자(X 계정) 허용. 나머지는 `403 FORBIDDEN_ROLE`.
- Kakao 로그인은 Supabase Auth Provider 설정으로 켤 수 있으나 데모 완료 조건은 아니다(이메일/비밀번호 데모 계정으로 충족).

**검증**

- 토큰 없음/위조 → 401. 만료 토큰 → 401.
- X 토큰으로 `POST /incidents/:id/submissions` → 403.

---

### F2. 장소 데이터

**API**

| Method/Path | 접근 | 설명 |
|---|---|---|
| `GET /api/v1/places?query=` | 로그인 | 장소 목록(`id, name, kind, address, lat, lng`) |

**처리 규칙**

- seed에 `A주차장` 1건 이상. 자유 입력 주소는 받지 않고 `placeId` 선택만 허용한다(매칭 정확성 유지).

---

### F3. 사고 요청 등록 (X)

**API**

| Method/Path | 접근 | 설명 |
|---|---|---|
| `POST /api/v1/uploads/photo-url` | REQUESTER | `{ incidentId?, position, mime, bytes }` → `{ objectPath, uploadUrl, token, expiresAt }` (Supabase `createSignedUploadUrl`) |
| `POST /api/v1/incidents` | REQUESTER | 본문 아래. `201` + `IncidentDetail` + `matching` 요약 |
| `POST /api/v1/incidents/:id/photos` | 작성자 | `{ objectPath, position }` — 업로드 완료를 서버에 알려 메타(크기·MIME·해시) 검증 후 연결. 최대 2장 |
| `GET /api/v1/incidents/:id` | 작성자, 알림 대상 Y, OPERATOR | Y에게는 개인정보 마스킹 DTO |
| `GET /api/v1/me/incidents` | REQUESTER | 본인 요청 목록과 제보 현황 |

**`POST /incidents` 본문**

```json
{
  "placeId": "uuid",
  "type": "HIT_AND_RUN",
  "occurredFrom": "2026-09-09T14:00:00+09:00",
  "occurredTo": "2026-09-09T14:10:00+09:00",
  "vehicle": { "color": "흰색", "model": "세단(아반떼)", "damageArea": "우측 후면" },
  "description": "주차 후 돌아왔더니 우측 뒤 범퍼가 긁혀 있었습니다.",
  "photoObjectPaths": ["incidents/{tmp}/0.jpg"],
  "consent": { "evidenceUse": true, "privacy": true }
}
```

**처리 규칙**

1. zod로 검증: `occurredFrom < occurredTo`, 범위 ≤ 24h, `description` ≤ 1,000자, `consent` 둘 다 true 필수.
2. 사진은 서버가 Storage 객체 메타를 조회해 MIME 시그니처·크기(≤10MB)·픽셀 상한을 확인하고 EXIF를 제거한 뒤 `incident_photos`에 연결한다. 사진 없이도 요청 생성은 가능하되 데모 시나리오는 1~2장을 올린다.
3. 트랜잭션 안에서 `incidents(status=OPEN)` 저장 → `settlements(DEPOSITED, deposit_amount=DEMO_DEPOSIT_AMOUNT)` 생성 → **F4 매칭 실행** → 응답.
4. 응답의 `matching: { matchedWitnessCount: 1, notifiedAt }`를 FE 완료 화면이 사용한다(`같은 시간대 방문 사용자 1명 발견`).
5. Y용 DTO에서는 X의 이름·연락처·정확한 차량번호를 제거하고 `place, occurredFrom/To, type, vehicle(color/model/damageArea), description(요약)`, 사진 signed URL(짧은 TTL), `rewardPreview: { amount, mock: true }`(정산의 `witness_reward`), `mySubmissionId?`(이미 제보했으면)만 제공한다.

**검증**

- 시간 역순, 동의 미체크, 3장째 사진 → 400.
- 타인 요청 조회(알림 대상도 아닌 사용자) → 404.

---

### F4. 방문 이력 매칭 → 인앱 알림 (Y)

**API**

| Method/Path | 접근 | 설명 |
|---|---|---|
| `GET /api/v1/me/notifications?cursor=&limit=` | 로그인 | 최신순. `{ id, type, title, body, incidentId, submissionId?, readAt, createdAt }` |
| `POST /api/v1/notifications/:id/read` | 본인 | 읽음 처리 |
| `GET /api/v1/me/visits` | WITNESS | 본인 방문 기록(데모 seed 확인·삭제용) |
| `DELETE /api/v1/me/visits/:id` | WITNESS | 원칙 문서의 "언제든 삭제" 충족 |

**매칭 규칙 (실제 로직)**

```
대상 = visits
  where place_id = incident.place_id
    and user_id != incident.requester_id
    and profiles.notification_consent = true
    and tstzrange(entered_at, exited_at) && tstzrange(occurred_from - MATCH_TIME_PADDING_MIN, occurred_to + MATCH_TIME_PADDING_MIN)
```

- `MATCH_TIME_PADDING_MIN` 기본 15분. seed(13:58~14:12)와 요청(14:00~14:10)은 패딩 없이도 겹친다.
- 대상 사용자마다 `notifications(type=WITNESS_REQUEST)`를 1건 생성한다. UNIQUE 제약으로 동일 사고 중복 알림을 막는다.
- 알림 본문에는 X의 개인정보를 넣지 않는다. 예: `"9월 9일 14:00~14:10 A주차장에서 사고가 있었습니다. 당시 블랙박스 영상이 있다면 확인해 주세요."`
- 매칭 결과 `matched_witness_count`를 `incidents`에 저장한다.
- 실제 GPS 수집·백그라운드 방문 기록은 범위 밖이며 `visits.source='SEED'`로 명시한다.

**검증**

- 시간 안 겹침(예: 15:00~15:10) → 알림 0건, `matchedWitnessCount=0`.
- 같은 사고 재등록 시도 → 새 incident면 새 알림 1건, 같은 incident면 0건 추가.
- `notification_consent=false`인 사용자는 제외.

---

### F5. 영상 제보 업로드 (Y)

**API**

| Method/Path | 접근 | 설명 |
|---|---|---|
| `POST /api/v1/incidents/:id/submissions` | 알림 대상 WITNESS | `{ mime: "video/mp4", bytes, durationSec?, recordedAt? }` → `201 { submissionId, objectPath, uploadUrl, token, expiresAt, status: "UPLOADING" }` |
| `POST /api/v1/submissions/:id/complete-upload` | 제보자 | 서버가 Storage 객체 존재·크기·MIME 확인, sha256 계산, (가능하면 ffprobe로 duration/해상도) → `status=UPLOADED` |
| `GET /api/v1/submissions/:id` | 제보자, 해당 X, OPERATOR | 상태·메타·분석 요약 |
| `GET /api/v1/submissions/:id/video-url` | 제보자, 해당 X(READY 이후), OPERATOR | 재생용 signed URL(TTL `VIDEO_SIGNED_URL_TTL_SEC`, 기본 900) |

**처리 규칙**

- 해당 incident에 `WITNESS_REQUEST` 알림을 받은 사용자만 제보 생성 가능. 아니면 404.
- 사용자당 사고당 1개 제보(UNIQUE). 재업로드는 기존 submission이 `UPLOADING`/`ANALYSIS_FAILED`일 때만 `uploadUrl` 재발급.
- 파일 제한: `video/mp4` 단일 파일, `MAX_VIDEO_BYTES`(기본 200MB), 4초 이상 60분 이하, 해상도 360×360 이상(TwelveLabs 입력 조건). 위반 시 `413`/`415`/`422`.
- 분할 업로드·재개는 범위 밖. 단일 PUT.
- `complete-upload` 성공 시 incident가 `OPEN`이면 `COLLECTING`으로 전이.
- 원본은 private 버킷에 두고, X에게는 `READY` 이후 signed URL만 준다(원칙: 즉시 전체 공개 금지). 데모에서는 얼굴·무관 번호판 블러 처리를 하지 않으며 화면에 "데모: 가림 처리 미적용"을 표시할 수 있게 `redactionApplied: false`를 DTO에 넣는다.

**검증**

- 알림 대상이 아닌 Y → 404. X 계정 → 403.
- `complete-upload` 시 객체 없음 → 409 `INVALID_STATE` (`UPLOAD_NOT_FOUND` 메시지).
- 3초 영상 → 422 `VIDEO_UNANALYZABLE`.

---

### F6. AI 영상 분석 (TwelveLabs, 실제)

**API**

| Method/Path | 접근 | 설명 |
|---|---|---|
| `POST /api/v1/submissions/:id/analyze` | 제보자 | `UPLOADED` 또는 `ANALYSIS_FAILED`에서만. `202 { analysisId, status: "QUEUED" }` |
| `GET /api/v1/submissions/:id/analysis` | 제보자, 해당 X, OPERATOR | `{ status, source, result?, error?, startedAt, finishedAt, model, promptVersion }` |
| `POST /api/v1/submissions/:id/analyze/retry` | 제보자 | `FAILED`에서만. 새 attempt |

**분석 파이프라인 (`jobs/analysisQueue.ts`)**

1. `analyses` 행 생성(`QUEUED`), submission → `ANALYZING`.
2. 워커가 작업을 잡고 `ANALYZING`으로 표시.
3. 영상 signed URL(TTL ≥ `ANALYSIS_TIMEOUT_MS` 이상) 발급. `video: { type: "url", url }`로 전달한다. 파일이 `TWELVELABS_BASE64_MAX_BYTES`(기본 25MB) 이하이고 URL 방식이 실패하면 `type: "base64_string"`로 1회 재시도한다(TwelveLabs base64 상한 30MB).
4. X의 피해 차량 사진이 있으면 `prompt_v2.media_sources`(최대 4)로 참고 이미지를 넣고 `<@victim-photo-1>` 플레이스홀더로 참조한다. 사진이 없으면 `prompt`만 사용한다.
5. `response_format: { type: "json_schema", json_schema: <아래 스키마> }`, `stream: false`, `temperature: 0.2`, `max_tokens: 1024`로 호출한다. 타임아웃 `ANALYSIS_TIMEOUT_MS`(기본 120000).
6. 응답 `data`를 JSON 파싱 → zod로 재검증 → `FINALIZING`에서 서버 필드(`incidentTimestampLabel = "00:12"`, `videoDurationSec`, `promptVersion`)를 붙여 `result`에 저장 → `READY`.
7. submission → `READY`, X에게 `notifications(type=CANDIDATE_FOUND)` 생성(F7).
8. 실패 시 `analyses.status=FAILED`, `error_code`(`PROVIDER_UNAVAILABLE`/`PROVIDER_REJECTED`/`INVALID_RESPONSE`/`TIMEOUT`), submission → `ANALYSIS_FAILED`.

**프롬프트 (`prompt_version = "v1"`, 서버 상수)**

```text
당신은 주차장 블랙박스 영상을 검토하는 보조 분석가입니다. 아래 사고 요청 정보를 바탕으로 영상에서 사고 후보 장면을 찾으세요.

[사고 요청]
- 장소: {place.name}
- 사고 추정 시간대: {occurredFrom}~{occurredTo} (현지 시각)
- 피해 차량: {vehicle.color} {vehicle.model}
- 신고된 파손 부위: {vehicle.damageArea}
- 설명: {description}
{if photos}- 피해 차량 참고 사진: <@victim-photo-1> {<@victim-photo-2>}{/if}

[지시]
1. 영상에서 피해 차량으로 보이는 차량이 있는지, 다른 차량과 접촉·충돌·급정지·비정상 접근이 있는지 찾으세요.
2. 가장 가능성이 높은 장면 하나의 시작 시각(초)을 incidentTimestampSeconds로 보고하세요. 사고 후보 장면이 없으면 incidentDetected=false로 두고 incidentTimestampSeconds는 0으로 두세요.
3. victimVehicle, otherVehicle은 색상과 차종 위주로 간단히 묘사하세요. 번호판은 읽지 마세요.
4. relevance는 사고 요청과 장면의 일치 정도이며 HIGH/MEDIUM/LOW 중 하나입니다.
5. evidence에는 요청 정보와 일치하는 근거를 한국어로 2~4개 적으세요. 관찰한 사실만 적고 가해자·과실을 단정하지 마세요.
6. 반드시 지정된 JSON 스키마로만 답하세요.
```

**JSON 스키마 (TwelveLabs 제약 준수: `additionalProperties`·`minLength`·`maxItems` 사용 금지, 첫 속성 required)**

```json
{
  "type": "object",
  "properties": {
    "incidentDetected": { "type": "boolean" },
    "incidentTimestampSeconds": { "type": "timestamp", "format": "seconds" },
    "victimVehicle": { "type": "string" },
    "otherVehicle": { "anyOf": [ { "type": "string" }, { "type": "null" } ] },
    "event": { "type": "string" },
    "relevance": { "type": "string", "enum": ["HIGH", "MEDIUM", "LOW"] },
    "evidence": { "type": "array", "items": { "type": "string" }, "minItems": 1 }
  },
  "required": ["incidentDetected", "incidentTimestampSeconds", "victimVehicle", "event", "relevance", "evidence"]
}
```

**스키마 설계 근거 (TwelveLabs `json_schema` 제약)**

- `timestamp`는 TwelveLabs 전용 타입이다. 모델이 "영상 안의 시각"을 지정한 형식(`seconds` → JSON number, `hh:mm:ss` → 문자열)으로 돌려주며, 일반 `number`로 받는 것보다 영상 타임라인과 정렬이 잘 된다.
- 문서상 `timestamp`는 **스키마 최상위 속성** 또는 **배열 항목 객체의 1단계 속성**에만 둘 수 있다. `anyOf`/`oneOf`/`allOf` 안, `$ref` 안, 더 깊은 중첩에 두면 HTTP 400으로 거부된다. 그래서 `null`과의 `anyOf`로 "없음"을 표현할 수 없고, 대신 `incidentDetected=false`일 때 값을 무시하는 방식을 쓴다. 프롬프트도 그 경우 `0`을 쓰도록 지시한다.
- 서버는 `incidentDetected=false`이면 `incidentTimestampSeconds`를 `null`로 정규화하고 `incidentTimestampLabel`도 `null`로 둔다. `true`인데 값이 `videoDurationSec`를 넘거나 음수면 `INVALID_RESPONSE`로 처리한다.
- `additionalProperties`, `minLength`/`maxLength`, `maxItems`, `uniqueItems`는 422를 일으키므로 쓰지 않는다. `minItems`는 `0` 또는 `1`만 허용된다. `enum`은 string에 허용된다. 첫 속성(`incidentDetected`)은 반드시 `required`에 포함한다.
- `start_time`/`end_time`은 예약된 속성명이므로 응답 스키마 필드명으로 쓰지 않는다.
- 스키마 문제로 400/422가 나면 `json_schema` 없이 `prompt`만으로 JSON 텍스트를 받아 서버에서 파싱하는 경로를 최후 대안으로 두되, 채택한 최종 스키마는 `fixtures/twelvelabs-schema.v1.json`에 고정하고 `ANALYSIS_PROMPT_VERSION`을 올린다.

**서버 저장 `result` 형식 (FE 계약)**

```json
{
  "incidentDetected": true,
  "incidentTimestampSeconds": 12,
  "incidentTimestampLabel": "00:12",
  "victimVehicle": "흰색 세단",
  "otherVehicle": "검은색 SUV",
  "event": "검은색 SUV가 후진하며 흰색 세단 우측 후면에 접촉한 것으로 보이는 장면",
  "relevance": "HIGH",
  "evidence": ["피해 차량의 색상과 차종이 사고 요청과 일치", "신고된 파손 부위와 접근 방향이 유사"],
  "videoDurationSec": 20.3,
  "disclaimer": "AI 결과는 사고 사실·가해 차량·과실을 확정하지 않습니다. 원본 영상과 함께 사람이 확인해야 합니다."
}
```

**사전 분석 결과(PRERECORDED) 규칙 — 데모 안정성**

- `PRERECORDED_FALLBACK_ENABLED=true`이고, 실제 호출이 `PROVIDER_UNAVAILABLE`/`TIMEOUT`으로 **실패한 뒤에만**, 업로드된 영상의 `sha256`이 `fixtures/prerecorded/*.json`의 `videoSha256`과 일치하면 그 결과를 `source="PRERECORDED"`로 저장하고 `READY`로 만든다.
- 일치하는 fixture가 없으면 `FAILED`로 남긴다. **실패를 조용히 사전 결과로 대체하지 않는다.** `source` 값은 항상 DTO에 포함되어 FE가 `실시간 AI 분석 결과` / `사전 분석 결과` 배지를 붙인다.
- `INVALID_RESPONSE`(스키마 불일치)는 fallback 대상이 아니다. 최대 `ANALYSIS_MAX_ATTEMPTS`(기본 2)까지 실제 재시도한다.

**검증**

- `UPLOADED` 아닌 상태에서 analyze → 409.
- 실제 API 키로 기준 영상 분석 → `READY`, `source=LIVE`, `incidentTimestampSeconds` 존재.
- TwelveLabs 호스트를 차단한 상태에서 analyze → `FAILED` 또는 fixture 일치 시 `READY(source=PRERECORDED)`.
- 응답 JSON 깨짐 → `INVALID_RESPONSE`, 재시도 1회, 그래도 실패면 `FAILED`.
- 동일 submission에 analyze 두 번 동시 요청 → analyses 1행, 두 번째는 202로 기존 analysisId 반환.

---

### F7. 후보 전달·X 알림

**API**

| Method/Path | 접근 | 설명 |
|---|---|---|
| `GET /api/v1/incidents/:id/candidates` | 작성자, OPERATOR | `READY` 이상인 제보 목록. 각 항목: `{ submissionId, status, analysis: { source, result }, videoUrl(signed), witness: { maskedId: "제보자 #1" }, insurerReview?, humanReviewed: false }` |

**처리 규칙**

- 분석 `READY` 시 X에게 `CANDIDATE_FOUND` 알림 생성: `"A주차장 사고에 대한 후보 영상이 발견되었습니다. 00:12 지점을 확인해 보세요."`
- Y의 신원(이름·연락처·방문 기록)은 X에게 노출하지 않는다. `제보자 #n`으로만 표시.
- 열람용 signed URL 발급은 `audit_logs`에 남긴다.

---

### F8. 보험사 제출·채택 (Mock)

**API**

| Method/Path | 접근 | 설명 |
|---|---|---|
| `POST /api/v1/submissions/:id/submit-to-insurer` | 해당 X | `READY`에서만. `insurer_reviews(REVIEWING)` 생성, submission → `SUBMITTED`, incident → `REVIEWING`. 응답에 `integrity: { sha256, submittedAt }` |
| `POST /api/v1/submissions/:id/insurer-decision` | OPERATOR, 또는 `DEMO_MODE=true`일 때 해당 X(발표자) | `{ decision: "ADOPTED" | "REJECTED", note? }` |
| `GET /api/v1/submissions/:id/insurer-review` | 해당 X, 제보자, OPERATOR | 현재 상태 |

**처리 규칙**

- 채택은 `REVIEWING → ADOPTED/REJECTED` 단방향. 이미 결정된 건 재변경 불가(409).
- `ADOPTED` 시 트랜잭션으로: submission → `ADOPTED`, incident → `ADOPTED`, **F9 정산 전이**, Y에게 `ADOPTION_UPDATED` + `REWARD_SCHEDULED` 알림.
- `REJECTED` 시 submission → `REJECTED`, incident는 `COLLECTING`으로 복귀(다른 제보 대기).
- 응답과 DTO에 `mock: true, label: "데모 보험사 채택"`을 포함해 실제 보험사 연동으로 오해하지 않게 한다.
- AI 점수만으로 자동 채택하지 않는다. 채택 API는 반드시 사람이 호출한다.

---

### F9. 에스크로·보상 (Mock)

**API**

| Method/Path | 접근 | 설명 |
|---|---|---|
| `GET /api/v1/incidents/:id/settlement` | 해당 X, OPERATOR | `{ status, depositAmount, platformFee, witnessReward, payoutScheduledAt?, mock: true }` |
| `GET /api/v1/me/rewards` | WITNESS | 본인이 받을 보상 목록 `{ incidentId, submissionId, amount, status, scheduledAt }` |

**처리 규칙**

- `POST /incidents` 시 `settlements(DEPOSITED, deposit_amount=DEMO_DEPOSIT_AMOUNT(기본 100000), platform_fee=DEMO_PLATFORM_FEE(기본 20000), witness_reward = deposit - fee)` 생성. 실제 결제 없음.
- 제출(`SUBMITTED`) 시 `ADOPTION_PENDING`, 채택 시 `PAYOUT_SCHEDULED` + `payout_user_id = witness`, `payout_scheduled_at = now() + DISPUTE_WINDOW_HOURS`.
- `dedupe_key = incidentId:submissionId`로 같은 증거 중복 지급을 막는다.
- 실제 송금·환불·PG는 구현하지 않는다. DTO에 `mock: true`.

---

### F10. 데모 운영 (DEMO_MODE 전용)

**API**

| Method/Path | 접근 | 설명 |
|---|---|---|
| `POST /api/v1/demo/reset` | `DEMO_MODE=true` + `X-Demo-Admin-Token` 헤더 일치 | 데모 계정의 incidents/submissions/analyses/notifications/settlements를 삭제하고 seed(visits, places)를 복원. Storage의 데모 객체 삭제 |
| `GET /api/v1/demo/accounts` | `DEMO_MODE=true` | `{ requester: { email }, witness: { email } }` — 비밀번호는 반환하지 않음(FE는 env로 가짐) |

**처리 규칙**

- `DEMO_MODE=false`면 라우터를 등록하지 않는다(404).
- 앱 시작 시 DB를 자동 초기화하거나 seed를 자동 실행하지 않는다. seed는 `npm run seed:demo`로 명시 실행.
- seed 스크립트는 Supabase Admin API로 X/Y 계정을 생성(이미 있으면 skip)하고 `profiles`, `places`, `visits`를 upsert한다. 상세는 `MOCK_DATA_AND_ASSETS.md`.

---

## 6. 보안·개인정보 체크리스트

- [ ] TwelveLabs·Supabase service role 키는 서버 env에만 존재. FE 번들·소스맵·로그에 없음.
- [ ] Storage 버킷 private, signed URL TTL ≤ 15분(분석용은 예외로 타임아웃 이상).
- [ ] Y 신원·방문 기록이 X DTO에 포함되지 않음. X 연락처·이름이 Y DTO에 포함되지 않음.
- [ ] 알림 본문에 개인정보 없음.
- [ ] 영상·사진 sha256 저장, 제출 시 무결성 값 응답.
- [ ] 모든 signed URL 발급·채택 변경·분석 호출이 `audit_logs`에 남음.
- [ ] AI 결과 DTO에 `disclaimer` 고정 포함, 자동 채택·자동 지급 경로 없음.
- [ ] `PRERECORDED` 결과는 항상 `source`로 구분되어 노출됨.

---

## 7. 통합 검증 시나리오 (완료 조건)

| # | 시나리오 | 통과 기준 |
|---|---|---|
| S1 | X 로그인 → 사고 요청 + 사진 2장 | 201, `matchedWitnessCount=1`, settlement `DEPOSITED` |
| S2 | Y 로그인 → 알림 조회 | `WITNESS_REQUEST` 1건, 개인정보 없음 |
| S3 | Y 제보 생성 → PUT 업로드 → complete-upload | `UPLOADED`, sha256·duration 저장, incident `COLLECTING` |
| S4 | analyze → 폴링 | `QUEUED→ANALYZING→FINALIZING→READY`, `source=LIVE`, 타임스탬프 존재 |
| S5 | X 알림·후보 조회 | `CANDIDATE_FOUND` 1건, candidates에 signed videoUrl |
| S6 | submit-to-insurer → insurer-decision ADOPTED | submission/incident `ADOPTED`, settlement `PAYOUT_SCHEDULED`, Y 알림 2건 |
| S7 | Y `/me/rewards` | 1건 `PAYOUT_SCHEDULED`, `mock: true` |
| F1 | 시간 안 겹치는 요청 | 알림 0건 |
| F2 | 3초 영상 | 422 |
| F3 | TwelveLabs 차단 | `FAILED` 또는 fixture 일치 시 `READY(source=PRERECORDED)` |
| F4 | 이미 ADOPTED에 REJECTED 시도 | 409 |
| F5 | X 토큰으로 제보 생성 / 타인 submission 조회 | 403 / 404 |
| F6 | 서버 재시작 중 `ANALYZING` | 재시작 후 `FAILED`로 정리되고 retry 가능(고아 상태 없음) |

테스트는 별도 Supabase 프로젝트(또는 로컬 `supabase start`)와 fake TwelveLabs 클라이언트로 수행하고, 실제 키로 기준 영상 1개를 분석한 로그를 `fixtures/prerecorded/`에 남긴다.

---

## 8. 구현 순서

1. env 검증, Supabase 클라이언트, 인증 미들웨어, 응답/에러 규약, `/config`, `/health` (F0, F1)
2. 마이그레이션·seed·Storage 버킷·정책 (§3, F2, F10)
3. 사고 요청·사진 업로드·매칭·알림 (F3, F4)
4. 영상 제보 업로드·complete-upload (F5)
5. TwelveLabs adapter·분석 큐·결과 DTO·PRERECORDED 규칙 (F6)
6. 후보 전달·X 알림 (F7)
7. 보험사 채택·정산 Mock (F8, F9)
8. OpenAPI 작성, 통합 시나리오 S1~S7, F1~F6 검증, README(실행법·seed·외부 설정)

---

## 9. 백엔드 구현 에이전트에 전달할 프롬프트

```text
BE_SPEC.md, MVP_scope.txt, MVP_PARKING_INCIDENT_EVIDENCE.md, MOCK_DATA_AND_ASSETS.md, .env.example을 모두 읽고 Lumina 주차장 사고 증거 매칭 데모 백엔드를 구현·검증하라.

스택은 Node 20 + TypeScript + Express 5, 인증·DB·Storage는 모두 Supabase, AI는 TwelveLabs Analyze API(pegasus1.5)다. Firebase는 쓰지 마라. 브라우저에서 AI 키나 공급자 API를 직접 호출하지 마라.

F0~F10 기능을 명세의 API·상태 머신·DTO대로 구현하라. X 사고 요청과 사진 저장, Y seed 방문 기록과의 장소·시간 겹침으로 인앱 알림 생성, Y의 MP4 signed upload와 complete-upload, TwelveLabs 실제 분석(json_schema 응답, 참고 이미지 media_sources), 사고 후보 타임스탬프 결과 DTO, 보험사 채택·에스크로 Mock 상태 전이를 완성하라.

실제 분석 실패를 사전 분석 결과로 조용히 대체하지 마라. PRERECORDED는 공급자 장애 시 sha256이 일치하는 fixture에만, source 필드를 붙여 사용하라.

OpenAPI, 마이그레이션, seed 스크립트, .env.example, 실행 README, 통합 시나리오 S1~S7·F1~F6 테스트를 제공하고 구현 범위·검증 결과·남은 항목을 보고하라. TwelveLabs 키가 없으면 fake 클라이언트로 검증하되 실제 연동 미확인을 명확히 보고하라.
```
