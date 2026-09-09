# Lumina BE 개발 에이전트 최상위 실행 명세

> 용도: 이 문서와 `PRODUCT_CONTRACT.md`를 백엔드 개발 에이전트에 함께 전달하여 실행 가능한 MVP를 한 번에 구현한다. 이 파일은 개발 지시서이며 현재 구현·배포·결제 연동이 완료되었다는 뜻이 아니다.
> 작성 기준: 2026-09-09. 참조 저장소: https://github.com/Icey067/Lumina.git, `main` 조회 tree SHA `538e9066a6079387f1ffc4bd90971b272da809b9`.

## 1. 임무와 우선순위

Lumina는 분실자가 **찾기 요청비 5,000원**을 결제하고, 이미지·설명·위치를 이용한 AI 매칭과 반환 중개를 받는 서비스다. 반환이 확인되면 결제액 중 **3,500원은 습득자 보상**, **1,500원은 플랫폼 배분액**으로 기록한다. 사용자 지정 사례금 경매나 자유 금액 모금 기능을 만들지 않는다. 플랫폼 배분액은 결제·AI·운영 비용 차감 전 금액이며 순이익을 뜻하지 않는다.

백엔드는 입력 저장부터 매칭, 소유 확인, 제한된 수령 정보 공개, 반환 인증, 정산·환불의 재시도까지 책임진다. UI가 성공으로 표시하더라도 서버가 검증하지 않은 결제와 반환은 인정하지 않는다.

우선순위는 다음과 같다.

1. 사용자가 명시한 요구와 기존 작업 디렉터리의 `AGENTS.md`.
2. FE와 BE 공통 계약인 `PRODUCT_CONTRACT.md`의 HTTP 경로, JSON, enum, 정책.
3. 이 문서의 서버 구현·데이터·보안·검증 요구.
4. 원본 코드의 구조와 재사용 가능한 구현.

충돌을 발견하면 공통 계약을 임의로 바꾸지 말고 차이와 권장 해결안을 기록한다. 계약으로 해소 가능한 구현 선택은 스스로 결정하여 진행한다. 실제 외부 결제·송금·AI 과금 실행과 운영 배포는 별도 활성화 대상이다. 기본 완료 결과는 키 없이 실행 가능한 명시적 demo 모드다.

## 2. 원본 저장소에서 보존할 것과 교체할 것

원본은 루트 React 19 + TypeScript + Vite 프런트엔드와 `server/`의 Express 5 + TypeScript 서버가 함께 있는 구조다. 서버에는 SQLite 기반 단일 `items` 테이블과 `GET/POST /api/items`가 존재하지만, 실제 FE는 `services/firebase.ts`를 통해 Firestore를 사용한다. 서버가 존재한다는 이유로 FE와 이미 연결되었다고 가정하지 않는다.

원본 `services/geminiService.ts`는 브라우저 API 키와 후보 ID 선택 흐름을 사용한다. 새 구현은 서버만 공급자 비밀 키를 보유하며, 이미지와 의미 텍스트 및 위치 정보를 실제 점수 계산에 사용해야 한다. 원본의 모두 허용하는 Firestore 규칙과 시작 시 자동 seed는 실사용 설정으로 승계하지 않는다.

- `server/`를 확장하고 루트 FE 프로젝트를 통째로 재생성하지 않는다.
- 서버 CommonJS/`ts-node-dev` 구성을 ESM 일관 구성으로 정리한다. `tsx` 개발 실행, `tsc` 빌드, `node dist/index.js` 운영 실행을 권장한다.
- Firebase는 사용자 신원 확인에만 사용한다. 물건·결제·매칭·반환·보상·알림의 진실 원본은 API 뒤의 SQLite다.
- 기존 SQLite 스키마는 migration으로 버전을 관리한다. 발견한 기존 데이터를 삭제하거나 앱 시작마다 재생성하지 않는다.
- 원본 UI에 있던 기부 등 이번 흐름 밖의 기능을 백엔드 핵심 범위로 확대하지 않는다.

## 3. 완료해야 할 사용자 흐름

### 3.1 습득 등록

로그인한 습득자가 사진, 발견 장소, 한 줄 설명을 올린다. 서버는 파일을 검증하고 AI로 제목·카테고리·색상·특징을 추출한다. 사용자가 초안을 확인하고 제출하면 공개 가능한 습득물로 저장한다. 보관 장소 상세와 연락 정보는 별도의 비공개 필드다. 습득 등록에는 결제가 없다. AI 실패 시 원문을 보존한 수동 초안으로 계속할 수 있다.

### 3.2 유료 찾기

분실자가 사진 또는 설명, 마지막 위치·시간을 제출하고 초안을 확인한다. 결제 준비 요청 시 서버가 고정 가격과 주문을 만든다. 결제창의 결과를 서버가 검증하여 승인한 시점에만 검색이 활성화된다. 결제되지 않은 초안은 매칭 작업을 시작하지 않는다. 검색 만료는 서버가 보관하는 결제 검증 시각과 계약의 기간으로 계산한다.

### 3.3 후보와 소유 확인

매칭은 일치 가능성을 제안할 뿐 소유권을 확정하지 않는다. 분실자는 후보의 공개 사진·대략적 장소·일치 근거를 보고, 공개되지 않은 특징이나 구매 자료 등 자신의 물건이라는 증거를 제출한다. 습득자는 본인 물건에 대한 신청만 열람·승인한다. 승인 후에만 해당 분실자에게 수령 상세가 공개된다. 동일 사용자끼리 자기 습득물에 청구하여 보상을 받는 경로는 차단한다.

### 3.4 반환과 정산

