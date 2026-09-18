# crewmux

ตัวครอบบางๆ ที่เปิด **Claude Code, Codex และ agent CLI อื่นๆ ด้วยหน้าจอเดิมของแต่ละเจ้า** ให้อยู่ข้างกันใน tmux
แล้วให้แต่ละตัวส่งข้อความหากันได้ผ่าน **MCP server ตัวเดียวของ harness**

> English: [README.md](../README.md) · **วิธีใช้และตั้งค่าทุกช่อง (รวม bypass): [`usage.md`](usage.md)** · คู่มือให้ AI ตั้งค่าเอง: [`agent-guide.md`](agent-guide.md) · กติกาเขียนโค้ด: [`CLEAN-CODE.md`](../CLEAN-CODE.md)

```text
 agent-myrepo  ≡ 0:harness  ● 1:planner claude  ● 2:coder codex ✉1       ? 1 question(s) · C-b a  14:31
┌ harness ───────────────────┐┌ planner · claude · opus ───────────────────────────────────────────┐
│AGENTS                      ││ Claude Code v2.1.276   (หน้าจอจริงของ Claude ไม่ถูกแตะ)             │
│● planner  claude ◀ here    ││                                                                    │
│● coder    codex            ││ ❯                                                                  │
│○ reviewer claude not start…││                                                                    │
│ASKING YOU (1)              ││                                                                    │
│coder 14:31                 ││                                                                    │
│  merge ได้เลยไหม?            ││                                                                    │
│MESSAGES                    ││                                                                    │
│14:31 planner→coder req ✓   ││                                                                    │
│  implement single-flight…  ││                                                                    │
│M-1..9 agent  C-b m all     ││                                                                    │
│C-b a answer C-b d detach   ││                                                                    │
└────────────────────────────┘└────────────────────────────────────────────────────────────────────┘
  sidebar 32 คอลัมน์ (crewmux panel)       CLI จริงของเจ้านั้น · ข้อความจาก agent อื่นถูก paste เข้ามาที่นี่
```

แต่ละ agent คุยกันผ่าน MCP ของ harness (`send_message`) ส่วน harness เป็นตัว paste ข้อความเข้า pane ของผู้รับ

## 1. harness ทำ และไม่ทำ อะไร

| ทำ | ไม่ทำ |
|---|---|
| เปิด CLI จริงของแต่ละเจ้าใน tmux window แยกกัน | ไม่มี UI หรือ chat ของตัวเอง ไม่แปลงหรือวาดหน้าจอใหม่ |
| ฉีด MCP server `harness` เข้าไปผ่าน flag ของแต่ละเจ้า | ไม่แก้ `~/.claude*` หรือ `~/.codex/config.toml` |
| paste ข้อความที่ agent ส่งหากันเข้า window ของผู้รับ | ไม่ตัดสินใจเรื่อง approval ของ shell และการแก้ไฟล์ ปล่อยให้ Claude/Codex ถามเองตามปกติ (มีข้อยกเว้นเดียวคือ tool ของ harness ซึ่งอนุญาตไว้ล่วงหน้า) |
| บันทึก event ทุกอย่างลง SQLite | ไม่เก็บบทสนทนา เพราะแต่ละเจ้าเก็บเองอยู่แล้ว |

## 2. ใช้งาน (ฉบับย่อ ดูเต็มๆ ได้ที่ [docs/usage.md](usage.md))

```bash
# ติดตั้งครั้งเดียว
git clone https://github.com/wasuza12345/crewmux && cd crewmux && pnpm install && pnpm build && npm link

# ใช้กับโปรเจกต์ไหนก็ได้
cd ~/projects/<your-repo>
crewmux                               # สร้าง .crewmux/ ถ้ายังไม่มี → เปิด planner (claude) + coder (codex) → attach
crewmux up planner coder reviewer     # เลือก role เอง
crewmux open tester / close tester    # เพิ่ม/ลด agent ระหว่างรัน (Ctrl-b n / Ctrl-b X)
crewmux down                          # ปิดทั้งหมด
```

