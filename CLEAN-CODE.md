# CLEAN-CODE — กติกาเขียนโค้ดของ crewmux

ทั้งคนและ agent ต้องอ่านไฟล์นี้ก่อนแก้โค้ดใน repo นี้
role `clean-code` ใน harness ก็ใช้ไฟล์นี้เป็นเกณฑ์รีวิวได้ โดยเพิ่ม `../CLEAN-CODE.md` เข้าไปใน `roles.yaml → clean-code.rules`
กติกาที่ใช้ได้กับทุกโปรเจกต์อยู่ที่ `templates/.crewmux/rules/clean-code.md` ส่วนไฟล์นี้มีแค่กติกาเฉพาะของ repo นี้

ระดับความรุนแรงที่ใช้ตอนรีวิว: **[BLOCKER]** ห้าม merge · **[MAJOR]** ต้องแก้ก่อน merge · **[MINOR]** แนะนำ

---

## 1. ชั้นและทิศทาง import — [BLOCKER]

ตาราง `ALLOWED` ใน `test/architecture.test.ts` คือตัวกำหนดจริง ถ้าไฟล์นี้กับ test ไม่ตรงกัน ให้ยึดตาม test

| ชั้น | import ได้ |
|---|---|
| `protocol/` | ตัวเองเท่านั้น + `zod`, `node:crypto` |
| `config/` | protocol |
| `core/` | protocol, config (pure ล้วน ไม่มี IO) |
| `agents/` | protocol, config (launcher = pure function ที่คืนค่าเป็น argv + env) |
| `bridge/` | protocol, config, core, workspace |
| `workspace/` | protocol |
| `persistence/` | protocol |
| `terminal/` | ไม่ import ชั้นอื่นเลย (`tmux.ts` ห่อ tmux · `chrome.ts` เป็น pure function ที่คืนรายการคำสั่ง tmux) |
| `ui/` | protocol, config, persistence (เป็นตัวแสดงผลแบบอ่านอย่างเดียว ห้ามแตะ core, bridge หรือ runtime) |
| `runtime/` | ทุกชั้นข้างบน (เป็น composition root ของ 1 run) |
| `src/cli.ts` | ทุกชั้น (เป็น entry point) |

- `core` กับ `bridge` ห้ามรู้ว่ามี Claude, Codex หรือ tmux อยู่ ของเฉพาะเจ้าอยู่ใน `agents/launchers/` ส่วนของเฉพาะ tmux อยู่ใน `terminal/`
- **harness ไม่ครอบหรือวาด UI ของ vendor ใหม่** launcher ทำได้แค่ต่อ flag, env และ MCP เข้ากับ CLI จริงเท่านั้น ห้าม parse output หรือ screen-scrape
- ถ้าอยากเพิ่มทิศทางใหม่ ให้แก้ `ALLOWED` พร้อมเขียนเหตุผลใน PR ห้ามแอบ import ข้ามชั้น

## 2. State มีเจ้าของคนเดียว — [BLOCKER]

- สถานะ session เปลี่ยนได้ผ่าน `SessionRegistry.add/setStatus` เท่านั้น
- การเปลี่ยนแปลงทุกอย่างต้อง `bus.publish(...)` เป็น `HarnessEvent` ถ้าไม่มี event ก็เท่ากับไม่เคยเกิดขึ้น
- ตัวตนของผู้เรียก (`role`, `sessionId`) มาจาก **token ของ session** เสมอ ห้ามรับค่านี้จาก argument ของ tool

## 3. Schema อยู่ที่เดียว — [MAJOR]

- type ของข้อมูลที่วิ่งข้ามชั้นต้องนิยามเป็น zod schema ใน `protocol/` (หรือ `config/schema.ts` ถ้าเป็นข้อมูล config) แล้วใช้ `z.infer` เอา type ออกมา ห้ามเขียน `interface` ซ้ำขึ้นมาอีกตัวที่หน้าตาเหมือนกัน
- ให้ `parse` แค่ **ที่ขอบระบบ** คือไฟล์ yaml, input ของ MCP tool, แถวข้อมูลจาก SQLite และ output ของ provider หลังผ่านขอบมาแล้วให้เชื่อ type ได้เลย ห้าม parse ซ้ำ
- id ทุกตัวต้องสร้างด้วย `newId()` ซึ่งเป็น UUID เต็ม ห้ามตัดให้สั้นลง

## 4. แยก logic ที่ตัดสินใจออกจาก IO — [MAJOR]

- **Pure:** `core/`, `agents/launchers/`, `runtime/prompt.ts`, `terminal/chrome.ts`, `ui/panel.ts` ส่วนนี้ห้ามอ่านไฟล์ ห้ามยิง network และห้ามเรียก `Date.now()` ตรงๆ ให้รับ clock เข้ามาเป็น parameter แบบที่ `EventBus` ทำ
- **IO อยู่ที่ขอบ:** `terminal/`, `workspace/`, `persistence/`, `bridge/mcp-server.ts`, `runtime/harness.ts`
- transport ต้องบางที่สุด เช่น `mcp-server.ts` แค่ห่อ `tools.ts` โดยไม่มี business logic ข้างใน ส่วน `tools.ts` ไม่ผูกกับ transport แต่ยังอ่านไฟล์ใน worktree อยู่ จึงไม่ถือว่าเป็น pure

