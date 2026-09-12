OpenClaw와 연결되는 간단하고 친근한 desktop pet 앱을 만들어줘.

목표는 Codex Pet과 비슷한 느낌의 OpenClaw용 companion이다.

macOS와 Windows에서 사용할 수 있어야 하며, 설치 후 복잡한 설정 없이 바로 실행할 수 있는 plug-and-play 경험을 목표로 한다.

기존에 활용할 수 있는 오픈소스 프로젝트나 OpenClaw integration이 있다면 적극적으로 조사하고 재사용해도 좋다. 처음부터 모든 것을 다시 만들 필요는 없다.

구체적인 기술 스택과 내부 architecture는 현재 환경과 유지보수성, 성능을 고려해서 네가 적절하게 판단해라.

다만 지나치게 무거운 앱은 피하고, 항상 켜두어도 부담되지 않을 정도로 reasonable하게 가볍게 만들어라.

## 기본 경험

앱을 켜면 화면 위에 작은 캐릭터가 나타난다.

캐릭터는:

- 원하는 위치로 드래그 가능
- 크기 조절 가능
- 사용자가 원하는 이미지/애니메이션으로 변경 가능
- OpenClaw 상태에 따라 모습이 바뀜
- 사용자의 mouse interaction에도 즉각 반응

해야 한다.

전체적으로 복잡한 application이라기보다 작은 desktop companion처럼 느껴져야 한다.

## OpenClaw 연결

OpenClaw와 쉽게 연결되고 끊을 수 있어야 한다.

사용자 경험은 가능한 한 단순하게 만들어라.

예를 들면 Settings 또는 작은 메뉴에서:

OpenClaw
[ ON / OFF ]

처럼 토글 하나로 connection을 켜고 끌 수 있는 정도가 좋다.

가능하면 설치 후 OpenClaw 환경을 자동으로 발견하고 연결해서 별도의 복잡한 configuration이 필요하지 않게 해라.

정상 연결되면 사용자가 내부 port, session ID, config file 등을 직접 다룰 필요가 없도록 한다.

연결이 안 될 경우에도 기술적인 오류 메시지 대신 사용자가 해결할 수 있는 간단한 안내를 제공한다.

## Quick Chat

캐릭터에 마우스를 올리면 캐릭터 아래에 아주 작은 채팅 입력창이 나타나게 한다.

예:

        [ PET ]

   [ Ask OpenClaw... ]

입력창은 현재 사용자가 사용하던 가장 최근 OpenClaw session에 자연스럽게 이어져야 한다.

사용자가 메시지를 입력하고 Enter를 누르면 그때 OpenClaw에게 메시지를 보낸다.

Quick Chat은 전체 chat application이 될 필요가 없다.

기본적으로 한 줄짜리 빠른 입력창이면 충분하다.

필요하다면 아주 짧은 최신 응답이나 상태 정도만 보여줘도 되지만 UI를 복잡하게 만들지는 말아라.

## Zero unnecessary token usage

중요한 원칙이다.

다음 행동은 OpenClaw의 LLM token을 사용하면 안 된다.

- 캐릭터 hover
- drag
- click
- character animation
- asset 변경
- size 변경
- settings 조작
- 캐릭터 반응
- 감정/상태 표시

이런 UI interaction은 모두 로컬에서 처리한다.

사용자가 Quick Chat에 실제 메시지를 입력해서 전송했을 때만 정상적인 OpenClaw agent turn이 발생한다.

캐릭터의 표정이나 상태를 결정하기 위해 OpenClaw에게 별도의 prompt를 보내지 않는다.

예를 들어:

"방금 답변의 감정을 판단해줘"

같은 추가 LLM 요청은 만들지 않는다.

가능하면 이미 존재하는 OpenClaw lifecycle/event 정보와 마지막 응답을 로컬에서 가볍게 분석해서 사용한다.

## Character reactions

OpenClaw가 어떤 상태인지에 따라 캐릭터 asset이 바뀌게 한다.

예:

idle
thinking
working
happy
error
question

정도의 기본 상태가 있으면 좋다.

상태를 너무 많이 만들 필요는 없다.

실제로 UX에 도움이 되는 정도로 네가 적절하게 정리해도 된다.

마지막 OpenClaw 답변의 내용이나 결과를 바탕으로 간단한 reaction을 보여주는 것도 구현한다.

예:

성공적인 작업 완료
→ happy

오류
→ error

사용자에게 질문
→ question

일반적인 응답
→ idle 또는 neutral

이 분류 때문에 추가 LLM 호출을 하지 않는다.

간단한 local heuristic 또는 이미 존재하는 metadata/event를 활용한다.

## Mouse interaction

캐릭터 자체도 살아있는 느낌이 나게 한다.

예:

마우스를 올리면
→ hover 모습

누르면
→ pressed 모습

드래그하면
→ dragging 모습

놓으면
→ 짧은 drop reaction

가능하다면 움직이는 방향에 따라 다른 asset을 지원해도 좋다.

하지만 이것은 선택 사항이다.

모든 캐릭터가 수많은 asset을 가지고 있어야 할 필요는 없다.

idle 이미지 하나만 있어도 정상적으로 사용할 수 있게 만들어라.

## Character / Asset Management

이 부분은 사용자 친화적인 GUI로 만들어라.

