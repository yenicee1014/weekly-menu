const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const P = require("../core.js");
const root = path.join(__dirname, "..");

function setup(t, raw) {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const dom = new JSDOM(html, {
    url: "https://example.test/weekly-menu/",
    runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  let now = new Date(2026, 9, 26, 12).getTime();
  const NativeDate = w.Date;
  w.Date = class extends NativeDate {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now;
    }
  };
  const timers = new Map();
  let nextTimer = 0;
  w.setTimeout = (fn, delay) => {
    timers.set(++nextTimer, { fn, delay });
    return nextTimer;
  };
  w.clearTimeout = (id) => timers.delete(id);
  w.setInterval = () => 0;
  w.matchMedia = () => ({ matches: true });
  w.Element.prototype.scrollIntoView = () => {};
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function (result = "") {
    this.returnValue = result;
    this.open = false;
    this.dispatchEvent(new w.Event("close"));
  };
  if (raw !== undefined) w.localStorage.setItem(P.STORAGE_KEY, raw);
  w.eval(fs.readFileSync(path.join(root, "core.js"), "utf8"));
  w.eval(fs.readFileSync(path.join(root, "app.js"), "utf8"));
  const $ = (selector) => w.document.querySelector(selector);
  const click = (selector) => $(selector).click();
  const fill = (name, value) => {
    const input = $(`[name="${name}"]`);
    input.value = value;
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
  };
  const submit = () =>
    $("#food-form").dispatchEvent(
      new w.Event("submit", { cancelable: true, bubbles: true }),
    );
  const saved = () => JSON.parse(w.localStorage.getItem(P.STORAGE_KEY));
  const advance = () => {
    now += 86400000;
    w.dispatchEvent(new w.Event("focus"));
  };
  return { w, $, click, fill, submit, saved, advance, timers };
}

test("first load preserves all purchases and existing saved empty inventory stays empty", (t) => {
  const a = setup(t);
  assert.equal(a.$("#stat-spent").textContent, "¥135.76");
  assert.equal(a.w.document.querySelectorAll(".food-row").length, 11);
  assert.equal(a.saved().items.length, 11);
  const b = setup(t, JSON.stringify({ version: 1, items: [] }));
  assert.equal(b.saved().items.length, 0);
  assert.equal(b.$("#empty-state").hidden, false);
});

test("add, reload, edit, search and remaining quantities persist with exact prices", (t) => {
  const a = setup(t);
  a.click("#add-button");
  assert.equal(a.$("#food-dialog").open, true);
  a.fill("name", "测试牛奶");
  a.fill("quantity", "250ml × 6");
  a.fill("remaining", "4盒");
  a.fill("storage", "fridge");
  a.fill("category", "dairy");
  a.fill("price", "12.34");
  a.fill("expiryDate", "2026-10-29");
  a.submit();
  assert.equal(a.$("#food-dialog").open, false);
  assert.equal(a.saved().items.length, 12);
  assert.match(a.$("#food-list").textContent, /剩 3 天/);
  assert.equal(a.$("#stat-spent").textContent, "¥148.10");
  const reload = setup(t, JSON.stringify(a.saved()));
  assert.match(reload.$("#food-list").textContent, /测试牛奶/);
  reload.click('[aria-label="编辑 测试牛奶"]');
  reload.fill("remaining", "2盒");
  reload.fill("useByDate", "2026-10-27");
  reload.fill("openedDate", "2026-10-26");
  reload.submit();
  assert.equal(
    reload.saved().items.find((x) => x.name === "测试牛奶").remaining,
    "2盒",
  );
  assert.match(reload.$("#food-list").textContent, /剩 1 天/);
  reload.$("#search").value = "测试牛奶";
  reload.$("#search").dispatchEvent(new reload.w.Event("input"));
  assert.equal(reload.w.document.querySelectorAll(".food-row").length, 1);
});

test("consume and restore retain purchase history and spend", (t) => {
  const a = setup(t);
  a.click('[aria-label="吃完 菜心苗"]');
  assert.equal(
    a.saved().items.find((x) => x.name === "菜心苗").status,
    "eaten",
  );
  assert.equal(a.$("#stat-spent").textContent, "¥135.76");
  a.click('[data-view="history"]');
  a.click('[data-filter="eaten"]');
  assert.equal(a.w.document.querySelectorAll(".food-row").length, 1);
  a.click('[aria-label="恢复 菜心苗"]');
  assert.equal(
    a.saved().items.find((x) => x.name === "菜心苗").status,
    "active",
  );
});

test("discard requires confirmation and can be cancelled", async (t) => {
  const a = setup(t);
  a.click('[aria-label="丢弃 菜心苗"]');
  assert.equal(a.$("#confirm-dialog").open, true);
  a.$("#confirm-dialog").close("cancel");
  await new Promise(setImmediate);
  assert.equal(
    a.saved().items.find((x) => x.name === "菜心苗").status,
    "active",
  );
  a.click('[aria-label="丢弃 菜心苗"]');
  a.$("#confirm-dialog").close("confirm");
  await new Promise(setImmediate);
  assert.equal(
    a.saved().items.find((x) => x.name === "菜心苗").status,
    "discarded",
  );
});

test("form rejects contradictory dates and protects unsaved input on storage failure", (t) => {
  const a = setup(t);
  a.click("#add-button");
  a.fill("name", "测试");
  a.fill("expiryDate", "2026-10-25");
  a.submit();
  assert.match(a.$("#form-error").textContent, /不能早于购买/);
  assert.equal(a.saved().items.length, 11);
  a.fill("expiryDate", "2026-10-27");
  a.w.Storage.prototype.setItem = () => {
    throw new Error("Quota exceeded");
  };
  a.submit();
  assert.equal(a.$("#food-dialog").open, true);
  assert.match(a.$("#storage-error").textContent, /保存失败/);
  assert.equal(a.saved().items.length, 11);
});

test("bad existing storage is never silently replaced", (t) => {
  const a = setup(t, "broken original data");
  assert.equal(a.$("#storage-error").hidden, false);
  a.click("#add-button");
  a.fill("name", "测试");
  a.submit();
  assert.equal(a.w.localStorage.getItem(P.STORAGE_KEY), "broken original data");
});

test("cross-day refresh updates today and overdue statuses and timer is scheduled", (t) => {
  const seed = P.seedItems();
  seed[0].expiryDate = "2026-10-27";
  const a = setup(t, JSON.stringify({ version: 1, items: seed }));
  assert.match(a.$("#food-list").textContent, /剩 1 天/);
  assert.ok([...a.timers.values()].some((x) => x.delay > 1000));
  a.advance();
  assert.match(a.$("#food-list").textContent, /今天截止/);
  a.advance();
  assert.match(a.$("#food-list").textContent, /已超 1 天/);
  assert.equal(a.$("#stat-expired").textContent, "1项");
});

test("user strings render as text, not HTML", (t) => {
  const a = setup(t);
  a.click("#add-button");
  a.fill("name", "<img src=x onerror=alert(1)>");
  a.fill("notes", "<script>alert(1)</script>");
  a.submit();
  assert.equal(a.$("#food-list img"), null);
  assert.equal(a.$("#food-list script"), null);
  assert.match(a.$("#food-list").textContent, /<img src=x/);
});

test("a second tab update cannot overwrite an open form with a stale revision", (t) => {
  const a = setup(t);
  a.click('[aria-label="编辑 菜心苗"]');
  const fresh = a.saved();
  const target = fresh.items.find((x) => x.name === "菜心苗");
  target.remaining = "更新后的数量";
  target.updatedAt = "2026-10-27T12:00:00Z";
  const raw = JSON.stringify(fresh);
  a.w.localStorage.setItem(P.STORAGE_KEY, raw);
  a.w.dispatchEvent(
    new a.w.StorageEvent("storage", { key: P.STORAGE_KEY, newValue: raw }),
  );
  a.fill("remaining", "旧数量");
  a.submit();
  assert.match(a.$("#form-error").textContent, /另一页面修改/);
  assert.equal(
    a.saved().items.find((x) => x.name === "菜心苗").remaining,
    "更新后的数量",
  );
});

test("delete requires confirmation and removes only the selected historical record", async (t) => {
  const a = setup(t);
  a.click('[aria-label="吃完 菜心苗"]');
  a.click('[data-view="history"]');
  a.click('[aria-label="删除 菜心苗"]');
  a.$("#confirm-dialog").close("cancel");
  await new Promise(setImmediate);
  assert.equal(a.saved().items.length, 11);
  a.click('[aria-label="删除 菜心苗"]');
  a.$("#confirm-dialog").close("confirm");
  await new Promise(setImmediate);
  assert.equal(a.saved().items.length, 10);
  assert.equal(a.$("#stat-spent").textContent, "¥130.42");
});

test("import merges only valid backups and preserves data on malformed files", async (t) => {
  const a = setup(t);
  const input = a.$("#import-file");
  const incoming = P.seedItems()[0];
  incoming.id = "backup-extra";
  incoming.name = "备份食材";
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [
      {
        size: 1000,
        text: async () => JSON.stringify({ version: 1, items: [incoming] }),
      },
    ],
  });
  input.dispatchEvent(new a.w.Event("change"));
  await new Promise(setImmediate);
  assert.equal(a.$("#confirm-dialog").open, true);
  a.$("#confirm-dialog").close("confirm");
  await new Promise(setImmediate);
  assert.equal(a.saved().items.length, 12);
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [{ size: 100, text: async () => "broken backup" }],
  });
  input.dispatchEvent(new a.w.Event("change"));
  await new Promise(setImmediate);
  assert.equal(a.saved().items.length, 12);
  assert.match(a.$("#toast").textContent, /导入失败/);
});