## 5. Security — [BLOCKER]

- server ทุกตัว bind ที่ `127.0.0.1` เท่านั้น
- path ที่ได้มาจาก agent ต้องเป็น relative path แล้วเช็คด้วย `realpathSync` ว่ายังอยู่ใน worktree (กัน `..` และ symlink) จากนั้นต้องผ่าน `PolicyEngine`
- token ส่งผ่าน env ของ window เท่านั้น ห้ามอยู่ใน argv, ไฟล์ config หรือ log (มี test ใน `launchers.test.ts` เช็คข้อนี้)
- harness ห้ามแก้ config ของ user (`~/.claude*`, `~/.codex/config.toml`) ให้ inject ทุกอย่างผ่าน flag ตอนเปิด
- harness ห้ามใช้ tmux server ของ user คำสั่ง tmux ทุกตัวต้องผ่าน `terminal/tmux.ts` ซึ่งใส่ `-L <socket>` ให้เสมอ ส่วน test ต้องตั้ง `CREWMUX_TMUX_SOCKET` เป็น server ส่วนตัวแล้ว `kill-server` ตอนจบ
- ห้ามมี secret อยู่ใน code, `.crewmux/`, log, event, test fixture หรือข้อความ error ใน config ใส่ได้แค่ **ชื่อ** env var
- ทุก security check ต้องมี negative test (ดูตัวอย่างใน `test/bridge.test.ts`)

## 6. Error — [MAJOR]

- ถ้าเป็นความผิดของ agent หรือ user ให้ throw `ToolError` ซึ่งข้อความจะถูกส่งกลับให้ agent อ่าน ต้องเขียนให้ agent เอาไปแก้ต่อได้
- ถ้าเป็น bug ให้ throw `Error` ธรรมดา แล้ว MCP server จะห่อเป็น `internal error: ...`
- ห้ามเขียน `catch {}` เปล่าๆ ต้องจัดการด้วย fallback ที่ชัดเจน หรือ throw ต่อพร้อมบอกว่าอะไรพังและเป็นของ id ไหน

## 7. Test — [MAJOR]

- ถ้าเป็นคำสั่ง tmux ต้องให้ **tmux จริงรัน** ด้วย (เคยพลาดมาแล้ว: `set-option -t =name` และ window option ที่ตั้งผ่าน session ผ่าน unit test ที่เทียบข้อความของคำสั่ง แต่ใช้กับ tmux จริงไม่ได้)

- พฤติกรรมใหม่ต้องมี test ที่ **fail ถ้าไม่มีการแก้ครั้งนี้**
- logic ที่เป็น pure ใช้ unit test ส่วน `bridge/` ต้องทดสอบผ่าน MCP client จริงบน HTTP และ `terminal/` กับ `runtime/` ต้องทดสอบบน tmux จริง (`test/e2e-tmux.test.ts`) ห้าม mock ตัว protocol
- test ห้ามยิง network หรือเสียเงิน ถ้าต้องใช้ agent ให้ใช้ `test/fixtures/fake-agent.mjs` (`kind: custom`) ส่วนการลองกับ Claude/Codex ตัวจริงต้องขอ OK ก่อน
- ของที่ test สร้างขึ้นต้องอยู่ใน `mkdtemp` เท่านั้น

## 8. รูปแบบโค้ด — [MINOR]

- ชื่อไฟล์เป็น `kebab-case.ts` และ 1 ไฟล์มี 1 แนวคิด ถ้ายาวเกิน ~300 บรรทัดให้พิจารณาแยก
- ใช้ named export เท่านั้น ห้าม default export
- import แบบ relative ต้องลงท้าย `.js` (ตามกติกาของ NodeNext) และใช้ `import type` เมื่อ import แค่ type
- comment ใช้อธิบาย **ว่าทำไม** ไม่ใช่ทำอะไร ส่วน TODO ต้องระบุ milestone เช่น `TODO(M1): ...`
- ไม่แก้ส่วนที่ไม่เกี่ยวกับงาน ไม่ reformat ทั้งไฟล์ ไม่ทิ้งโค้ดที่ไม่ได้ใช้

## 9. เพิ่ม vendor ใหม่ (checklist)

1. ลองก่อนว่า `kind: custom` + env `HARNESS_*` ใช้ได้เลยหรือไม่ ถ้าใช้ได้ ไม่ต้องเขียนโค้ดเพิ่ม
2. ถ้าต้องมี flag เฉพาะของ vendor ให้สร้าง `src/agents/launchers/<kind>.ts` (pure) แล้วเพิ่ม `kind` ใน `AgentDefinition` และใน `LAUNCHERS`
3. เช็ค flag จาก `--help` ของเวอร์ชันที่ติดตั้งอยู่จริง ห้ามเดา แล้วเขียน test เทียบ argv ใน `launchers.test.ts` รวมถึงเช็คว่า token ไม่อยู่ใน argv
4. smoke ด้วย `CREWMUX_DEBUG=1 crewmux up <role>` ต้องเห็น `mcp <role> tools/list` ใน window harness

## 10. ก่อน commit

```bash
pnpm typecheck && pnpm test      # tsc (src + test) + vitest (รวม architecture และ e2e tmux)
git diff --cached | grep -nEi 'api[_-]?key|secret|token=|BEGIN .*PRIVATE' && echo "⚠ ตรวจ secret"
```
