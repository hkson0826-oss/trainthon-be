## 1. 임무와 우선순위

해커톤 데모 기준이다. 광고는 ADS_MODE=demo, AI 매칭은 멀티모달 모델이 DB 후보를 보고 고르는 단순한 방식이다.

무료 습득 등록, demo 광고 완료 후 단순 멀티모달 AI 찾기, 지도에서 위치 확인을 제공한다. 백엔드는 로그인 검증, 파일 검증과 저장, 습득물 AI 정보 추출, 검색 초안 저장, demo 광고 완료 기록, 단순 AI 매칭, 목록·지도용 공개 위치 데이터 제공을 책임진다.

PRODUCT_CONTRACT.md, FE_MASTER.md, START_HERE.md에 남아 있는 유료 찾기·반환·정산 요구가 이 문서와 충돌하면 이 문서의 최신 MVP 기준을 적용한다. 공통 계약이 이전 버전이라는 이유로 제거된 기능을 다시 구현하지 않는다. 충돌하지 않는 공통 응답 형식과 관례는 재사용한다. 구현 시 변경된 API·DTO·enum을 공통 계약과 OpenAPI에 반영하고 FE 통합 차이를 명시한다. 이 개정은 BE_MASTER.md 두 사본을 대상으로 하며, 다른 문서가 이미 동기화되었다고 가정하지 않는다.

이번 MVP 완료 조건에서 제외하는 기존 기능:

- 찾기 요청비 결제, 결제창, 결제 웹훅, 환불.
- 습득자 보상, 플랫폼 배분, 송금, 지급 계정과 정산 원장.
- 소유권 청구·증빙 승인·예약, 반환 QR/인증코드, 반환 완료 처리.
- 결제 시점부터 7일 동안 지속 검색, 자동 재매칭, 검색 기간 만료 정책.
- 위 기능을 위한 관리자 화면·분쟁 처리·알림 시스템.
- AdMob 등 실제 광고 매체 연동, 서명된 웹훅, 서버 간 완료 조회. 해커톤에서는 ADS_MODE=demo와 POST /demo/ad-sessions/:id/complete만 사용한다.
- embedding, 벡터 DB, 가중치 앙상블, 학습된 랭커 등 복잡한 매칭 파이프라인.

기존 코드나 데이터에 위 기능이 있더라도 이 문서를 이유로 사용자 데이터를 삭제하지 않는다. 신규 MVP 경로에서 의존하지 않도록 범위를 분리한다.

## 2. 구현 기반

Express 5, TypeScript strict, ESM, SQLite WAL과 migration, 런타임 입력 검증, Supabase Auth 인증, 서버 측 AI adapter, demo 광고 세션 adapter, 파일 저장소, 내장 작업 worker, OpenAPI를 사용한다. SQLite는 단일 서버와 영속 디스크를 전제로 한다.

- 기존 server/를 확장하고 FE 프로젝트를 재생성하지 않는다.
- Supabase Auth는 로그인 신원 확인에만 사용하고, 도메인 데이터의 원본은 서버 뒤의 SQLite로 둔다. 습득물·검색·광고 세션을 Supabase Postgres나 Storage로 이전하지 않는다.
- AI 비밀 키는 서버에서만 사용한다. 광고는 demo 완료 API만 쓰므로 매체 SDK 비밀·웹훅 서명 키는 이번 범위에 없다.
- 앱 시작마다 DB를 초기화하거나 demo seed를 자동 실행하지 않는다.
- 인증은 Supabase Kakao, 광고는 demo, AI는 실제 멀티모달 호출을 기본으로 한다. AI_MODE=demo는 키 없이 로컬 테스트할 때만 쓴다. 광고 demo 완료를 실제 광고 시청으로 보고하지 않는다.

권장 구조:

```text
server/
  src/
    index.ts
    app.ts
    config/env.ts
    middleware/{auth,errors,requestId,rateLimit}.ts
    modules/{uploads,items,searchRequests,adSessions,matching}/
    adapters/{auth,ai,ads,storage}/
    db/{connection,migrate,transactions}.ts
    db/migrations/
    jobs/{worker,outbox,cleanup}.ts
  scripts/seed-demo.ts
  test/{unit,integration,fixtures}/
  .env.example
  README.md
shared/openapi.yaml
shared/fixtures/demo-manifest.json
```

## 3. 완료해야 할 (MVP) 사용자 흐름

### 3.1 습득 등록

로그인한 습득자가 사진, 발견 장소, 그리고 상세한 설명을 올린다. 사용자가 초안을 확인하고 제출하면 공개 가능한 습득물로 저장한다. 보관 장소 상세와 연락 정보는 별도의 비공개 필드다. 습득 등록에는 결제가 없다. 서버는 파일을 검증하고 AI로 제목·카테고리·색상·특징을 추출한다.

