const { test } = require("node:test");
const assert = require("node:assert/strict");
const P = require("../core.js");
const item = (overrides) => ({ ...P.seedItems()[0], ...overrides });

test("original purchases remain exact, with all unknown dates unguessed", () => {
  const items = P.seedItems();
  assert.equal(items.length, 11);
  assert.equal(P.summarize(items, "2026-10-26").spent, 135.76);
  assert.equal(P.summarize(items, "2026-10-26").missing, 11);
  assert.ok(
    items.every(
      (value) =>
        !value.purchaseDate && !value.expiryDate && value.storage === "unknown",
    ),
  );
  assert.deepEqual(P.parseBackup({ version: 1, items }).items, items);
});

test("calendar dates validate leap years, ranges and malformed dates", () => {
  assert.notEqual(P.dayNumber("2028-02-29"), null);
  for (const date of [
    "2026-02-29",
    "2026-04-31",
    "2026-13-01",
    "2026-00-05",
    "2026-1-01",
    "2026-10-26T00:00:00Z",
    "",
    "1899-01-01",
  ])
    assert.equal(P.dayNumber(date), null);
});

test("countdowns distinguish missing, today, soon, fresh and overdue", () => {
  const checks = [
    ["", null, "missing"],
    ["2026-10-25", -1, "expired"],
    ["2026-10-26", 0, "today"],
    ["2026-10-27", 1, "soon"],
    ["2026-10-29", 3, "soon"],
    ["2026-10-30", 4, "fresh"],
  ];
  for (const [expiryDate, days, status] of checks) {
    const result = P.deadlineInfo(item({ expiryDate }), "2026-10-26");
    assert.equal(result.days, days);
    assert.equal(result.status, status);
  }
});

test("opening deadline can shorten but never extend package expiry", () => {
  assert.equal(
    P.deadlineInfo(
      item({
        expiryDate: "2026-11-10",
        useByDate: "2026-10-28",
        dateBasis: "personal",
      }),
      "2026-10-26",
    ).basis,
    "个人计划截止",
  );
  assert.equal(
    P.deadline(item({ expiryDate: "2026-10-28", useByDate: "2026-11-10" })),
    "2026-10-28",
  );
  assert.equal(
    P.deadlineInfo(item({ useByDate: "2026-10-28" }), "2026-10-26").days,
    2,
  );
});

test("date math handles leap days, year boundaries and DST calendar days", () => {
  assert.equal(
    P.deadlineInfo(item({ expiryDate: "2028-03-01" }), "2028-02-28").days,
    2,
  );
  assert.equal(
    P.deadlineInfo(item({ expiryDate: "2027-01-01" }), "2026-12-31").days,
    1,
  );
  assert.equal(
    P.deadlineInfo(item({ expiryDate: "2026-03-09" }), "2026-03-07").days,
    2,
  );
  assert.equal(P.localDate(new Date(2026, 9, 26, 0, 1)), "2026-10-26");
});

test("statistics retain purchase spend after consumption and exclude unknown prices", () => {
  const items = [
    item({ expiryDate: "2026-10-26", price: 0.1 }),
    item({ id: "2", expiryDate: "2026-10-25", price: 0.2 }),
    item({ id: "3", status: "eaten", price: null, finishedDate: "2026-10-26" }),
  ];
  assert.deepEqual(P.summarize(items, "2026-10-26"), {
    total: 2,
    soon: 1,
    expired: 1,
    missing: 0,
    spent: 0.3,
    unknownPrices: 1,
  });
});

test("backup validation rejects malformed and inconsistent records", () => {
  for (const changes of [
    { name: "" },
    { price: -1 },
    { price: NaN },
    { price: undefined },
    { storage: "__proto__" },
    { category: "bad" },
    { status: "bad" },
    { purchaseDate: "2026-10-26", expiryDate: "2026-10-25" },
    { openedDate: "2026-10-25", purchaseDate: "2026-10-26" },
    { openedDate: "2026-10-26", useByDate: "2026-10-25" },
    { status: "eaten" },
    { updatedAt: "not a date" },
  ])
    assert.throws(() => P.validateItem(item(changes)));
  assert.throws(() => P.parseBackup({ version: 2, items: [] }));
  assert.throws(() => P.parseBackup("{bad json"));
  assert.throws(() => P.parseBackup({ version: 1, items: [item(), item()] }));
  assert.equal(P.validateItem(item({ price: null })).price, null);
  assert.equal(P.validateItem(item({ price: 0 })).price, 0);
});

test("merge preserves other purchases and only accepts newer revisions", () => {
  const existing = item({ notes: "new", updatedAt: "2026-10-26T12:00:00Z" });
  const older = item({ notes: "old" });
  assert.deepEqual(P.mergeItems([existing], [older]), [existing]);
  const newer = item({ notes: "newer", updatedAt: "2026-10-27T12:00:00Z" });
  const extra = item({ id: "extra" });
  assert.deepEqual(P.mergeItems([existing], [newer, extra]), [newer, extra]);
});

test("screenshot shelf lives match all six products without inventing expiry dates", () => {
  const items = P.seedItems();
  assert.deepEqual(
    items
      .filter((item) => item.shelfLife)
      .map((item) => [item.name, item.shelfLife]),
    [
      ["顺德鱼皮角", "12个月"],
      ["玉米猪肉蒸饺", "12个月"],
      ["鲜虾荠菜猪肉水饺", "12个月"],
      ["亚麻籽冷鲜猪肉丸子", "5天"],
      ["去皮五花肉片", "4天"],
      ["冷鲜猪瘦肉丝", "4天"],
    ],
  );
  assert.ok(items.every((item) => !item.expiryDate && !item.purchaseDate));
});

test("legacy records gain shelf life once while preserving personal changes", () => {
  const legacy = P.seedItems().map(
    ({ shelfLife, productDetailsRevision, ...item }) => item,
  );
  legacy[0].notes = "已分装";
  legacy[0].expiryDate = "2026-11-15";
  legacy[0].remaining = "一半";
  const enriched = P.parseBackup({ version: 1, items: legacy }).items;
  assert.equal(enriched[0].shelfLife, "12个月");
  assert.equal(enriched[0].notes, "已分装");
  assert.equal(enriched[0].expiryDate, "2026-11-15");
  assert.equal(enriched[0].remaining, "一半");
  assert.equal(enriched[0].updatedAt, legacy[0].updatedAt);
  enriched[0].shelfLife = "";
  assert.equal(
    P.parseBackup({ version: 1, items: enriched }).items[0].shelfLife,
    "",
  );
  const unrelated = { ...legacy[0], id: "another-purchase" };
  assert.equal(
    P.parseBackup({ version: 1, items: [unrelated] }).items[0].shelfLife,
    "",
  );
  assert.deepEqual(P.parseBackup({ version: 1, items: [] }).items, []);
});
