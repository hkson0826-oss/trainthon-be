# Lumina — 제품 정의 및 BE·FE 공통 계약 v1.0

작성일: 2026-09-09. 이 문서는 BE_MASTER.md와 FE_MASTER.md의 공통 기준이다. 사용자 확정 요구와 아래 MVP 가정을 구분한다. 실제 구현을 완료한 문서가 아니라 개발 에이전트를 위한 명세다.

## 1. 제품과 성공 조건

Lumina는 분실자가 탐색 서비스에 비용을 지불하고, 반환이 확인되면 그 비용 일부를 습득자에게 지급하는 AI 매칭 중개 서비스다. 개인이 금액을 올리는 사례금 경매나 반환 대가 협상 기능은 만들지 않는다.

- 습득자: 사진·발견 장소·한 줄 설명 → AI 초안 → 본인 확인 → 무료 게시.
- 분실자: 사진(없으면 설명)·마지막 위치·분실 시점 → 초안 확인 → 찾기 요청비 결제.
- 플랫폼: 이미지 유사도·의미 기반 텍스트·위치·시간을 함께 고려해 후보 추천.
- 당사자: 비공개 특징을 통한 소유권 확인 → 승인된 요청에만 보관 장소와 수령 방법 공개.
- 반환: 분실자가 보여주는 QR/인증코드를 습득자가 확인 → 서버가 반환 완료 기록.
- 정산: 5,000원 중 3,500원 습득자 보상, 1,500원 플랫폼 배분. 1,500원은 결제원가·AI 비용·운영비 차감 전 배분액이며 순이익을 의미하지 않는다.

핵심 데모는 서로 다른 계정으로 등록→결제→매칭→소유권 승인→코드 반환→보상 지급 상태까지 새로고침 후에도 유지되는 하나의 완결된 흐름이다.

## 2. 이번 개발에 적용할 명시적 가정

| 항목 | v1 기본값 | 성격 |
|---|---|---|
| 가격 | KRW 5,000원 고정, 3,500/1,500 배분 | 사용자 예시를 MVP 고정값으로 채택 |
| 탐색 기간 | 서버 결제 확인 시각부터 7×24시간 | 신규 가정 |
| 미반환 만료·취소 | 전액 환불, 습득자 보상·플랫폼 배분 없음 | 신규 가정 |
| 반환 후 | 자동 취소/환불 없음, 이의 제기는 운영자 검토 | 신규 가정 |
| 채널 | 모바일 우선 반응형 웹, 메신저형 입력 | 카카오 실제 채널 연동은 후속 |
| 지역 | 단일 캠퍼스, 장소 목록+좌표 | 확대 후속 |
| 인증 | 실제 Firebase Auth Google 로그인; 별도 demo identity | 학교 소속 자동 검증을 주장하지 않음 |
| 결제 | demo adapter 기본, live PSP adapter 명시 설정 | 실제 공급자 계약/계정 미지정 |
| 지급 | 자동 outbox 작업, demo 지급 가능; live 공급자 미설정이면 PENDING/FAILED 표시 | 완료 위장 금지 |
| 보관 | 기본 습득자 보관, 운영자 지원 가능 | 제휴 장소·영업시간 허위 생성 금지 |

이 가정은 구현자가 임의로 바꾸지 않는다. 결제 전에 기간·실패 시 환불·배분을 보여주고 termsVersion을 저장한다. 법률·세무 확정 의견은 이 문서 범위가 아니다. live 출시에서는 실제 PG 지급/환불 지원과 적용 약관을 검증해야 한다.

## 3. 참고 저장소에서 확인한 사실과 새 결정

