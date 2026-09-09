# Lumina FE 구현 명세 — 주차장 사고 증거 매칭 데모 MVP

작성일: 2026-09-09  
기준 문서: `MVP_PARKING_INCIDENT_EVIDENCE.md`(제품 원칙), `MVP_scope.txt`(데모 범위), `BE_SPEC.md`(API 계약).  
**시각 디자인(색상·타이포·간격·컴포넌트 스타일·아이콘·모션)은 FE 저장소의 `design.md`를 따른다.** 이 문서는 화면 구성·흐름·상태·API 소비·모바일 제약을 정의하며, `design.md`와 이 문서가 충돌하면 **시각 요소는 `design.md`**, **흐름·데이터·문구 규칙은 이 문서**를 우선한다. `design.md`가 아직 없으면 §6의 최소 가드레일로 구현하고, `design.md`가 추가되면 그에 맞춰 스타일만 교체한다.

대상 독자: 프론트엔드 구현 에이전트/개발자. 계획서가 아니라 **그대로 구현·검증해야 하는 작업 명세**다.

---

## 0. 한 줄 목표

> iPhone 11 세로 화면 하나에서 X(요청자)와 Y(제보자) 두 계정을 전환하며, 사고 요청 등록 → Y 알림 → 20초 MP4 업로드 → 실제 AI 분석 진행 → `00:12 사고 후보` 탭 시 영상이 12초로 점프 → 보험사 채택 → Y 보상 예정까지 끊김 없이 시연한다.

---

## 1. 기술 스택과 기본 결정

| 항목 | 결정 |
|---|---|
| 프레임워크 | Next.js(App Router) + TypeScript(strict). React 19 |
| 스타일 | Tailwind CSS(로컬 빌드). 토큰·컴포넌트 스타일은 `design.md` |
| 인증 | `@supabase/supabase-js` + `@supabase/ssr`. 이메일/비밀번호 데모 계정 X, Y. Kakao는 Supabase Provider 설정 시 선택 활성화 |
| 서버 상태 | TanStack Query(폴링·캐시). 개인 데이터 queryKey에 `userId` 포함, 계정 전환 시 `queryClient.clear()` |
| 폼 | React Hook Form + zod |
| 업로드 | 서버가 발급한 Supabase signed upload URL로 **브라우저가 직접 PUT**(XHR로 진행률 표시). 파일이 BE 서버를 경유하지 않음 |
| 영상 재생 | 네이티브 `<video playsinline>`; 타임스탬프 탭 시 `currentTime` 변경 후 `play()` |
| 배포 | Vercel(선택). 로컬 `http://localhost:3000` |

Firebase는 사용하지 않는다. 브라우저에서 TwelveLabs 등 AI 공급자 API·키를 직접 사용하지 않는다. 모든 도메인 상태(사고 요청·알림·제보·분석·채택·정산)는 BE API(`/api/v1`)로만 읽고 쓴다. Supabase 클라이언트는 **로그인과 Storage 업로드**에만 사용한다.

### 1.1 환경 변수 (public만)

```dotenv
NEXT_PUBLIC_SITE_URL=http://localhost:3000
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001/api/v1
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_KAKAO_AUTH_ENABLED=false
NEXT_PUBLIC_DEMO_MODE=true
NEXT_PUBLIC_DEMO_REQUESTER_EMAIL=
NEXT_PUBLIC_DEMO_WITNESS_EMAIL=
NEXT_PUBLIC_DEMO_ACCOUNT_PASSWORD=
```

service role 키, TwelveLabs 키는 절대 `NEXT_PUBLIC_`에 넣지 않는다. 전체 키 목록은 루트 `.env.example` 참고.

---

## 2. 정보 구조와 라우트

역할별로 라우트를 나눈다. 로그인 사용자의 `role`(`/me`)에 따라 기본 진입 화면이 달라진다.

