# คู่มือใช้งานและตั้งค่า crewmux

- ภาพรวมและสถาปัตยกรรมอยู่ที่ [README.th.md](README.th.md)
- ไฟล์นี้อธิบาย **วิธีใช้** และ **ทุกช่องใน `.crewmux/`**

---

## 1. ติดตั้ง (ทำครั้งเดียว)

ต้องมี Node ≥ 22, tmux ≥ 3.0 และ CLI ของเจ้าที่จะใช้ (`claude`, `codex` หรืออื่นๆ) ที่ login ไว้แล้ว

```bash
git clone https://github.com/wasuza12345/crewmux && cd crewmux
pnpm install && pnpm build
npm link                 # สร้างคำสั่ง global: ~/.local/bin/crewmux → repo นี้
crewmux help
```

- ตรวจว่าติดตั้งสำเร็จ: `crewmux help` ต้องแสดงรายการคำสั่ง
- เพราะเป็น symlink มาที่ repo แก้โค้ดแล้วแค่ `pnpm build` คำสั่ง global ก็ได้โค้ดใหม่ทันที
- ถอนการติดตั้ง: `npm unlink -g crewmux`

---

## 2. เริ่มใช้กับโปรเจกต์

```bash
cd ~/projects/<your-repo>
crewmux
```

คำสั่งเดียวนี้ทำให้ทั้งหมด:
1. ถ้ายังไม่มี `.crewmux/` จะสร้างจาก template (ชื่อ project = ชื่อโฟลเดอร์) แล้วรัน `doctor`
2. เปิด role ที่ตั้ง `autostart: true` ไว้ (ค่าเริ่มต้นคือ planner = Claude และ coder = Codex) พร้อม sidebar
3. พาเข้า tmux ถ้าเปิดอยู่แล้วจะแค่ attach กลับเข้าไป

แนะนำ (ไม่บังคับ):
- ถ้าโปรเจกต์ยังไม่เป็น git repo ให้ `git init` แล้ว commit ไว้ก่อน จะได้ `git diff` ดูว่า agent แก้อะไรไป
- ถ้าไม่อยากให้ `.crewmux/` เข้า git ของทีม: `echo ".crewmux/" >> .git/info/exclude`

### คำสั่งทั้งหมด

| คำสั่ง | ทำอะไร |
|---|---|
| `crewmux init [--force]` | สร้าง `.crewmux/` อย่างเดียวโดยไม่เปิด agent ถ้ามีอยู่แล้วจะไม่ทับ ต้องใส่ `--force` ถ้าอยากทับไฟล์ template |
| `crewmux doctor` | เช็คว่า config ถูกต้อง มี tmux และมี binary ของทุก agent ที่ role ใช้ |
| `crewmux` | สร้าง `.crewmux/` ถ้ายังไม่มี แล้ว `up` (ใช้คำสั่งนี้เป็นหลัก) |
| `crewmux up` | เปิดทุก role ที่ `autostart: true` ถ้า session เปิดอยู่แล้วจะแค่ attach เข้าไป |
| `crewmux up planner coder reviewer` | เปิดเฉพาะ role ที่ระบุ (ใช้ได้เฉพาะตอนที่ session ยังไม่ได้เปิด) |
| `crewmux up --no-attach` | เปิดทิ้งไว้เบื้องหลังโดยไม่พาเข้า tmux |
| `crewmux up --fresh` | เปิดทุก role ด้วยบทสนทนาใหม่ ไม่ resume ของเดิม |
| `crewmux down` | ปิดทั้ง session รวมทุก agent และยกเลิก token ทั้งหมด |
| `crewmux open <role>` / `close <role>` / `status` | เพิ่ม / เอาออก / ดู agent ระหว่างรัน (ดูหัวข้อ "เพิ่ม agent / role") |
| `CREWMUX_DEBUG=1 crewmux up` | ให้ window harness แสดง MCP call ทุกครั้ง (ใช้ตอนหาปัญหา) |

`agent` หา `.crewmux/` จากโฟลเดอร์ปัจจุบันขึ้นไปทีละชั้นแบบเดียวกับ git จึงสั่งจากโฟลเดอร์ย่อยได้

### หน้าจอ (layout A · Sidebar)

