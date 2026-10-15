# Momentrip

시기·기간·비용·취향·여행 스타일로 **나라 3곳 → 도시 3곳 → 코스 3안 → 일자별 일정**을 추천해 주는 나만의 AI 여행 큐레이터.

- 화면: `index.html` + `img/` + `icons/`, `manifest.webmanifest`, `sw.js`(앱 설치·오프라인)
- AI: `api/ai.js` (Vercel 서버 함수 · Google Gemini 무료 또는 Claude · 키는 서버에만)
- 로그인·저장·사진: Supabase (프로젝트 `soundtrack-credit`에 `momentrip_` 테이블과 `momentrip-photos` 저장소로 이미 만들어 둠)

휴대폰과 컴퓨터에서 **같은 이메일로 로그인하면 같은 여행·기록·사진**이 보여요.

---

## 배포하기 (한 번만)

### 1. GitHub에 올리기
1. github.com → **New repository** → 이름 `momentrip`, **Private** 추천 → Create.
2. 새 저장소 화면의 **uploading an existing file** → 이 폴더 안의 파일과 폴더를 전부 끌어다 놓기 → **Commit changes**.
   (`index.html`, `api/`, `img/`, `icons/`, `manifest.webmanifest`, `sw.js`, `supabase/`, `vercel.json`, `package.json`, `README.md`, `.gitignore`)

### 2. Vercel에 배포
1. vercel.com → **Add New… → Project** → 방금 만든 GitHub 저장소 **Import**.
2. Framework Preset은 **Other** 그대로, Build 설정은 건드리지 않아요.
3. **Environment Variables**에 두 개 추가:

   | 이름 | 값 |
   |---|---|
   | `GEMINI_API_KEY` | **무료** — aistudio.google.com → Get API key → Create API key 로 만든 키 (카드 필요 없음) |
   | `ALLOWED_EMAILS` | AI를 쓸 내 이메일 (여러 개면 쉼표로: `a@x.com,b@y.com`) |

   Claude를 쓰고 싶으면 `GEMINI_API_KEY` 대신 `ANTHROPIC_API_KEY`(platform.claude.com, 유료 충전)를 넣으면 돼요. 둘 다 있으면 Gemini가 먼저 쓰이고, `AI_PROVIDER=claude`를 넣으면 Claude를 써요. Gemini 모델을 직접 고르려면 `GEMINI_MODEL`(예: `gemini-3.8-flash`)을 넣어요.

4. **Deploy** → 끝나면 `https://momentrip-xxxx.vercel.app` 같은 주소가 나와요.

### 3. Supabase에 내 사이트 주소 알려 주기 (로그인 링크용)
supabase.com → 프로젝트 **soundtrack-credit** → **Authentication → URL Configuration**
- **Redirect URLs**에 `https://내-vercel-주소/**` 추가 → Save.
- ⚠️ **Site URL은 바꾸지 마세요.** 같은 프로젝트를 쓰는 다른 앱이 쓰고 있어요.

**로그인 메일 관련 (중요)**
- Supabase 기본 메일 발송은 **이 Supabase 조직(팀) 멤버의 이메일로만** 보내고, **시간당 몇 통**으로 제한돼요. 혼자 쓴다면 **Supabase에 가입한 이메일로 로그인**하면 돼요. 다른 이메일도 쓰려면 Authentication → Emails → SMTP Settings에서 Resend 같은 메일 서비스를 연결하세요.
- (추천) **Authentication → Emails**의 **Magic Link**와 **Confirm signup** 템플릿 본문에 `{{ .Token }}` 한 줄을 넣어 두세요. 메일에 6자리 코드가 같이 와서, 메일 앱 안에서 링크가 열려 로그인이 엉뚱한 브라우저에 될 때 코드를 앱에 직접 넣을 수 있어요.

