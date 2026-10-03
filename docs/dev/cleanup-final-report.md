# 문서 정리 최종 검증 보고서

독립 검증 결과 (2026-09-24), 재검증 갱신 (2026-10-03). 요청된 범위에서만 검사했으며 문서 본문 링크 정정 외 내용은 수정하지 않았다.

| 검사                                   | 결과          | 증거                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| README 길이                            | PASS          | `wc -l`: README.md 235줄(≤350), README.ko.md 229줄(≤400).                                                                                                                                                                                                                                                                   |
| 영문·한국어 README 링크                | PASS          | `bash docs/marketing/check-readme-links.sh` → 39개 상대 링크 확인 OK. `bash docs/marketing/check-readme-links-ko.sh` → 39개 상대 링크 확인 OK; 비ASCII 앵커 3개는 체커 정책상 SKIP.                                                                                                                                         |
| 이동된 내부 문서의 이전 경로 참조 제거 | PASS (재검증) | 저장소 전체 tracked Markdown의 markdown 링크 구문을 `docs/dev/` 새 경로로 정정하고, 이동된 문서(`docs/dev/plans`, `docs/dev/research` 등) 내부 상호 참조의 상대 경로 깊이도 보정했다. `bash docs/dev/check-doc-links.sh`로 docs 이하 전체 tracked md 818개 링크를 전수 검증 → broken 0건. 이동 전 경로(`docs/research       | plans | prs | internal | superpowers/`)를 가리키는 링크 구문은 무잔류다. |
| Quickstart와 사용법 감사               | PASS (표본)   | `docs/dev/usage-audit.md`는 PASS, MISMATCH 0건을 보고한다. README 두 언어의 표본에서 `init ... --setup`, `init ... --host bun --setup`, `codegen/dev --config rustra.json`, `generate --config rustra.json --check`가 감사 결과와 모순되지 않음을 확인. 감사 파일은 요약만 제공하므로 주장별 감사표와의 독립 대조는 제한됨. |
| untracked 파일 이동 여부               | PASS          | `git ls-files --others --exclude-standard docs/research docs/plans docs/prs docs/internal docs/superpowers`에서 untracked 원본 6개가 기존 경로에 남아 있음을 확인. `git status --short`에서도 이 파일들은 `?? docs/research/`, `?? docs/plans/` 아래로 표시되며 이동된 tracked 문서의 `R` 항목과 구별됨.                    |

## 요약 및 의도적으로 남긴 예외

README 줄 수와 두 README 링크 체커, quickstart 표본, untracked 원본 보존, 그리고 docs 전체 링크 전수 검증까지 모두 통과했다. 문서 정리 목표는 완료 상태다.

`docs/dev/check-doc-links.sh` 검증에서 의도적으로 제외한 대상은 다음과 같다.

- untracked 대상 20건: `docs/research/2026-09-24-*` 등 untracked 원본 6개로의 링크는 파일이 기존 경로에 존재하므로 정상이며, untracked 원본은 이동·수정하지 않는 정책에 따라 검증 예외로 둔다.
- 저장소 밖 절대 경로 6건: `/tmp/...` 등 과거 임시 산출물 경로는 저장소 밖이라 검증 대상에서 제외한다.
- 앵커 전용 링크(`#section`)와 외부 링크(http/https/mailto), 코드 펜스·인라인 코드 내부의 링크 구문은 검증 대상이 아니다.