| 라우트 | 화면 | 역할 | MVP_scope §7 번호 |
|---|---|---|---|
| `/` | 랜딩·로그인(데모 계정 버튼 2개) | 공개 | – |
| `/auth/callback` | Supabase 세션 확정 → role별 홈 | – | – |
| `/x` | X 홈: 내 사고 요청 목록 + `사고 제보하기` CTA | REQUESTER | – |
| `/x/incidents/new` | X 사고 제보 폼 | REQUESTER | 1 |
| `/x/incidents/[id]/done` | X 제보 완료·접수 완료(매칭 인원 표시) | REQUESTER | 2 |
| `/x/incidents/[id]` | X 요청 상세: 상태·제보 현황·후보 영상·보험사 제출·채택·정산 | REQUESTER | 8, 9 |
| `/y` | Y 홈: 인앱 알림 목록 | WITNESS | 3 |
| `/y/incidents/[id]` | Y 사고 요청 상세(마스킹) + `영상 제보하기` | WITNESS | 4 |
| `/y/incidents/[id]/upload` | 영상 선택·미리보기·업로드 | WITNESS | 5 |
| `/y/submissions/[id]/analysis` | AI 분석 진행 → 결과(플레이어+타임스탬프) | WITNESS | 6, 7 |
| `/y/rewards` | Y 보상 내역(보상 지급 예정) | WITNESS | 9 |
| `/notifications` | 공통 알림 목록(role별 필터) | 로그인 | 3, 8 |

- 모든 페이지는 새로고침·뒤로 가기 시 URL만으로 복원되어야 한다(App 내부 state로만 화면을 전환하지 않는다).
- 데모 계정 전환은 상단 앱바의 `계정 전환` 스위치(X ⇄ Y). 실제로 `signOut → signInWithPassword`를 수행하고 role 홈으로 이동한다. `NEXT_PUBLIC_DEMO_MODE=false`면 스위치를 숨긴다.

---

## 3. 화면별 명세

각 화면은 **목적 → 구성 → 상태 → API → 완료 조건** 순서로 적는다. 시각 스타일은 `design.md`.

### 3.1 `/` 랜딩·로그인

- 구성: 서비스 한 줄 설명, `X(요청자)로 시작`, `Y(제보자)로 시작` 버튼(데모 모드), Kakao 로그인 버튼(설정 시).
- Kakao 미설정이면 버튼을 `설정 대기`로 비활성 표시한다. 가짜 성공 버튼을 만들지 않는다.
- 로그인 성공 → `/me`로 role 조회 → `/x` 또는 `/y`.

### 3.2 `/x/incidents/new` — X 사고 제보 폼 (필수 화면 1)

- 구성(위→아래, 한 열):
  1. 사고 장소 선택(`GET /places` 결과에서 선택, 기본값 `A주차장`)
  2. 사고 유형 세그먼트: 뺑소니 / 접촉 사고 / 차량 파손 / 기타
  3. 사고 추정 시간: 날짜 + 시작·종료 시각(기본 오늘 14:00~14:10). `<input type="time">` 사용
  4. 피해 차량: 색상, 차종, 파손 부위(각 텍스트, 파손 부위는 칩 선택 + 직접 입력)
  5. 사고 설명(textarea, 1,000자, 카운터)
  6. 피해 차량 사진 1~2장(`<input type="file" accept="image/*" multiple>`, iOS 사진 보관함 흐름). 썸네일·삭제
  7. 동의 체크 2개(증거 이용, 개인정보 처리)
  8. 하단 고정 `제보 등록` 버튼(safe-area 반영)
- 검증(zod): 시작 < 종료, 24시간 이내, 설명 필수, 동의 2개 필수, 사진 ≤ 2장·장당 ≤ 10MB·JPEG/PNG/WebP.
- 제출 절차:
  1. 사진마다 `POST /uploads/photo-url` → signed URL로 PUT(진행률)
  2. `POST /incidents`(photoObjectPaths 포함) → 201
  3. `/x/incidents/[id]/done`으로 이동 (사진 연결은 `POST /incidents`가 한 번에 처리하므로 별도 호출 없음)
- 오류: 400 fieldErrors를 필드 아래 표시. 업로드 실패 시 해당 사진만 재시도.
- 완료 조건: 320px 너비에서 가로 스크롤 없음, 모든 입력 터치 영역 ≥ 44pt.

### 3.3 `/x/incidents/[id]/done` — 제보 완료·접수 완료 (필수 화면 2)

