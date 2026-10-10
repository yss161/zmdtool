// 基于 Chrome DevTools Protocol 的电路模式交互测试（Node 22 内置 WebSocket，无需第三方依赖）。
// 前置：headless Chrome 已带 --remote-debugging-port=9222 启动，本地服务 http://127.0.0.1:8123 已就绪。
const CDP_HTTP = "http://127.0.0.1:9222";
const PAGE_URL = "http://127.0.0.1:8123/";

let ws;
let msgId = 0;
const pending = new Map();

function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

async function main() {
  // 找到 page target
  const list = await (await fetch(CDP_HTTP + "/json/list")).json();
  let page = list.find(t => t.type === "page");
  if (!page) throw new Error("没有可用的 page target");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };

  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("页面异常: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };

  let pass = 0, fail = 0;
  const expect = (cond, name) => {
    if (cond) { pass++; console.log("  ✓", name); }
    else { fail++; console.log("  ✗", name); }
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // 打开深链 V40020，等自动求解（带 query 强制完整加载，避免 hash 同文档导航）
  console.log("→ 打开 #V40020");
  await send("Network.enable");
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  await send("Page.navigate", { url: PAGE_URL + "?t=" + Date.now() + "#V40020" });
  await sleep(1800);

  let v = await evalJs(`({
    mode: document.body.dataset.mode,
    balloonHidden: document.getElementById("page-balloon").hidden,
    circuitHidden: document.getElementById("page-circuit").hidden,
    status: document.getElementById("c-status").textContent,
    pieces: __cstate.placed.reduce((s, p) => s + p.cells.length, 0),
    cells: document.querySelectorAll("#c-board-wrap .ccell").length,
    disabled: document.querySelectorAll("#c-board-wrap .ccell.s1").length,
    counter: document.getElementById("c-placed").textContent + "/" + document.getElementById("c-total").textContent,
    paletteItems: document.querySelectorAll(".pal-item").length,
  })`);
  console.log("  页面状态:", JSON.stringify(v));
  expect(v.mode === "circuit", "深链自动切换到电路模式");
  expect(v.balloonHidden && !v.circuitHidden, "页面显隐正确");
  expect(v.cells === 25, "棋盘 5×5=25 格");
  expect(v.disabled === 2, "V40020 有 2 个禁用格");
  expect(v.status.includes("找到可行解"), "自动求解成功: " + v.status.split("\n")[0]);
  expect(v.pieces === 18, "答案铺满 18 格（.piece 按格渲染）");
  expect(v.counter === "18/18", "计数器 18/18");
  expect(v.paletteItems === 26, "元件库 26 种");

  // ---- 交互 1：点选元件 → ghost → 放置 → 收回 ----
  console.log("→ 交互：选元件/放置/收回");
  v = await evalJs(`(async () => {
    const out = {};
    const placedCount = () => __cstate.placed.reduce((s, p) => s + p.cells.length, 0);
    const clickFirstPieceCell = () => {
      const p = __cstate.placed[0];
      const [r, c] = p.cells[0];
      document.querySelector('.ccell[data-r="' + r + '"][data-c="' + c + '"]').click();
    };
    // 先收回求解答案（逐块点击其格子）
    while (__cstate.placed.length) {
      clickFirstPieceCell();
      await new Promise(r => setTimeout(r, 30));
    }
    out.piecesAfterClear = placedCount();
    // 选中 2*2 L形（绿）
    const item = [...document.querySelectorAll(".pal-item")].find(x => x.dataset.id === "22lshape");
    item.querySelector(".pal-shape").click();
    out.selected = !!item.classList.contains("selected") || !!document.querySelector(".pal-item.selected");
    // hover (0,0) 应出现 ghost-ok（V40020 的 (0,0) 为空）
    const cell = document.querySelector('.ccell[data-r="0"][data-c="0"]');
    cell.dispatchEvent(new PointerEvent("pointerenter"));
    await new Promise(r => setTimeout(r, 30));
    out.ghostOk = !!document.querySelector(".ccell.ghost-ok");
    out.ghostBad = !!document.querySelector(".ccell.ghost-bad");
    // 点击放置
    cell.click();
    await new Promise(r => setTimeout(r, 30));
    out.piecesAfterPlace = placedCount();
    // 再点击收回
    clickFirstPieceCell();
    await new Promise(r => setTimeout(r, 30));
    out.piecesAfterRemove = placedCount();
    return out;
  })()`);
  console.log("  交互结果:", JSON.stringify(v));
  expect(v.piecesAfterClear === 0, "点击可收回求解答案");
  expect(v.selected, "元件库点选成功");
  expect(v.ghostOk && !v.ghostBad, "悬停显示合法 ghost");
  expect(v.piecesAfterPlace === 3, "点击放置成功（2*2 L形 = 3 格）");
  expect(v.piecesAfterRemove === 0, "再点收回成功");

  // ---- 交互 2：右键循环格子状态（非蓝色模式: 空→禁→绿锁→空）----
  console.log("→ 交互：右键切换格子状态");
  v = await evalJs(`(async () => {
    const cell = document.querySelector('.ccell[data-r="0"][data-c="0"]');
    const seq = [];
    for (let i = 0; i < 4; i++) {
      cell.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 20));
      seq.push((document.querySelector('.ccell[data-r="0"][data-c="0"]').className.match(/s\\d/) || [""])[0]);
    }
    return seq;
  })()`);
  console.log("  状态循环:", v.join(" → "));
  expect(v.join(",") === "s1,s2,s0,s1", "非蓝色模式循环 空→禁→绿锁→空→禁");

  // ---- 交互 3：蓝色模式（V40060）----
  console.log("→ 打开蓝色预设 V40060");
  await evalJs(`
    document.getElementById("c-preset-search").value = "";
    document.getElementById("c-preset").value = "V4_BOT_0060";
    document.getElementById("c-preset").dispatchEvent(new Event("change"));
  `);
  await sleep(1500);  v = await evalJs(`({
    type2: document.getElementById("c-type2").checked,
    blueTargets: document.querySelectorAll("#c-board-wrap .c-target.blue").length,
    blueSteppers: document.querySelectorAll(".mini-stepper.blue").length,
    bluePieces: __cstate.placed.filter(p => p.type === 2).length,
    greenPieces: __cstate.placed.filter(p => p.type === 1).length,
    status: document.getElementById("c-status").textContent,
    counter: document.getElementById("c-placed").textContent + "/" + document.getElementById("c-total").textContent,
  })`);
  console.log("  蓝色模式:", JSON.stringify(v));
  expect(v.type2, "type2 自动启用");
  expect(v.blueTargets === 10, "蓝色行列目标输入 5+5=10 个");
  expect(v.blueSteppers > 0, "蓝色计数器出现");
  expect(v.status.includes("找到可行解"), "蓝色题求解成功");
  expect(v.bluePieces > 0 && v.greenPieces > 0, "蓝/绿元件都渲染");

  // ---- 交互 4：模式切换回气球页 ----
  console.log("→ 切回气球模式");
  v = await evalJs(`(async () => {
    document.querySelector('.mode-tab[data-mode="balloon"]').click();
    await new Promise(r => setTimeout(r, 100));
    const out = {
      mode: document.body.dataset.mode,
      balloonVisible: !document.getElementById("page-balloon").hidden,
      boardCells: document.querySelectorAll("#board .cell").length,
    };
    document.querySelector('.mode-tab[data-mode="circuit"]').click();
    await new Promise(r => setTimeout(r, 100));
    out.backToCircuit = document.body.dataset.mode;
    return out;
  })()`);
  console.log("  模式切换:", JSON.stringify(v));
  expect(v.mode === "balloon" && v.balloonVisible, "切回气球页正常");
  expect(v.boardCells === 25, "气球棋盘仍正常渲染");
  expect(v.backToCircuit === "circuit", "再切回电路页正常");

  console.log(`\n浏览器交互测试通过 ${pass}/${pass + fail}`);
  process.exit(fail ? 1 : 0);
}

main().then(() => process.exit(0)).catch(err => { console.error("测试失败:", err.message); process.exit(1); });