구현 순서는 입력·업로드 검증 → 멀티모달 AI 추출 → 사용자의 초안 확인·수정 → 제출·공개다. AI가 초안을 자동 게시하지 않는다. 추출 실패 시 원본을 보존하고 오류와 재시도 가능 여부를 제공하며, 수동으로 내용을 보완해 등록할 수 있다. 사진, 발견 장소, 상세 설명은 습득 등록 필수 입력이다.

### 3.2 찾기

분실자가 사진 또는 설명, 마지막 위치·시간을 제출하고 초안을 확인한다. 그 이후, 광고 세션을 발급하고 demo 완료 API로 완료를 기록한 뒤에만 멀티모달 AI 검색을 실행한다.

해커톤에서는 실제 광고를 재생하거나 AdMob 웹훅을 붙이지 않는다. FE는 광고 시청 UI를 흉내 낼 수 있으나, 서버가 인정하는 완료는 POST /demo/ad-sessions/:id/complete뿐이다. 서버가 광고를 재생하거나 시청하는 것으로 구현하지 않는다.

검색 소유권과 광고 세션 연결을 위해 찾기 요청도 로그인한 사용자를 기준으로 저장한다. 사진은 없어도 되지만 사진과 설명이 모두 없으면 거절한다. 마지막 위치와 시간은 필수다. 광고 전 초안 확인은 입력값 저장·검증으로 수행하고, 분실 요청에 대한 AI 분석과 후보 매칭은 demo 광고 완료 후 시작한다. 기존 습득물 AI 정보 추출은 무료 등록 흐름이므로 이 광고 조건과 별개다.

MVP 기본 동작은 확정된 입력 한 건에 대한 1회 검색이다. 새 조건으로 다시 검색하려면 새 초안 확인과 광고 완료가 필요하다. 같은 실행의 장애 재시도와 저장된 결과 재조회에는 광고를 다시 요구하지 않는다. 지속 탐색이나 신규 습득물 등록에 따른 자동 재검색은 추가하지 않는다.

### 3.3 UI

지도 형태의 UI로도 분실물의 위치를 제공한다.

백엔드는 공개 습득물과 검색 후보를 지도에 표시할 수 있는 좌표·장소명·물건 식별자를 제공한다. 공개 지도 핀은 습득물의 발견 위치를 뜻하며 현재 실시간 위치나 비공개 보관 장소를 뜻하지 않는다. 분실자의 마지막 위치는 본인 검색 상세에서만 제공한다. 지도 렌더링과 지도 SDK 연결은 FE 책임이다.

## 4. 인증과 접근 권한

실제 로그인은 Supabase Auth Kakao 로그인을 사용한다. FE가 Authorization: Bearer로 Supabase access token(JWT)을 전달하면 서버가 서명·만료·issuer(프로젝트 Auth URL)·audience를 검증하고 Supabase user UUID(`sub`)를 내부 user ID에 매핑한다. 실패하면 401을 반환하며 demo로 전환하지 않는다. 학교 소속 인증은 이번 범위에 없다.

토큰 검증은 `@supabase/supabase-js`의 `auth.getUser(jwt)` 또는 `auth.getClaims()`, 또는 프로젝트 JWKS(`{SUPABASE_URL}/auth/v1/.well-known/jwks.json`)로 수행한다. JWT payload만 디코드하거나 FE가 보낸 user id를 그대로 신뢰하지 않는다. 서비스 롤 키와 JWT 비밀은 서버에서만 사용한다. users 행은 `auth_provider='supabase'`, `provider_uid`=Supabase Auth user UUID로 저장한다.

AUTH_MODE=demo는 로컬 개발용으로만 지원하고, 분실자와 습득자 테스트 계정의 서버 검증 가능한 토큰을 사용한다. 토큰 부재나 임의 userId 헤더를 로그인으로 간주하지 않는다.

| 자원/행위 | 접근 주체 |
| --- | --- |
| 공개 습득물 목록·상세·지도 핀 | 익명 포함 공개 사용자 |
| 업로드·습득물 AI 추출·초안 생성 | 로그인 사용자 |
| 습득물 초안 조회·수정·게시·비공개 필드 조회 | 작성자 |
| 분실 요청·광고 세션·검색 실행·결과 | 해당 요청 소유자 |
| demo 광고 완료 | 해당 세션 소유자, ADS_MODE=demo일 때만 |