- **แถบบน:** ชื่อโปรเจกต์ + แท็บของแต่ละ role (`●` รันอยู่ · `○` ปิดแล้ว · `✉N` ข้อความที่ยังไม่อ่าน) + `? N question(s)` เมื่อมี agent ถามคุณ
- **ซ้าย 32 คอลัมน์:** sidebar ของ harness มี AGENTS / ASKING YOU / MESSAGES ข้อมูลอ่านจาก event ไม่ได้อ่านจากหน้าจอของ agent
- **ขวา:** CLI จริงของ agent นั้น พิมพ์คุยได้ตามปกติ ข้อความจาก agent อื่นจะถูก paste เข้ามาที่นี่
- **title ของแท็บ terminal** เปลี่ยนเป็น `crewmux · <project> · <agent ที่ดูอยู่>` (ถ้า Windows Terminal ไม่เปลี่ยนตาม ให้ปิด "Suppress title changes" ใน profile ของ Ubuntu)
- window `0:harness` แสดง log เต็มของ harness (บันทึกลง `.crewmux/state/harness.log` ด้วย) หน้านี้ **ไม่รับปุ่มใดๆ** กด `Ctrl-C` ก็ไม่ทำให้อะไรปิด ปิดได้ทางเดียวคือ `crewmux down`
- attach แล้วจะเข้าไปที่ agent ตัวแรกเสมอ ไม่ใช่หน้า log

| ปุ่ม | ผล |
|---|---|
| `Alt-1` … `Alt-9` | ไปที่ agent ลำดับนั้น (ไม่ต้องกด prefix) |
| `Ctrl-b m` | หน้าต่างลอยแสดงข้อความทั้งหมดแบบเต็ม ปิดด้วย `q` หรือ `Esc` |
| `Ctrl-b a` | กระโดดไปหา agent ที่ถามคุณล่าสุด แล้วพิมพ์ตอบในจอของมันได้เลย |
| `Ctrl-b n` (หรือ `Ctrl-b Ctrl-n`) | เพิ่ม agent: ช่อง `open role:` ขึ้นที่ **แถบด้านบน** พิมพ์ชื่อ role แล้ว Enter ผลขึ้นที่แถบด้านบน 4 วินาที |
| `Ctrl-b X` (X ตัวใหญ่ = Shift+x) | เอา agent ของแท็บนี้ออก (ถามยืนยัน `y` ที่แถบด้านบน) · ส่วน `Ctrl-b x` ตัวเล็กเป็นปุ่มเดิมของ tmux (kill-pane) |
| `Ctrl-b z` | ขยาย pane ที่เลือกให้เต็มจอ (ซ่อน sidebar ชั่วคราว) กดซ้ำเพื่อคืน |
| `Ctrl-b d` | ออกมาโดยให้ agent ทำงานต่อ กลับเข้าไปด้วย `crewmux` |
| `q` (เมื่ออยู่ใน sidebar หรือหน้า harness) | ออกเหมือน `Ctrl-b d` ใช้ได้แม้ terminal แย่ง `Ctrl-b` ไป เช่น VS Code (คลิกที่ sidebar ก่อน แล้วกด `q`) |
| คลิกเมาส์ | เลือก pane หรือแท็บได้ (เปิด `mouse on` ไว้) |

**ใช้ใน terminal ของ VS Code:** VS Code ใช้ `Ctrl+B` เปิด/ปิด sidebar ของตัวเอง ปุ่ม `Ctrl-b` จึงไปไม่ถึง tmux แก้โดยเพิ่มบรรทัดนี้ใน User Settings (JSON) แล้วปุ่มลัดทุกตัวจะถูกส่งไปที่ terminal (ย้อนกลับ = ลบบรรทัดนี้ออก)
```json
"terminal.integrated.sendKeybindingsToShell": true
```
ถ้ายังไม่ได้ตั้งค่า ใช้ได้ตามนี้: คลิกแท็บหรือ pane ด้วยเมาส์, `Alt-1..9` และกด `q` ใน sidebar เพื่อออก

**tmux ของคุณไม่ถูกแตะ:** แต่ละโปรเจกต์รัน tmux server แยกของตัวเอง (`tmux -L crewmux-<project>`) ปุ่มลัดข้างบนจึงมีผลแค่ใน server นั้น ถ้าสั่ง `crewmux up` จากในหน้าจอ tmux ของคุณเอง จะเกิด tmux ซ้อนกัน `Alt-` ใช้ได้ตามปกติ แต่ `Ctrl-b` ต้องกด 2 ครั้ง (ครั้งแรกจะถูก tmux ชั้นนอกรับไป)