승인된 분실자가 단기 유효 코드/QR을 표시하고 습득자가 현장에서 인증한다. 코드를 찍었다는 사실만으로 누구나 반환 처리할 수 없어야 한다. 인증된 습득자, 승인된 신청, 아직 유효한 검색·예약, 미사용 코드가 모두 일치해야 한다. 반환 상태 변경, 보상 배분 원장, 지급 작업 생성은 하나의 DB 트랜잭션으로 완료한다. 실제 외부 지급은 작업자가 처리한다. 지급 장애가 반환 자체를 취소하거나 두 번 배분하게 만들면 안 된다.

### 3.5 미반환·취소

MVP 정책은 미반환 만료와 반환 전 취소의 전액 환불이다. 환불 요청·외부 처리 중·완료·실패는 구분한다. 만료나 취소는 진행 중 신청·예약·코드를 무효화하고 환불 작업을 생성한다. 반환과 환불 경합에서는 하나만 승리해야 한다. 이미 반환한 주문에는 일반 취소 경로로 환불을 만들 수 없다. 분쟁은 관리자 검토 대상으로 보존한다.

## 4. 범위와 구현 스택

필수: Express 5, TypeScript strict, ESM, SQLite, WAL, migration, Zod 또는 동등 런타임 검증, Firebase Admin 신원 검증, demo adapter, private storage adapter, AI adapter, 결제/환불/보상 adapter, outbox worker, 단위·API·경합 테스트, OpenAPI 및 실행 README.

SQLite MVP는 한 서버 인스턴스와 로컬 영속 디스크를 전제로 한다. 네트워크 파일 시스템이나 영속 디스크 없는 서버리스에 그대로 배포하지 않는다. 여러 프로세스가 연결하더라도 트랜잭션과 DB 제약으로 정확성을 보장하고 작업 lease로 중복 처리를 통제한다. 향후 PostgreSQL 이전을 위해 도메인 서비스와 SQL repository를 분리하되, 이번 MVP에 분산 시스템을 불필요하게 추가하지 않는다.

권장 파일 구조:

```text
server/
  package.json
  tsconfig.json
  .env.example
  src/
    index.ts                 # listen/shutdown만
    app.ts                   # app factory; 테스트 import 가능
    config/env.ts
    middleware/{auth,errors,requestId,rateLimit}.ts
    modules/
      auth/ uploads/ items/ searchRequests/ payments/
      matching/ claims/ handovers/ settlements/ notifications/ admin/
    domain/{money,clock,policies,errors}.ts
    db/{connection,migrate,transactions}.ts
    db/migrations/
    adapters/{auth,ai,payment,payout,storage}/
    jobs/{worker,outbox,expiry,reconcile}.ts
    contracts/               # 공통 계약 export 또는 import 경계
  scripts/{seed-demo,reconcile}.ts
  test/{unit,integration,fixtures}/
  # API 명세는 루트 shared/openapi.yaml에 생성
  README.md
```

이 구조는 권장사항이다. 더 단순한 파일 수로 같은 책임 경계를 지킬 수 있다. 스택과 패키지 버전은 구현 시 실제 원본 lockfile과 지원 범위를 확인하고 고정한다.

## 5. 인증·권한

`AUTH_MODE=demo|firebase`를 명시한다. demo는 seed된 사용자 계정 세 개(분실자, 습득자, 운영자)를 서버가 검증하는 토큰으로 제공한다. 임의 헤더의 사용자 ID를 곧바로 신뢰하거나 토큰 없음을 demo 로그인으로 간주하지 않는다. 운영자 권한은 서버에 저장된 역할에서만 읽는다.

firebase 모드는 Admin SDK가 ID token의 서명·만료·대상 프로젝트를 검증하여 외부 UID를 내부 user ID에 매핑한다. 실패하면 401이고 demo로 후퇴하지 않는다. 클라이언트의 `userId`, `role`, 보상 수령자 ID는 권한 증거가 아니다. 인증 정보와 도메인 데이터를 한 DTO에 섞지 않는다.

| 자원/행위 | 접근 주체 |
| --- | --- |
| 공개 습득물 목록·공개 상세 | 계약에서 허용한 공개 사용자 |
| 물건 초안 및 수정 | 작성자 |
| 분실 요청·결제·매칭 결과 | 요청 소유자 |
| 청구 증빙 | 신청자, 해당 습득물 작성자, 감사 대상 운영자 |
| 수령 상세 | 승인된 활성 신청의 신청자와 습득자 |
| 코드 발급/표시 | 승인된 신청의 분실자 |
| 코드 소비 | 해당 습득자 |
| 보상 내역 | 해당 습득자 |
| 재처리·분쟁 검토 | 서버 검증 운영자 |

소유하지 않은 자원은 계약의 403/404 정책에 따라 일관되게 응답한다. 타 사용자 ID를 바꿔 보는 IDOR 회귀 테스트가 필수다.

## 6. SQLite 데이터 모델

공통 계약의 상태 enum을 그대로 사용한다. 아래 이름은 내부 테이블 설계로, 응답 필드 이름을 새로 정의하지 않는다. ID는 추측하기 어려운 UUID 계열 문자열, 모든 금액은 정수 KRW, 시각은 UTC로 저장한다. SQLite `PRAGMA foreign_keys=ON`, `journal_mode=WAL`, 적정 `busy_timeout`을 연결마다 적용하고 CHECK/FK/UNIQUE를 애플리케이션 검증과 함께 사용한다.