- 구성: 체크 아이콘, `사고 접수가 완료되었습니다`, 요약 카드(장소·시간·차량), **`같은 시간대 방문 사용자 {matchedWitnessCount}명 발견`** 강조 문구, `예치 완료(데모)` 상태 배지, `내 요청 보기` 버튼.
- `matchedWitnessCount=0`이면 `아직 같은 시간대 방문 사용자가 없습니다. 새로운 방문 기록이 확인되면 알려드릴게요.`
- API: 생성 응답의 `matching`, `GET /incidents/:id`, `GET /incidents/:id/settlement`.

### 3.4 `/y` — Y 인앱 알림 목록 (필수 화면 3)

- 구성: 상단 `알림`, 목록 카드(`WITNESS_REQUEST`: 장소·시간대·"당시 영상이 있다면 확인해 주세요", 미읽음 점), 빈 상태 문구.
- 폴링: TanStack Query `refetchInterval` 5초(화면 활성 시). 데모 중 X → Y 전환 직후 알림이 보여야 한다.
- 탭 → `POST /notifications/:id/read` → `/y/incidents/[id]`.
- 알림에는 X의 개인정보가 없다(BE 보장, FE는 있어도 렌더하지 않음).

### 3.5 `/y/incidents/[id]` — Y 사고 요청 상세 (필수 화면 4)

- 구성: 장소·시간대, 사고 유형, 피해 차량(색상·차종·파손 부위), 설명 요약, 피해 차량 사진(signed URL), 보상 안내 카드(`채택 시 보상 {witnessReward}원 예정 · 데모`), 하단 고정 `영상 제보하기`.
- DTO에 `mySubmissionId`가 있으면 버튼을 `내 제보 보기`로 바꾸고 `/y/submissions/[mySubmissionId]/analysis`로 이동.
- API: `GET /incidents/:id`(Y용 마스킹 DTO). `GET /incidents/:id/settlement`은 X 전용이므로 보상 금액은 Y용 DTO의 `rewardPreview.amount`를 사용한다.

### 3.6 `/y/incidents/[id]/upload` — 영상 선택·미리보기·업로드 (필수 화면 5)

- 구성:
  1. 안내: `사고 추정 시각 전후 영상 1개(MP4)를 선택해 주세요. 데모에서는 약 20초 영상을 사용합니다.`
  2. `<input type="file" accept="video/mp4,video/*">` — iOS Safari 사진 보관함·파일 앱 선택 흐름 사용. 파일 1개만.
  3. 선택 즉시 `URL.createObjectURL`로 `<video controls playsinline muted>` 미리보기(16:9, 전체 너비). `loadedmetadata`에서 `duration`·해상도 읽어 표시.
  4. 클라이언트 사전 검증: MP4, ≤ `videoMaxBytes`(`GET /config`), duration ≥ 4초. 실패 시 이유 표시하고 업로드 버튼 비활성.
  5. 확인 항목: 촬영 시각(선택 입력), 제출 목적·보상 조건 동의 체크.
  6. 하단 고정 `업로드` → 진행률 바(%) + 취소.
- 업로드 절차:
  1. `POST /incidents/:id/submissions` `{ mime, bytes, durationSec, recordedAt? }` → `uploadUrl, token, submissionId`
  2. XHR `PUT uploadUrl`(헤더 `Content-Type: video/mp4`, `x-upsert: false`)로 진행률 표시. supabase-js `uploadToSignedUrl`을 쓰면 진행률이 없으므로 XHR 직접 구현 권장.
  3. `POST /submissions/:id/complete-upload` → `UPLOADED`
  4. `AI 분석 시작` 버튼 활성 → `POST /submissions/:id/analyze`(202) → `/y/submissions/[id]/analysis`
- 오류: 네트워크 중단 시 `업로드가 중단되었습니다` + `다시 업로드`(같은 submission으로 `uploadUrl` 재발급). 413/415/422 메시지를 그대로 표시.
- 화면을 이탈해도 업로드 중 상태를 `sessionStorage`에 남겨 복귀 시 안내한다(재개 기능은 범위 밖).

### 3.7 `/y/submissions/[id]/analysis` — AI 분석 진행 → 결과 (필수 화면 6, 7)

**진행 상태(6)**