작성자 ID와 검색 소유자는 인증 정보에서 정한다. 클라이언트의 ownerId, status, role, adCompleted를 권한 증거로 사용하지 않는다. 다른 사용자의 비공개 리소스 조회는 404로 통일한다. 공개 API에는 보관 장소 상세와 연락처를 포함하지 않는다. 이번 MVP에는 타 사용자에게 이 비공개 정보를 공개하는 승인 절차가 없으므로 작성자 전용으로 유지한다.

## 5. 광고 완료 검증

이번 해커톤의 기본값은 ADS_MODE=demo다. AdMob 등 실제 매체 SDK, 서명된 웹훅, 서버 간 완료 조회는 구현하지 않는다. POST /webhooks/ads는 범위 밖이다. 세션 발급·소유자 확인·완료 기록·1회 소비 흐름만 추적한다.

1. 사용자가 검색 초안을 확인하면 서버가 해당 입력 버전과 sourceHash를 고정한다.
2. 서버는 ownerId, searchRequestId, sourceHash에 연결된 광고 세션과 추측 불가능한 식별자를 생성한다. provider는 demo로 표시한다.
3. FE는 광고 시청 UI를 보여 줄 수 있으나, 완료 증거는 POST /demo/ad-sessions/:id/complete뿐이다.
4. 서버는 로그인 사용자 = 세션 소유자, 세션이 CREATED, 만료 전, sourceHash 일치일 때만 VERIFIED로 바꾼다.
5. FE의 검색 실행 요청에서 이 검증된 세션을 한 번 소비하고 검색 작업을 만든다.

watched=true, 프런트 타이머, 클라이언트만 발생시킨 종료 이벤트를 완료로 인정하지 않는다. demo 완료 API를 거치지 않으면 VERIFIED가 될 수 없다. 타인 세션 완료는 404로 거절한다. live 환경에 demo 완료 경로를 등록하지 않는다. 응답에서 adsMode=demo임을 밝히며 실제 광고 검증 완료로 보고하지 않는다.

광고 미완료·취소·만료·검증 실패 상태에서는 AI 검색 작업이 없어야 한다. capabilities.ads는 demo 완료 경로가 동작하면 true가 될 수 있으나 GET /config의 adsMode는 demo여야 한다.

세션 유효기간은 ADS_SESSION_TTL_SECONDS로 정의하고 API에서 expiresAt을 반환한다. 만료되거나 소비된 세션을 재사용할 수 없다. 초안 수정 시 기존 미소비 세션을 무효화한다. 입력이 바뀐 뒤 이전 세션으로 새 입력을 승인하지 않는다.

## 6. 상태·데이터 모델

공개 상태의 기준은 이 MVP 설계다. 기존 결제·반환 중심 enum을 그대로 사용하지 않는다. ID는 opaque UUID, 시간은 ISO-8601 UTC, JSON 필드는 camelCase로 통일한다.

| 자원 | 상태 및 전이 |
| --- | --- |
| FoundItem | DRAFT → AVAILABLE → ARCHIVED |
| Analysis | QUEUED → PROCESSING → READY 또는 FAILED |
| SearchRequest | DRAFT → AWAITING_AD → QUEUED → SEARCHING → COMPLETED 또는 FAILED |
| AdSession | CREATED → VERIFIED → CONSUMED; 미소비 세션은 EXPIRED 또는 INVALIDATED로 종료 |
| 실패 검색 재시도 | FAILED → QUEUED; 동일 입력·동일 실행에 한정 |

초안 확인 시 AWAITING_AD로 바꾼다. DRAFT와 AWAITING_AD에서만 입력 수정이 가능하며 수정하면 DRAFT로 돌아가 기존 광고 세션을 무효화한다. QUEUED 이후 입력은 고정한다. 사용자가 다른 조건으로 검색하려면 새 요청을 만든다. 입력 확인과 광고 완료는 각각 별도 상태로 보존한다.

| 테이블 | 핵심 필드와 제약 |
| --- | --- |
| users | id, auth_provider, provider_uid; UNIQUE(auth_provider, provider_uid) |
| uploads | id, owner_id, object_key UNIQUE, mime, bytes, width, height, purpose, status |
| items | id, owner_id, status, title, description, category, colors, features, public_place_label, public_lat, public_lng, version, created_at |
| found_item_private | item_id PK/FK, original_found_location, storage_place, contact_info; 작성자만 조회 |
| item_images | item_id, upload_id, position; 물건 내 중복·순서 UNIQUE |
| analyses | id, owner_id, item_id, source_hash, status, result, error_code, provider, model_version |
| item_features | item_id, source_hash, provider, model_version, feature_version, features; 동일 버전 중복 방지 |
| search_requests | id, owner_id, photo_ids, description, last_location, last_seen_at, source_hash, version, confirmed_at, status |
| ad_sessions | id, owner_id, search_request_id, source_hash, provider, status, expires_at, verified_at, consumed_at |
| ad_events | provider, event_id, body_hash, session_id, processed_at; UNIQUE(provider, event_id) |
| search_runs | id, search_request_id UNIQUE, ad_session_id UNIQUE, source_hash, status, provider, model_version, attempts, error_code, started_at, completed_at |
| matches | run_id, found_item_id, score, component_scores, reasons, source_versions; UNIQUE(run_id, found_item_id) |
| idempotency_keys | actor_id, scope, key, request_hash, response_status, response_json; UNIQUE(actor_id, scope, key) |
| outbox_jobs | id, run_id 또는 analysis_id, dedupe_key UNIQUE, status, attempts, available_at, lease_until, locked_by |
| schema_migrations | version PRIMARY KEY, checksum, applied_at |

