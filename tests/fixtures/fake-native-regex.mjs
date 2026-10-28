#!/usr/bin/env node
/**
 * 시험용 가짜 정규식 엔진.
 *
 * Rust 바이너리를 흉내 내지 않는다. **고장 난 엔진**을 흉내 낸다.
 *
 * ## 왜 필요한가
 *
 * 클라이언트는 응답 프레임을 **길이만 믿고** 읽는다. 프로세스가 죽는 동안 쓰다만
 * 응답이 잘려서 도착하면 길이가 맞지 않는다.
 *
 * 그때 예외를 그대로 흘리면 **stdout 의 `data` 핸들러에서 터져 Node 가 죽는다.**
 * 엔진 하나가 죽은 것 때문에 서버까지 죽으면 안 된다.
 *
 * 이 가짜 엔진은 그 상황을 **만들어 낸다.** 잘린 프레임·길이가 어긋난 프레임·
 * 아무도 기다리지 않는 id 의 프레임을 흘려보내서, 클라이언트가 조용히 실패하지 않고
 * **명확히 실패하는지** 확인한다.
 *
 * ## 모드
 *
 * `FAKE_NATIVE_MODE` 환경변수로 고른다.
 *
 * | 모드 | 하는 일 |
 * |------|---------|
 * | `ok` | 정상 응답. 매칭 0건 |
 * | `truncated` | 길이 헤더는 10 이라고 하는데 본문은 3바이트만 보낸다 |
 * | `bad-length` | 메시지 길이가 999 라고 하는데 본문이 비어 있다 |
 * | `unknown-id` | 아무도 기다리지 않는 id 로 먼저 한 번 보낸다 |
 * | `stderr` | 표준 오류에 잡음을 낸다 (프로토콜을 깨지 않아야 한다) |
 * | `exit` | 아무것도 하지 않고 즉시 끝난다 |
 */

const MODE = process.env.FAKE_NATIVE_MODE ?? "ok";

if (MODE === "stderr") {
  /** 엔진의 표준 오류는 MCP 표준 입출력과 섞이면 안 된다. 프로토콜이 깨진다. */
  process.stderr.write("fake engine noise on stderr\n");
}

/** 요청은 `op u8 | id u32 | count u32 | ...` 이다. */
function readOp(chunk) {
  return chunk.length >= 1 ? chunk.readUInt8(0) : 0;
}

function readId(chunk) {
  return chunk.length >= 5 ? chunk.readUInt32LE(1) : 0;
}

/** 응답 프레임 하나. `[u32 총길이] | status u8 | id u32 | kind u8 | message(u32+bytes) | payload` */
function frame(status, id, kind, message, payload = Buffer.alloc(0)) {
  const msg  = Buffer.from(message, "utf8");
  const body = Buffer.alloc(1 + 4 + 1 + 4 + msg.length + payload.length);
  let off = 0;
  body.writeUInt8(status, off); off += 1;
  body.writeUInt32LE(id, off); off += 4;
  body.writeUInt8(kind, off); off += 1;
  body.writeUInt32LE(msg.length, off); off += 4;
  msg.copy(body, off); off += msg.length;
  payload.copy(body, off);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** 연산별 본문. 매칭 0건으로 충분하다 — 실패 경로만 확인한다. */
function payloadFor(op) {
  if (op === 2) {
    /** find_first — "찾지 못함" 표시 하나. */
    const p = Buffer.alloc(1);
    p.writeUInt8(0, 0);
    return p;
  }
  if (op === 3 || op === 4) {
    /** find_all / find_all_many — 매칭 0건. */
    const p = Buffer.alloc(4);
    p.writeUInt32LE(0, 0);
    return p;
  }
  if (op === 5) {
    /** replace_all — `[u32 길이] | 텍스트 | [u8 exact]`. */
    const text = Buffer.from("[R]", "utf8");
    const p    = Buffer.alloc(4 + text.length + 1);
    p.writeUInt32LE(text.length, 0);
    text.copy(p, 4);
    p.writeUInt8(1, 4 + text.length);
    return p;
  }
  return Buffer.alloc(0);
}

if (MODE === "exit") {
  process.exit(3);
}

process.stdin.on("data", (chunk) => {
  const id = readId(chunk);

  if (MODE === "truncated") {
    /** 길이 헤더는 10 이라고 하는데 본문은 3바이트만 보낸다. */
    const header = Buffer.alloc(4);
    header.writeUInt32LE(10, 0);
    process.stdout.write(Buffer.concat([header, Buffer.from([0, 0, 0])]));
    return;
  }

  if (MODE === "bad-length") {
    /** 메시지 길이가 999 라고 하는데 본문이 비어 있다. */
    const body = Buffer.alloc(10);
    body.writeUInt8(0, 0);
    body.writeUInt32LE(id, 1);
    body.writeUInt8(0, 5);
    body.writeUInt32LE(999, 6);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    process.stdout.write(Buffer.concat([header, body]));
    return;
  }

  if (MODE === "unknown-id") {
    /** 아무도 기다리지 않는 id 로 먼저 한 번 보낸다. 그 다음 올바른 id 로 보낸다. */
    process.stdout.write(frame(0, id + 1000, 0, "", payloadFor(readOp(chunk))));
    process.stdout.write(frame(0, id, 0, "", payloadFor(readOp(chunk))));
    return;
  }

  process.stdout.write(frame(0, id, 0, "", payloadFor(readOp(chunk))));
});

process.stdin.on("end", () => process.exit(0));