- 단계 인디케이터 3단계: `업로드 완료` → `AI 분석 중` → `결과 정리 중`. `GET /submissions/:id/analysis`를 2초 간격 폴링하여 `QUEUED/ANALYZING → 2단계`, `FINALIZING → 3단계`, `READY → 결과 화면`, `FAILED → 오류 카드`.
- 긴 전체 화면 스피너 금지. 단계별 짧은 설명 텍스트와 경과 시간(초)을 표시한다.
- 폴링 상한 `ANALYSIS_POLL_TIMEOUT_MS`(기본 180초) 초과 시 `분석이 지연되고 있습니다` + `계속 대기`/`다시 시도`.
- `FAILED`: 오류 코드별 문구(`PROVIDER_UNAVAILABLE`: "AI 서비스 연결에 실패했습니다", `VIDEO_UNANALYZABLE`: "영상 조건이 맞지 않습니다") + `다시 분석` (`POST /submissions/:id/analyze/retry`). **실패를 성공처럼 표시하지 않는다.**

**결과(7)**

- 상단 배지: `source=LIVE` → `실시간 AI 분석 결과`, `source=PRERECORDED` → `사전 분석 결과`(반드시 다른 색·아이콘, `design.md` 배지 규칙). 배지는 항상 보인다.
- 영상 플레이어: `<video controls playsinline preload="metadata">`, 16:9 전체 너비, `src`는 `GET /submissions/:id/video-url`의 signed URL. 만료(403) 시 자동 재발급 1회.
- 분석 카드(플레이어 아래 한 열):
  - `사고 후보` 카드: 큰 타임스탬프 버튼 `00:12 사고 후보` — 탭 시 `video.currentTime = incidentTimestampSeconds; video.play()`. 재생 위치가 타임스탬프 ±1.5초 안이면 카드 강조.
  - `장면` 텍스트(`event`), `관련도` 칩(`HIGH/MEDIUM/LOW` → 높음/보통/낮음).
  - `차량 특징`: 피해 차량 / 상대 차량.
  - `일치 근거` 리스트(`evidence`).
  - 고정 면책 문구(`result.disclaimer`): "AI 결과는 사고 사실·가해 차량·과실을 확정하지 않습니다."
  - `incidentDetected=false`이면 `사고 후보 장면을 찾지 못했습니다` 카드와 `다른 영상 올리기` 안내(데모 실패 흐름).
- 하단: `제보 완료. 요청자에게 후보 영상이 전달되었습니다.` + `내 보상 보기`.
- 완료 조건: iPhone 11 Safari에서 타임스탬프 탭 → 12초 지점 재생이 실제로 동작(iOS는 사용자 제스처 안에서 `play()` 호출 필요, 탭 핸들러 내부에서 동기 호출).

### 3.8 X 후보 발견 알림 화면 (필수 화면 8)

- `/notifications` 또는 `/x` 상단 배너: `CANDIDATE_FOUND` — `A주차장 사고에 대한 후보 영상이 발견되었습니다. 00:12 지점을 확인해 보세요.` 탭 → `/x/incidents/[id]#candidates`.
- `NO_CANDIDATE`(제보 영상에서 관련 장면을 찾지 못함)는 중립 톤의 알림 카드로 표시하고 탭 시 요청 상세로 이동. 후보 카드가 아니라 `후보 없음으로 끝난 제보 {meta.noCandidateCount}건` 요약 문구로만 보인다.
- X 계정에서도 5초 폴링. Y → X 전환 직후 배너가 보여야 한다.

### 3.9 `/x/incidents/[id]` — 요청 상세·보험사 채택·보상 예정 (필수 화면 8, 9)