### 4. 사용
- 컴퓨터와 휴대폰에서 사이트를 열고 **같은 이메일**로 로그인 → 메일의 링크를 누르면 끝.
- 한 번 로그인하면 그 기기에서는 계속 로그인돼 있어요. 한 기기에서 로그아웃해도 다른 기기는 로그인 상태가 유지돼요.
- 휴대폰은 브라우저 공유 메뉴의 **홈 화면에 추가**를 누르면 앱처럼 열려요.

---

## 주요 기능
- **연차로 길게 쉬기**: 한국 공휴일·대체공휴일(2026~2027)로 가진 연차에 맞는 가장 긴 연휴를 찾아 시기·기간에 바로 넣어요. 공휴일이 바뀌면 `index.html`의 `KR_HOLI`를 고치면 돼요.
- **실제 데이터**: 추천마다 그 달의 평균 기온·비 온 날(Open-Meteo, 지난 3년 관측), 오늘 환율(open.er-api.com), 직선거리를 AI 추정값과 구분해 보여 줘요. 키 없이 쓰는 무료 서비스예요.
- **여행 취향 프로필**: 여행 기록으로 AI가 취향을 정리하고, 직접 고칠 수 있어요. 다음 추천에 반영돼요.
- **3곳 비교표**, **답이 나오는 대로 순서대로 표시**(스트리밍).
- **여행 중 모드**: 출발일을 넣으면 오늘 일정·다음 일정, 15일 이내 일기예보, 비 오는 날 대체 일정 버튼, 다녀온 곳 체크.
- **동행 투표**: 추천 3곳으로 투표 링크를 만들어 보내면, 로그인 없이 이름만 적고 투표해요.
- **지출 기록**: 현지 통화로 적으면 원화로 바꿔 예상 경비와 비교하고, 여행이 끝나면 기록에 자동으로 채워요.
- **앱처럼 설치·오프라인**: 휴대폰에서 "홈 화면에 추가"하면 앱처럼 열리고, 인터넷이 없을 때도 마지막으로 불러온 여행을 볼 수 있어요.

## 알아 두면 좋은 것
- **AI는 `ALLOWED_EMAILS`에 있는 계정만** 쓸 수 있어요. 다른 사람이 가입해도 AI 요금을 쓸 수 없고, 내 여행·기록·사진도 볼 수 없어요(행 단위 잠금).
- Supabase 기본 메일 발송은 **시간당 몇 통**으로 제한돼요. 로그인 메일이 안 오면 조금 뒤 다시 받아요. 한 번 로그인하면 거의 다시 받을 일이 없어요.
- Supabase 무료 프로젝트는 **일주일 넘게 아무도 안 쓰면 일시정지**돼요. 그땐 Supabase 대시보드에서 Restore를 누르면 돼요.
- Gemini 무료 요금제는 분당·하루 사용량 한도가 있고, 보낸 내용이 Google의 서비스 개선에 쓰일 수 있어요. Claude 키를 쓸 때는 앱의 **설정**에서 모델을 바꿀 수 있어요.
- **설정 → 전체 백업 받기**로 여행과 기록을 JSON 파일로 받아 둘 수 있어요.
- API 키를 바꾸려면 Vercel → Project → Settings → Environment Variables에서 수정하고 **Redeploy**.

## 문제가 생기면
| 증상 | 확인할 곳 |
|---|---|
| "AI 서버에 API 키가 없어요" | Vercel의 `GEMINI_API_KEY` 이름·값 확인 후 **Redeploy** |
| "무료 AI 사용량을 다 썼거나…" | Gemini 무료 한도. 잠시 뒤나 다음 날 다시 |
| "이 계정은 AI를 쓸 수 없어요" | Vercel의 `ALLOWED_EMAILS`에 로그인한 이메일이 있는지 |
| 로그인 링크를 누르면 다른 사이트로 감 | Supabase Redirect URLs에 Vercel 주소가 있는지 |
| "로그인 링크가 만료됐어요" | 링크는 한 번만, 1시간 안에 써야 해요. 새로 받기 |