| 테이블 | 필수 필드와 제약 |
| --- | --- |
| users | id, auth_provider, provider_uid UNIQUE(provider, uid), display_name, role, created_at, updated_at |
| uploads | id, owner_id FK, object_key UNIQUE, mime, bytes, width, height, sha256, purpose, status, created_at; public path 원문 저장 금지 |
| analyses | id, owner_id FK, kind, input_json, status, result_json nullable, error_code nullable, source_hash, created_at, updated_at; AnalysisStatus 사용 |
| items | id, owner_id FK, type, status, title, description, category, colors_json, public_location_label, lat/lng 비공개, occurred_at, private_storage_location, private_pickup_instructions, ai_status, version, created_at, updated_at |
| item_images | item_id FK, upload_id FK, position; UNIQUE(item_id, upload_id), UNIQUE(item_id, position) |
| search_requests | id, owner_id FK, lost_item_id FK, status, price_amount, currency, terms_version, terms_accepted_at, paid_at, expires_at, returned_at, version; 금액/통화 CHECK |
| payments | id, search_request_id FK, provider, provider_order_id UNIQUE, provider_payment_id UNIQUE nullable, amount, currency, status, verified_at, last_error, created_at, updated_at |
| payment_events | provider, provider_event_id, body_hash, processed_at, processing_result; UNIQUE(provider, provider_event_id) |
| item_features | item_id FK, provider, model_version, feature_version, source_hash, image_features, text_features, extracted_attributes_json, processed_at; 원본 변경시 feature 무효화 |
| matches | id, search_request_id FK, found_item_id FK, score, component_scores_json, reasons_json, scoring_version, feature_version, status, created_at, updated_at; UNIQUE(search_request_id, found_item_id) |
| claims | id, search_request_id FK, found_item_id FK, match_id FK nullable, claimant_id FK, status, private_evidence_text, handoff_id nullable FK, reviewed_by, reviewed_at, rejection_reason, created_at, updated_at |
| handoffs | id, claim_id UNIQUE FK, search_request_id FK, found_item_id FK, finder_id FK, seeker_id FK, status READY/COMPLETED/CANCELLED, completed_at nullable, created_at; READY/COMPLETED에 search/found 각각 부분 UNIQUE |
| handover_tokens | id, claim_id FK, secret_hash UNIQUE, expires_at, consumed_at, revoked_at, attempt_count, created_at; 평문 비밀 저장 금지 |
| ledger_entries | id, payment_id FK, handoff_id FK, beneficiary_id nullable, kind, amount, currency, created_at; UNIQUE(handoff_id, kind), integer CHECK |
| settlements | id, handoff_id UNIQUE FK, finder_id FK, amount, currency, status, provider_transfer_id UNIQUE nullable, attempt_count, last_error, next_retry_at |
| payout_accounts | user_id UNIQUE FK, provider, provider_account_token 비공개, verified_status, verified_at, onboarding_reference nullable; 원시 계좌번호 저장 금지 |
| refunds | id, payment_id UNIQUE FK, reason, amount, currency, status, provider_refund_id UNIQUE nullable, attempt_count, last_error, next_retry_at |
| idempotency_keys | actor_id, scope, key, request_hash, status, response_status, response_json, resource_id, expires_at; UNIQUE(actor_id, scope, key) |
| outbox_jobs | id, event_type, aggregate_id, dedupe_key UNIQUE, payload_json, status, attempts, available_at, lease_until, locked_by, last_error, created_at |
| notifications | id, user_id FK, type, resource_type, resource_id, message, read_at, created_at, dedupe_key UNIQUE |
| audit_logs | id, actor_id nullable, action, target_type, target_id, request_id, sanitized_metadata_json, created_at; 비밀·전체 증빙 제외 |
| reports | id, reporter_id FK, resource_type, resource_id, reason, status, created_at, reviewed_at nullable; ADMIN 조회 지원 |
| schema_migrations | version PRIMARY KEY, checksum, applied_at |

필수 인덱스:

- 공개 습득물 `(type, status, category, created_at, id)`; 위치 후보가 많아지면 bounding box 필터 인덱스나 RTree를 검토한다.
- 검색 만료 작업 `(status, expires_at)`; 소유자 조회 `(owner_id, created_at, id)`.
- 결제 `(search_request_id, status)`; 동일 검색에 활성 결제 하나만 허용하는 부분 UNIQUE 또는 동등한 원자적 검증.
- 청구 `(found_item_id, status)`, `(search_request_id, status)`; 승인 상태의 found item 및 search request 각각에 부분 UNIQUE를 적용한다.
- 매칭 `(search_request_id, score DESC, id)`.
- 작업 `(status, available_at, lease_until)`; 알림 `(user_id, created_at, id)`.

JSON 필드는 런타임 schema로 확인한다. 핵심 관계와 금액을 JSON에만 넣지 않는다. 공개 DTO는 column allowlist로 만들고 `SELECT *` 결과를 바로 반환하지 않는다. 마이그레이션에 손실 가능 변환이 있으면 별도 백업 및 변환 절차를 README에 기록한다.

`handoffs`는 승인부터 존재하는 외부 Handoff 자원이다. 승인 transaction에서 READY handoff를 만들고 claims.handoff_id에 저장한다. 조회·목록 Claim DTO는 handoffId nullable을 반환한다. search/found 식별자를 handoffs에 포함하고 READY/COMPLETED에만 부분 UNIQUE를 걸어 취소 후 새 예약을 허용한다. `settlements`는 외부 Payout DTO로 매핑한다. `items`의 내부 LOST 자료는 SearchRequest DTO로만 노출한다. 현재 claim API는 evidenceText만 받으므로 증빙 첨부 endpoint를 임의로 늘리지 않는다. 사용자 입력에서 다른 사람의 신분증·계좌·연락처 전체를 요구하지 않는다.