- 구성:
  1. 상태 타임라인: `접수 → 제보 수집 중 → 증거 검토 중 → 채택 완료`(incident.status 매핑)
  2. 요약 카드(장소·시간·차량·사진)
  3. `후보 영상` 섹션(`GET /incidents/:id/candidates`): 제보자 `제보자 #1`, 배지(`실시간/사전 분석`), 플레이어 + `00:12 사고 후보` 버튼(3.7과 같은 컴포넌트 재사용), 관련도·근거, `humanReviewed:false`면 `담당자 검토 전(데모)` 표시
  4. `보험사 제출` 버튼(READY에서만) → `POST /submissions/:id/submit-to-insurer` → 무결성 카드(`sha256 앞 12자`, 제출 시각) 표시
  5. `보험사 채택 상태` 카드: `검토 중` → 데모 버튼 `증거 채택(데모)`/`미채택(데모)` → `POST /submissions/:id/insurer-decision`. 결정 후 버튼 비활성. `mock: true`면 카드에 `데모 보험사` 라벨 고정
  6. `예치·보상` 카드(`GET /incidents/:id/settlement`): `예치 완료 → 채택 대기 → 보상 지급 예정` 스텝, 금액(예치·수수료·제보자 보상), `데모: 실제 결제·송금 없음`
- 완료 조건: `증거 채택` 탭 후 정산 카드가 `보상 지급 예정`으로 갱신(mutation 후 invalidate).

### 3.10 `/y/rewards` — Y 보상 내역 (필수 화면 9)

- 구성: 카드 목록(`GET /me/rewards`): 사고 장소·일시, 금액, 상태 칩(`보상 지급 예정`), 예정 시각, `데모` 라벨. 알림(`REWARD_SCHEDULED`) 탭으로 진입.
- 발표 마지막 장면이므로 진입 직후 데이터가 보여야 한다(프리페치 또는 전환 시 invalidate).

### 3.11 방문 기록 관리 (선택, 원칙 문서 §5-3)

- `/y/visits`: `GET /me/visits` 목록(`A주차장 13:58~14:12`, `데모 seed`), 삭제 버튼(`DELETE /me/visits/:id`), 알림 동의 토글(`PATCH /me`). 데모 발표에 필수는 아니지만 원칙(조회·삭제 가능)을 보이는 화면이므로 시간이 되면 구현한다.

---

## 4. 공통 컴포넌트

| 컴포넌트 | 책임 |
|---|---|
| `AppBar` | 타이틀, 뒤로 가기, 데모 `계정 전환` 스위치(X/Y 현재 역할 표시), 알림 종(미읽음 수) |
| `BottomActionBar` | 하단 고정 CTA, `padding-bottom: env(safe-area-inset-bottom)` |
| `StepIndicator` | 3단계 진행(업로드 완료/AI 분석 중/결과 정리 중), 상태 타임라인에도 재사용 |
| `VideoPlayer` | `<video>` 래퍼, `seekTo(seconds, autoplay)` 메서드 노출, signed URL 만료 재발급 |
| `TimestampButton` | `00:12 사고 후보` — `seconds`→`mm:ss` 포맷, 활성 강조 |
| `AnalysisResultCard` | source 배지, event, relevance, 차량 특징, evidence, disclaimer |
| `StatusChip` | incident/submission/insurer/settlement 상태 → 한국어 라벨·색상(§5 매핑) |
| `NotificationCard` | type별 아이콘·문구, 미읽음 표시 |
| `FilePicker(Image|Video)` | iOS 친화 `<input type=file>`, 미리보기, 클라이언트 검증 메시지 |
| `UploadProgress` | XHR 진행률, 취소, 재시도 |
| `DemoBadge` | `데모`, `사전 분석 결과`, `데모 보험사` 등 Mock 표기를 일관되게 |
| `ErrorState`, `EmptyState`, `Skeleton` | 공통 상태 UI |

---

## 5. 상태·문구 매핑

| 도메인 | 서버 값 | 화면 라벨 |
|---|---|---|
| incident | `OPEN` / `COLLECTING` / `REVIEWING` / `ADOPTED` / `CLOSED_NO_EVIDENCE` / `CANCELLED` | 접수 완료 / 제보 수집 중 / 증거 검토 중 / 채택 완료 / 증거 없음 종료 / 취소 |
| submission | `UPLOADING` / `UPLOADED` / `ANALYZING` / `READY` / `ANALYSIS_FAILED` / `SUBMITTED` / `ADOPTED` / `REJECTED` | 업로드 중 / 업로드 완료 / AI 분석 중 / 후보 확인 가능 / 분석 실패 / 보험사 검토 중 / 채택 / 미채택 |
| analysis | `QUEUED`,`ANALYZING` / `FINALIZING` / `READY` / `FAILED` | AI 분석 중 / 결과 정리 중 / 완료 / 실패 |
| analysis.source | `LIVE` / `PRERECORDED` | 실시간 AI 분석 결과 / 사전 분석 결과 |
| relevance | `HIGH`/`MEDIUM`/`LOW` | 높음/보통/낮음 |
| settlement | `DEPOSITED` / `ADOPTION_PENDING` / `PAYOUT_SCHEDULED` | 예치 완료 / 채택 대기 / 보상 지급 예정 |

