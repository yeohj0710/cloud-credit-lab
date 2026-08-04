# 비공개 카카오톡 말투 챗봇

카카오톡 대화를 가명처리해 학습한 `Qwen3-30B-A3B` LoRA 모델을 사용자 PC에서 실행한다. Vercel은 로그인과 짧은 수명의 접속 토큰만 담당한다. 대화 내용과 말투 예시는 Vercel 함수나 NAVER Cloud로 보내지 않는다.

나중에 Codex에서 이어서 작업할 때는 다음처럼 요청하면 된다.

```text
C:\dev\cloud-gpu-runner의 비공개 카카오톡 말투 챗봇 상태를 확인하고 이어서 작업해줘. examples/kakaotalk_persona/README.md를 먼저 읽어줘.
```

## 현재 구성

- 저장소: `C:\dev\cloud-gpu-runner`
- 작업 브랜치: `private-persona-chat`
- Draft PR: `https://github.com/yeohj0710/cloud-gpu-runner/pull/1`
- 고정 Preview 주소: `https://cloud-gpu-runner-yeohj0710-yeohj0710s-projects.vercel.app/persona.html`
- 모델: 공식 `Qwen3-30B-A3B` GGUF와 카카오톡 LoRA 어댑터
- 추론 위치: 사용자 PC의 `127.0.0.1`
- 외부 연결: Cloudflare Quick Tunnel
- 유휴 종료: 마지막 요청 후 20분
- Windows 복구: 로그인 1분 뒤 브리지·터널·Vercel Preview 자동 갱신

웹사이트의 `PC 연결·모델 켜기` 버튼은 실행 중인 로컬 브리지에 모델 시작을 요청한다. PC가 꺼졌거나 브리지 자체가 종료된 경우에는 웹사이트가 PC 프로세스를 시작할 수 없다.

## 데이터와 파일 위치

Git에 포함되는 파일과 로컬에만 남는 파일을 구분한다.

| 구분 | 위치 | 내용 |
| --- | --- | --- |
| 소스 코드 | `examples/kakaotalk_persona/`, `lib/persona-style.js` | 전처리, 학습, 브리지, 자동 복구 |
| 웹 화면 | `public/persona.*`, `api/persona-session.js` | 채팅 UI와 접속 토큰 발급 |
| 테스트 | `scripts/persona-bridge.test.mjs` | 인증, 말투 검색, 시작 버튼, 자동 복구 계약 |
| 비공개 데이터 | `etc/kakaotalk-persona/` | 가명처리 데이터, 실명 매핑, 상태, 로그, 모델 실행 파일 |
| 모델 결과 | `artifacts/cloud-gpu/kakaotalk-persona/` | LoRA 어댑터와 회수한 학습 결과 |
| 비밀값 | `.env.local`, Vercel Preview 환경변수 | 브리지 서명키와 현재 터널 주소 |

`etc/`, `artifacts/`, `.env.local`은 Git과 Vercel 업로드에서 제외한다. 대화문, 실명 매핑, 개인정보, 로그 속 대화 샘플을 터미널 출력이나 문서에 복사하지 않는다.

## 평소 사용

1. PC를 켜고 Windows에 로그인한다.
2. 자동 시작 작업 `Wellnessbox Persona Bridge`가 1분 뒤 브리지와 터널을 실행한다.
3. 고정 Preview 주소에 접속한다.
4. `PC 연결·모델 켜기`를 누른다.
5. 첫 실행은 모델 적재 때문에 최대 2분 정도 기다린다.

모델만 끄려면 웹사이트의 `모델 끄기`를 누른다. 브리지와 터널은 남아 있으므로 다음 접속에서 모델을 다시 켤 수 있다.

## 수동 복구

사이트에 `PC 연결 안 됨`이 표시되면 저장소 루트에서 다음 명령을 실행한다.

```powershell
cd C:\dev\cloud-gpu-runner
& .\examples\kakaotalk_persona\Start-PersonaBridge.ps1 -SyncVercel -DeployPreview
```

명령은 기존 브리지와 터널을 정리하고 새 Quick Tunnel 주소를 Vercel Preview 환경변수에 저장한 뒤 Preview를 다시 배포한다. Quick Tunnel 주소는 재시작할 때마다 바뀌므로 `-SyncVercel -DeployPreview`를 함께 사용한다.

Windows 자동 복구 작업을 다시 등록하려면 다음 명령을 실행한다.

```powershell
& .\examples\kakaotalk_persona\Register-PersonaBridgeStartup.ps1
```

브리지, 터널, 모델을 모두 종료하려면 다음 명령을 실행한다.

```powershell
& .\examples\kakaotalk_persona\Stop-PersonaBridge.ps1
```

## 상태 점검

대화 내용이나 비밀값을 출력하지 않고 다음 항목을 확인한다.

