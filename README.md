# Lumina — 주차장 사고 증거 매칭 데모 MVP (Backend)

주차장 뺑소니·접촉 사고 피해자(X)와 같은 장소·시간대에 방문한 블랙박스 보유자(Y)를 연결하고, TwelveLabs로 영상 속 사고 후보 장면을 찾아 보험사 채택·보상까지 이어지는 데모 MVP의 백엔드 저장소입니다.

## 문서 읽는 순서

| 순서 | 문서 | 내용 |
|---|---|---|
| 1 | [`MVP_PARKING_INCIDENT_EVIDENCE.md`](./MVP_PARKING_INCIDENT_EVIDENCE.md) | 제품 정의·참여자·핵심 흐름·운영 원칙. 범위 판단의 기준 |
| 2 | [`MVP_scope.txt`](./MVP_scope.txt) | 이번 데모(iPhone 11, TwelveLabs, 20초 Mock 영상)의 구현 범위와 완료 기준. 두 문서가 충돌하면 이 문서 우선 |
| 3 | [`BE_SPEC.md`](./BE_SPEC.md) | 백엔드 구현 명세. 공통 규약, Supabase 데이터 모델, 상태 머신, 기능별(F0~F10) API·처리 규칙·검증, TwelveLabs 연동, 구현 에이전트용 프롬프트 |
| 4 | [`MOCK_DATA_AND_ASSETS.md`](./MOCK_DATA_AND_ASSETS.md) | 데모 계정, seed, 피해 차량 사진, 블랙박스 Mock 영상 제작 지침, TwelveLabs fixture, 알림 문구, FE mock fixture |
| 5 | [`.env.example`](./.env.example) | BE·FE·TwelveLabs 분석 에이전트 환경 변수 예시 (비밀 값 없음) |
| – | `FE_SPEC.md` | 프론트엔드 구현 명세. **FE 저장소(`trainthon-fe`)로 이동 예정**이며 시각 디자인은 FE 저장소의 `design.md`를 따른다 |

## 기술 스택 (요약)

- Node.js 20, TypeScript, Express 5, `/api/v1`
- Supabase: Auth(이메일/비밀번호 데모 계정, Kakao 선택), Postgres, Storage(private 버킷 + signed URL)
- TwelveLabs Analyze API (`pegasus1.5`, `json_schema` 응답, 참고 이미지)
- Firebase는 사용하지 않음. 브라우저에서 AI 공급자 API를 직접 호출하지 않음

## 시작하기

1. `.env.example`을 `server/.env`로 복사하고 `FILL` 항목(Supabase URL/service role, TwelveLabs API 키, 데모 비밀번호 등)을 채운다.
2. Supabase 프로젝트에 `supabase/migrations/`를 적용하고 `incident-photos`, `evidence-videos` private 버킷을 만든다.
3. `npm run seed:demo`로 데모 계정·장소·Y 방문 이력을 넣는다 (서버 시작 시 자동 실행되지 않음).
4. `npm run dev`로 서버(3001)를 띄우고 FE(3000)와 연결한다.

세부 실행 명령·스크립트 이름은 구현 시 이 README에 확정해 적는다.

## 실제 / Mock 경계

| 실제 | Mock |
|---|---|
| 사고 요청·사진 저장, 장소·시간 매칭 → 인앱 알림, 영상 업로드, TwelveLabs 분석 | Y 방문 이력(seed), 보험사 채택 상태, 예치·보상 상태, 20초 블랙박스 영상 파일 |

AI 결과는 사고 사실·가해 차량·과실을 확정하지 않으며, 실제 분석 실패를 사전 분석 결과로 조용히 대체하지 않는다(`source=PRERECORDED`로 항상 구분 표시).