사진 연결은 FK가 있는 연결 테이블 또는 동등하게 참조 무결성이 보장되는 구조를 사용한다. SQLite는 foreign_keys=ON, journal_mode=WAL, busy_timeout을 적용하고 상태·좌표·관계는 CHECK/FK/UNIQUE와 런타임 검증으로 보호한다. 공개 목록, 소유자 목록, 지도 범위, 매칭 순위, 작업 대기·lease 조회에 인덱스를 둔다. 공개 DTO는 허용 필드 목록으로 만든다.

## 7. 검색 시작의 원자성과 멱등성

모든 사용자 mutation은 Idempotency-Key를 받는다. actor + route + key + 정규화된 body가 같으면 최초 확정 결과를 반환하고, 같은 key의 다른 body는 409를 반환한다. 재생 전에도 인증·소유권을 검사한다. 처리 중 요청의 재호출은 상태 확인이 가능한 409 REQUEST_IN_PROGRESS로 통일한다.

검색 실행은 짧은 DB transaction에서 다음을 수행한다.

1. 요청 소유자, AWAITING_AD 상태, 확정된 sourceHash를 확인한다.
2. 해당 사용자·요청·입력과 일치하는 VERIFIED 광고 세션의 만료 여부를 검사한다.
3. 조건부 update로 광고 세션을 CONSUMED로 바꾼다.
4. 유일한 search_run과 outbox 작업을 만들고 검색을 QUEUED로 변경한다.
5. commit 후 202와 실행 식별자를 반환한다.

다른 key로 중복 실행을 요청해도 search_request_id UNIQUE로 새 실행을 만들지 않는다. 이미 접수된 실행을 반환한다. 광고 소비와 작업 저장은 함께 성공하거나 함께 rollback한다. 실패한 실행의 재시도는 기존 run에 연결되고 광고를 다시 소비하지 않는다.

worker는 lease로 작업을 확보하고 DB transaction 밖에서 AI를 호출한다. 완료 저장에는 lease 소유자·실행 상태·입력 버전을 확인한다. 결과와 COMPLETED 상태를 한 transaction으로 반영한다. crash 후 재시도에서 결과 행과 사용자 실행을 중복 생성하지 않는다. 외부 AI가 멱등 호출을 지원하지 않으면 네트워크 timeout 뒤 중복 호출 비용까지 완전히 방지한다고 주장하지 않으며 호출 횟수와 재시도 상한을 기록한다.

## 8. AI 추출과 단순 멀티모달 매칭

습득 등록은 검증된 사진과 상세 설명을 멀티모달 모델에 한 번 넣어 제목·카테고리·색상·특징을 추출한다. 사용자 입력과 이미지 속 문자는 데이터로 취급하고 모델에 비밀 조회나 권한 변경 도구를 주지 않는다. 구조화 응답을 런타임 검증하고 없는 특징이나 연락처·보관 장소를 생성하지 않는다. 사용자가 수정한 값을 자동 덮어쓰지 않는다.

검색은 demo 광고 완료 후 멀티모달 모델을 호출한다. 공개 가능한 AVAILABLE 습득물을 SQLite에서 읽어, 분실 요청의 사진·설명과 후보의 공개 사진·제목·설명·카테고리·색상·특징을 모델이 보고 같은 물건인지 고른다. 복잡한 검색 알고리즘을 만들지 않는다.

해커톤 매칭 절차:

1. AVAILABLE 공개 습득물을 DB에서 조회한다. 후보가 많으면 최근 N건, 카테고리가 있으면 같은 카테고리 우선처럼 단순한 상한만 둔다.
2. 분실 요청에 사진이 있으면 이미지와 설명을, 없으면 설명만 모델에 넣는다. 설명이 없고 사진만 있는 요청도 정상 처리한다. 사진과 설명이 모두 없는 요청은 앞 단계에서 거절한다.
3. 각 후보의 공개 이미지와 공개 텍스트를 함께 넣어 일치 여부, 간단한 점수, 짧은 근거를 JSON으로 받는다. 기본 모델은 Groq `qwen/qwen3.6-27b`다. 요청당 이미지는 최대 5장이므로 후보가 많으면 나눠 호출한다. thinking/reasoning 모드는 끄고 JSON mode만 쓴다. 한 번의 배치 호출이든 후보별 호출이든 구현이 단순한 쪽을 택한다.
4. 서버는 응답을 검증한 뒤 점수 내림차순으로 matches에 저장한다. 위치·시간은 있으면 보조 힌트로 모델에 알려 주고, 없으면 생략한다. 거리 함수·시간 감쇠·embedding cosine·벡터 DB·가중치 앙상블은 사용하지 않는다.
5. 후보 ID만 주고 고르게 하거나 고정 fixture 순위를 AI 결과로 반환하지 않는다.
6. 반환 점수는 순위 지표이며 소유권이나 정답 확률의 증명이 아니다. 일치 근거는 실제 공개 입력에 근거한다.

후보가 없으면 외부 AI를 호출하지 않고 COMPLETED와 빈 결과를 반환한다. 외부 AI 장애는 FAILED로 구분하며 후보 없음으로 숨기지 않는다. 후보 상한, timeout, 동시 호출 수는 설정으로 관리한다.

원본 수정 시 sourceHash로 추출 정보를 무효화하고 이전 작업이 새 내용을 덮어쓰지 못하게 한다. 후보 조회 시 현재 공개 상태를 다시 확인하여 보관 처리된 물건이나 삭제된 공개 정보를 노출하지 않는다.

해커톤 기본값은 AI_MODE=live다. 기본 공급자는 Groq이고, 모델은 사진 입력이 되는 `qwen/qwen3.6-27b`다. Gemini·GPT-4o 계열은 쓰지 않는다. Groq 무료 티어로 데모 호출량을 감당하는 것을 전제로 한다. 키가 있으면 실제 멀티모달 호출로 추출과 매칭을 수행한다. AI_MODE=demo는 키 없이 로컬 테스트할 때만 쓰는 결정적 fixture다. live 실패 시 demo로 자동 전환하지 않는다. 키가 없으면 로컬 검증은 수행하되 실제 AI 연동 미완료를 명시한다.

## 9. 지도 데이터와 개인정보

PublicFoundItem은 id, title, category, thumbnailUrl, publicLocation을 제공한다. publicLocation은 label, lat, lng, precision을 포함하고 precision은 APPROXIMATE로 표시한다. BE는 발견 위치를 캠퍼스 건물·공개 구역 또는 일관된 격자로 일반화해 지도 핀을 생성한다. 지도 정책과 정밀도는 설정에 기록하고 목록·상세·검색 후보·지도에서 같은 공개 좌표를 사용한다.

공개 지도는 습득물의 발견 위치를 보여 준다. 정확한 원본 발견 위치, 보관 장소 상세, 연락처, 분실자의 마지막 위치는 공개 지도 응답에서 제외한다. 검색 소유자의 마지막 위치는 본인 검색 DTO로 전달하여 FE가 별도 마커로 표시할 수 있다.

지도 조회는 bbox=west,south,east,north와 category, cursor, limit을 지원한다. bbox는 공개 좌표 기준으로 필터링한다. 위경도 범위·좌표 순서·지원 서비스 영역·조회 면적 상한을 검증하고 최대 50건씩 안정적으로 페이지를 나눈다. 전체 지도의 모든 결과를 반환한 것처럼 표시하지 않도록 nextCursor를 제공한다. 지도 SDK 선택과 화면 렌더링은 FE에서 처리한다.

사진은 JPEG/PNG/WebP, 장당 10MB, 요청당 최대 3장으로 제한한다. MIME와 실제 signature를 검증하고 decode 시 픽셀 상한을 적용하며 EXIF를 제거한다. 사용자 파일명을 저장 경로로 사용하지 않고 업로드 소유권을 확인한다. 비공개 파일 저장소 전체를 static 공개하지 않는다.

연락처와 보관 장소는 별도 비공개 필드로 저장하며 AI 입력·공개 설명·일치 이유·로그에 넣지 않는다. 공개될 사진과 설명에는 연락처나 신분증 원문 등 개인정보가 포함되지 않도록 초안 확인 단계에서 안내한다. 서버 비밀과 인증 토큰은 에러·로그에 남기지 않는다.

## 10. MVP API 기준