Found private 데이터는 계약대로 별도 `found_item_private(item_id PK/FK, private_features, storage_place_json, pickup_instructions)`에 저장한다. 위 items 표의 private 필드는 이 별도 레코드에 해당하며 공개 items projection에 실제로 섞어 저장하지 않는다. handoff별 코드 실패 잠금은 재발급으로 초기화되지 않는 `handoff_attempt_limits(handoff_id PK/FK, window_started_at, failure_count, locked_until)`로 관리한다.

## 7. 상태 전이와 불변식

계약의 enum과 전이 표를 유일한 외부 기준으로 삼는다. 내부 구현은 일반 `PATCH status`를 노출하지 않고 `confirmPayment`, `approveClaim`, `confirmHandover`, `cancelSearch`, `expireSearch` 같은 명령으로 전이를 제한한다.

반드시 지킬 불변식:

1. 승인 결제 없는 검색은 유료 매칭 작업을 시작할 수 없다.
2. 하나의 검색에는 성공 결제 최대 하나, 실제 반환 최대 하나, 전액 환불 최대 하나다.
3. 하나의 습득물은 한 활성 신청에만 예약되고 한 번만 반환된다.
4. 매칭 점수는 청구 승인이나 반환을 자동 실행하지 않는다.
5. 반환과 취소/만료/환불 예약은 DB에서 직렬화하여 양립하지 않는다.
6. 반환 시 배분 합계는 정확히 5,000원이고 3,500원/1,500원을 클라이언트가 덮어쓸 수 없다.
7. 코드 재발급은 이전 미사용 코드를 무효화한다. 사용·취소·만료된 코드는 다시 성공할 수 없다.
8. 실패한 지급 재시도가 새로운 배분 원장을 만들지 않는다.
9. 외부 결제 상태가 불명확하면 새 주문이나 환불을 반복 생성하지 않고 조회·대사를 한다.
10. 증빙·보관 상세·인증 코드·비밀 키는 공개 목록, 알림, 로그, AI 후보 설명에 유출되지 않는다.

승인 transaction은 같은 found의 다른 PENDING claim을 REJECTED로 종료하고 그 검색은 만료 여부에 따라 SEARCHING/EXPIRED로 바꾼다. search별 active claim은 PENDING/APPROVED를 합쳐 최대 하나가 되도록 부분 UNIQUE를 적용한다. Found가 RESERVED이면 다른 새 claim을 만들 수 없다. 모든 version 기반 수정은 `WHERE id=? AND version=?` 조건과 version 증가를 사용하고 충돌에 VERSION_CONFLICT를 반환한다.

취소·만료 이후 늦게 검증된 결제는 SEARCHING을 복원하지 않고 REFUND_PENDING으로 보상 처리한다. 결제 재시도 주문이 두 번 실제 성공한 경우 두 공급자 거래를 payment 레코드로 모두 보존하고 정상 성공 결제 한 건만 canonical payment로 선택한다. 초과 거래는 별도 refund 레코드로 전액 환불한다. “성공 결제 최대 하나”를 단순 UNIQUE로 구현하여 두 번째 실제 과금 사실을 버리지 않는다.

승인 상태에 있는 청구가 취소 또는 검색 만료로 종료되면 습득물을 다시 공개 가능 상태로 되돌린다. 다른 사용자의 이미 유효한 예약은 덮어쓰지 않는다. 검색 만료 시각 이후 작업자가 아직 실행되지 않았더라도 청구 승인·코드 소비 endpoint가 서버 시각으로 만료를 재검사해야 한다.

## 8. 결제와 멱등성

### 8.1 결제 adapter

결제 공급자 인터페이스는 주문 준비, 서버 확인, 상태 조회, 전액 환불, webhook 서명 검증을 분리한다. demo adapter는 재현 가능한 테스트 이벤트를 생성한다. live adapter는 선정한 공급자의 공식 문서에 따라 구현하고 실제로 지원하지 않는 송금 기능을 임의 API로 가정하지 않는다. 결제 수납과 개인 습득자 지급은 다른 계약·기능일 수 있으므로 PaymentProvider와 PayoutProvider를 분리한다.

브라우저가 보내는 `success=true`, 금액, 승인 시각을 신뢰하지 않는다. 서버 저장 주문 ID·소유자·통화·금액과 공급자가 확인한 결과가 모두 일치해야 한다. webhook은 raw body로 검증하고 일반 JSON 파서 이전에 경로를 연결한다. 이벤트 중복과 역순 도착을 정상 상황으로 취급한다. `FAILED` 이벤트가 이미 확정한 결제를 되돌릴 수 없다.

### 8.2 HTTP 멱등 처리

계약에서 정한 변경 요청에 `Idempotency-Key`를 받는다. actor + route scope + key로 구분하고 normalized payload hash를 저장한다. 같은 key와 같은 payload는 최초의 확정 응답을 재생한다. 같은 key에 다른 payload는 409다. 처리 중이면 계약의 재시도 응답을 반환한다. 인증·권한 검사는 재생 전에 다시 적용하고 민감 응답은 다른 사용자에게 재생하지 않는다.

SQLite 트랜잭션을 잡은 채 외부 HTTP 요청을 기다리지 않는다. 결제 준비는 로컬 의도 저장 → 외부 호출 → 외부 ID/결과 저장으로 구성하고 외부 idempotency key를 로컬 resource ID에 결합한다. 사이에서 프로세스가 죽으면 reconciliation이 provider 조회로 이어 처리한다.

### 8.3 환불·보상