사용자가 직접 폴더 구조나 JSON 파일을 수정해야만 사용할 수 있는 방식은 피한다.

Settings에서 쉽게:

- 새로운 캐릭터 추가
- 캐릭터 삭제
- 캐릭터 변경
- 캐릭터 이름 변경
- 각 상태별 이미지 변경
- asset preview
- 캐릭터 크기 조절

을 할 수 있게 한다.

예:

Character

[ Momo ▼ ]

[ Add Character ]
[ Edit Assets ]
[ Delete ]

Size
[ ─────●──── ]

Asset 관리 화면에서는:

Idle       [ Preview ] [ Change ]
Hover      [ Preview ] [ Change ]
Thinking   [ Preview ] [ Change ]
Working    [ Preview ] [ Change ]
Happy      [ Preview ] [ Change ]
Error      [ Preview ] [ Change ]

정도처럼 직관적으로 사용할 수 있으면 좋다.

실제 UI 디자인은 네가 더 좋은 UX가 있다고 판단하면 자유롭게 개선해도 된다.

PNG, WebP, GIF 등 일반적인 이미지 형식을 편하게 사용할 수 있게 해라.

가능하다면 사용자가 이미지 파일을 drag & drop해서 asset을 설정할 수도 있게 한다.

## Character import

캐릭터를 추가하는 과정도 간단해야 한다.

예를 들어:

Add Character
→ 이름 입력
→ 이미지 선택
→ 완료

정도의 flow가 이상적이다.

고급 사용자를 위해 character pack import/export 기능을 제공해도 좋다.

하지만 처음 사용하는 사람이 character pack specification을 이해해야만 쓸 수 있게 만들지는 않는다.

## Settings

Settings는 복잡하지 않게 구성한다.

주요 설정은 대략:

General
- OpenClaw ON/OFF
- Launch at login
- Always on top

Character
- Character 선택
- Add / Remove Character
- Asset 관리
- Size

Behavior
- Reaction ON/OFF
- Hover Chat ON/OFF

정도면 충분하다.

필요하다고 판단되는 옵션은 추가해도 좋지만 너무 많은 설정으로 사용자를 압도하지 않는다.

## Plug-and-play

이 프로젝트에서 매우 중요하다.

최종 사용자는 개발자가 아닐 수 있다.

가능하면:

1. 설치
2. 실행
3. OpenClaw 자동 감지
4. 캐릭터 표시
5. 바로 사용

의 흐름으로 동작하게 한다.

개발자가 CLI 명령을 여러 번 실행하거나 config file을 직접 편집해야 하는 설치 과정은 피한다.

필요한 OpenClaw integration/plugin이 있다면 앱이 설치 또는 설정 과정을 최대한 도와주도록 한다.

사용자가 OpenClaw integration을 끄고 싶으면 toggle 하나로 비활성화할 수 있어야 한다.

## Performance

극단적인 optimization이 목표는 아니다.

대신 desktop pet 특성상 항상 실행해 두는 앱이므로 합리적으로 가벼워야 한다.

불필요한:

- continuous polling
- 높은 CPU 사용
- 과도한 background process
- 모든 캐릭터 asset preload
- 불필요한 network request

등은 피한다.

idle 상태에서는 시스템에 큰 부담을 주지 않는 수준이면 된다.

기술 스택은 이 목표와 macOS/Windows 개발 편의성을 종합해서 네가 선택해라.

## Privacy

캐릭터 기능 때문에 대화 내용을 외부 서비스로 전송하지 않는다.

analytics나 external sentiment API는 필요 없다.

OpenClaw와의 communication 외에는 가능한 한 local-first로 동작하게 한다.

## Design freedom

위 요구사항을 문자 그대로 구현하는 것보다 전체 사용자 경험을 더 중요하게 생각해라.

더 간단하거나 더 자연스러운 UX가 있다면 변경해도 좋다.

기존 OpenClaw architecture나 사용할 수 있는 프로젝트를 조사한 후 가장 유지보수하기 좋은 방법을 선택해라.

불필요하게 복잡한 architecture는 만들지 않는다.

목표는:

"A small character on my desktop that feels connected to OpenClaw."

이다.

## 완료 기준

최종적으로 다음 경험이 가능하면 된다.

- macOS와 Windows에서 실행
- 설치 후 쉽게 OpenClaw 연결
- OpenClaw 연결 ON/OFF를 간단히 변경
- 캐릭터를 화면에서 자유롭게 이동
- 캐릭터 크기 변경
- hover / drag 등에 캐릭터가 반응
- OpenClaw가 작업할 때 캐릭터 상태 변경
- 마지막 답변 결과에 따라 간단한 reaction
- 캐릭터 hover 시 작은 Quick Chat
- Quick Chat이 최근 OpenClaw session에 이어짐
- 실제 메시지를 보낼 때만 OpenClaw token 사용
- GUI에서 캐릭터 추가/삭제/변경
- GUI에서 상태별 asset 변경 및 preview
- 별도의 복잡한 설정 없이 일반 사용자가 사용할 수 있음

먼저 현재 사용할 수 있는 OpenClaw integration과 기존 desktop pet 프로젝트를 조사해라.

이미 잘 구현된 부분은 재사용해라.

그 후 가장 적합한 architecture를 선택하고 실제 구현을 진행해라.

내 요구사항에 없는 세부 기술 결정은 스스로 판단해서 진행해도 된다.