```powershell
cd C:\dev\cloud-gpu-runner
git status --short --branch
git log --oneline -5
Get-Content .\etc\kakaotalk-persona\persona-online-state.json
Get-Content .\etc\kakaotalk-persona\persona-bridge-state.json
Get-ScheduledTask -TaskName 'Wellnessbox Persona Bridge'
npm test
```

프로세스 확인 기준은 다음과 같다.

- `local_bridge.mjs`: 항상 실행되는 로컬 인증 브리지
- `cloudflared.exe`: Vercel 브라우저와 PC를 잇는 터널
- `llama-server.exe`: 대화할 때만 실행되는 모델 서버

`llama-server.exe`가 없고 브리지와 터널만 실행 중인 상태는 정상이다. 첫 메시지나 시작 버튼이 모델을 켠다.

## 개인정보 보호 방식

- 모든 참가자의 동의를 확인한 데이터만 사용한다.
- 원본 카카오톡 파일은 로컬에서만 읽는다.
- 이름, 이메일, 전화번호, 계좌번호, IP, URL과 긴 숫자열을 전처리 단계에서 가린다.
- `identity-map.local.json`과 `pseudonym-salt.local`은 로컬에만 둔다.
- 브라우저에는 가명과 화자별 집계 건수만 보낸다.
- 브라우저가 대화 내용을 Quick Tunnel을 통해 PC로 직접 전송한다.
- Vercel은 10분짜리 HMAC 접속 토큰만 발급한다.
- 로컬 말투 검색이 선택한 과거 답장을 프롬프트에 넣지만 PC 밖으로 따로 전송하지 않는다.
- 생성 답장이 말투 예시와 12자 이상 겹치면 예시 없이 한 번 다시 생성한다.

## 말투 품질과 한계

현재 LoRA 학습은 377 step, 약 `0.04 epoch`에서 끝났다. 전체 데이터의 약 4%만 학습했기 때문에 모델이 화자별 말투보다 일반 AI 답변처럼 말할 수 있다.

로컬 브리지는 화자별 과거 답장 중 현재 질문과 가까운 예시를 최대 3개 골라 말투와 길이 참고 자료로 사용한다. 8개 비공개 평가에서 문자 bigram F1이 `0.000`에서 `0.125`로 올랐지만, 표본이 작아 품질 개선을 보장하는 수치는 아니다. 근본적인 개선에는 더 긴 학습과 화자별 균형 샘플링이 필요하다.

## 학습 데이터 만들기

먼저 파일 수와 참가자 수만 확인한다.

```powershell
python .\prepare_data.py --input-dir '<카카오톡 폴더>' --inventory-only
```

참가자 전원이 동의한 뒤 다음 형식의 로컬 동의 파일을 만든다.

```json
{
  "all_participants_consented": true,
  "scope": "naver-cloud-private-persona-training"
}
```

가명처리 데이터는 저장소의 ignored 디렉터리에 만든다.

```powershell
python .\prepare_data.py `
  --input-dir '<카카오톡 폴더>' `
  --output-dir 'C:\dev\cloud-gpu-runner\etc\kakaotalk-persona' `
  --consent-manifest 'C:\dev\cloud-gpu-runner\etc\kakaotalk-persona\consent.json'
```

## 로컬 모델 직접 실행

웹 브리지를 거치지 않고 모델을 점검할 때 사용한다.

```powershell
& .\run_local.ps1 `
  -LlamaServer '<llama-server.exe>' `
  -BaseModel '<Qwen3-30B-A3B-Q4_K_M.gguf>' `
  -Adapter '<kakaotalk-persona-lora-f16.gguf>' `
  -GpuLayers 40 `
  -Context 2048
```

RTX 5070 Ti 16GB에는 약 17.3GiB인 Q4_K_M 모델 전체가 들어가지 않는다. 일부 레이어는 GPU에서, 나머지는 시스템 메모리에서 실행한다.

## 다음 작업자의 확인 순서

1. 이 README와 최근 Git 커밋 5개를 읽는다.
2. `git status`로 사용자 변경사항을 먼저 확인한다.
3. `persona-online-state.json`의 PID가 실제 브리지·터널 프로세스와 일치하는지 확인한다.
4. `persona-bridge-state.json`으로 모델 실행 여부를 확인한다.
5. Vercel Preview 환경변수의 터널 주소와 현재 로컬 터널이 같은지 확인한다. 비밀값 자체는 출력하지 않는다.
6. 변경 전 실패를 재현하고 `scripts/persona-bridge.test.mjs`에 회귀 테스트를 추가한다.
7. `npm test`와 실제 로컬 시작·종료 요청을 확인한다.
8. 모델 검증 후 `llama-server.exe`가 종료됐는지 확인한다.
9. 대화문, 실명 매핑, 개인정보, 로그 속 대화 샘플을 응답이나 Git에 포함하지 않는다.

Reference basis: tossfeed short practical guide.