[Lumina 원본](https://github.com/Icey067/Lumina), main 조회 tree SHA `538e9066a6079387f1ffc4bd90971b272da809b9` 기준. tree SHA는 커밋 SHA로 표현하지 않는다.

| 실제 확인 경로 | 사실 | v1 결정 |
|---|---|---|
| [package.json](https://github.com/Icey067/Lumina/blob/main/package.json) | React 19, TS, Vite, Firebase, TomTom, Gemini 패키지 | root FE 구조 보존 |
| [App.tsx](https://github.com/Icey067/Lumina/blob/main/App.tsx) | 화면 state 전환, services/firebase 직접 사용 | URL 라우팅, 도메인 API 접근으로 변경 |
| components/ | Dashboard, ReportForm, ItemCard, MapContainer, Messenger, Navbar, ProfileModal, SherlockAgent | 역할을 재사용하되 유료 탐색 플로우로 확장 |
| [server/index.ts](https://github.com/Icey067/Lumina/blob/main/server/index.ts), [server/db.ts](https://github.com/Icey067/Lumina/blob/main/server/db.ts) | Express GET/POST items, SQLite 단일 테이블, 시작 시 예제 seed | server/ 경계 보존, 인증·트랜잭션·마이그레이션 추가 |
| [services/geminiService.ts](https://github.com/Icey067/Lumina/blob/main/services/geminiService.ts) | 브라우저 Gemini 호출, 카테고리/키워드 후보 후 LLM 판별 | 서버 AI 처리 및 실제 이미지·텍스트 특징 기반 매칭으로 대체 |
| [firestore.rules](https://github.com/Icey067/Lumina/blob/main/firestore.rules) | 모든 문서 read/write 허용 | 새 도메인에 사용하지 않고 차단 |
| [vite.config.ts](https://github.com/Icey067/Lumina/blob/main/vite.config.ts) | AI 키 define 치환 | 비밀 키 번들 포함 경로 제거 |

원본 README의 설명을 구현 완료 증거로 간주하지 않는다. 특히 기존 QR 반환·새 요금 정산이 존재한다고 가정하지 않는다. 원본 라이선스 표기는 README와 package.json이 다르므로 코드 재배포 전 실제 라이선스를 확인하며 임의 MIT 표기를 새 프로젝트에 복사하지 않는다.

### 실행 구조

- FE: root React + TypeScript + Vite, port 3000. API 기본 `/api/v1`, 개발 proxy 3001.
- BE: server/ Express + TypeScript ESM, port 3001, SQLite WAL + foreign_keys, 단일 서버 및 내장 durable worker.
- 인증: Firebase ID token을 BE가 검증. Firebase는 도메인 데이터 저장소가 아니다.
- 도메인 원장: SQLite 하나만 사용. FE 직접 Firestore mutation 금지.
- 업로드: 서버 소유 파일 저장소 adapter, 로컬은 영속 uploads volume; live object storage 교체 가능.
- AI: 서버 Gemini adapter 및 교체 가능한 image/text embedding adapter. 모델 ID는 설정에서 지정하고 구현 당시 공식 문서로 지원 여부 확인.
- demo: 테스트 사용자, 결정론적 AI fixture, 모의 결제/지급을 명시적 모드로 제공. live 장애에서 demo로 자동 강등 금지.
- SQLite MVP는 다중 복제 서버로 배포하지 않는다. 수평 확장은 PostgreSQL 등 별도 설계 후 진행.

## 4. 공통 데이터 및 권한

ID는 opaque UUID string, 인증 subject는 Firebase uid string. 시간은 ISO-8601 UTC, 화면은 Asia/Seoul. 금액은 원 단위 정수, 통화 KRW. JSON camelCase, 상태 UPPER_SNAKE_CASE. 목록은 cursor 기반 기본 20/최대 50.

```ts
type Category = 'ELECTRONICS' | 'CLOTHING' | 'KEYS' | 'WALLET' | 'ID_CARD' | 'BOOKS' | 'ACCESSORIES' | 'OTHER';
type FoundStatus = 'DRAFT' | 'AVAILABLE' | 'RESERVED' | 'RETURNED' | 'ARCHIVED';
type SearchStatus = 'DRAFT' | 'AWAITING_PAYMENT' | 'SEARCHING' | 'CLAIM_PENDING' | 'HANDOFF_READY' | 'RETURNED' | 'CANCELLED' | 'EXPIRED';
type PaymentStatus = 'CREATED' | 'PENDING' | 'PAID' | 'FAILED' | 'REFUND_PENDING' | 'REFUNDED';
type ClaimStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'COMPLETED';
type PayoutStatus = 'PENDING' | 'PROCESSING' | 'PAID' | 'FAILED' | 'ON_HOLD';
type AnalysisStatus = 'QUEUED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED';
interface Place { label: string; lat: number; lng: number; }
interface ReportInput {
  title: string; description: string; category: Category;
  photoIds: string[]; occurredAt: string; place: Place;
}
interface MoneyBreakdown { amount: 5000; currency: 'KRW'; finderAmount: 3500; platformAmount: 1500; }
```

- User: id, displayName, role(USER/ADMIN), createdAt. 동일 user가 두 역할로 활동 가능하나 자신의 found에 claim 불가.
- FoundItem: ReportInput, id, finderId, status, version, createdAt, updatedAt. private 식별 특징/실제 보관 장소/pickupInstructions는 별도 private 레코드.
- SearchRequest: ReportInput, id, seekerId, status, paymentId nullable, expiresAt nullable, activeClaimId nullable, version, createdAt, updatedAt.
- Match: id, searchId, foundItemId, score 0..1, reasons(string[]), algorithmVersion, generatedAt. score는 반환 성공 확률이 아니다.
- Claim: id, searchId, foundItemId, seekerId, finderId, status, evidenceText(private), handoffId nullable, createdAt, updatedAt. 승인 시 handoffId를 저장하고 상세/본인 목록에 반환하여 새로고침 후 수령 화면을 복원한다.
- Payment: id, searchId, status, MoneyBreakdown, provider, providerOrderId, paidAt nullable, refundedAt nullable, refundErrorCode nullable, refundRetryable boolean. 비밀 공급자 payload 제외. 환불 일시 실패는 REFUND_PENDING 유지 및 안전한 refundErrorCode로 구분한다.
- Handoff: id, claimId, status(READY/COMPLETED/CANCELLED), completedAt nullable. code는 별도 짧은 유효기간 데이터이며 평문 저장 금지.
- Payout: id, handoffId, finderId, amount=3500, currency, status, failureCode nullable, createdAt, paidAt nullable.
- Notification: id, type, title, body, resourceType, resourceId, readAt nullable, createdAt.

공개 found 응답은 PublicFoundItem 전용: id/title/category/마스킹 description/공개 thumbnail/동 단위 또는 캠퍼스 구역 placeLabel/status만. 정확 좌표, 원본 사진, 사용자 이메일, private 특징, claimant 증빙은 포함하지 않는다. 위치 점수 reasons도 범주형으로 제한한다. 소유자 상세와 승인된 claimant 상세를 공개 DTO와 별개로 구현한다.

## 5. 상태와 금전 불변식

1. found 초안 작성 후 publish → AVAILABLE. AI 실패 시 수동 입력으로 게시 가능.
2. search DRAFT → checkout으로 AWAITING_PAYMENT → 서버가 공급자 결제 검증한 뒤 SEARCHING. FE 리다이렉트만으로 변경 금지.
3. SEARCHING → claim 제출 → CLAIM_PENDING. 이 상태에서도 검색 만료시간은 연장되지 않는다.
4. finder 승인 트랜잭션: AVAILABLE → RESERVED, claim APPROVED, search HANDOFF_READY, handoff READY. 하나의 found에는 승인 claim 하나만. 다른 pending claim은 REJECTED, 해당 search는 SEARCHING(이미 만료면 EXPIRED).
5. finder 거절: claim REJECTED, search SEARCHING(만료면 EXPIRED). search별 동시 active claim 최대 하나.
6. seeker 코드 발급 → finder consume 성공 시 found/search RETURNED, claim COMPLETED, handoff COMPLETED와 배분 원장·payout outbox를 같은 DB transaction에 기록.
7. PAID는 결제 검증 완료, payout PAID는 별도 지급 검증 완료다. 반환 화면에서 지급 대기를 정상 상태로 표시한다.
8. 미반환 search 취소/만료: active claim CANCELLED, handoff CANCELLED, found 예약 해제, search CANCELLED/EXPIRED, PAID payment REFUND_PENDING 및 refund outbox 생성. 이미 RETURNED면 취소 409.
9. 검색 만료와 반환 경쟁은 동일 DB write transaction에서 expiresAt 및 상태 재검증하여 단 하나만 성공. expiresAt <= 서버 현재시각이면 반환 불가.
10. 미결제 취소는 환불 없음. 취소/만료 이후 도착한 결제 성공 이벤트는 탐색을 되살리지 않고 REFUND_PENDING으로 보상 처리.
11. payment는 search별 성공 결제 최대 하나. 재시도 주문이 중복 성공하면 초과 결제를 별도 감지·환불하고 정상 결제와 원장을 섞지 않는다.
12. 반환 하나당 보상 원장 하나, provider payout key 하나. 외부 호출 성공 후 timeout은 공급자 조회 후 재개하며 새 키로 중복 송금 금지.
13. PG 실패 또는 지급계정 미등록은 반환 기록을 되돌리지 않는다. 지급 PENDING/FAILED 상태와 필요한 행동을 노출한다.

QR/code는 소유권 증명이 아니다. claim에서 비공개 특징/구입 증빙 등 확인 후 승인한다. 원본 번호·신분증을 공개 피드에 보여주지 않는다. 코드 TTL 5분, 재발급 시 이전 토큰 무효, handoff당 실패 5회/15분 잠금, cryptographic random 생성, 로그인한 해당 finder만 검증, 성공 단일사용. QR에는 개인정보/결제 권한/공개 보관장소가 아닌 opaque token만 포함한다.

## 6. API 공통 규약

모든 경로 prefix `/api/v1`. Authorization: Bearer Firebase ID token(demo는 별도 검증기). client가 전달한 userId/가격/상태를 신뢰하지 않는다. mutation은 `Idempotency-Key` 필수(동일 user+route+key+body이면 최초 결과, body가 다르면 409). 수정은 body `version` 낙관적 잠금, 충돌 409. POST 생성 201, 작업 접수 202, 조회/수정 200.

```json
{"data":{"id":"example"},"meta":{"requestId":"uuid"}}
```
```json
{"data":[],"meta":{"requestId":"uuid","nextCursor":null}}
```
```json
{"error":{"code":"INVALID_STATE","message":"현재 상태에서는 처리할 수 없습니다.","fieldErrors":{},"retryable":false},"meta":{"requestId":"uuid"}}
```

공통 오류: 400 VALIDATION_ERROR, 401 UNAUTHENTICATED, 403 FORBIDDEN, 404 NOT_FOUND, 409 INVALID_STATE / VERSION_CONFLICT / IDEMPOTENCY_CONFLICT / ITEM_UNAVAILABLE, 410 CODE_EXPIRED, 413 FILE_TOO_LARGE, 415 UNSUPPORTED_MEDIA_TYPE, 422 CODE_INVALID, 429 RATE_LIMITED, 503 PROVIDER_UNAVAILABLE. FE는 error code에 대응하며 서버 message HTML 렌더링 금지. 비소유자의 민감 리소스 조회는 404로 통일.

### API 목록 — 두 에이전트가 동일하게 구현할 최소 계약

| Method/path | 입력 / 접근 | data 결과 |
|---|---|---|
| GET /config | 공개 | mode, pricing:MoneyBreakdown, searchDurationHours:168, termsVersion, capabilities:{payments,payouts,ai,maps} |
| GET /me | 본인 | User |
| POST /uploads | 로그인 multipart file; jpg/png/webp, 장당 10MB, 최대 3장(개별 업로드) | {id,status:'READY',previewUrl}; BE 재인코딩/EXIF 제거 |
| POST /analyses | {kind:'FOUND'/'LOST',photoIds,description,place} | 202 {id,status:AnalysisStatus} |
| GET /analyses/:id | 소유자 | {id,status,result:ReportInput 일부 또는 null,errorCode:null/string} |
| POST /found-items | ReportInput + privateFeatures + storagePlace + pickupInstructions | FoundItem(DRAFT) |
| PATCH /found-items/:id | 부분 입력 + version; 소유자, DRAFT/AVAILABLE만 | FoundItem |
| POST /found-items/:id/publish | {version}; 소유자 | FoundItem(AVAILABLE) |
| POST /found-items/:id/archive | {version}; 예약/반환 상태 불가 | FoundItem(ARCHIVED) |
| GET /found-items | 공개 category,query,cursor; AVAILABLE만 기본 | PublicFoundItem[] |
| GET /found-items/:id | 익명 public / 본인 owner DTO | public 또는 owner 상세 |
| GET /me/found-items | 본인 cursor | FoundItem[] (private 상세는 개별 조회) |
| POST /search-requests | ReportInput | SearchRequest(DRAFT) |
| PATCH /search-requests/:id | 부분 입력+version; DRAFT만 | SearchRequest |
| GET /me/search-requests | 본인 cursor | SearchRequest[] |
| GET /search-requests/:id | 본인 | SearchRequest |
| POST /search-requests/:id/checkout | {termsVersion}; 본인 | {payment:Payment,checkoutUrl:string/null}; 서버 고정 금액 |
| GET /payments/:id | 본인 | Payment |
| POST /payments/:id/confirm | {providerPaymentKey}; 본인, 서버 공급자 검증 | Payment(PAID/PENDING) |
| POST /search-requests/:id/cancel | {version,reason}; 본인 | {search:SearchRequest,payment:Payment/null} |
| GET /search-requests/:id/matches | 결제된 활성 요청 소유자, cursor | Match[] + found public summary |
| POST /claims | {searchId,foundItemId,evidenceText}; 결제 활성 요청 소유자 | Claim(PENDING) |
| GET /me/claims | 본인 role=seeker/finder, cursor | Claim[] |
| GET /claims/:id | 당사자 | Claim; approved인 당사자만 pickup:{storagePlace,pickupInstructions} 포함 |
| POST /claims/:id/approve | finder | {claim:Claim,handoff:Handoff} |
| POST /claims/:id/reject | finder {reason} | Claim |
| GET /handoffs/:id | 당사자 | Handoff |
| POST /handoffs/:id/code | seeker만 | {token,manualCode,expiresAt}; 응답은 no-store |
| POST /handoffs/:id/complete | finder만 {token} 또는 {manualCode}, 정확히 하나 | {handoff:Handoff,payout:Payout} |
| GET /me/payouts | finder cursor | Payout[] |
| PUT /me/payout-account | 본인 {providerAccountToken}; 원시 계좌정보 자체 보관 제외 | {status:'REGISTERED'/'PENDING'} |
| POST /me/payout-account/onboarding | 본인; 공급자가 hosted onboarding 지원할 때만 활성 | {onboardingUrl:string}; 미지원 503 PROVIDER_UNAVAILABLE |
| GET /notifications | 본인 cursor | Notification[] |
| POST /notifications/:id/read | 본인 | Notification |
| POST /reports | 로그인 {resourceType,resourceId,reason} | {id,status:'OPEN'} |
| GET /admin/reports | ADMIN cursor | 신고 목록 |
| POST /admin/payouts/:id/retry | ADMIN {reason}; 상태 재검증 | Payout |
| POST /admin/refunds/:paymentId/retry | ADMIN {reason} | Payment |
| POST /webhooks/payments | 공급자 signature 검증, 사용자 인증 대신 provider 인증 | {received:true}; 중복 eventId 처리 |
| POST /demo/payments/:id/succeed | DEMO 모드 본인만 | Payment; live에서는 route 미등록 |
| GET /health | 공개 최소 liveness | {status:'ok'} |
| GET /ready | 인프라 제한 readiness | {status:'ready'} 또는 503 |

OpenAPI는 BE가 `shared/openapi.yaml` 생성 책임을 갖고 FE는 생성 타입/fixture를 소비한다. 위 표의 응답 union은 실제 OpenAPI에서 public/owner DTO를 명시한다. 추가 필드가 필요하면 먼저 이 문서를 수정하고 양쪽에 통보한다. 웹훅은 raw body 검증, 중복 이벤트 저장, 응답 성공 전 durable 처리 접수. PSP별 실제 필드는 adapter 내부에서 매핑하며 브라우저가 알려준 성공 값을 믿지 않는다.

지급계정은 공급자 hosted onboarding에서 등록하고 서버가 공급자에 token 소유·등록 상태를 확인한다. 일반 사용자에게 providerAccountToken 직접 입력을 요구하지 않는다. demo는 테스트 계정을 fixture로 제공한다. hosted onboarding 미지원 live에서는 등록 불가 사유와 지급 대기를 표시하며 계좌번호 수집 폼으로 우회하지 않는다. `capabilities.payouts`는 공급자 계정 등록과 지급의 실제 지원 여부를 반영한다.

### 입력 검증

title 2..80자, description 5..1000자, evidenceText 10..1000자, privateFeatures 최대 1000자, pickupInstructions 5..500자. found photoIds 1..3개, lost 0..3개. 이미지는 현재 사용자 소유이며 업로드 완료·검사 통과한 것만 연결. lat -90..90, lng -180..180, 유효한 서버 캠퍼스 경계 내 좌표. occurredAt은 미래 5분 초과 불가. 알 수 없는 AI 필드는 null/사용자 확인으로 처리하고 장소·시각을 추측해 확정하지 않는다.

## 7. 매칭 및 비동기 작업 계약

등록/결제/새 습득물/특징 갱신을 durable job으로 연결한다. 결제 전 무료 AI 초안 분석은 가능하나 활성 매칭/보관 장소 제공은 불가하다. 양방향 재매칭으로 먼저 등록된 분실물도 새 습득물을 발견한다.

기본 점수 제안은 image .45 + semanticText .35 + geo .15 + time .05, 가용 채널만 가중치 재정규화. 이미지 없는 요청은 text/geo/time으로 동작한다. 후보 필터는 캠퍼스·반대 유형·AVAILABLE·자기 물건 제외, 시간은 오차를 고려하여 결정. 무관 후보를 강제로 채우지 않으며 top 10/하한 .60은 조정 가능한 초기값으로 평가 fixture에 기록한다. 실제 embedding 없이 키워드만 구현한 경로를 멀티모달 매칭 완료라고 표시하지 않는다.

FE는 analyses 2초 간격 최대 60초 후 처리중 안내, searches/matches/claims/handoffs/payments는 화면 활성일 때 5초 간격 polling, terminal 상태에서 중단, background 중단 및 재진입 refetch. polling 실패가 기존 PAID/RETURNED를 실패 상태로 덮어쓰지 않는다. 네트워크 복구 후 서버 상태 재조회.

## 8. 파일 소유권 및 통합 순서

| 영역 | 구현 담당 |
|---|---|
| server/**, shared/openapi.yaml, migrations, 서버 env sample, DB·worker 테스트 | BE |
| components/**, pages/**, hooks/**, services/**, App.tsx, index.*, FE 스타일/테스트 | FE |
| root package.json/lock, vite.config.ts, tsconfig.json | FE; BE는 server/package.json만 독립 수정 |
| generated API 타입 | FE가 BE OpenAPI에서 생성; 수동 양쪽 편집 금지 |
| 공동 문서/통합 fixture scenario | 최초 계약 유지, 변경 필요 시 양쪽 통보 |

1. 두 에이전트가 본 문서→본인 MASTER를 읽는다.
2. BE가 OpenAPI/상태/fixture shape를 먼저 확정하고 FE에 제공한다.
3. FE는 동일 계약 mock으로 UI 병행, BE는 SQLite/worker/provider adapter 구현.
4. 실제 API 모드로 전환하여 seed 두 계정 전체 흐름, 실패/중복/경쟁 케이스를 통합 검증한다.
5. README에 정확한 실행·테스트 명령과 demo/live 지원 범위를 남긴다. test 미실행을 통과로 보고하지 않는다.

이번 문서 작성 작업에서는 실제 앱 구현·유료 호출·배포를 수행하지 않는다. 향후 구현 에이전트는 로컬 통합까지 완성하되 키가 없는 외부 기능만 명시적으로 미연결 상태로 보고한다.

## 9. 공통 완료 판정

- 한 프로세스 재시작과 FE 새로고침 이후 신고/결제/claim/반환/지급 내역 보존.
- 결제 실패면 매칭 활성화 없음. 결제 redirect 조작으로 PAID 설정 불가.
- 두 finder/seeker 계정으로 전체 happy path 통과, 자기 claim 및 타인 리소스 접근 차단.
- 다른 두 seeker가 같은 found를 동시 승인 요청해도 하나만 예약·반환.
- 코드 재사용·만료·추측·다른 사용자 소비 차단, consume retry는 최초 성공 결과 반환.
- payment webhook 중복, 환불/반환 경쟁, 지급 timeout 이후 재시도에서 중복 금전 이동 없음.
- 7일 만료 및 취소 환불 완료/지연/실패 각각 화면과 저장 상태 일치.
- 이미지 없음·AI 실패·지도 거절·무결과·업로드 실패·401·409·오프라인 각각 복구 가능한 화면.
- 공개 응답/이미지에서 private 특징·정밀 위치·연락처 누출 없음.
- demo가 실제 결제·실제 송금처럼 보이지 않으며 live에서 demo route/secret 번들 포함 없음.

## 10. 공유 시연 fixture와 인수 시나리오

각 구현은 동일한 시나리오명을 사용한다. ID는 실제 UUID로 seed하고 역할별 매핑을 `shared/fixtures/demo-manifest.json`에 기록한다(BE 생성, FE 소비). 테스트 토큰은 production에서 유효하지 않아야 한다. 실제 학생 개인정보나 신분증 이미지는 seed에 넣지 않는다.

| 시나리오 | 입력 | 기대 결과 |
|---|---|---|
| F01_RETURN_SUCCESS | demo-finder의 흰색 이어폰 케이스 found, demo-seeker의 같은 물건 lost; 표면 파란 별 스티커는 비공개 검증 특징 | 5000 결제, 후보 발견, 스티커 증빙 승인, 코드 소비, 3500 보상 PAID |
| F02_NO_MATCH | 우산 lost, 이어폰 found | 후보 없음; 가짜 매칭 카드 생성 금지 |
| F03_NO_PHOTO | 사진 없는 이어폰 lost, 색/브랜드/위치 설명 존재 | text/geo/time으로 검색 가능, 실제 사진을 임의 합성하지 않음 |
| F04_AI_FAILURE | 분석 adapter timeout | FAILED 표시, 수동 초안 입력·재시도 가능 |
| F05_PAYMENT_FAILURE | 공급자 결제 실패 | AWAITING_PAYMENT 유지, paidAt/expiresAt 설정 금지, 재시도 가능 |
| F06_DOUBLE_CLAIM | 두 seeker가 동일 found로 서로 다른 claim 제출 | 첫 승인만 성공, 다른 claim 거절 및 해당 search 복귀 |
| F07_CODE_REPLAY | 같은 complete 요청 동일 키 재전송 및 다른 키 재전송 | 동일 키는 동일 성공 응답; 새 키는 이미 완료 상태 반환/409, 추가 배분 없음 |
| F08_EXPIRED | clock 주입으로 paidAt+7일 경과 | EXPIRED, 코드 무효, REFUND_PENDING→REFUNDED, payout 없음 |
| F09_PAYOUT_TIMEOUT | 공급자 송금 성공 후 응답 단절 | 조회·재조정 후 PAID, 새 송금 생성 없음 |
| F10_CANCEL_LATE_PAID | 미결제 취소 후 결제 성공 webhook 도착 | search CANCELLED 유지, 공급자 결제 확인 후 전액환불 |
| F11_PRIVATE_ACCESS | 비당사자가 claims/handoffs/payment/정밀 장소 접근 | 404, 공개 DTO에는 비밀 필드 없음 |
| F12_REFUND_RETRY | 환불 일시 실패 후 운영자 재시도 | REFUND_PENDING 유지 후 REFUNDED; 환불 중복 없음 |

데모 장소는 가상 캠퍼스 건물명과 서울 인근 테스트 좌표로 표시하고 실존 제휴 보관소로 소개하지 않는다. fixture 사진은 해당 물체와 시각적으로 일치하는 로컬 샘플이며 라이선스·출처를 기록한다. 알고리즘 fixture와 UI fixture는 같은 아이템/상태를 참조한다. timeout/시각 경과는 테스트 clock/provider fault injection으로 재현하며 실제 7일을 기다리지 않는다.

배분 원장 검증 기준: 성공 반환 1건에는 수납 5000, 습득자 지급 의무 3500, 플랫폼 배분 1500이 한 번 기록된다. 환불 시나리오는 수납에 대응하는 환불 5000, 배분 0이다. PG 비용은 별도 비용 항목이며 이를 보상액에서 몰래 차감하지 않는다. 지급은 지급 의무의 해소이므로 비용·배분을 이중 합산하지 않는다.