취소/만료 transaction은 상태를 종료하고 환불 레코드와 outbox를 만든다. worker는 고정 provider key로 환불을 호출한다. 실패 상태는 사용자에게 완료처럼 표시하지 않는다. 이미 외부에서 성공했으나 DB 기록 전에 죽었으면 같은 key 재호출 또는 조회로 동일 거래를 확인한다.

보상 지급에는 별도 상태를 두며, 사용자 계좌 원문 대신 공급자 recipient token을 우선한다. live 지급 수단을 등록하지 않은 사용자는 지급 대기로 남는다. demo 지급 내역을 실제 송금 영수증처럼 표현하지 않는다. 관리자 재시도도 기존 settlement의 외부 key를 유지한다.

`POST /me/payout-account/onboarding`은 공급자가 지원하는 hosted onboarding URL만 발급한다. 돌아온 providerAccountToken을 `PUT /me/payout-account`로 받되 공급자에서 사용자 연결과 등록 완료 여부를 검증한다. 임의 문자열을 REGISTERED로 인정하지 않는다. demo 계정은 테스트 fixture로 준비한다. 미지원 live는 503 PROVIDER_UNAVAILABLE과 capability=false로 처리하며 일반 사용자에게 token 수동 입력이나 원시 계좌 수집을 요구하지 않는다.

## 9. 반환 트랜잭션 설계

아래 절차를 하나의 짧은 `BEGIN IMMEDIATE` transaction으로 구현한다.

1. 인증 사용자와 claim, 검색, 습득물, 결제, token을 다시 읽는다.
2. finder 소유권, claimant 불일치, 승인 상태, 활성 예약, 미반환, 만료 전, 환불 미예약을 검증한다.
3. token hash를 상수 시간 비교가 가능한 방식으로 검증하고 만료·미사용·미폐기 여부를 확인한다.
4. 조건부 update로 token을 한 번만 소비한다. 변경 row 수가 1이 아니면 경합 실패다.
5. 승인 시 만든 READY handoff를 조건부로 COMPLETED로 바꾸고 completedAt을 기록한다. 습득물/검색/청구도 계약의 반환 완료 상태로 바꾼다.
6. 배분 원장 두 행, finder settlement, 지급 outbox, 양 당사자 알림을 생성한다.
7. 감사 기록을 남기고 commit한다. HTTP 응답은 원장과 settlement의 현재 상태를 반환한다.

어떤 단계에서든 실패하면 전체 rollback한다. 외부 송금은 commit 이후 worker에서 수행한다. 동일 요청 재전송은 기존 handoff를 반환하고, 다른 사용자의 동일 code 시도는 정보 없이 거절한다. 짧은 숫자 코드를 쓰면 사용자·청구·IP rate limit 및 시도 상한을 강제한다. QR payload는 개인정보 없이 충분히 긴 임의 token과 필요한 routing 식별자만 가진다.

계약의 정확한 기준은 TTL 5분, handoff당 실패 5회 이후 15분 잠금이다. 실패 횟수는 실패 응답과 함께 rollback해 없애지 않도록 별도 짧은 transaction으로 확정한다. 코드/QR 발급 응답에는 `Cache-Control: no-store`를 적용한다. 모든 mutation 멱등 기록에 평문 token 응답을 그대로 남기지 말고 짧은 TTL의 암호화 응답 저장 또는 동등한 비밀 보존 방식으로 최초 응답 재생을 지원한다. 만료된 코드의 기존 key를 재사용하면 새 유효 코드를 만들지 않으며 새 발급은 새 key가 필요하다.

## 10. AI 처리와 매칭

### 10.1 초안 생성

업로드된 사진과 사용자의 원문은 명령이 아니라 데이터로 취급한다. 사진 안 텍스트와 설명의 prompt injection이 도구 실행, 비밀 조회, 권한 변경을 유도할 수 없도록 모델에 권한 있는 도구를 주지 않는다. structured output을 검증하고 허용된 카테고리·필드만 수용한다. AI가 없는 특징·연락처·보관 위치를 만들어내지 않도록 원문 기반 추출로 제한한다.

AI timeout·rate limit·잘못된 JSON이면 원문 및 업로드는 보존하고 수동 편집 가능한 초안을 반환한다. live 공급자 실패를 숨기고 demo 점수를 실제 AI 결과처럼 반환하지 않는다. processing/failed/ready와 retry 가능 여부를 계약에 맞게 노출한다.

### 10.2 실제 다중 신호 매칭

카테고리·시간·대략적 거리로 유효 습득물을 제한한 뒤 이미지 유사도, 의미 텍스트 유사도, 위치 근접도, 시간·속성 일치를 계산한다. 후보 ID만 LLM에 보여 주고 고르게 하는 방식으로 이미지 매칭을 주장하지 않는다.

- 이미지: 서버에 저장한 양쪽 실제 이미지 입력을 사용하는 multimodal pair scoring 또는 이미지 embedding cosine 유사도. 사용한 방식과 모델 버전을 저장한다.
- 텍스트: 설명·추출 특징에 대한 의미 embedding 또는 의미 비교. 단순 문자열 동일 여부를 유일한 의미 점수로 사용하지 않는다.
- 위치: 위경도를 비공개로 사용하여 거리 계산. 좌표 없음은 결측으로 처리한다.
- 속성·시간: 색상, 브랜드, 특징 및 분실/발견 시간의 일관성을 보조 신호로 쓴다. 확실한 상충 신호에는 감점을 준다.
- 이유: 검증된 입력에서 유래한 짧은 설명만 반환한다. 정확한 보관 장소나 증빙을 일치 이유에 포함하지 않는다.