- `Alt-1..9` สลับ agent · `Ctrl-b m` หน้าต่างลอยดูข้อความทั้งหมด · `Ctrl-b a` กระโดดไปหา agent ที่ถามคุณ (ตอบในจอของมันเอง) · `Ctrl-b d` ออกโดยให้ agent ทำงานต่อ แล้วกลับเข้าไปด้วย `crewmux up`
- แต่ละโปรเจกต์รัน **tmux server ของตัวเอง** (`tmux -L crewmux-<project>`) ปุ่มลัดและการตั้งค่าจึงไม่ไปแตะ tmux ที่คุณใช้อยู่ ถ้าอยากดู session เองใช้ `tmux -L crewmux-<project> ls`
- ใส่ `CREWMUX_DEBUG=1 crewmux up` ถ้าอยากให้ window harness แสดง MCP call ทุกครั้ง
- ครั้งแรกที่เปิดในโฟลเดอร์ใหม่ Codex จะถามว่า trust โฟลเดอร์นี้ไหม และบางครั้งจะชวนอัปเดต ให้ตอบในหน้าจอของ Codex ตามปกติ MCP จะต่อเข้ามาหลังจากตอบคำถามเหล่านี้แล้ว
- tool ของ harness อนุญาตไว้ล่วงหน้า (Claude: `--allowedTools mcp__harness` · Codex: `default_tools_approval_mode="approve"`) agent จึงส่งข้อความหากันได้โดยไม่ต้องกดยืนยันทุกครั้ง

## 3. Session

| ชั้น | ใครดูแล | รายละเอียด |
|---|---|---|
| Process / หน้าจอ | **tmux** | 1 โปรเจกต์ = tmux server + session `crewmux-<project>`, 1 role = 1 window (sidebar + CLI) · detach แล้ว agent ยังรันต่อ |
| บทสนทนา | **แต่ละเจ้าเอง** | harness แค่จำ id ไว้ แล้ว **resume ให้อัตโนมัติ** ทุกครั้งที่เปิด: Claude `--resume <uuid>` · Codex `codex resume <id>` · ใช้ `--fresh` ถ้าอยากเริ่มใหม่ |
| ตัวตนบน MCP | **harness** | 1 session = 1 token ถ้า window ปิด token จะถูกยกเลิกภายใน ~2 วินาที |

## 4. Agent คุยกันผ่าน MCP

| Tool | ใช้ทำอะไร |
|---|---|
| `list_agents` | ตัวเองเป็น role อะไร และตอนนี้มี role ไหนรันอยู่บ้าง |
| `send_message(to, type, content, artifacts?, replyTo?)` | ส่งหา role อื่น หรือหา `user` |
| `submit_review(to, verdict, notes)` | ส่งผลรีวิว `approve` / `request_changes` / `reject` |
| `report_artifact(kind, path)` | แชร์ไฟล์ harness จะ copy ไปไว้ที่ `state/artifacts/` แล้วคืน id ให้แนบไปกับข้อความ |
| `ask_user(question)` | ถามคน คำถามจะไปแสดงใน window harness |
| `guide(topic)` | ค้นคู่มือ crewmux (usage + agent-guide) ให้ agent ตอบและพาผู้ใช้ตั้งค่าทีละขั้น |

ข้อความที่ถูก paste เข้าไปในหน้าจอของผู้รับมีหน้าตาแบบนี้

```text
[harness] message msg_… from "planner" · type=request
please implement single-flight refresh
attachments:
- art_… (analysis): /…/.crewmux/state/artifacts/r_…/planner/analysis-art_….md
(reply with send_message to="planner" replyTo="msg_…")
```

**ความปลอดภัย**
- ตัวตน (`from`) มาจาก token เท่านั้น agent จึงปลอมตัวเป็น agent อื่นไม่ได้
- server ฟังแค่ `127.0.0.1`
- token ส่งผ่าน env ของ window เท่านั้น ไม่อยู่ใน argv และไม่ถูกเขียนลงไฟล์
  - Claude ใช้ `${HARNESS_MCP_TOKEN}` ใน `--mcp-config`
  - Codex ใช้ `bearer_token_env_var`