### สั่งให้ agent คุยกัน

พิมพ์บอก agent ตัวหนึ่งตามปกติ เช่นที่ window ของ planner:

> วิเคราะห์ bug login แล้วส่งงานให้ coder แก้ ให้ reviewer ตรวจต่อ

agent จะเรียก `send_message(to: "coder")` เอง แล้วข้อความจะไปโผล่ใน window ของ coder

---

### Resume: ปิดแล้วเปิดใหม่ คุยต่อจากเดิม

ทุกครั้งที่เปิด แต่ละ role จะ **คุยต่อจากบทสนทนาล่าสุดของตัวเองโดยอัตโนมัติ** `crewmux down` จึงไม่ทำให้อะไรหาย

| vendor | วิธี resume |
|---|---|
| Claude | harness กำหนด `--session-id` ไว้ตั้งแต่ตอนเปิด แล้วครั้งถัดไปเปิดด้วย `--resume <id>` |
| Codex | ตอนปิด harness หา id จาก `~/.codex/sessions` แล้วจดไว้ ครั้งถัดไปเปิดด้วย `codex resume <id>` |
| Grok | กำหนด `--session-id` ไว้ตั้งแต่ตอนเปิด แล้วครั้งถัดไปใช้ `--resume <id>` (ถ้ามี `~/.grok/sessions/<path>/<id>/chat_history.jsonl`) |
| custom | resume ได้เมื่อตั้ง `cli.session` ไว้ (ดูข้อ 5.1) ถ้าไม่ได้ตั้ง จะไม่ resume |

- resume เฉพาะเมื่อยังเป็น vendor เดิม และอยู่ในโฟลเดอร์เดิม ถ้าเปลี่ยน role ไปใช้เจ้าอื่น หรือตั้ง `isolation: worktree` (โฟลเดอร์จะใหม่ทุกครั้ง) จะเริ่มบทสนทนาใหม่
- ถ้าเปิดแล้วไม่เคยพิมพ์อะไร vendor จะยังไม่ได้บันทึกบทสนทนา ครั้งถัดไปจึงเริ่มใหม่
- อยากเริ่มใหม่ทั้งหมด: `crewmux down && crewmux up --fresh`
- MCP ของ harness ถูกฉีดเข้าไปใหม่ทุกครั้งที่เปิด agent จึงส่งข้อความหากันได้ตามปกติหลัง resume

### ถาม AI ได้เลย (tool `guide`)

agent ทุกตัวมี MCP tool ชื่อ `guide` ที่ค้นคู่มือนี้และ `agent-guide.md` ได้ ถามเป็นภาษาปกติในจอ agent ไหนก็ได้ เช่น "จะเพิ่ม grok ยังไง" "ตั้ง bypass ยังไง" "Ctrl-b ไม่ทำงาน" แล้ว agent จะเรียก `guide` แล้วพาทำทีละขั้น หรือทำให้เลยถ้าสั่ง

### ให้ AI ตั้งค่าให้

agent ทุกตัวได้รับ path ของ [`docs/agent-guide.md`](agent-guide.md) ใน system prompt อยู่แล้ว สั่งเป็นภาษาปกติได้เลย เช่น "เพิ่ม role tester ใช้ codex แล้วเปิดให้ด้วย" หรือ "ต่อ Grok CLI เข้ามาเป็น role ใหม่" แล้ว agent จะอ่านคู่มือ แก้ `.crewmux/` รัน `crewmux doctor` และ `open` ให้เอง คู่มือนี้อยู่ที่เดียวใน repo crewmux ทุกโปรเจกต์จึงได้ฉบับล่าสุดเสมอ (role ที่เปิดอยู่ก่อนจะเห็นคู่มือหลังจาก close + open)

### เพิ่ม agent / role