점수 가중치·결측 처리·표시 단위는 공통 계약에 맞춘다. 유효한 구성 요소 가중치 합으로 재정규화하고 사용 가능한 신호가 너무 적으면 낮은 신뢰 상태를 함께 반환한다. 점수는 확률로 보정한 결과가 아니므로 “정답 확률 95%”라고 주장하지 않는다. 경계값은 config에 두고 fixture 데이터에서 최소 검증한다.

v1 초기 가중치는 image 0.45 / semanticText 0.35 / geo 0.15 / time 0.05, score 범위 0..1, top 10 및 하한 0.60이다. 속성 상충은 image/text 내부 근거로 반영한다. 계약 밖 confidence 필드는 임의로 응답에 추가하지 않고 reasons에 입력 결측을 정직하게 설명한다. 알고리즘 버전과 fixture별 정답·오답·사진 없음·유사한 다른 물건의 순위를 기록한다. 수치 성능은 평가한 표본 범위만 보고한다.

사용자 원본 변경 시 source hash가 달라지고 feature와 match를 재생성한다. 같은 source hash/모델/버전의 중복 작업은 캐시한다. lost 유료 활성화와 found 새 등록 모두 매칭 재계산을 트리거하되 대상은 활성 요청뿐이다. 종료된 요청에는 새 청구 가능 후보를 추가하지 않는다.

### 10.3 비용과 장애

동시성, 후보 최대 개수, 이미지 크기, timeout, retry, per-user rate limit을 제한한다. 오류 발생 시 지수 backoff+jitter, 최대 시도 후 실패 상태와 운영자 재처리를 제공한다. 모델 호출 중 DB lock을 유지하지 않는다. 유효 작업이 맞는지 실행 전후 다시 확인한다. demo matcher는 fixture와 고정 알고리즘으로 같은 입력에 같은 결과를 주고 AI 제공자와 구별되는 metadata를 남긴다.

## 11. 업로드와 개인정보

JPEG/PNG/WebP allowlist, 파일당 10 MB, 게시물당 최대 3장 한도를 적용한다. 습득물은 최소 1장, 분실 요청은 0장도 허용한다. MIME 헤더와 실제 파일 signature를 모두 검사하고 SVG/실행 파일/압축 폭탄을 허용하지 않는다. 이미지 decode 후 픽셀 수를 제한하고 EXIF 위치 등 metadata를 제거하여 재인코딩한다.

업로드는 임의 storage key로 저장하고 사용자 filename을 디스크 경로로 쓰지 않는다. 소유자와 purpose가 맞는 업로드만 게시물/증빙에 연결한다. 임의 외부 URL을 서버가 fetch하는 endpoint를 만들지 않는다. 로컬 파일은 `server/data/uploads` 등 영속 위치에 두고 전체 폴더를 static 공개하지 않는다. 공개 이미지와 비공개 증빙의 권한 경로를 분리한다. 객체 저장소는 private bucket과 제한된 signed URL adapter를 사용한다.

증빙·보관 상세 접근마다 권한을 확인한다. 증빙 URL을 취득한 다른 사용자가 접근할 수 없도록 짧은 유효 기간을 설정한다. 종료 후 링크가 즉시 무효화되어야 하는 중요 데이터는 signed URL만 믿지 않고 인증 proxy를 사용한다. 로그에는 token·계좌·주소·증빙 원문을 남기지 않는다. 보유 기간과 삭제 작업은 환경/정책 값으로 정의하고 실제 운영 정책이 아직 미정이면 README에서 분리해 기록한다.

## 12. API 구현 원칙

HTTP 경로, body, DTO, pagination, error envelope는 `PRODUCT_CONTRACT.md`에서 가져온다. OpenAPI와 서버 런타임 schema 및 FE 공유 타입 사이 불일치를 테스트로 잡는다. 정체불명 필드는 거부하거나 명시적으로 제거하고, owner/status/amount/role mass assignment를 막는다.

BE가 루트 `shared/openapi.yaml`을 소유한다. root package.json/lock, vite.config.ts와 FE 생성 타입은 FE 소유이므로 덮어쓰지 않는다. FE port는 3000, BE는 3001, API prefix는 `/api/v1`이다. 목록 기본 20/최대 50, 입력 한도는 계약 검증 표를 그대로 적용한다. title/description/좌표/시각을 검증하고 캠퍼스 경계 데이터는 config/fixture에 명시하여 브라우저 좌표를 무제한 신뢰하지 않는다.

`/config`는 pricing, 168시간, termsVersion, 실제 활성 capabilities를 반환한다. `/checkout`에서 전달된 termsVersion을 현재 버전과 확인하여 동의 시각을 저장한다. 기본 domain mutation은 Idempotency-Key 필수이며 webhook은 사용자 키 대신 검증된 provider event ID로 멱등 처리한다. `/reports`와 관리자 목록/재시도 API도 권한 및 감사 기록까지 구현한다.

- request ID를 응답과 로그에 일관되게 남긴다.
- 목록은 안정적 cursor와 tie-breaker ID를 사용하고 페이지 최대 크기를 제한한다.
- 오류는 code, 사용자용 message, 필요한 field details를 제공하되 SQL·stack·provider secret을 내보내지 않는다.
- 401 인증, 403 권한, 404 없음, 409 상태/멱등 충돌, 400 입력, 422 잘못된 반환 코드, 429 제한, 503 외부 서비스 장애를 계약에 맞춘다.
- 결제/반환 요청의 FE 금액과 user ID는 참고 값으로도 의사결정에 쓰지 않는다.
- CORS는 허용 origin만, proxy 신뢰는 배포 설정에 맞게, body size와 request timeout을 제한한다.
- cookie auth를 선택하면 CSRF 방어를 포함한다. bearer auth면 localStorage 장기 demo secret 하드코딩을 피하고 XSS에 노출되는 민감 데이터를 줄인다.
- health는 프로세스 상태, readiness는 migration/DB 접근/필수 config 상태를 구분한다. health 응답에 비밀과 내부 파일 경로를 노출하지 않는다.