- `report_artifact` อ่านได้เฉพาะไฟล์ใน cwd ของ agent นั้นเอง โดยเช็คทั้ง `..` และ symlink และต้องผ่าน `policy.yaml → paths.deny`

## 5. `.crewmux/` (ต่อโปรเจกต์)

```text
.crewmux/
├── config.yaml     ← commit · project, baseBranch, isolation (shared|worktree), delivery.pasteDelayMs
├── roles.yaml      ← commit · role → agent (+model, prompt, rules, autostart)
├── policy.yaml     ← commit · paths.deny (ไฟล์ที่ห้าม report_artifact)
├── agents/         ← commit · 1 ไฟล์ = 1 vendor CLI · kind: claude | codex | custom
├── prompts/        ← commit · บอกหน้าที่ของแต่ละ role (planner, coder, reviewer, clean-code)
├── rules/          ← commit · กติกาที่ role ดึงไปใช้ผ่าน `rules:` (clean-code.md)
└── state/          ← ไม่ commit · harness.db, artifacts/, worktrees/
```

`roles.yaml`
```yaml
roles:
  planner:    { agent: claude, prompt: planner.md }
  coder:      { agent: codex,  prompt: coder.md }
  reviewer:   { agent: claude, prompt: reviewer.md, autostart: false }
  clean-code:
    agent: claude             # คนละค่ายกับ coder โดยตั้งใจ
    prompt: clean-code.md
    autostart: false
    rules: [rules/clean-code.md, ../CLEAN-CODE.md]   # อ่านจากที่อยู่จริงของไฟล์ ไม่ copy มาไว้ในนี้
```

**system prompt ที่แต่ละ agent ได้รับ** ประกอบจาก 3 ส่วนตามลำดับ
1. preamble ของ harness บอกว่าตัวเองเป็น role อะไรและใช้ tools อย่างไร
2. `prompts/<role>.md`
3. ไฟล์ใน `rules:` ทีละไฟล์

ส่งเข้าไปด้วย `--append-system-prompt` สำหรับ Claude, `-c developer_instructions` สำหรับ Codex และ env `HARNESS_SYSTEM_PROMPT` สำหรับ custom

**เพิ่มเจ้าอื่น** (gemini, opencode, aider…) ใช้ `kind: custom` agent จะได้ env `HARNESS_MCP_URL`, `HARNESS_MCP_TOKEN`, `HARNESS_ROLE`, `HARNESS_SESSION_ID`, `HARNESS_SYSTEM_PROMPT` แล้วใช้ `command`/`args` ต่อค่าเหล่านี้เข้ากับ CLI นั้นเอง

## 6. โครงสร้างโค้ด (`src/`)

```text
src/
├── protocol/     สัญญากลาง (zod): AgentSessionInfo, AgentEnvelope, ArtifactRef, HarnessEvent, newId
├── config/       อ่านและ validate .crewmux/*.yaml · buildRolePrompt (prompt + rules)
├── core/         EventBus · SessionRegistry (เจ้าของสถานะ session) · PathPolicy   ← pure ไม่มี IO
├── agents/       launcher ของแต่ละเจ้า: ได้คำสั่งเปิด CLI จริง + env (pure ทดสอบด้วยการเทียบ argv)
│   └── launchers/  claude.ts · codex.ts · custom.ts
├── bridge/       MCP server (Streamable HTTP, stateless) + logic ของ 5 tools
├── terminal/     tmux.ts: window/pane/option/paste · chrome.ts: แถบบน + ปุ่มลัด (pure)
├── ui/           panel.ts: sidebar/popup จาก event (pure) · panel-runner.ts: อ่าน SQLite แบบ read-only แล้ววาดใหม่
├── workspace/    git worktree (ถ้าตั้ง isolation: worktree) · เขียน artifact
├── persistence/  SQLite event log (.crewmux/state/harness.db)
├── runtime/      Harness: ประกอบทุกชั้นเข้าด้วยกัน · launch · ส่งข้อความเข้า window · เก็บ window ที่ปิดไปแล้ว
└── cli.ts        init | doctor | up | down | serve | panel
```