1. **ถ้าจะใช้ vendor ที่มีอยู่แล้ว** (claude หรือ codex) ให้เพิ่มแค่ role ใน `.crewmux/roles.yaml`:
   ```yaml
   roles:
     tester:
       agent: codex          # ใช้ agents/codex.yaml ที่มีอยู่
       prompt: coder.md      # หรือสร้าง prompts/tester.md ของตัวเอง
       autostart: true       # ให้ `crewmux` เปิดตัวนี้ด้วยทุกครั้ง
   ```
2. **ถ้าจะใช้ vendor ใหม่ หรืออยากได้ flag คนละชุด** (เช่น Claude ที่ bypass permission) ให้สร้าง `.crewmux/agents/<id>.yaml` ใหม่ แล้วผูก role เข้ากับ id นั้น (ดูข้อ 3.2 และ 5)
3. เปิดได้ทันทีระหว่างที่รันอยู่ ไม่ต้อง down (harness อ่าน `roles.yaml` ใหม่ทุกครั้งที่ open):

| ต้องการ | คำสั่ง | ใน tmux |
|---|---|---|
| เพิ่ม agent | `crewmux open tester` (`--fresh` = เริ่มบทสนทนาใหม่) | `Ctrl-b n` แล้วพิมพ์ชื่อ role |
| เอา agent ออก | `crewmux close tester` | `Ctrl-b X` ที่แท็บนั้น แล้วกด `y` |
| ดูว่าตัวไหนรันอยู่ | `crewmux status` | ดูจาก sidebar |
| ปิดจากในจอ agent เอง | พิมพ์ `/exit` ใน Claude/Codex | harness เห็นเองภายใน ~2 วินาที |

- ปิดแล้วเปิดใหม่ Claude/Codex จะคุยต่อจากบทสนทนาเดิม
- เลขแท็บเรียงใหม่อัตโนมัติ `Alt-<n>` จึงตรงกับแท็บเสมอ
- คำสั่งเหล่านี้คุยกับ harness ที่รันอยู่ผ่าน `.crewmux/state/control.sock` (สิทธิ์ 600 เฉพาะ user ของคุณ) ถ้า harness ไม่ได้รันอยู่จะขึ้นว่า "harness is not running"

---

## 3. ตั้งค่า `.crewmux/`

```text
.crewmux/
├── config.yaml     ตั้งค่าโปรเจกต์
├── roles.yaml      role → agent
├── policy.yaml     ไฟล์ที่ห้าม agent แชร์
├── agents/*.yaml   1 ไฟล์ = 1 vendor CLI
├── prompts/*.md    หน้าที่ของแต่ละ role
├── rules/*.md      กติกาที่ role ดึงไปใช้
└── state/          (ไม่ commit) harness.db, artifacts/, worktrees/
```

แก้ไฟล์ไหนก็ตาม ต้อง **`crewmux down && crewmux up`** ถึงจะมีผล และควรรัน `crewmux doctor` ก่อนเพื่อเช็คว่าเขียนถูก

### 3.1 `config.yaml`

```yaml
version: 1
project: my-repo          # ชื่อ tmux session = crewmux-<project> · ใช้ได้แค่ A-Z a-z 0-9 _ -
baseBranch: main          # branch ที่ใช้สร้าง worktree
isolation: shared         # shared | worktree
delivery:
  pasteDelayMs: 300       # รอหลัง paste ข้อความก่อนกด Enter (ms)
```

| ช่อง | ค่า default | คำอธิบาย |
|---|---|---|
| `version` | ต้องใส่ `1` | |
| `project` | ต้องใส่ | `crewmux init` ตั้งให้จากชื่อโฟลเดอร์ |
| `baseBranch` | `main` | |
| `isolation` | `shared` | `shared`: ทุก agent ทำงานใน repo เดียวกัน · `worktree`: แต่ละ role ได้ worktree ของตัวเองที่ `.crewmux/state/worktrees/<runId>/<role>` บน branch `agent/<runId>/<role>` |
| `delivery.pasteDelayMs` | `300` | ถ้าข้อความถูก paste แต่ไม่ถูกส่ง (ค้างอยู่ในช่องพิมพ์) ให้เพิ่มค่านี้ |

> โหมด `worktree`: harness ยังไม่ลบ worktree และยังไม่ merge กลับให้เอง (อยู่ในแผน M2) ต้องจัดการเองด้วย `git worktree list` และ `git worktree remove <path>`

### 3.2 `agents/<id>.yaml`