## 13. 작업 큐·운영·관측

outbox는 domain transaction과 함께 기록한다. worker는 준비된 작업을 짧은 transaction에서 lease한 뒤 transaction 밖에서 실행한다. 완료 후 lease 소유자와 상태를 조건부 확인하여 종료한다. crash 후 lease 만료로 재시도하며 side effect는 provider idempotency와 DB UNIQUE가 지킨다. “작업을 한 번만 실행한다”는 가정에 기대지 않는다.

필수 작업: 이미지 feature 생성, 초기/재매칭, 검색 만료, 환불 실행, 보상 지급, 외부 상태 대사, 연결되지 않은 임시 업로드 정리. 반복 작업도 dedupe key를 가진다. graceful shutdown은 새 HTTP/작업 수락을 중단하고 진행 중 transaction을 정리하며, 미완료 작업은 lease로 회복한다.

로그 필드: requestId, actorId 최소 식별자, resourceId, operation, durationMs, outcome, errorCode. 지표: 결제 검증 실패, 매칭 지연/실패, outbox lag, 만료 처리 지연, 환불/지급 대기 수, provider unknown 수. 진단 endpoint는 관리자만 접근한다. 운영자 재처리는 scope가 명확한 기존 작업 ID에 한정하고 감사 기록을 남긴다.

SQLite 백업은 실행 중 파일 하나를 무작정 복사하지 않고 SQLite backup API나 안전한 snapshot 절차를 쓴다. DB와 업로드를 함께 복원하는 절차 및 최소 한 번의 복원 검증을 문서화한다.

## 14. 환경 구성과 실행 결과물

`.env.example`에는 비밀이 아닌 예시만 넣는다. 최소 설정은 아래 의미를 포함한다. 변수명은 FE 문서와 맞춰 정리한다.

```dotenv
NODE_ENV=development
PORT=3001
APP_MODE=demo
AUTH_MODE=demo
PAYMENT_MODE=demo
PAYOUT_MODE=demo
AI_MODE=demo
DATABASE_PATH=./data/lumina.sqlite
UPLOAD_DIR=./data/uploads
CORS_ORIGINS=http://localhost:3000
PUBLIC_APP_URL=http://localhost:3000
GEMINI_MODEL=
GEMINI_API_KEY=
FIREBASE_PROJECT_ID=
PAYMENT_SECRET_KEY=
PAYMENT_WEBHOOK_SECRET=
```

실제 private key는 환경별 secret manager/SDK 기본 인증 경로를 사용한다. `VITE_` 환경변수에 서버 비밀을 넣지 않는다. 운영 모드에서 demo auth·payment·payout·AI가 조용히 켜지지 않게 startup validation을 한다. live 기능은 설정이 불충분하면 fail closed하고 무엇이 부족한지 비밀 없이 로그한다.

루트 또는 server README에서 다음 명령을 실제 지원하도록 제공한다.

```text
설치 → DB migrate → 명시적 seed:demo → 개발 서버 실행
typecheck → unit/API 테스트 → build → 빌드 결과 실행
worker 실행 → reconciliation dry-run → 대상 재처리
```

seed는 반복 실행해도 demo 데이터만 중복 없이 갱신하고 실사용 데이터와 분리한다. 앱 시작마다 seed를 실행하지 않는다. 마이그레이션 누락은 readiness 실패로 드러낸다. 테스트 DB는 별도 임시 경로를 쓰며 실제 DB 초기화 명령을 호출하지 않는다.

BE는 공통 계약의 F01~F12에 맞는 `shared/fixtures/demo-manifest.json`도 생성한다. FE가 동일 ID·계정·상태와 기대 결과를 소비하므로 문서에 없는 fixture 이름을 독자적으로 만들지 않는다. Claim.handoffId nullable 및 Payout.createdAt을 반환한다. 환불 장애의 Payment는 REFUND_PENDING을 유지하고 refundErrorCode nullable/refundRetryable boolean을 제공한다. 별도 REFUND_FAILED 공개 enum을 추가하지 않는다.

## 15. 필수 검증 시나리오

핵심 금전·권한·경합 요구는 의미 있는 자동화 테스트로 검증한다. 결과 화면만 있는 mock 테스트로 실제 API 테스트를 대체하지 않는다.

| 테스트 | 통과 조건 |
| --- | --- |
| 결제 전 검색 | 후보 생성 작업이 없고 검색이 활성화되지 않음 |
| 잘못된 금액/소유자 | 서버가 결제 승인과 검색 시작을 거절 |
| 확인+webhook 동시 성공 | 결제 1건, 검색 시작 1회, 초기 작업 1건 |
| webhook 중복/역순 | 상태 회귀·중복 금액 기록 없음 |
| 타 사용자 조회/수정 | 분실 요청·증빙·보관 상세·정산 접근 차단 |
| 다른 사람 업로드 연결 | 저장 거절 |
| AI 장애/비정상 JSON | 원문 보존, 수동 초안 가능, fake live 성공 없음 |
| 이미지/텍스트/위치 | 각각 변경 시 점수 구성 변화 확인, 결측 정상 처리 |
| 두 claim 동시 승인 | 습득물 예약 하나만 성공 |
| 자기 물건 자기 청구 | 보상 획득 경로 거절 |
| 만료 후 코드 발급/소비 | worker 실행 전에도 거절 |
| 코드 2회 소비 | 반환/원장/settlement 한 번만 생성 |
| 코드 소비와 취소 동시 | 반환 또는 환불 예약 중 하나만 성공 |
| 지급 후 DB 기록 전 crash | 재처리해도 외부 지급 한 번 |
| 환불 provider timeout | unknown/pending 보존 후 대사, 중복 환불 없음 |
| worker crash/lease 만료 | 작업 회복, side effect 중복 없음 |
| 재시작 | 기존 데이터와 결제·반환 상태 보존 |
| 에러 응답 | 계약 code 및 envelope 일치, 비밀 없음 |

