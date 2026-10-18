(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const format = (value) =>
    new Intl.NumberFormat("tr-TR").format(Number(value) || 0);
  const date = (value) =>
    new Intl.DateTimeFormat("tr-TR", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  const node = (tag, className, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const routeNames = {
    runbook: "Hazır çözüm",
    cache: "Önbellek",
    rag: "Kaynaklı yanıt",
    clarify: "Bilgi isteği",
    handoff: "İnsan desteği",
    ticket: "Destek kaydı",
    resolved: "Çözüldü",
  };
  const statusNames = {
    draft: "Taslak",
    queued: "Kuyrukta",
    resolved: "Çözüldü",
  };
  const actions = {
    "session.login": "Yönetici girişi",
    "session.logout": "Oturum kapatıldı",
    "model.pause": "Model çağrıları durduruldu",
    "model.resume": "Model çağrıları açıldı",
    "cache.clear": "Yanıt önbelleği temizlendi",
    "ticket.resolve": "Destek kaydı çözüldü",
    "ticket.reopen": "Destek kaydı tekrar açıldı",
  };
  const views = {
    overview: [
      "Genel bakış",
      "Operasyon merkezi",
      "Harcamayı izleyin. Gerektiğinde müdahale edin.",
    ],
    tickets: [
      "Destek kayıtları",
      "Destek kayıtları",
      "Onaylanan talepleri takip edin ve sonuçlandırın.",
    ],
    knowledge: [
      "Bilgi tabanı",
      "Kaynak ve arama kontrolü",
      "Şirket belgelerini ve erişim kapsamlarını doğrulayın.",
    ],
    audit: [
      "İşlem geçmişi",
      "İşlem geçmişi",
      "Yönetici müdahalelerinin izini takip edin.",
    ],
  };
  let csrf = "",
    user = null,
    data = null,
    books = [],
    toastTimer;
  function toast(message) {
    $("toast").textContent = message;
    $("toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ($("toast").hidden = true), 5000);
  }
  async function api(path, body) {
    const response = await fetch("/admin/api/" + path, {
      credentials: "same-origin",
      cache: "no-store",
      ...(body === undefined
        ? {}
        : {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": csrf,
            },
            body: JSON.stringify(body),
          }),
    });
    const value = await response.json();
    if (!response.ok) {
      const error = new Error(
        response.status === 401
          ? path === "login"
            ? "Yönetici anahtarı doğrulanamadı."
            : "Yönetici oturumu gerekli."
          : response.status === 429
            ? "Çok fazla giriş denemesi. Bir dakika sonra tekrar deneyin."
            : response.status === 404
              ? "Kayıt bu işlem için uygun değil."
              : "İşlem tamamlanamadı. Yetkiyi ve bağlantıyı kontrol edin.",
      );
      error.status = response.status;
      if (response.status === 401 && path !== "login" && path !== "session")
        window.location.reload();
      throw error;
    }
    return value;
  }
  function setView(view) {
    if (!views[view]) return;
    document
      .querySelectorAll(".view")
      .forEach((el) => (el.hidden = el.id !== "view-" + view));
    document.querySelectorAll("[data-view]").forEach((el) => {
      const active = el.dataset.view === view;
      el.classList.toggle("active", active);
      if (active) el.setAttribute("aria-current", "page");
      else el.removeAttribute("aria-current");
    });
    [
      $("breadcrumb").textContent,
      $("page-title").textContent,
      $("page-subtitle").textContent,
    ] = views[view];
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }
  function renderChart(rows) {
    const days = Array.from({ length: 7 }, (_, i) => {
      const day = new Date();
      day.setUTCHours(0, 0, 0, 0);
      day.setUTCDate(day.getUTCDate() - 6 + i);
      const key = day.toISOString().slice(0, 10);
      return {
        key,
        value: Number(rows.find((r) => r.day === key)?.requests ?? 0),
      };
    });
    const max = Math.max(1, ...days.map((d) => d.value)),
      svg = $("activity-chart"),
      ns = "http://www.w3.org/2000/svg";
    svg.replaceChildren();
    for (let i = 0; i < 4; i++) {
      const line = document.createElementNS(ns, "line");
      for (const [k, v] of Object.entries({
        x1: 0,
        x2: 700,
        y1: 15 + i * 50,
        y2: 15 + i * 50,
        stroke: "#edf0e8",
        "stroke-dasharray": "3 5",
      }))
        line.setAttribute(k, String(v));
      svg.append(line);
    }
    days.forEach((day, i) => {
      const rect = document.createElementNS(ns, "rect");
      for (const [k, v] of Object.entries({
        x: 30 + i * 100,
        y: 165 - Math.max(3, (day.value / max) * 140),
        width: 40,
        height: Math.max(3, (day.value / max) * 140),
        rx: 4,
        fill: i === 6 ? "#77975a" : "#dce5cf",
      }))
        rect.setAttribute(k, String(v));
      const title = document.createElementNS(ns, "title");
      title.textContent = day.key + ": " + day.value + " talep";
      rect.append(title);
      svg.append(rect);
    });
    $("chart-labels").replaceChildren(
      ...days.map((d) =>
        node(
          "span",
          "",
          new Intl.DateTimeFormat("tr-TR", {
            day: "2-digit",
            month: "short",
            timeZone: "UTC",
          }).format(new Date(d.key + "T00:00:00Z")),
        ),
      ),
    );
    const total = days.reduce((n, d) => n + d.value, 0);
    $("week-total").textContent = format(total) + " talep";
    $("chart-empty").textContent = total
      ? "Model çağrısı gerektirmeyen çözümler de talep sayısına dahildir."
      : "Henüz talep yok. Gelen talepler burada görünecek.";
  }
  function renderTickets() {
    const filtered = data.tickets.filter(
      (t) =>
        $("ticket-filter").value === "all" ||
        t.status === $("ticket-filter").value,
    );
    $("ticket-rows").replaceChildren(
      ...filtered.map((t) => {
        const tr = node("tr"),
          issue = node("td"),
          button = node(
            "button",
            "ticket-name",
            t.body.split("\n")[0].replace(/^Sorun: /, ""),
          );
        button.type = "button";
        button.addEventListener("click", () => {
          $("ticket-title").textContent = "Kayıt " + t.id.slice(0, 8);
          $("ticket-detail").textContent = t.body;
          $("ticket-dialog").showModal();
        });
        issue.append(button, node("span", "ticket-id", t.id.slice(0, 8)));
        const status = node("td");
        status.append(
          node(
            "span",
            "badge " +
              (t.status === "resolved"
                ? "success"
                : t.status === "queued"
                  ? "warning"
                  : "neutral"),
            statusNames[t.status] ?? t.status,
          ),
        );
        const control = node("td", "align-right");
        if (t.status === "queued" || t.status === "resolved") {
          const next = t.status === "queued" ? "resolved" : "queued";
          const action = node(
            "button",
            "button secondary ticket-action",
            next === "resolved" ? "Çözüldü" : "Tekrar aç",
          );
          action.type = "button";
          action.addEventListener("click", async () => {
            action.disabled = true;
            try {
              await api("ticket", { id: t.id, status: next });
              await refresh();
              toast(
                next === "resolved"
                  ? "Kayıt çözüldü olarak işaretlendi."
                  : "Kayıt tekrar kuyruğa alındı.",
              );
            } catch (e) {
              toast(e.message);
            } finally {
              action.disabled = false;
            }
          });
          control.append(action);
        } else control.append(node("span", "muted", "Kullanıcı onayı"));
        tr.append(
          issue,
          node("td", "", t.user),
          node("td", "", date(t.created)),
          status,
          control,
        );
        return tr;
      }),
    );
    $("ticket-empty").hidden = filtered.length > 0;
  }
  function renderBooks() {
    $("book-count").textContent = books.length + " kaynak";
    $("book-list").replaceChildren(
      ...books.map((b) => {
        const item = node("article", "book-item");
        const meta = node("div", "book-meta");
        meta.append(
          node("span", "badge neutral", b.scope),
          node("span", "", b.sections + " bölüm"),
          node("span", "", b.revision),
        );
        if (b.fastPath)
          meta.append(node("span", "badge success", "HAZIR ÇÖZÜM"));
        item.append(node("h3", "", b.title), meta);
        return item;
      }),
    );
    if (!books.length)
      $("book-list").append(
        node("p", "empty-state", "Bu şirkete ait kaynak bulunamadı."),
      );
  }
  function render() {
    const s = data.summary,
      queue = Number(
        data.ticketCounts.find((t) => t.status === "queued")?.count ?? 0,
      ),
      drafts = Number(
        data.ticketCounts.find((t) => t.status === "draft")?.count ?? 0,
      );
    $("metric-requests").textContent = format(s.requests);
    $("metric-calls").textContent = format(s.calls);
    $("metric-tokens").textContent = format(
      Number(s.inputTokens) + Number(s.outputTokens),
    );
    $("metric-queued").textContent = format(queue);
    $("nav-queued").textContent = format(queue);
    $("metric-drafts").textContent = format(drafts) + " onay bekleyen taslak";
    $("metric-users").textContent = format(data.users) + " kullanıcı eşlemesi";
    const local = data.routes
      .filter((r) => r.route === "runbook" || r.route === "cache")
      .reduce((n, r) => n + Number(r.count), 0);
    $("metric-local").textContent =
      format(local) + " talep hazır çözüm / önbellek";
    $("metric-usage").textContent =
      format(s.inputTokens) + " giriş · " + format(s.outputTokens) + " çıkış";
    $("backend").textContent =
      data.engine.backend === "rust" ? "Rust / WebAssembly" : "TypeScript";
    $("groq-status").textContent = data.engine.groqConfigured
      ? "Yapılandırıldı"
      : "Anahtar gerekli";
    $("telegram-status").textContent = data.channels.telegram
      ? "Yapılandırıldı"
      : "Yapılandırılmadı";
    $("whatsapp-status").textContent = data.channels.whatsapp
      ? "Yapılandırıldı"
      : "Yapılandırılmadı";
    $("cache-count").textContent = format(data.cacheEntries) + " kayıt";
    $("engine-badge").textContent = data.paused ? "Duraklatıldı" : "Çalışıyor";
    $("engine-badge").className =
      "badge " + (data.paused ? "warning" : "success");
    $("paused-banner").hidden = !data.paused;
    $("pause-toggle").textContent = data.paused ? "Sürdür" : "Duraklat";
    $("updated").textContent =
      "Son güncelleme " +
      new Intl.DateTimeFormat("tr-TR", {
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(data.now));
    renderChart(data.daily);
    const routes = data.routes.length
      ? data.routes
      : [
          { route: "runbook", count: 0 },
          { route: "cache", count: 0 },
          { route: "rag", count: 0 },
        ];
    $("route-list").replaceChildren(
      ...routes.map((r) => {
        const row = node("div", "route-row"),
          progress = node("progress");
        progress.max = Math.max(1, Number(s.requests));
        progress.value = Number(r.count);
        progress.setAttribute("aria-label", routeNames[r.route] ?? r.route);
        row.append(
          node("span", "", routeNames[r.route] ?? r.route),
          progress,
          node("strong", "", format(r.count)),
        );
        return row;
      }),
    );
    $("limits").replaceChildren(
      ...[
        data.limits.maxCalls + " çağrı / talep",
        data.limits.maxOutput + " çıktı tokenı",
        data.limits.dailyCallsPerOwner + " çağrı / kullanıcı / gün",
      ].map((t) => node("span", "", t)),
    );
    $("unknown-usage").hidden = !s.unreportedCalls;
    $("unknown-usage").textContent =
      format(s.unreportedCalls) +
      " çağrının token kullanımı raporlanamadı. Gösterilen toplam bu çağrıları içermez.";
    renderTickets();
    $("audit-list").replaceChildren(
      ...data.audit.map((a) => {
        const row = node("article", "audit-item"),
          copy = node("div");
        copy.append(
          node("strong", "", actions[a.action] ?? a.action),
          node(
            "p",
            "",
            a.actor +
              (a.detail.count !== undefined
                ? " · " + a.detail.count + " kayıt"
                : ""),
          ),
        );
        const time = node("time", "", date(a.created));
        time.dateTime = new Date(a.created).toISOString();
        row.append(node("span", "audit-icon", "◷"), copy, time);
        return row;
      }),
    );
  }
  async function refresh() {
    const button = $("refresh");
    button.disabled = true;
    try {
      const value = await api("overview");
      if (user) {
        data = value;
        render();
      }
    } finally {
      button.disabled = false;
    }
  }
  async function openWorkspace(session) {
    csrf = session.csrf;
    user = session.user;
    $("admin-key").value = "";
    $("admin-name").textContent = user.id;
    $("tenant-name").textContent = user.tenant;
    $("login").hidden = true;
    $("workspace").hidden = false;
    const result = await api("knowledge");
    books = result.books;
    renderBooks();
    await refresh();
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }
  function confirmAction(title, description, label, action) {
    $("confirm-title").textContent = title;
    $("confirm-description").textContent = description;
    const submit = $("confirm-submit");
    submit.textContent = label;
    submit.disabled = false;
    submit.onclick = async () => {
      submit.disabled = true;
      try {
        await action();
        $("confirm-dialog").close();
        await refresh();
      } catch (e) {
        toast(e.message);
      } finally {
        submit.disabled = false;
      }
    };
    $("confirm-dialog").showModal();
  }
  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button");
    button.disabled = true;
    $("login-error").textContent = "";
    try {
      await openWorkspace(await api("login", { token: $("admin-key").value }));
    } catch (e) {
      $("login-error").textContent = e.message;
    } finally {
      $("admin-key").value = "";
      button.disabled = false;
    }
  });
  document
    .querySelectorAll("[data-view]")
    .forEach((button) =>
      button.addEventListener("click", () => setView(button.dataset.view)),
    );
  $("refresh").addEventListener("click", () =>
    refresh().catch((e) => toast(e.message)),
  );
  $("ticket-filter").addEventListener("change", () => renderTickets());
  $("logout").addEventListener("click", async () => {
    try {
      await api("logout", {});
      window.location.reload();
    } catch (e) {
      toast(e.message);
    }
  });
  $("pause-toggle").addEventListener("click", () => {
    const paused = !data.paused;
    confirmAction(
      paused ? "Model çağrılarını durdur?" : "Model çağrılarını sürdür?",
      paused
        ? "Bu şirket için yeni Groq çağrıları durdurulur. Başlamış bir istek tamamlanabilir. Hazır çözümler ve destek kayıtları çalışmaya devam eder."
        : "Bu şirketin talepleri mevcut token ve çağrı limitleriyle tekrar Groq kullanabilir.",
      paused ? "Çağrıları durdur" : "Çağrıları sürdür",
      async () => {
        await api("pause", { paused });
        toast(
          paused
            ? "Yeni model çağrıları durduruldu."
            : "Model çağrıları yeniden açıldı.",
        );
      },
    );
  });
  $("clear-cache").addEventListener("click", () =>
    confirmAction(
      "Yanıt önbelleğini temizle?",
      user.tenant +
        " çalışma alanının önbelleği temizlenir. Sonraki sorular yeni model çağrısı gerektirebilir. Destek kayıtları ve kullanıcı geçmişi korunur.",
      "Önbelleği temizle",
      async () => {
        const result = await api("cache/clear", {});
        toast(result.cleared + " önbellek kaydı temizlendi.");
      },
    ),
  );
  $("search-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button");
    button.disabled = true;
    try {
      const result = await api("search", { query: $("search-query").value });
      $("search-timing").textContent =
        result.backend + " · " + result.durationMs + " ms · 0 model çağrısı";
      $("search-results").replaceChildren(
        ...result.results.map((r) => {
          const item = node("article", "source-result");
          item.append(
            node("h3", "", r.title + " / " + r.section),
            node("div", "source-id", r.id + " · " + r.scope),
            node("p", "", r.text),
          );
          return item;
        }),
      );
      if (!result.results.length)
        $("search-results").append(
          node(
            "p",
            "empty-state",
            "Bu sorguyla eşleşen yetkili kaynak bulunamadı.",
          ),
        );
    } catch (e) {
      toast(e.message);
    } finally {
      button.disabled = false;
    }
  });
  api("session")
    .then(openWorkspace)
    .catch(() => {
      $("login").hidden = false;
      $("workspace").hidden = true;
    });
})();