```yaml
id: codex                 # ชื่อที่ roles.yaml อ้างถึง
kind: codex               # claude | codex | grok | custom
model: gpt-5.6-sol        # (ไม่ใส่ก็ได้) model ตั้งต้นของ agent นี้
command: codex            # (ไม่ใส่ก็ได้) path ของ binary · ต้องใส่ถ้า kind: custom
args: []                  # (ไม่ใส่ก็ได้) flag เพิ่มเติม ต่อท้ายสุดจึง override ค่าของ harness ได้
```

**สิ่งที่ harness ใส่ให้เองตาม `kind`** (คุณไม่ต้องใส่ซ้ำ):

| kind | flag ที่ harness ใส่ให้ |
|---|---|
| `claude` | `--mcp-config` (MCP ของ harness), `--allowedTools mcp__harness`, `--append-system-prompt`, `--name <role>`, `--session-id <uuid>`, `--model` |
| `codex` | `-c mcp_servers.harness.url/bearer_token_env_var/default_tools_approval_mode="approve"`, `-c developer_instructions`, `-m` |
| `grok` | `--rules` (prompt ของ role แบบต่อท้าย), `--allow MCPTool(*harness*)`, `--session-id` / `--resume`, `-m` และเขียน block `[mcp_servers.harness]` ลง `.grok/config.toml` ของโปรเจกต์ (มีแค่ `${…}` ไม่มี secret) |
| `custom` | ไม่ใส่ flag ใดๆ แต่ส่ง env `HARNESS_MCP_URL`, `HARNESS_MCP_TOKEN`, `HARNESS_ROLE`, `HARNESS_SESSION_ID`, `HARNESS_SYSTEM_PROMPT` ให้ |

MCP server ของคุณเองที่ตั้งไว้ใน Claude หรือ Codex ยังโหลดตามปกติ harness แค่เพิ่มตัวของมันเข้าไปอีกตัว

### 3.3 `roles.yaml`

```yaml
roles:
  planner:
    agent: claude          # id ใน agents/
    model: opus            # (ไม่ใส่ก็ได้) ใช้แทน model ของ agent
    prompt: planner.md     # (ไม่ใส่ก็ได้) ไฟล์ใน prompts/
    rules: []              # (ไม่ใส่ก็ได้) ไฟล์กติกา path นับจาก .crewmux/
    autostart: true        # (default true) ให้ `crewmux up` เปิด role นี้เองไหม
```

- ชื่อ role ใช้ได้แค่ `a-z 0-9 -` และเป็น **ที่อยู่** ที่ agent อื่นใช้ส่งข้อความหา (`send_message(to: "planner")`)
- ใน 1 ช่วงเวลา แต่ละ role มี session ได้แค่ 1 ตัว แต่หลาย role ใช้ agent ตัวเดียวกันได้ เช่น planner กับ reviewer เป็น claude ทั้งคู่
- `rules` ใช้ชี้ไฟล์ที่อยู่นอก `.crewmux/` ได้ เช่น `../CLEAN-CODE.md` harness อ่านจากที่อยู่จริงของไฟล์ ไม่ได้ copy มาเก็บ
- system prompt ที่ agent ได้รับ = preamble ของ harness + `prompts/<prompt>` + ไฟล์ใน `rules` ตามลำดับ

### 3.4 `policy.yaml`

```yaml
paths:
  deny: ["*.env", "*.env.*", "*.pem", "*.key", "*creds-*", "id_rsa*", "id_ed25519*"]
```

ใช้กันเฉพาะ **`report_artifact`** (ไฟล์ที่ agent ขอให้ harness copy ไปแชร์) โดย pattern เทียบทั้ง path และชื่อไฟล์
ไม่ได้กันสิ่งที่ agent ทำเองใน shell เพราะเรื่องนั้นเป็นหน้าที่ของ permission ในแต่ละเจ้า (ดูข้อ 4)

---

## 4. Permission และ bypass

ค่าเริ่มต้นคือ **Claude และ Codex ถาม approval เองตามปกติ** ยกเว้น tool ของ harness ที่อนุญาตไว้ล่วงหน้า เพื่อให้ agent ส่งข้อความหากันได้โดยไม่ต้องมีคนกดยืนยัน

