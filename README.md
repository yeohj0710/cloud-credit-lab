# Cloud GPU Runner

## Visual LoRA Playground

The public playground keeps the Qwen text LoRA pipeline and adds a zero-preparation SDXL image LoRA demo. A pinned five-image Diffusers example starts with one button; custom image upload remains available as an optional advanced path. Image runs support 100-step checkpoints, two-minute Object Storage snapshots, interrupted-run recovery, parent-model lineage, same-seed base/LoRA comparison images, and continued training from the selected model's latest checkpoint.

Vercel remains a stateless control plane. Training and checkpoint uploads run on the disposable GPU server; browser uploads go directly to Object Storage, and polling stops when the page is not visible. See `docs/visual-lora-playground.md` for the execution and recovery contract.

## Private KakaoTalk persona chat

The local-only persona model, Vercel chat bridge, privacy boundary, restart recovery, and handoff checklist are documented in [`examples/kakaotalk_persona/README.md`](examples/kakaotalk_persona/README.md).

## Capability-first GPU policy

The local baseline is an RTX 5070 Ti with 16GB VRAM. Paid cloud GPU is blocked when the local GPU can reasonably complete the work. Cloud execution permits NVIDIA accelerators with at least 48GB VRAM per GPU: NAVER L40S and KakaoCloud A100 (`p2i`). NAVER L4 and KakaoCloud T4 (`gn1i`) are rejected. Eligible accelerators usually exceed the default 2,000 KRW approval, so paid execution requires a task-specific budget.

NAVER Cloud와 KakaoCloud GPU에서 Python 학습·대량 추론을 실행하는 웰니스박스 공용 실행기입니다. 프로젝트 분석, 비용 예측, 업로드, 실행, 결과 회수, 실제 비용 기록, GPU·공인 IP·임시 디스크 반납을 한 흐름으로 처리합니다.

웹 `/jobs`는 별도 파일이나 명령 준비 없이 Qwen2.5-7B-Instruct를 48GB급 GPU에서 BF16 LoRA 학습하는 준비형 playground입니다. 완료된 어댑터는 Object Storage의 영구 모델 레지스트리에 버전별로 누적되며, 저장 모델을 선택해 새 질문으로 유료 GPU 추론할 수 있습니다. 학습과 추론 모두 GPU 생성 직전 실행 비밀번호를 다시 확인합니다.

이 저장소가 유일한 기준입니다.

- 로컬 경로: `C:\dev\cloud-gpu-runner`
- GitHub: https://github.com/yeohj0710/cloud-gpu-runner
- 공개 크레딧 현황: https://cloud-gpu-runner.vercel.app
- 실행 명령: `C:\dev\cloud-gpu-runner\scripts\cloud-gpu.ps1`

## 다른 프로젝트에서 사용

Codex에 다음처럼 요청합니다.

```text
C:\dev\cloud-gpu-runner 활용해서 GPU 학습 진행해
```

별도 조건이 없으면 GPU 1개, 최대 60분, 예상 비용 2,000원(VAT 별도) 범위로 제한합니다. `auto`는 만료가 빠른 NAVER를 우선 확인하고 사용할 수 없으면 Kakao로 전환합니다.

```powershell
& 'C:\dev\cloud-gpu-runner\scripts\cloud-gpu.ps1' status

& 'C:\dev\cloud-gpu-runner\scripts\cloud-gpu.ps1' run `
  -ProjectPath 'C:\dev\some-project' `
  -Command 'pip install -r requirements.txt && python train.py' `
  -Provider auto -Minutes 60 -MaxEstimatedCostKRW 2000 `
  -ApproveEstimatedCost
```

결과 증거는 `<대상 프로젝트>\artifacts\cloud-gpu\<job-id>\`에 저장됩니다. `job.json`에는 공급자, 실행시간, 예상·실제 비용, 잔액, 자원 반납 상태가 기록되며 가능한 경우 `run.log`와 `result.tar.gz`도 저장됩니다.

## 웹 경계

- `/`: 비로그인 공개 크레딧·익명화 작업 현황
- `/api/public-dashboard`: 민감 필드를 제거한 조회 전용 API
- `/jobs`와 관리 API: 로그인 보호
- GPU 실행·취소, 원본 명령, 작업 ID, 오류 원문, 저장 경로: 공개하지 않음
- 실제 GPU 생성 직전 `EXECUTION_PASSWORD`를 다시 확인하며, 배포 환경에서는 `0903`으로 설정

## 크레딧

| 공급자 | 지급액 | 만료일 | 선택 기준 |
| --- | ---: | --- | --- |
| NAVER Cloud | 5,300,000원 | 300,000원: 2026-07-31 / 5,000,000원: 2027-04-30 | 우선 사용 |
| KakaoCloud | 10,000,000원 | 2027-05-31 | NAVER 불가 또는 하드웨어 적합 시 |

잔액은 공개 화면에서 확인합니다. NAVER는 Billing API와 Runner 장부를 대조하고, Kakao는 Runner가 기록한 GPU·디스크·공인 IP 실제 사용량을 합산합니다.

## 테스트

```powershell
cd C:\dev\cloud-gpu-runner
.\scripts\run-tests.ps1
npm test
```

## 구조

```text
api/                 Vercel 제어·조회 API
lib/                 공급자, 비용, 작업, 스토리지 구현
public/              공개 현황과 보호된 관리자 UI
gpu/                 원격 GPU worker
scripts/             공용 CLI, 테스트, 기존 연구 유틸리티
work_memory/         GPU 활용 모듈
docs/, experiments/  아키텍처·비용 통제·연구 이력
```

실제 키와 `EXECUTION_PASSWORD`는 ignored `.env.local` 및 Vercel 환경 변수에만 둡니다. 공개 데이터 또는 비민감 샘플만 원격으로 전송합니다.
