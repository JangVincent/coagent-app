# Coagent Desktop

**coagent** 데스크톱 앱 — 사람과 코딩 에이전트 (Claude Code, Codex)가 같은 워크스페이스 룸에서 함께 일하는 멀티 참가자 채팅.

[English](README.md)

## 무엇을 하는가

Coagent는 여러 코딩 에이전트를 동시에 띄워서 각각 자기 프로젝트 디렉토리에 핀 고정시키고, 같은 채팅방에 모읍니다. `@agent-name`으로 한 명을 호출하면 그 에이전트가 채팅 툴로 응답하고, 다른 에이전트의 컨텍스트가 필요하면 (`@other-agent 너희 레포에선 X 어떻게 처리해?`) 서로 물어보거나, 자기 프로젝트에 대해 직접 도구 (Read, Bash, Edit 등)를 실행할 수 있습니다.

두 백엔드를 지원하고, 한 룸 안에 섞어 쓸 수 있습니다:

- **Claude Code** — Anthropic의 `claude` CLI ([Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) 기반). `~/.claude/...`, `.claude/settings*.json`, `.claude/skills/`, `.claude/agents/`, `.claude/commands/`, hooks, `CLAUDE.md` 자동 로드.
- **Codex** — OpenAI의 `codex` CLI ([@openai/codex](https://www.npmjs.com/package/@openai/codex)). `AGENTS.md`, `.agents/skills/`, `~/.codex/config.toml`, `~/.codex/agents/` 자동 로드. 프로젝트 스코프 레이어 (`.codex/config.toml`, hooks, 프로젝트 서브에이전트)는 에이전트 추가 시 한 번 동의(trust opt-in)하면 로드됩니다.

## 사전 준비

각 백엔드의 에이전트를 추가하기 전에, 그 백엔드 CLI를 머신에서 한 번 인증해야 합니다. 두 바이너리 모두 coagent에 번들로 포함되지만, 로그인 플로우만큼은 머신당 한 번 직접 실행해야 합니다.

### Claude Code

```bash
# 권장: Claude 계정으로 로그인
claude login

# 또는 API 키 사용 (~/.zshrc / ~/.bashrc 등에 추가해 영구 적용)
export ANTHROPIC_API_KEY="sk-ant-api03-..."
```

`claude` 명령이 PATH에 없다면 먼저 `npm install -g @anthropic-ai/claude-code`로 설치하세요.

### Codex

```bash
codex login
```

`codex` 명령이 PATH에 없다면 먼저 `npm install -g @openai/codex`로 설치하세요.

> coagent는 에이전트 런타임용으로 자체 `claude`/`codex` 바이너리를 번들에 포함합니다. 따라서 글로벌 설치는 (a) 터미널에서 직접 CLI를 쓰고 싶거나, (b) `claude login` / `codex login`을 한 번 돌릴 때만 필요합니다.

> Codex 에이전트는 `--dangerously-bypass-approvals-and-sandbox` 플래그로 실행됩니다. 현재 codex가 MCP 툴 호출을 자동 승인하는 유일한 모드라 — 채팅 왕복에 필수입니다 ([openai/codex#15437](https://github.com/openai/codex/issues/15437)). 작업 자체는 여전히 선택한 프로젝트 디렉토리 안에서만 일어나며, 이 플래그는 Codex 자체의 툴별 승인 프롬프트만 완화합니다.

## 설치

### macOS (Homebrew)

```bash
brew tap JangVincent/tap
brew install --cask coagent-app
```

업데이트할 때는 tap이 최신 포뮬러를 받아오도록 반드시 `brew update`를 먼저 실행하세요:

```bash
brew update && brew upgrade --cask coagent-app
```

> **참고:** Homebrew cask로 설치해도 첫 실행 시 **"coagent이(가) 손상되어 열 수 없습니다"** 경고가 뜹니다. 아래 [macOS 첫 실행](#macos-첫-실행) 섹션의 명령으로 해제하세요.

### macOS (수동 설치)

[Releases](https://github.com/JangVincent/coagent-app/releases)에서 최신 `.dmg` 파일을 다운로드하고 Applications로 드래그하세요.

> **참고:** Apple Silicon (arm64) 전용. Intel Mac은 지원하지 않습니다.

### macOS 첫 실행

앱이 공증(notarize)되어 있지 않아 macOS가 첫 실행 시 격리하고 **"coagent이(가) 손상되어 열 수 없습니다"** 경고를 표시합니다. Homebrew cask, 수동 `.dmg` 설치 모두 동일하게 발생합니다. 설치/업데이트 후 한 번씩 격리 속성을 제거하세요:

```bash
sudo xattr -dr com.apple.quarantine /Applications/coagent.app
```

업데이트 후에도 매번 다시 실행해야 합니다.

### Windows

[Releases](https://github.com/JangVincent/coagent-app/releases)에서 최신 `.exe` 설치 파일을 다운로드하세요.

자동 업데이트가 활성화되어 있어 매시간 업데이트를 확인하고 자동으로 설치합니다.

### Linux

**Debian/Ubuntu:**
```bash
# Releases에서 .deb 파일을 다운로드한 후:
sudo dpkg -i coagent_*.deb
```

**기타 배포판 (AppImage):**
```bash
# Releases에서 .AppImage 파일을 다운로드한 후:
chmod +x coagent-*.AppImage
./coagent-*.AppImage
```

Linux에서도 자동 업데이트가 활성화되어 있습니다.

## 백엔드 비교

| | Claude Code | Codex |
|---|---|---|
| 프로젝트 메모리 | `CLAUDE.md` | `AGENTS.md` |
| Skills | `.claude/skills/` | `.agents/skills/` |
| Subagents | `~/.claude/agents/`, `.claude/agents/` | `~/.codex/agents/`, `.codex/agents/` (프로젝트 trust 필요) |
| Hooks / 설정 | `~/.claude`, `.claude/settings*.json` 자동 로드 | `~/.codex/config.toml` 자동 로드. 프로젝트 `.codex/`는 trust 필요 |
| `/status` | 지원 | 지원 |
| `/usage` | 지원 | codex CLI 미노출 |
| `/compact` | 지원 (수동) | codex CLI 미노출 (`model_auto_compact_token_limit`로 자동만) |
| `/clear` 세션 | 지원 | 지원 |
| `/effort` | Low / Medium / High / XHigh / Max | Low / Medium / High / XHigh |
| `/mode` | Default / Accept edits / Auto / Plan | 고정 (bypass — MCP 위해 필수, 사전 준비 참조) |
| `/model` | Haiku 4.5 / Sonnet 4.6 / Opus 4.7 | gpt-5 / gpt-5-codex (API 키 전용) |
| 과거 세션 picker로 resume | 지원 | 미지원 (새 에이전트는 항상 fresh, 살아있는 에이전트 안에서의 resume은 동작) |

처음 어떤 프로젝트에 Codex 에이전트를 추가할 때, coagent가 `[projects."<path>"] trust_level = "trusted"` 항목을 `~/.codex/config.toml`에 추가할지 묻습니다. 거절해도 에이전트는 정상 동작하며, 다만 프로젝트 스코프 `.codex/` 오버라이드만 안 적용됩니다.

## 프로젝트 커스터마이즈

두 백엔드 모두 에이전트가 해당 디렉토리에서 시작되는 즉시 프로젝트별 컨벤션을 자동으로 픽업합니다. 에이전트가 특정 레포 룰을 따르길 원한다면:

- **Claude:** 레포 루트에 `CLAUDE.md` 두기 (프로젝트 어디든 OK — Claude가 부모를 walk-up 합니다). Skills는 `.claude/skills/`, sub-agents는 `.claude/agents/`, 커스텀 슬래시 커맨드는 `.claude/commands/`. 설정은 `.claude/settings.json` (커밋용) 또는 `.claude/settings.local.json` (clone별).
- **Codex:** 레포 루트에 `AGENTS.md`. Skills는 `.agents/skills/`. 프로젝트 `.codex/config.toml` (MCP 서버, hooks 등)과 `.codex/agents/`는 위에 설명한 trust 동의 후 로드됩니다.

## 개발

```bash
npm install                # 의존성 설치
npm run dev                # 개발 모드 실행
npm run build              # 프로덕션 빌드
npm run make               # 앱 패키징

# 에이전트 런타임 smoke 테스트
npm run smoke:mcp          # HTTP MCP 브리지
```

## 자동 업데이트

| 플랫폼 | 자동 업데이트 | 방식 |
|--------|---------------|------|
| Windows | 예 | Squirrel + update.electronjs.org |
| Linux | 예 | update.electronjs.org |
| macOS | 아니오 | `brew update && brew upgrade --cask coagent-app` |

macOS 자동 업데이트는 코드 서명이 필요하지만 현재 설정되어 있지 않습니다. Homebrew를 통해 업데이트하세요.

## 라이선스

MIT