prefix는 /api/v1, FE 기본 포트는 3000, BE는 3001이다. ID와 날짜, DTO는 위 기준을 따른다. 이 목록은 기존 유료 API 계약을 대체할 MVP 기준이며 구현 시 OpenAPI와 공통 계약에 명시한다.

| Method/path | 입력·접근·결과 |
| --- | --- |
| GET /config | 공개; mode, authMode, aiMode, adsMode, capabilities:{ai,ads,maps}, 업로드 제한·지도 정책 |
| GET /me | 본인 사용자 정보 |
| POST /uploads | 로그인 multipart; 검증된 upload 반환 |
| POST /found-items | 사진·발견 장소·상세 설명과 선택 비공개 필드; DRAFT 생성 |
| POST /found-items/:id/analyses | 작성자; 현재 초안의 멀티모달 AI 추출 접수, 202 Analysis |
| GET /analyses/:id | 작성자; 상태·추출 결과·오류 |
| PATCH /found-items/:id | 작성자 DRAFT; version 기반 수정 |
| POST /found-items/:id/publish | 작성자; 필수 입력·사용자 확인 검증 후 AVAILABLE |
| POST /found-items/:id/archive | 작성자; AVAILABLE → ARCHIVED |
| GET /me/found-items | 본인 목록 |
| GET /found-items | 공개 목록; category, query, cursor, limit |
| GET /found-items/map | 공개 지도; bbox, category, cursor, limit |
| GET /found-items/:id | 익명은 public DTO, 작성자는 owner DTO; 초안은 작성자 전용 |
| POST /search-requests | 로그인; 사진 또는 설명, 마지막 위치·시간으로 DRAFT 생성 |
| PATCH /search-requests/:id | 본인; version 기반 입력 수정·기존 확인 무효화 |
| POST /search-requests/:id/confirm | 본인; version 확인 후 입력 확정·AWAITING_AD |
| GET /me/search-requests | 본인 목록 |
| GET /search-requests/:id | 본인; 초안·상태·현재 실행·오류 |
| POST /search-requests/:id/ad-sessions | 본인; 확정된 입력에 연결된 demo 세션 발급 |
| GET /ad-sessions/:id | 본인; 상태·expiresAt 조회 |
| POST /demo/ad-sessions/:id/complete | ADS_MODE=demo 전용, 본인; 세션을 VERIFIED로 바꿈. 해커톤 기본 완료 경로 |
| POST /search-requests/:id/execute | 본인 {adSessionId}; VERIFIED 세션 소비 후 202 실행 정보 |
| POST /search-requests/:id/retry | 본인; 재시도 가능한 FAILED 실행 재접수, 추가 광고 없음 |
| GET /search-requests/:id/matches | 본인; COMPLETED 결과, 점수·근거·publicLocation·cursor |
| GET /health | 공개 최소 liveness |
| GET /ready | 인프라 제한; DB·migration·필수 설정 readiness |

공급자 내부 필드를 공통 DTO에 무분별하게 노출하지 않는다. /found-items/map은 :id 경로보다 먼저 등록한다. POST /webhooks/ads는 이번 해커톤 범위 밖이며 구현하지 않는다. ADS_MODE가 demo가 아니면 /demo/ad-sessions/:id/complete는 404 또는 403으로 거절한다.

초안 사진 ID 배열·설명·장소·시간·version을 schema로 검증하고 문자열 길이 상한을 명시한다. 습득물 제목·카테고리·색상·특징의 AI 제안은 사용자가 확인한 후 저장한다. mutation에 owner나 서버 상태를 직접 지정하는 mass assignment를 막는다.

성공은 {data,meta:{requestId,nextCursor?}}, 실패는 {error:{code,message,fieldErrors?,retryable},meta:{requestId}}를 사용한다. 생성 201, 작업 접수 202, 조회·수정 200을 기본으로 한다. 검색 완료 전 matches 조회는 409 SEARCH_NOT_COMPLETE, 완료 후 후보 없음은 200과 빈 배열이다.

주요 오류는 400 VALIDATION_ERROR, 401 UNAUTHENTICATED, 403 AD_NOT_VERIFIED, 404 NOT_FOUND, 409 INVALID_STATE/VERSION_CONFLICT/IDEMPOTENCY_CONFLICT/REQUEST_IN_PROGRESS, 410 AD_SESSION_EXPIRED, 413 FILE_TOO_LARGE, 415 UNSUPPORTED_MEDIA_TYPE, 429 RATE_LIMITED, 503 PROVIDER_UNAVAILABLE이다.

## 11. 운영과 환경 설정