ถ้าอยากเปลี่ยน ให้ใส่ flag ของแต่ละเจ้าใน `args` (flag ด้านล่างเช็คจาก `--help` ของ Claude Code 2.1.276 และ Codex 0.154.0 แล้ว)

| ต้องการ | Claude (`agents/claude.yaml`) | Codex (`agents/codex.yaml`) |
|---|---|---|
| ถามตามปกติ | ไม่ต้องใส่อะไร | ไม่ต้องใส่อะไร |
| แก้ไฟล์ได้โดยไม่ถาม | `args: ["--permission-mode", "acceptEdits"]` | `args: ["-a", "never", "-s", "workspace-write"]` |
| **bypass ทั้งหมด** | `args: ["--dangerously-skip-permissions"]` | `args: ["--dangerously-bypass-approvals-and-sandbox"]` |

### bypass แค่บาง role

`args` ผูกกับ agent ไม่ได้ผูกกับ role ถ้าต้องการแบบนี้ให้สร้าง agent แยกอีกไฟล์:

```yaml
# .crewmux/agents/codex-yolo.yaml
id: codex-yolo
kind: codex
args: ["--dangerously-bypass-approvals-and-sandbox"]
```
```yaml
# .crewmux/roles.yaml
roles:
  coder:    { agent: codex-yolo, prompt: coder.md }   # bypass
  reviewer: { agent: claude, prompt: reviewer.md }    # ถามตามปกติ
```

### ⚠ ก่อนเปิด bypass

1. **ตั้ง `isolation: worktree`** มิฉะนั้น agent ที่ bypass หลายตัวจะแก้ไฟล์ชุดเดียวกันพร้อมกันโดยไม่มีใครถาม
2. ข้อความจาก agent อื่นคือ input ของ agent ตัวที่ bypass ถ้า agent ตัวไหนอ่านเนื้อหาจากภายนอก (web, issue, ไฟล์ที่ไม่น่าเชื่อถือ) แล้วโดน prompt injection มันส่งคำสั่งต่อไปให้ตัวที่ bypass ทำได้โดยไม่มีใครกดยืนยัน
3. `policy.yaml` **ไม่ได้** กันคำสั่ง shell

---

## 5. เพิ่ม Grok

```yaml
# .crewmux/agents/grok.yaml
id: grok
kind: grok
# args: ["--always-approve"]   # bypass (ถ้าต้องการ)
```
แล้วเพิ่ม role ใน `roles.yaml` → `crewmux open grok` harness จะต่อ MCP, ส่ง prompt และ resume ให้เอง ห้ามใช้ `--system-prompt-override` (เขียนทับคำสั่งพื้นฐานของ Grok)

## 5.1 เพิ่มเจ้าอื่น (`kind: custom`)

**ไม่ต้องแก้โค้ด crewmux** บอกวิธีส่ง prompt, session/resume และ MCP ได้ใน `cli:` ของไฟล์ agent (Grok ก็เป็นแค่ preset ของ `cli:` แบบนี้) ตัวอย่างเต็มและ checklist อยู่ใน `agent-guide.md` ข้อ 4 หรือพิมพ์ถาม agent ว่า "ต่อ <ชื่อ CLI> เข้ามาเป็น role ใหม่" แล้วมันจะเรียก `guide` แล้วทำตาม checklist ให้

```yaml
id: mycli
kind: custom
command: mycli
cli:
  prompt: { flag: "--append-system-prompt" }
  session: { new: ["--session-id", "{id}"], resume: ["--resume", "{id}"] }
  mcp: { args: ["--mcp-url", "{url}"] }
```

ถ้าไม่มี `cli:` เลย จะได้แค่ env ต่อไปนี้:

agent จะได้ env ต่อไปนี้ แล้วใช้ `command`/`args` ต่อค่าเหล่านี้เข้ากับ CLI ของเจ้านั้น

| env | ค่า |
|---|---|
| `HARNESS_MCP_URL` | `http://127.0.0.1:<port>/mcp` (Streamable HTTP) |
| `HARNESS_MCP_TOKEN` | ต้องส่งเป็น header `Authorization: Bearer <token>` |
| `HARNESS_ROLE` / `HARNESS_SESSION_ID` | role และ session ของตัวเอง |
| `HARNESS_SYSTEM_PROMPT` | preamble + prompt + rules |