Clock adapter와 fake provider로 만료·재시도를 시간 대기 없이 검증한다. SQLite 경합 테스트는 같은 파일에 대한 별도 connection을 사용한다. 단일 연결 직렬 호출로만 동시성 검증을 했다고 보고하지 않는다.

## 16. 구현 순서와 중간 산출물

1. 저장소와 기존 지시·lockfile·git 변경 상태를 확인한다. 사용자의 미커밋 변경을 보존한다.
2. 공통 계약을 읽고 endpoint/enum/DTO/가격/상태에 대한 구현 checklist를 만든다.
3. app factory, config validation, errors, auth, DB migration, demo seed를 만든다.
4. 업로드와 공개/비공개 item DTO, 초안·게시 동작을 만든다.
5. 검색 초안, 결제 주문·검증·webhook·멱등 처리와 outbox를 만든다.
6. AI 추출·매칭 provider와 deterministic demo matcher, 비동기 재계산을 만든다.
7. claim 증빙·승인·예약·보관 정보 공개를 구현한다.
8. code 발급·소비와 반환 transaction, allocation ledger를 구현한다.
9. refund/payout worker·만료·대사·알림을 연결한다.
10. FE가 필요한 계약 요청을 OpenAPI와 API 테스트로 검증하고 통합 차이를 해결한다.
11. 필수 경합·권한 테스트, typecheck, build, 재시작 검증을 실행한다.
12. 실행법·demo 계정·환경 한계·실제 완료 범위를 README와 최종 보고에 남긴다.

## 17. Definition of Done

- 키 없이 명시적 demo 모드에서 습득 등록 → 유료 찾기 → 후보 → 증빙 승인 → 수령 상세 → 코드 반환 → 보상 배분 조회가 API로 끝까지 실행된다.
- 미반환 취소/만료 → 환불 완료 demo 흐름이 별도로 동작한다.
- 결제·환불·지급과 반환의 중복/경합 불변식이 테스트로 확인된다.
- 브라우저에서 도메인 Firestore 쓰기와 AI/결제 비밀 키가 제거될 수 있도록 FE 연동 계약이 제공된다.
- 공개 API가 정확 위치·증빙·코드를 노출하지 않는다.
- OpenAPI, 마이그레이션, 명시적 demo seed, `.env.example`, README가 있고 실제 명령이 통과한다.
- live adapter가 미구현이면 완료처럼 표시하지 않고 활성화 불가 상태와 구현해야 할 메서드를 명확히 기록한다.
- 사용자에게 파일 목록, 테스트 명령·결과, demo 실행법, 외부 연결에 필요한 설정을 간결하게 보고한다. 실제 서비스 운영 가능성·실제 송금·실제 AI 성능을 demo만으로 주장하지 않는다.

## 18. 백엔드 에이전트에 그대로 전달할 프롬프트

```text
Lumina 백엔드 MVP를 지금 구현하라. 이 메시지는 계획만 요청하는 것이 아니라 실행 가능한 코드와 검증까지 요청한다.

먼저 AGENTS.md와 PRODUCT_CONTRACT.md, BE_MASTER.md를 읽고 기존 저장소/사용자 변경을 확인하라. PRODUCT_CONTRACT.md를 FE와 BE 사이의 단일 API·상태·금액 계약으로 삼고 server/를 중심으로 구현하라. 루트 React/Vite 앱을 재생성하거나 FE 계약을 임의로 바꾸지 마라.

제품은 5,000원 찾기 요청비를 검증한 후 7일 검색하며, 반환 확정 시 습득자 3,500원과 플랫폼 1,500원을 배분한다. 미반환 만료/취소는 전액 환불하는 MVP 가정을 구현하라. 실제 결제/송금/유료 AI를 자동 실행하지 말고 기본 demo adapter로 E2E 동작을 완성하라. live와 demo를 명시적으로 분리하고 실패 시 몰래 전환하지 마라.

Express5 TypeScript ESM과 SQLite WAL, Firebase Auth 신원 검증 adapter, 서버 저장/AI/payment/payout adapter, outbox와 migration을 사용하라. 공개 DTO와 비공개 증빙/보관 상세를 분리하라. 소유 확인 승인 전 상세 위치를 공개하지 마라. 분실자에게 발급한 code를 인증된 습득자가 consume하여 한 번만 반환하고, 원장·배분·작업 예약을 원자적으로 처리하라. provider idempotency와 UNIQUE 제약으로 중복 결제/환불/지급을 방지하라.

문서의 구현 순서대로 작업하고 필요한 테스트와 typecheck/build를 실제 수행하라. 명시적 demo seed와 API 문서, 환경 예시, 실행 README를 제공하라. 완료 보고에는 구현 범위, 통과한 검증, 실행법, live 연결에 남은 항목을 구분하라. 환경상 불가능한 검증은 실행했다고 주장하지 마라.
```