요청별 인증·rate limit·body 크기·timeout을 적용한다. CORS는 지정 origin만 허용하고 공개 health에는 내부 경로나 비밀을 넣지 않는다. worker는 지수 backoff와 최대 재시도 수를 적용한다. 필수 작업은 습득물 AI 추출, demo 광고 완료 후 검색, 미연결 업로드와 만료 광고 세션 정리다.

requestId, 최소 actorId, runId, 소요시간, 결과 코드와 AI 공급자·모델·호출 횟수를 기록한다. AI 실패·지연, outbox 대기, 재시도 횟수를 관측한다. DB와 업로드의 백업·복원 방법을 README에 적고 서버 재시작 후 진행 중 작업이 복구되도록 한다.

환경 예시는 비밀이 없는 값만 제공한다.

```dotenv
NODE_ENV=development
PORT=3001
APP_MODE=demo
AUTH_MODE=supabase
AI_MODE=live
ADS_MODE=demo
DATABASE_PATH=./data/trainthon.sqlite
UPLOAD_DIR=./data/uploads
CORS_ORIGINS=http://localhost:3000
PUBLIC_APP_URL=http://localhost:3000
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
GROQ_API_KEY=
AI_MODEL=qwen/qwen3.6-27b
ADS_SESSION_TTL_SECONDS=
```

위 예시는 해커톤 데모 기본값이다. AUTH_MODE=supabase, AI_MODE=live, ADS_MODE=demo를 사용한다. AI는 Groq `qwen/qwen3.6-27b`다. 서버에서 OpenAI 호환 Chat Completions로 호출하고, 사진·설명 추출과 매칭에 같은 모델을 쓴다. 광고 매체 키·웹훅 서명 비밀은 넣지 않는다. AUTH_MODE=demo와 AI_MODE=demo는 키 없이 로컬 테스트할 때만 쓴다. Supabase 서비스 롤 키와 JWT 검증 비밀, Groq API 키는 env 또는 secret manager로 공급한다. FE에는 publishable(anon) 키와 프로젝트 URL만 두고, 서비스 롤 키와 Groq 키를 VITE_ 변수에 넣지 않는다. Kakao 제공자는 Supabase Auth 대시보드와 Kakao Developers에서 활성화한다. 서버는 Kakao access token을 직접 검증하지 않고, FE가 받은 Supabase JWT만 검증한다.

AUTH 또는 AI live 설정이 부족하면 startup validation 또는 해당 capability에서 명확히 실패하며 demo로 자동 전환하지 않는다. 광고는 demo가 정상 경로이므로 매체 키 부재를 오류로 취급하지 않는다. maps capability는 지도용 데이터 API 제공 여부를 의미하며 FE 지도 SDK가 준비되었다는 뜻은 아니다. 결제·웹훅 결제 비밀 키·지급 설정은 이번 MVP에 필요하지 않다.

## 12. 검증 시나리오

| 시나리오 | 통과 기준 |
| --- | --- |
| 습득 등록 | 로그인·사진·발견 장소·상세 설명 검증, 멀티모달 AI 추출, 사용자 확인 후 공개 |
| 미완성 초안 | 공개 목록·지도·검색 후보에 노출되지 않음 |
| 사진만/설명만 검색 | 둘 중 하나로 가능, 둘 다 없으면 거절 |
| 광고 전 AI 검색 | 초안 저장·확인만 가능하며 검색용 AI 호출·작업이 없음 |
| demo 완료 없이 execute | AD_NOT_VERIFIED, 검색 작업 없음 |
| 위조 완료·타인 세션 | 거절, 검색 작업 없음 |
| 광고 만료·초안 수정 | 기존 세션으로 변경된 입력 검색 불가 |
| execute 동시 요청 | 광고 소비 1회, run 1개, 최초 작업 1개 |
| AI 실패 후 재시도 | 원본 보존, 기존 실행 사용, 광고 재요구 없음 |
| 후보 없음과 AI 장애 | 빈 성공 결과와 실패 상태가 구분됨 |
| 단순 멀티모달 검색 | DB의 AVAILABLE 후보와 분실 입력을 모델이 비교하고, embedding·벡터검색 없이 점수·근거 반환 |
| 목록·지도·검색 후보 | 같은 공개 위치 정책 적용, bbox·페이지네이션 정상 |
| 타 사용자 비공개 데이터 | 마지막 위치·보관 장소·연락처·초안·검색 결과 접근 차단 |
| 잘못된 파일·타인 업로드 | 업로드 또는 연결 거절 |
| worker crash·재시작 | 작업 복구, 중복 결과 없음, 기존 데이터 유지 |
| AUTH/AI live 설정 누락 | demo로 위장하지 않고 미지원·오류를 표시 |

