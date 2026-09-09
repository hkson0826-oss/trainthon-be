# Lumina — 주차장 사고 증거 매칭 데모 MVP (Backend)

주차장 뺑소니·접촉 사고 피해자(X)와 같은 장소·시간대에 방문한 블랙박스 보유자(Y)를 연결하고, TwelveLabs로 영상 속 사고 후보 장면을 찾아 보험사 채택·보상까지 이어지는 데모 MVP의 백엔드 저장소입니다.

## 문서 읽는 순서

| 순서 | 문서 | 내용 |
|---|---|---|
| 1 | [`MVP_PARKING_INCIDENT_EVIDENCE.md`](./MVP_PARKING_INCIDENT_EVIDENCE.md) | 제품 정의·참여자·핵심 흐름·운영 원칙. 범위 판단의 기준 |
| 2 | [`MVP_scope.txt`](./MVP_scope.txt) | 이번 데모(iPhone 11, TwelveLabs, 20초 Mock 영상)의 구현 범위와 완료 기준. 두 문서가 충돌하면 이 문서 우선 |
| 3 | [`BE_SPEC.md`](./BE_SPEC.md) · [`server/openapi.yaml`](./server/openapi.yaml) | 백엔드 구현 명세와 API 계약. 공통 규약, Supabase 데이터 모델, 상태 머신, 기능별(F0~F10) API·처리 규칙·검증, TwelveLabs 연동, 구현 에이전트용 프롬프트 |
| 4 | [`MOCK_DATA_AND_ASSETS.md`](./MOCK_DATA_AND_ASSETS.md) | 데모 계정, seed, 피해 차량 사진, 블랙박스 Mock 영상 제작 지침, TwelveLabs fixture, 알림 문구, FE mock fixture |
| 5 | [`.env.example`](./.env.example) | BE·FE·TwelveLabs 분석 에이전트 환경 변수 예시 (비밀 값 없음) |
| – | `FE_SPEC.md` | 프론트엔드 구현 명세. **FE 저장소(`trainthon-fe`)로 이동 예정**이며 시각 디자인은 FE 저장소의 `design.md`를 따른다 |

## 기술 스택 (요약)

- Node.js 20, TypeScript, Express 5, `/api/v1`
- Supabase: Auth(이메일/비밀번호 데모 계정, Kakao 선택), Postgres, Storage(private 버킷 + signed URL)
- TwelveLabs Analyze API (`pegasus1.5`, `json_schema` 응답, 참고 이미지)
- Firebase는 사용하지 않음. 브라우저에서 AI 공급자 API를 직접 호출하지 않음

## 저장소 구성

```
server/
  src/                      Express 앱 (F0~F10 모듈: config, me, places, incidents, notifications, visits,
                            submissions, analysis, candidates, insurer(+settlement), demo)
  supabase/migrations/      0001_core … 0005_insurer_reviews (서버 시작 시 자동 적용, advisory lock 으로 직렬화)
  scripts/                  migrate.ts, seed-demo.ts
  fixtures/                 twelvelabs-schema.v1.json, prerecorded/, demo-accounts.json, incident-a-parking.json, copy.ko.json
  openapi.yaml              API 계약 (라우터와 1:1, 테스트로 동기화 검증)
  test/                     vitest — 단위 + PGlite 기반 통합 테스트
```

## 시작하기 (server/)

```bash
cd server
npm ci
cp ../.env.example .env        # FILL 항목: DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
                               #            TWELVELABS_API_KEY(AI_MODE=live), DEMO_ADMIN_TOKEN, DEMO_ACCOUNT_PASSWORD
npm run migrate                # 마이그레이션만 적용 (서버 시작 시에도 자동 적용됨)
npm run seed:demo              # 데모 계정(X/Y/운영자) 생성 + profiles/places/visits upsert. 자동 실행되지 않음
npm run dev                    # http://localhost:3001/api/v1 (tsx watch)
```

| 명령 | 설명 |
|---|---|
| `npm run dev` / `npm run build && npm start` | 개발 서버 / 프로덕션 실행 |
| `npm run migrate` | `supabase/migrations/*.sql` 적용 (체크섬 추적, 재실행 안전) |
| `npm run seed:demo` | Supabase Admin API 로 데모 계정 생성(있으면 skip), `A주차장`/`B아파트`, Y 방문 이력 `DEMO_DATE 13:58~14:12` upsert |
| `npm run seed:demo -- --reset` | 위 + 데모 계정의 incidents/submissions/analyses/insurer_reviews/settlements/notifications 와 Storage 객체 삭제 후 visits 재삽입 (`POST /demo/reset` 과 동일) |
| `npm test` / `npm run typecheck` | 테스트(PGlite 내장 Postgres, 외부 의존 없음) / 타입 검사 |

Supabase 쪽 사전 준비: Postgres 연결 문자열(`DATABASE_URL`), private 버킷 `incident-photos`, `evidence-videos`, Auth 이메일/비밀번호 로그인 활성화. RLS 정책은 마이그레이션에 포함되어 있으며 서버는 service role 로 접근한다.

### 발표 전 체크

1. 발표 당일 아침 `npm run seed:demo -- --reset` (또는 `POST /demo/reset` + `X-Demo-Admin-Token`) — Y 방문 이력이 `DEMO_DATE`(기본: 오늘, `Asia/Seoul`) 기준으로 다시 들어간다.
2. `AI_MODE=live`, `TWELVELABS_API_KEY` 설정 확인. `AI_MODE=fake` 이면 사전 분석 fixture 만 반환된다(서버 시작 로그에 경고).
3. 데모 영상의 `sha256sum` 을 `fixtures/prerecorded/dashcam-a-parking-01.json` 의 `videoSha256` 에 기록해 두면 TwelveLabs 장애·타임아웃 시 `source=PRERECORDED` 로 표시되며 대체된다(`PRERECORDED_FALLBACK_ENABLED=true`).
4. `GET /api/v1/config` 로 `demoMode`, `aiMode`, 업로드 제한, 정산 Mock 값을 확인한다.

### 데모 흐름 (S1)

X `POST /incidents` → Y 에게 `WITNESS_REQUEST` 알림 → Y `POST /incidents/:id/submissions` + signed upload → `POST /submissions/:id/complete-upload` → `POST /submissions/:id/analyze`(202) → `GET /submissions/:id/analysis`(READY) → X `GET /incidents/:id/candidates` → X `POST /submissions/:id/submit-to-insurer` → X(DEMO_MODE) 또는 운영자 `POST /submissions/:id/insurer-decision {decision:"ADOPTED"}` → Y `ADOPTION_UPDATED`/`REWARD_SCHEDULED` 알림, `GET /me/rewards`.

## 실제 / Mock 경계

| 실제 | Mock |
|---|---|
| 사고 요청·사진 저장, 장소·시간 매칭 → 인앱 알림, 영상 업로드, TwelveLabs 분석 | Y 방문 이력(seed), 보험사 채택 상태, 예치·보상 상태, 20초 블랙박스 영상 파일 |

AI 결과는 사고 사실·가해 차량·과실을 확정하지 않으며, 실제 분석 실패를 사전 분석 결과로 조용히 대체하지 않는다(`source=PRERECORDED`로 항상 구분 표시).