ทิศทาง import ถูกบังคับด้วย `test/architecture.test.ts` (รายละเอียดดู `CLEAN-CODE.md` §1)

## 7. สถานะ (M0 + M1 layout A)

| ส่วน | proof |
|---|---|
| protocol, config, core, launchers, bridge, runtime, cli | 🟡 `pnpm typecheck` (รวม test) + `pnpm build` exit 0 |
| MCP bridge: 5 tools, token, path/symlink/policy | 🟢 vitest 8 tests ยิงผ่าน MCP client จริงบน HTTP |
| launchers claude/codex/custom (argv, token ไม่อยู่ใน argv) | 🟢 vitest 5 tests |
| e2e tmux: เปิด 2 role → ส่งข้อความผ่าน MCP → paste เข้า window → agent ที่ปิดไปแล้วถูกตัดออก → เขียนลง SQLite | 🟢 vitest 5 tests บน tmux จริง |
| template + prompt + rules, architecture | 🟢 vitest 7 tests |
| **Claude Code 2.1.276 และ Codex 0.154.0 ตัวจริง** ต่อ MCP ของ harness ได้ (initialize + tools/list) | 🟢 smoke ด้วย `crewmux up` โดยไม่ได้พิมพ์ prompt จึงไม่เสีย token |
| **Codex ตัวจริง ส่งไปกลับ 2 รอบ:** planner (ตัวปลอม) → paste เข้า Codex → Codex เรียก `send_message(to:"planner", replyTo)` → คำตอบ "pong 42" / "pong 2" ถูก paste กลับไปหา planner ใช้เวลา ~9 วินาทีต่อรอบ | 🟢 ทดสอบ 2026-09-18 |
| Claude ตัวจริงส่งข้อความหาคนอื่น | ⚪ ยังไม่ได้ลอง (ส่วนการต่อ MCP ผ่านแล้ว) |
| **Layout A:** sidebar ในทุก window ของ agent, แถบบนแสดง ● ✉ ?, ปุ่มลัด, ข้อความเข้า pane ของ agent (ไม่เข้า sidebar), sidebar คงที่ 32 คอลัมน์เมื่อ resize, badge ✉ หายเมื่อเข้าไปดู | 🟢 e2e บน tmux server แยก + smoke กับ Claude/Codex ตัวจริง (ไม่ได้พิมพ์ prompt) |
| `Ctrl-b m` (popup) และ `Ctrl-b a` (กระโดดไปหาคนถาม) | 🟡 test แค่ว่า tmux รับคำสั่งผูกปุ่ม ยังไม่ได้กดปุ่มจริง |
| **เพิ่ม/ลด agent ระหว่างรัน:** open role ที่เพิ่งเพิ่มใน roles.yaml, close, status, คำสั่งของปุ่ม `Ctrl-b n` ถูก tmux จริงรันแล้วเปิด role ได้, เลขแท็บไม่เว้นช่อง | 🟢 e2e + smoke ด้วย `crewmux` ที่ติดตั้งจริง |
| **Resume:** Claude และ Codex ตัวจริงจำคำไว้ → `down` → เปิดใหม่ → ตอบคำเดิมถูก (PINEAPPLE / MANGO) | 🟢 ทดสอบ 2026-09-18 |

รวม `pnpm test` ผ่าน 47/47

**ข้อจำกัดที่รู้แล้ว**
- ถ้าผู้รับกำลังทำงานอยู่ ข้อความที่ paste เข้าไปจะถูก CLI นั้นจัดการตามวิธีของมันเอง (Claude จะเข้าคิว ส่วน Codex ยังไม่ได้ทดสอบ)
- ถ้า `serve` รีสตาร์ท จะออก token ใหม่ agent ที่เปิดค้างไว้จะต่อ MCP ไม่ได้จนกว่าจะเปิด role นั้นใหม่

## 8. ถัดไป

- **M1 (ที่เหลือ):**
  - ลองให้ Claude กับ Codex คุยกันจริง (มีค่าใช้จ่าย token จึงต้องขอ OK ก่อน)
- **M2:** รวม diff จาก worktree กลับเข้า base branch และทำ `crewmux send <role> <text>` จาก shell
