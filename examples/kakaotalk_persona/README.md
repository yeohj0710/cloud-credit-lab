# 비공개 카카오톡 말투 모델

카카오톡 TXT를 로컬에서 가명처리한 뒤 `Qwen3-30B-A3B`에 QLoRA 어댑터를 학습한다. 원본 파일과 실명 매핑은 클라우드에 올리지 않는다.

## 개인정보 경계

- 참여자 전원의 명시적 동의가 없으면 학습 데이터를 만들거나 업로드하지 않는다.
- 로컬 전처리는 참가자 이름, URL, 이메일, 전화번호, 주민등록번호 형태, 계좌번호 형태, IP, 긴 숫자와 로컬 경로를 치환한다.
- 자동 치환은 자유서술 속 모든 개인정보를 찾는 완전한 익명화가 아니다. 클라우드 사업자가 학습 중 평문 메모리에 접근할 가능성을 0으로 만들 수도 없다.
- `identity-map.local.json`과 `pseudonym-salt.local`은 로컬 전용이다.
- 학습 결과는 비공개 로컬 사용만 허용한다. 실제 참가자를 사칭해 메시지를 자동 전송하지 않는다.

## 로컬 전처리

```powershell
python .\prepare_data.py --input-dir '<카카오톡 폴더>' --inventory-only
python .\prepare_data.py --input-dir '<카카오톡 폴더>' --output-dir '<repo>\etc\kakaotalk-persona' --consent-manifest '<repo>\etc\kakaotalk-persona\consent.json'
```

동의 매니페스트에는 다음 값이 필요하다.

```json
{
  "all_participants_consented": true,
  "scope": "naver-cloud-private-persona-training"
}
```

## 클라우드 학습

4×L40S에서 다음 명령을 실행한다. 학습 시간은 18시간으로 제한하고 나머지 시간은 모델 다운로드, 평가, LoRA GGUF 변환과 결과 업로드에 사용한다.

GPU VM의 기본 디스크에 30B BF16 원본 전체를 받지 않도록 학습에는 `unsloth/Qwen3-30B-A3B-bnb-4bit` 공개 양자화 체크포인트를 사용한다. 로컬 추론에는 Qwen 공식 GGUF를 사용한다.

```bash
pip install -r requirements.txt && \
MAX_JOBS=8 pip install flash-attn==2.8.0.post2 --no-build-isolation && \
torchrun --standalone --nproc_per_node=4 train.py --data-archive "$CGR_DATA_FILE" --output "$CGR_OUTPUT_DIR" --train-hours 18 && \
bash export_lora_gguf.sh
```

## 로컬 추론

공식 `Qwen/Qwen3-30B-A3B-GGUF`의 `Q4_K_M` 파일은 약 17.3GiB다. RTX 5070 Ti 16GB에는 전체가 들어가지 않으므로 `--n-gpu-layers`로 일부 레이어만 GPU에 두고 나머지를 32GB 시스템 메모리에서 실행한다.

```powershell
.\run_local.ps1 -LlamaServer '<llama-server.exe>' -BaseModel '<Qwen3-30B-A3B-Q4_K_M.gguf>' -Adapter '<kakaotalk-persona-lora-f16.gguf>' -GpuLayers 40 -Context 2048
```

캠페인이 완료되고 결과가 자동 압축 해제되면 다음 단축 명령을 사용할 수 있다.

```powershell
.\Start-KakaoChat.ps1 -Variant 30b -GpuLayers 40 -Context 2048
.\Start-KakaoChat.ps1 -Variant 14b -GpuLayers 99 -Context 4096
```

## Vercel에서 비공개로 접속

Vercel 화면은 짧은 수명의 서명 토큰만 발급한다. 채팅 내용은 Vercel 함수로 보내지 않고, 브라우저가 Cloudflare Quick Tunnel을 통해 사용자 PC의 로컬 브리지로 직접 전송한다. 로컬 브리지는 `127.0.0.1`의 `llama-server`만 호출하며 20분 동안 요청이 없으면 모델을 자동으로 종료한다.

```powershell
.\Start-PersonaBridge.ps1 -SyncVercel -DeployPreview
```

Quick Tunnel 주소는 PC를 재부팅하거나 터널을 다시 시작하면 달라진다. 위 명령을 다시 실행하면 Preview 환경변수와 배포를 새 주소로 갱신한다. 브리지와 모델을 즉시 종료하려면 다음 명령을 실행한다.

```powershell
.\Stop-PersonaBridge.ps1
```