test("export includes all persisted records and corrupted original data is recoverable", async (t) => {
  for (const original of [undefined, "broken original"]) {
    const a = setup(t, original);
    let blob;
    let fileName;
    a.w.URL.createObjectURL = (value) => {
      blob = value;
      return "blob:test";
    };
    a.w.HTMLAnchorElement.prototype.click = function () {
      fileName = this.download;
    };
    a.click("#export-button");
    const reader = new a.w.FileReader();
    const text = await new Promise((resolve) => {
      reader.onload = () => resolve(reader.result);
      reader.readAsText(blob);
    });
    if (original) {
      assert.equal(text, original);
      assert.match(fileName, /原始数据/);
    } else assert.equal(JSON.parse(text).items.length, 11);
  }
});

test("clearing storage from another tab blocks writing instead of silently recreating it", (t) => {
  const a = setup(t);
  a.w.localStorage.clear();
  a.w.dispatchEvent(
    new a.w.StorageEvent("storage", { key: null, newValue: null }),
  );
  a.click("#add-button");
  a.fill("name", "新食材");
  a.submit();
  assert.equal(a.w.localStorage.getItem(P.STORAGE_KEY), null);
  assert.equal(a.$("#storage-error").hidden, false);
});

test("existing browser records persist screenshot shelf lives without overwriting dates or quantities", (t) => {
  const old = P.seedItems().map(
    ({ shelfLife, productDetailsRevision, ...item }) => item,
  );
  old[0].remaining = "一半";
  old[0].expiryDate = "2026-11-15";
  const a = setup(t, JSON.stringify({ version: 1, items: old }));
  assert.equal(a.saved().items[0].shelfLife, "12个月");
  assert.equal(a.saved().items[0].remaining, "一半");
  assert.equal(a.saved().items[0].expiryDate, "2026-11-15");
  assert.equal(a.saved().items.length, 11);
  a.click('[aria-label="编辑 顺德鱼皮角"]');
  assert.equal(a.$('[name="shelfLife"]').value, "12个月");
  a.fill("shelfLife", "以实物包装为准");
  a.submit();
  const reload = setup(t, JSON.stringify(a.saved()));
  assert.equal(reload.saved().items[0].shelfLife, "以实物包装为准");
});

test("shelf life alone never becomes a countdown and is escaped as plain text", (t) => {
  const a = setup(t);
  a.click('[aria-label="编辑 去皮五花肉片"]');
  assert.match(a.$("#deadline-preview").textContent, /保质期 4天/);
  a.fill("shelfLife", '<img src=x onerror="alert(1)">');
  a.submit();
  assert.equal(a.$("#food-list img"), null);
  assert.equal(a.$("#stat-soon").textContent, "0项");
  assert.equal(a.$("#stat-expired").textContent, "0项");
  assert.equal(
    a.saved().items.find((item) => item.name === "去皮五花肉片").expiryDate,
    "",
  );
});
