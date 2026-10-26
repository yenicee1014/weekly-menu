/* global Pantry, lucide */
(function () {
  "use strict";
  const P = Pantry;
  const $ = (selector) => document.querySelector(selector);
  const form = $("#food-form");
  const foodDialog = $("#food-dialog");
  const confirmDialog = $("#confirm-dialog");
  const filters = {
    inventory: [
      ["all", "全部"],
      ["soon", "3天内到期"],
      ["expired", "已过期限"],
      ["missing", "待补日期"],
    ],
    history: [
      ["all", "全部记录"],
      ["active", "在库"],
      ["eaten", "已吃完"],
      ["discarded", "已丢弃"],
    ],
  };
  let state = { version: 1, items: [] };
  let view = "inventory";
  let filter = "all";
  let query = "";
  let storageFilter = "all";
  let sort = "expiry";
  let lastDay = P.localDate();
  let rawDamagedData = null;
  let storageReadable = true;
  let toastTimer;
  let midnightTimer;
  let editingRevision = null;
  const escape = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[character],
    );
  const icon = (name) => `<i data-lucide="${name}"></i>`;
  const money = (value) =>
    value === null ? "金额待确认" : `¥${value.toFixed(2)}`;
  const dateText = (value) => (value ? value.replaceAll("-", ".") : "待确认");
  const field = (name) => form.elements.namedItem(name);
  const icons = () => {
    if (window.lucide) lucide.createIcons();
  };

  function showStorageError(message) {
    $("#storage-error").textContent = message;
    $("#storage-error").hidden = false;
  }
  function load() {
    let raw = null;
    try {
      raw = localStorage.getItem(P.STORAGE_KEY);
      if (raw !== null) state = P.parseBackup(raw);
      else {
        state = P.parseBackup({ version: 1, items: P.seedItems() });
        localStorage.setItem(P.STORAGE_KEY, JSON.stringify(state));
      }
    } catch (error) {
      if (raw !== null) {
        rawDamagedData = raw;
        storageReadable = false;
        showStorageError(
          "已有记录未能读取，已停止写入以保护数据。请先导出原始记录备份，再检查文件。",
        );
      } else {
        showStorageError(
          "当前浏览器无法保存记录。请允许网站存储后重试；新修改尚未保存。",
        );
      }
    }
    if (raw !== null && storageReadable && raw !== JSON.stringify(state)) {
      try {
        localStorage.setItem(P.STORAGE_KEY, JSON.stringify(state));
      } catch (error) {
        showStorageError(
          "保质期信息尚未保存，请允许网站存储后重试。原有记录仍保留。",
        );
      }
    }
  }
  function commit(items) {
    if (!storageReadable) {
      toast("请先导出并检查原始记录，当前无法写入。");
      return false;
    }
    try {
      // Re-read before writing to detect edits made in another tab.
      const stored = localStorage.getItem(P.STORAGE_KEY);
      const actual = stored === null ? [] : P.parseBackup(stored).items;
      if (
        JSON.stringify(actual) !== JSON.stringify(state.items) &&
        stored !== null
      ) {
        state = { version: 1, items: actual };
        render();
        toast("另一页面更新了记录，已刷新。请核对后再保存本次修改。");
        return false;
      }
      const next = { version: 1, items: items.map(P.validateItem) };
      localStorage.setItem(P.STORAGE_KEY, JSON.stringify(next));
      state = next;
      $("#storage-error").hidden = true;
      render();
      return true;
    } catch (error) {
      showStorageError(
        `保存失败，修改尚未生效。${error instanceof Error ? error.message : "请检查浏览器存储空间。"}`,
      );
      return false;
    }
  }
  function toast(message) {
    clearTimeout(toastTimer);
    $("#toast").textContent = message;
    $("#toast").hidden = false;
    toastTimer = setTimeout(() => {
      $("#toast").hidden = true;
    }, 4200);
  }
  function matches(item, candidateFilter, today) {
    if (view === "history")
      return candidateFilter === "all" || item.status === candidateFilter;
    if (item.status !== "active") return false;
    const info = P.deadlineInfo(item, today);
    return (
      candidateFilter === "all" ||
      (candidateFilter === "soon" &&
        info.days !== null &&
        info.days >= 0 &&
        info.days <= 3) ||
      (candidateFilter === "expired" && info.status === "expired") ||
      (candidateFilter === "missing" && info.status === "missing")
    );
  }
  function selectedItems(today) {
    const needle = query.trim().toLocaleLowerCase();
    return state.items
      .filter(
        (item) =>
          matches(item, filter, today) &&
          (storageFilter === "all" || storageFilter === item.storage) &&
          (!needle ||
            [
              item.name,
              item.quantity,
              item.remaining,
              item.shop,
              item.notes,
            ].some((value) => value.toLocaleLowerCase().includes(needle))),
      )
      .sort((a, b) => {
        if (sort === "name") return a.name.localeCompare(b.name, "zh-CN");
        if (sort === "price") return (b.price ?? -1) - (a.price ?? -1);
        if (sort === "purchase")
          return (
            (b.purchaseDate || "").localeCompare(a.purchaseDate || "") ||
            Date.parse(b.createdAt) - Date.parse(a.createdAt)
          );
        return (
          (P.deadline(a) || "9999").localeCompare(P.deadline(b) || "9999") ||
          a.name.localeCompare(b.name, "zh-CN")
        );
      });
  }
  function countdownMarkup(item, today) {
    const info = P.deadlineInfo(item, today);
    if (item.status !== "active") {
      return `<span class="deadline-badge ${item.status}">${icon(item.status === "eaten" ? "check" : "archive-x")}${P.statusNames[item.status]}</span><p class="deadline-caption">${dateText(item.finishedDate)} 处理</p>${info.date ? `<p class="deadline-caption">原截止 ${dateText(info.date)}</p>` : ""}`;
    }
    const label =
      info.days === null
        ? "待补日期"
        : info.days < 0
          ? `已超 <strong>${Math.abs(info.days)}</strong> 天`
          : info.days === 0
            ? "今天截止"
            : `剩 <strong>${info.days}</strong> 天`;
    return `<span class="deadline-badge ${info.status}">${icon(info.status === "missing" ? "calendar-plus" : info.status === "expired" ? "circle-alert" : "clock-3")}${label}</span><p class="deadline-caption">${info.date ? `${dateText(info.date)} · ${info.basis}` : "补充日期后开始倒数"}</p>`;
  }
  function rowMarkup(item, today) {
    const name = escape(item.name);
    const info = P.deadlineInfo(item, today);
    const detailDates = [
      `购买 ${dateText(item.purchaseDate)}`,
      item.shelfLife ? `保质期 ${escape(item.shelfLife)}` : "",
      item.openedDate ? `开封 ${dateText(item.openedDate)}` : "",
      item.expiryDate ? `包装到期 ${dateText(item.expiryDate)}` : "",
    ].filter(Boolean);
    const notes = [item.shop && `购于 ${item.shop}`, item.notes]
      .filter(Boolean)
      .join(" · ");
    return `<article class="food-row" data-id="${escape(item.id)}" data-status="${item.status === "active" ? info.status : item.status}">
      <div class="food-identity">
        <div class="food-icon category-${item.category}" aria-hidden="true">${icon(P.categoryIcons[item.category])}</div>
        <div class="food-copy"><div class="food-title"><h2>${name}</h2><span class="storage-tag">${P.storageNames[item.storage]}</span></div>
          <p class="food-amount"><span>${escape(item.quantity || "规格待补充")}</span><strong>${money(item.price)}</strong>${item.remaining ? `<span>剩余 ${escape(item.remaining)}</span>` : ""}</p>
          <p class="food-dates">${detailDates.map((text) => `<span>${text}</span>`).join("")}</p>
          ${notes ? `<p class="food-note">${escape(notes)}</p>` : ""}
        </div>
      </div>
      <div class="countdown">${countdownMarkup(item, today)}</div>
      <div class="row-actions">
        ${
          item.status === "active"
            ? `<button type="button" class="eat-button" data-action="eaten" title="记录为已吃完" aria-label="吃完 ${name}">${icon("check")}吃完</button>`
            : `<button type="button" class="eat-button" data-action="restore" title="恢复到库存" aria-label="恢复 ${name}">${icon("undo-2")}恢复</button>`
        }
        <button type="button" class="icon-button" data-action="edit" title="编辑记录" aria-label="编辑 ${name}">${icon("pencil")}</button>
        ${item.status === "active" ? `<button type="button" class="icon-button" data-action="discarded" title="记录为已丢弃" aria-label="丢弃 ${name}">${icon("archive-x")}</button>` : `<button type="button" class="icon-button" data-action="delete" title="删除这条记录" aria-label="删除 ${name}">${icon("trash-2")}</button>`}
      </div>
    </article>`;
  }
  function render() {
    const today = P.localDate();
    lastDay = today;
    const stats = P.summarize(state.items, today);
    $("#current-date").textContent = new Intl.DateTimeFormat("zh-CN", {
      month: "long",
      day: "numeric",
      weekday: "long",
    }).format(new Date());
    $("#stat-total").innerHTML = `${stats.total}<small>项</small>`;
    $("#stat-soon").innerHTML = `${stats.soon}<small>项</small>`;
    $("#stat-expired").innerHTML = `${stats.expired}<small>项</small>`;
    $("#stat-spent").textContent = money(stats.spent);
    $("#stat-spent-foot").textContent = stats.unknownPrices
      ? `${stats.unknownPrices}项金额待确认，未计入`
      : "所有已登记商品，含已吃完与丢弃";
    $("#missing-notice").hidden = stats.missing === 0;
    $("#missing-title").textContent =
      `${stats.missing} 项在库食材，还缺一个截止日期`;
    $("#inventory-count").textContent = stats.total;
    $("#history-count").textContent = state.items.length;
    document.querySelectorAll("[data-view]").forEach((button) => {
      const active = button.dataset.view === view;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    $("#filters").innerHTML = filters[view]
      .map(([value, label]) => {
        const count = state.items.filter((item) =>
          matches(item, value, today),
        ).length;
        return `<button type="button" data-filter="${value}" class="${filter === value ? "active" : ""}" aria-pressed="${filter === value}">${label}<span>${count}</span></button>`;
      })
      .join("");
    const items = selectedItems(today);
    $("#result-count").textContent =
      `共 ${items.length} 项${view === "inventory" ? "在库" : "记录"}`;
    $("#food-list").innerHTML = items
      .map((item) => rowMarkup(item, today))
      .join("");
    $("#empty-state").hidden = items.length > 0;
    const trulyEmpty =
      state.items.length === 0 || (view === "inventory" && stats.total === 0);
    $("#empty-title").textContent = trulyEmpty
      ? "食材都安排好了"
      : "没有符合条件的食材";
    $("#empty-description").textContent = trulyEmpty
      ? "买了新食材，就在这里记下来。"
      : "试试其他关键词或筛选条件。";
    $("#empty-button").textContent = trulyEmpty ? "记一笔采购" : "清除筛选";
    $("#empty-button").dataset.add = String(trulyEmpty);
    $("#refresh-label").textContent =
      `${dateText(today)} 已更新 · 每天自动重新计算，重新打开也会刷新`;
    $("#saved-label").innerHTML =
      `<span></span>${storageReadable && $("#storage-error").hidden ? "记录保存在当前浏览器" : "请检查记录保存状态"}`;
    icons();
  }
  function setView(nextView, nextFilter = "all") {
    view = nextView;
    filter = nextFilter;
    render();
  }
  function showForm(item = null) {
    form.reset();
    $("#form-error").hidden = true;
    $("#form-title").textContent = item ? "编辑食材记录" : "记一笔采购";
    const values = item || {
      category: "prepared",
      storage: "unknown",
      purchaseDate: P.localDate(),
      dateBasis: "label",
    };
    for (const element of form.elements)
      if (element.name) element.value = values[element.name] ?? "";
    editingRevision = item?.updatedAt || null;
    previewDeadline();
    foodDialog.showModal();
    field("name").focus();
  }
  function previewDeadline() {
    const info = P.deadlineInfo({
      expiryDate: field("expiryDate").value,
      useByDate: field("useByDate").value,
      dateBasis: field("dateBasis").value,
    });
    $("#deadline-preview").textContent =
      info.days === null
        ? field("shelfLife").value.trim()
          ? `已记保质期 ${field("shelfLife").value.trim()}；还需包装上的具体到期日，才能开始倒计时。`
          : "尚未填写截止日，保存后标记为“待补日期”。"
        : `${info.basis} ${dateText(info.date)} · ${info.days < 0 ? `已超${-info.days}天` : info.days === 0 ? "今天截止" : `剩余${info.days}天`}`;
  }
  async function confirmAction(title, description, actionLabel) {
    $("#confirm-title").textContent = title;
    $("#confirm-description").textContent = description;
    $("#confirm-action").textContent = actionLabel;
    confirmDialog.returnValue = "cancel";
    confirmDialog.showModal();
    return new Promise((resolve) =>
      confirmDialog.addEventListener(
        "close",
        () => resolve(confirmDialog.returnValue === "confirm"),
        { once: true },
      ),
    );
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    $("#form-error").hidden = true;
    try {
      const values = Object.fromEntries(new FormData(form));
      const existing = state.items.find((item) => item.id === values.id);
      if (values.id && (!existing || existing.updatedAt !== editingRevision))
        throw new Error("这条记录已在另一页面修改，请关闭后重新编辑。");
      if (!values.id && state.items.length >= 5000)
        throw new Error("已达到5000项记录上限，请先整理记录。");
      const now = new Date().toISOString();
      const item = P.validateItem({
        ...values,
        id:
          existing?.id ||
          (crypto.randomUUID
            ? crypto.randomUUID()
            : `food-${Date.now()}-${Math.random().toString(36).slice(2)}`),
        price: values.price.trim() === "" ? null : Number(values.price),
        status: existing?.status || "active",
        finishedDate: existing?.finishedDate || "",
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        source: existing?.source || "手动登记",
        productDetailsRevision: existing?.productDetailsRevision || "",
      });
      const next = existing
        ? state.items.map((value) => (value.id === item.id ? item : value))
        : [...state.items, item];
      if (commit(next)) {
        foodDialog.close();
        toast(existing ? "记录已更新" : "采购已记下");
      }
    } catch (error) {
      $("#form-error").textContent = error.message;
      $("#form-error").hidden = false;
    }
  });
  $("#food-list").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const item = state.items.find(
      (value) => value.id === button.closest("[data-id]").dataset.id,
    );
    if (!item) return;
    const action = button.dataset.action;
    if (action === "edit") {
      showForm(item);
      return;
    }
    if (action === "delete") {
      if (
        await confirmAction(
          "删除这条记录？",
          `“${item.name}”将从购买记录和金额统计中移除。此操作不能撤销，建议先导出备份。`,
          "删除记录",
        )
      ) {
        if (commit(state.items.filter((value) => value.id !== item.id)))
          toast("记录已删除");
      }
      return;
    }
    if (
      action === "discarded" &&
      !(await confirmAction(
        "记为已丢弃？",
        `“${item.name}”将移入购买记录，仍保留金额和明细，可以随时恢复。`,
        "记为已丢弃",
      ))
    )
      return;
    const updated = {
      ...item,
      status: action === "restore" ? "active" : action,
      finishedDate: action === "restore" ? "" : P.localDate(),
      updatedAt: new Date().toISOString(),
    };
    if (
      commit(
        state.items.map((value) => (value.id === item.id ? updated : value)),
      )
    )
      toast(
        action === "restore"
          ? "已恢复到库存"
          : action === "eaten"
            ? "已记为吃完，可在购买记录中恢复"
            : "已记录丢弃，可在购买记录中恢复",
      );
  });
  document.addEventListener("click", (event) => {
    const filterButton = event.target.closest("[data-filter]");
    if (filterButton) {
      if (filterButton.closest(".summary")) {
        query = "";
        storageFilter = "all";
        $("#search").value = "";
        $("#storage-filter").value = "all";
        setView("inventory", filterButton.dataset.filter);
      } else {
        filter = filterButton.dataset.filter;
        render();
      }
    }
    const viewButton = event.target.closest("[data-view]");
    if (viewButton) setView(viewButton.dataset.view);
    if (event.target.closest("[data-close-dialog]")) foodDialog.close();
  });
  $("#add-button").addEventListener("click", () => showForm());
  $("#missing-button").addEventListener("click", () => {
    query = "";
    storageFilter = "all";
    $("#search").value = "";
    $("#storage-filter").value = "all";
    setView("inventory", "missing");
    $("#food-list").scrollIntoView({
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
      block: "start",
    });
  });
  $("#empty-button").addEventListener("click", () => {
    if ($("#empty-button").dataset.add === "true") {
      showForm();
      return;
    }
    query = "";
    storageFilter = "all";
    filter = "all";
    $("#search").value = "";
    $("#storage-filter").value = "all";
    render();
  });
  $("#search").addEventListener("input", (event) => {
    query = event.target.value;
    render();
  });
  $("#storage-filter").addEventListener("change", (event) => {
    storageFilter = event.target.value;
    render();
  });
  $("#sort").addEventListener("change", (event) => {
    sort = event.target.value;
    render();
  });
  form.addEventListener("input", previewDeadline);
  form.addEventListener("change", previewDeadline);
  $("#export-button").addEventListener("click", () => {
    const contents =
      rawDamagedData ??
      JSON.stringify(
        { ...state, exportedAt: new Date().toISOString() },
        null,
        2,
      );
    const url = URL.createObjectURL(
      new Blob([contents], { type: "application/json;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `食材记录${rawDamagedData === null ? "" : "-原始数据"}-${P.localDate()}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast("备份文件已生成");
  });
  $("#import-button").addEventListener("click", () =>
    $("#import-file").click(),
  );
  $("#import-file").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    event.target.value = "";
    if (!storageReadable) {
      toast("已有记录读取异常，请先导出并检查原始记录。");
      return;
    }
    try {
      if (file.size > 10 * 1024 * 1024)
        throw new Error("备份文件超过10MB，请检查文件。");
      const incoming = P.parseBackup(await file.text());
      if (
        await confirmAction(
          "合并导入备份？",
          `文件含 ${incoming.items.length} 项记录。相同编号保留更新时间较新的内容，现有记录继续保留。`,
          "合并导入",
        )
      ) {
        if (commit(P.mergeItems(state.items, incoming.items)))
          toast("备份已合并导入");
      }
    } catch (error) {
      toast(`导入失败：${error.message}`);
    }
  });
  function refreshDates() {
    if (P.localDate() !== lastDay) {
      render();
      if (foodDialog.open) previewDeadline();
    }
    scheduleMidnight();
  }
  function scheduleMidnight() {
    clearTimeout(midnightTimer);
    const next = new Date();
    next.setHours(24, 0, 1, 0);
    midnightTimer = setTimeout(
      refreshDates,
      Math.max(1000, next.getTime() - Date.now()),
    );
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshDates();
  });
  window.addEventListener("focus", refreshDates);
  window.addEventListener("pageshow", refreshDates);
  setInterval(() => {
    if (!document.hidden && P.localDate() !== lastDay) refreshDates();
  }, 60000);
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== P.STORAGE_KEY) return;
    try {
      if (event.newValue === null) throw new Error("另一页面清除了存储");
      state = P.parseBackup(event.newValue);
      storageReadable = true;
      rawDamagedData = null;
      $("#storage-error").hidden = true;
      render();
      toast("已同步此浏览器另一页面的修改");
    } catch (error) {
      storageReadable = false;
      if (event.newValue !== null) rawDamagedData = event.newValue;
      showStorageError(
        "另一页面的存储发生变化，暂时停止保存。请导出备份后刷新检查。",
      );
    }
  });
  load();
  render();
  scheduleMidnight();
})();