테스트는 임시 DB와 fake clock/provider를 사용한다. 광고 소비 경합은 같은 SQLite 파일에 별도 connection을 사용하여 검증한다. 실제 멀티모달 호출 검증은 fake 테스트와 별도로 실행 결과를 남긴다. 광고는 demo 완료 경로가 해커톤 완료 기준이다.

## 13. 구현 순서와 완료 기준

1. 기존 코드·AGENTS.md·사용자 변경을 확인하고 이 문서의 최신 범위를 적용한다.
2. 이전 공통 계약과의 차이를 정리하고 이 MVP의 OpenAPI·DTO·상태를 맞춘다.
3. 인증, 입력 검증, DB migration, 업로드, 공개/비공개 데이터 분리를 구현한다.
4. 습득 등록의 멀티모달 AI 추출·초안 확인·게시와 목록·지도 API를 구현한다.
5. 검색 초안·확정, demo 광고 세션·완료 API, 원자적 검색 실행을 구현한다.
6. 단순 멀티모달 매칭·결과 조회·오류 재시도와 worker 복구를 연결한다.
7. API·권한·경합 테스트, typecheck, build, 재시작을 검증한다.
8. FE와 동일한 demo fixture 및 새 계약을 공유하고 세 사용자 흐름을 통합 검증한다.
9. 실행법, 필요한 외부 설정, 남은 항목을 README에 기록한다.

해커톤 완료 조건:

- 로그인한 습득자의 입력 → 멀티모달 AI 추출 → 초안 확인 → 공개 등록이 동작한다.
- 분실 요청 → 초안 확인 → POST /demo/ad-sessions/:id/complete → 멀티모달 검색 → 결과 조회가 동작한다.
- 지도 API가 공개 가능한 위치를 제공하고 FE에서 목록과 같은 물건을 지도에 표시할 수 있다.
- 비공개 보관 장소·연락처·타인의 마지막 위치가 공개 API에 노출되지 않는다.
- demo 완료 없이 검색 실행이 막히고, 중복 검색·서버 재시작·AI 장애 검증이 통과한다.
- OpenAPI, migration, .env.example, 명시적 demo seed, 실행 README가 제공된다.
- 실제 광고 매체 미연동은 남은 항목으로 적되, ADS_MODE=demo가 정상 경로이므로 이 이유만으로 미완료로 보지 않는다.
- AI 키가 없어 실제 멀티모달 호출을 못 하면 그 항목만 미완료로 명시한다.

## 14. 백엔드 구현 에이전트에 전달할 프롬프트

```text
해커톤 백엔드 데모를 구현하고 검증하라.
무료 습득 등록, demo 광고 완료 후 단순 멀티모달 AI 찾기, 지도용 위치 데이터 제공이다. 로그인한 습득자의 사진·발견 장소·상세 설명을 검증하고 멀티모달 AI로 제목·카테고리·색상·특징을 추출한 뒤 사용자 확인을 거쳐 게시하라. 보관 장소 상세와 연락처는 비공개로 저장하라.

분실자는 사진 또는 설명과 마지막 위치·시간을 입력하고 초안을 확인한다. POST /demo/ad-sessions/:id/complete로 세션을 VERIFIED한 후에만 AI 검색을 실행하라. AdMob 등 실제 광고 웹훅은 구현하지 마라. 광고 세션을 사용자·검색·입력 버전에 연결하고 단일 소비와 실행 생성을 transaction으로 보장하라. 실패 재시도는 같은 실행을 사용하고 광고를 다시 요구하지 마라.

매칭은 AVAILABLE 습득물을 DB에서 읽어 멀티모달 모델이 사진·설명을 보고 고르는 단순한 방식으로 하라. embedding, 벡터 DB, 가중치 앙상블은 쓰지 마라.

목록·지도·검색 후보에 동일한 공개 발견 위치를 제공하라. 지도 렌더링은 FE가 담당한다. 비공개 보관 장소·연락처·타인의 마지막 위치를 공개하지 마라.

Express/TypeScript/SQLite/Supabase Kakao Auth 기반으로 기존 server/를 확장하라. 기본 설정은 AUTH_MODE=supabase, AI_MODE=live, ADS_MODE=demo다. AI는 Groq `qwen/qwen3.6-27b`로 사진·텍스트를 보고 추출·매칭하라. Gemini는 쓰지 마라. 실제 AI 키가 없으면 로컬 검증은 진행하되 실제 연결 미완료를 명확히 보고하라.

의미 있는 API·권한 테스트, typecheck/build와 FE 통합 검증을 수행하라. 실행 README·환경 예시·fixture·API 문서를 제공하고 구현 범위, 검증 결과, 실행법, 남은 항목을 보고하라.
```