**문구 규칙**

- AI 결과를 "가해 차량 확정", "사고 확정", "일치 확률 98%"처럼 단정적으로 표현하지 않는다. `사고 후보`, `관련도 높음`, `~로 보이는 장면`을 사용한다.
- Mock 기능(보험사 채택, 예치·보상, 방문 기록 seed, 사전 분석 결과)은 항상 `데모` 라벨을 붙인다.
- 실패는 실패로 보인다. `FAILED`를 스피너 뒤에 숨기거나 성공 화면으로 넘기지 않는다.

---

## 6. 모바일(iPhone 11) 제약과 최소 디자인 가드레일

`design.md`가 우선이며, 아래는 어떤 경우에도 지켜야 하는 최소 조건이다.

- 기준 viewport `375×812`, **320px 너비까지 가로 스크롤 없음**. `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`.
- 모든 주요 버튼·탭 영역 ≥ 44×44pt. 인라인 텍스트 링크만으로 핵심 동작을 제공하지 않는다.
- 하단 고정 버튼: `padding-bottom: calc(12px + env(safe-area-inset-bottom))`. 상단 앱바: `padding-top: env(safe-area-inset-top)`.
- 영상 플레이어 16:9 전체 너비, 분석 카드는 플레이어 아래 한 열. 가로 2열 레이아웃 금지(320px 기준).
- `<video>`에 `playsinline` 필수(iOS 전체화면 강제 방지). `muted`는 미리보기에만.
- 파일 선택은 표준 `<input type="file">`. 드래그앤드롭 전용 UI 금지.
- 폰트 최소 14px(보조 텍스트 12px), 본문 16px. iOS 입력 확대 방지를 위해 input 폰트 ≥ 16px.
- 색상 대비 WCAG AA. 상태를 색만으로 구분하지 않고 라벨·아이콘을 함께 사용.
- 폴링 중에도 화면 상호작용 가능. 전체 화면 차단 로딩은 페이지 최초 로드 스켈레톤에만.
- 새로고침·백그라운드 복귀 후 URL 기준으로 같은 화면·같은 데이터가 복원된다.
- 다크모드는 `design.md`에 정의된 경우에만.

---

## 7. API 클라이언트 규약

- `lib/api.ts`: `fetch` 래퍼. Supabase 세션의 `access_token`을 `Authorization: Bearer`로 첨부. 응답 `{data, meta}` / `{error, meta}` 언래핑. 401 시 세션 갱신 1회 → 실패면 `/`로.
- `X-Request-Id`(uuid)를 보내고 오류 토스트에 `meta.requestId` 앞 8자를 표시(디버깅용).
- 타입은 BE `openapi.yaml`에서 생성(`openapi-typescript`)하거나 `types/api.ts`에 수동 정의. 서버 enum을 FE에서 임의로 확장하지 않는다.
- 폴링 간격: 알림 5초, 분석 2초. 탭 비활성(`visibilitychange`) 시 중단.
- 계정 전환 시 `queryClient.clear()`, `sessionStorage` 업로드 상태 삭제.

---

## 8. 데모 시나리오 체크리스트 (MVP_scope §8)

발표 전 iPhone 11 실기기 Safari에서 순서대로 확인한다.