`args` ถูกส่งไปตามตัวอักษร `$VAR` จึง **ไม่ถูกแทนค่า** ถ้าต้องการใช้ env ใน flag ให้ครอบด้วย `sh -c`:

```yaml
id: my-cli
kind: custom
command: sh
args: ["-c", "my-cli --mcp-url \"$HARNESS_MCP_URL\" --mcp-header \"Authorization: Bearer $HARNESS_MCP_TOKEN\""]
```

CLI นั้นต้องรองรับ MCP แบบ HTTP ที่ส่ง header ได้ ถ้าไม่รองรับ agent จะรันได้ แต่ส่งข้อความหาใครไม่ได้
ตัวอย่างที่ใช้ทดสอบอยู่จริงคือ `test/fixtures/fake-agent.mjs`

---

## 6. แก้ปัญหา

| อาการ | สาเหตุ / วิธีแก้ |
|---|---|
| `crewmux doctor` แสดง ✗ ที่บรรทัด agent | binary ไม่อยู่ใน PATH ให้ใส่ `command: /full/path` ในไฟล์ agent |
| window ของ Codex ค้างอยู่ที่คำถาม trust หรือชวนอัปเดต | เป็นหน้าจอปกติของ Codex ให้ `Ctrl-b <เลข>` เข้าไปตอบ MCP จะต่อเข้ามาหลังตอบเสร็จ |
| agent บอกว่าไม่มี tool `harness` | รัน `CREWMUX_DEBUG=1 crewmux up` แล้วดู window 0 ต้องเห็น `mcp <role> tools/list` ถ้าไม่เห็น แปลว่า CLI ยังค้างอยู่ที่หน้าจอถามข้อ (ดูแถวบน) |
| ข้อความโผล่ในช่องพิมพ์แต่ไม่ถูกส่ง | เพิ่ม `delivery.pasteDelayMs` เช่นเป็น 800 |
| `no running agent with role "x"` | role นั้นไม่ได้เปิด หรือถูกปิดไปแล้ว ให้เช็คชื่อใน `roles.yaml` และดูว่า window ยังอยู่ไหม |
| แก้ config แล้วไม่มีผล | ต้อง `crewmux down && crewmux` เพราะถ้า session เปิดอยู่แล้วจะแค่ attach (บทสนทนาไม่หาย เพราะ resume ให้) |
| อยากดูประวัติข้อความ | `Ctrl-b m` หรือ `.crewmux/state/harness.db` ตาราง `events` (บันทึกทุก event เป็น JSON) |
| ขึ้น `✗ the harness did not start` | ข้อความถัดมาคือสาเหตุ (มาจาก `.crewmux/state/harness.log`) แก้ตามนั้นแล้วสั่ง `crewmux` ใหม่ |
| เห็นแค่ `[exited]` | เป็นอาการของเวอร์ชันก่อน 18 ก.ย. 16:05 ที่กด `Ctrl-C` ในหน้า harness แล้วปิดทั้งหมด ให้ `pnpm build` แล้วเปิดใหม่ |
| `tmux ls` ไม่เห็น session ของ harness | เพราะ harness ใช้ server แยก ให้ใช้ `tmux -L crewmux-<project> ls` |
| `Ctrl-b m` / `Ctrl-b a` ไม่ทำงาน | ถ้ารันอยู่ใน tmux อีกชั้น ต้องกด `Ctrl-b` 2 ครั้ง |
| กด `Ctrl-b` แล้วไม่มีอะไรเกิดขึ้น (หรือ sidebar ของ VS Code เปิด/ปิด) | VS Code แย่งปุ่มไป ตั้งค่า `terminal.integrated.sendKeybindingsToShell` ตามข้างบน หรือกด `q` ใน sidebar เพื่อออก |
| `Ctrl-b n` / `Ctrl-b X` ไม่ทำงาน หรือขึ้น ⚠ "started by an older crewmux" | session ถูกเปิดด้วยเวอร์ชันก่อนหน้า ให้ `crewmux down && crewmux` ครั้งเดียว (บทสนทนา resume ต่อ) · ปุ่มจะถูกตั้งใหม่ทุกครั้งที่ attach |
| คำถามยืนยัน (y/n) ไม่เห็น | ถูกแสดงที่ **แถบด้านบน** ไม่ใช่ด้านล่าง |