1. [ ] `/`에서 `X로 시작` → `/x`
2. [ ] `사고 제보하기` → A주차장, 14:00~14:10, 흰색/세단/우측 후면, 설명, 사진 2장 → `제보 등록`
3. [ ] 완료 화면에 `같은 시간대 방문 사용자 1명 발견`, `예치 완료(데모)`
4. [ ] 앱바 `계정 전환` → Y → `/y`에 새 알림 1건(5초 이내)
5. [ ] 알림 탭 → 사고 상세 → `영상 제보하기`
6. [ ] 약 20초 MP4 선택 → 미리보기 표시 → `업로드` 진행률 0→100%
7. [ ] `AI 분석 시작` → 3단계 인디케이터가 순서대로 진행
8. [ ] 결과: `실시간 AI 분석 결과` 배지, `00:12 사고 후보` 버튼
9. [ ] 버튼 탭 → 플레이어가 12초로 이동해 재생
10. [ ] `계정 전환` → X → 상단 배너 `후보 영상 발견` → 요청 상세
11. [ ] `보험사 제출` → 무결성 카드 → `증거 채택(데모)` → 정산 카드 `보상 지급 예정`
12. [ ] `계정 전환` → Y → `/y/rewards`에 `보상 지급 예정` 카드
13. [ ] 전체 흐름에서 가로 스크롤·막힌 동작·전체화면 스피너 없음

**실패 흐름 확인**

- [ ] 시간 안 겹치는 요청 → `0명 발견` 문구
- [ ] 3초 영상 선택 → 업로드 전 클라이언트 거절 문구
- [ ] 업로드 중 네트워크 끊김 → `다시 업로드` 동작
- [ ] AI 실패(`FAILED`) → 오류 카드 + `다시 분석`; 성공처럼 보이지 않음
- [ ] `PRERECORDED` 결과 → `사전 분석 결과` 배지가 명확히 다르게 보임
- [ ] `incidentDetected=false` → `후보 없음` 카드

---

## 9. 구현 순서

1. 프로젝트 기반: Next.js, Tailwind(`design.md` 토큰), Supabase 클라이언트, 인증 콜백, `AppBar`/`BottomActionBar`/`DemoBadge`, API 래퍼, TanStack Query Provider
2. 로그인·데모 계정 전환·role 라우팅(`/`, `/x`, `/y`)
3. X 사고 제보 폼 + 사진 업로드 + 완료 화면(3.2, 3.3)
4. Y 알림 목록 + 사고 상세(3.4, 3.5)
5. 영상 선택·미리보기·XHR 업로드·complete-upload(3.6)
6. 분석 진행·결과·`VideoPlayer`·`TimestampButton`(3.7)
7. X 후보 알림·요청 상세·보험사 제출·채택·정산(3.8, 3.9)
8. Y 보상 내역(3.10), 방문 기록(3.11, 선택)
9. iPhone 11 실기기 체크리스트 §8 전체 통과, 실패 흐름 확인, README(실행법·env)

---

## 10. 프론트엔드 구현 에이전트에 전달할 프롬프트

```text
FE_SPEC.md, design.md, BE_SPEC.md, MVP_scope.txt, MVP_PARKING_INCIDENT_EVIDENCE.md, MOCK_DATA_AND_ASSETS.md를 모두 읽고 Lumina 주차장 사고 증거 매칭 데모 프론트엔드를 구현·검증하라.

시각 디자인은 design.md를 따르고, 화면 흐름·상태·API 소비·문구 규칙은 FE_SPEC.md를 따르라. Next.js(App Router) + TypeScript + Tailwind + Supabase(로그인·Storage 업로드만) + TanStack Query로 구현하라. Firebase와 브라우저 측 AI 호출은 쓰지 마라. 도메인 상태는 BE_SPEC.md의 /api/v1 API로만 다루라.

iPhone 11(375×812, 320px까지) 세로 화면에서 X 사고 제보 → Y 알림 → 20초 MP4 선택·미리보기·진행률 업로드 → 3단계 AI 분석 진행 → 실시간/사전 분석 배지가 있는 결과 → `00:12 사고 후보` 탭 시 영상 12초 재생 → X 후보 알림 → 보험사 제출·채택(데모) → Y 보상 지급 예정까지 9개 필수 화면을 완성하라.

Mock 기능에는 항상 데모 라벨을 붙이고, AI 실패를 성공처럼 표시하지 마라. BE가 준비되기 전에는 MOCK_DATA_AND_ASSETS.md의 fixture로 mock API 모드를 만들어 병행 개발하되, 실제 API 모드에서 §8 체크리스트를 통과시켜라. 변경 파일, 실행법, 실기기 검증 결과, 남은 항목을 보고하라.
```
