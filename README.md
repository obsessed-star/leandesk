# LeanDesk

**İşletmeler için kaynak gösteren, token bütçeli IT destek ajanı.**

LeanDesk çalışanların teknik sorunlarını onaylı şirket belgelerinden çözer. Bilinen hata kodlarında model çağırmaz; gerektiğinde ilgili bölümleri Groq'a gönderir. Çözülemeyen sorunlar için açık kullanıcı onayıyla yerel destek kaydı hazırlar.

TypeScript · Node.js 24 · Groq · SQLite · eve · Telegram · WhatsApp

## Başlangıç

```sh
npm ci
npm run demo
npm test
npm run evaluate
```

Anahtarsız demo gerçek uygulama çekirdeğinde VPN çözümü, kayıt taslağı ve onay akışını çalıştırır. Kullanıcılar ve belgeler sentetiktir.

`.env.example` dosyasını `.env` olarak kopyalayın. Örnek API token'ını rastgele bir değerle değiştirin; model yanıtları için `GROQ_API_KEY` ekleyin. Gerçek anahtarları Git'e göndermeyin.

```sh
npm start
```

Yerel API `127.0.0.1:4321` adresinde açılır. PowerShell:

```powershell
$headers = @{ Authorization = 'Bearer YOUR_LOCAL_API_TOKEN' }
$body = @{ message = 'Windows VPN 809 hatası'; conversation = 'active'; eventId = 'demo-1' } | ConvertTo-Json
Invoke-RestMethod http://localhost:4321/api/messages -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
```

`GET /healthz` herkese açık sağlık kontrolüdür. `GET /api/metrics` aynı bearer kimliğiyle yalnızca o kullanıcının ölçümlerini döndürür. Yanıtlar `route`, `text`, `citations`, `usage` içerir. Tekrar teslimatta aynı `eventId` kullanılmalıdır.

## Token ekonomisi

| Karar                              | Davranış                                                       |
| ---------------------------------- | -------------------------------------------------------------- |
| Bilinen hata                       | Onaylı runbook, sıfır model çağrısı                            |
| Tekrarlanan talep                  | Yetki, vaka ve belge sürümüne bağlı 15 dakikalık önbellek      |
| Yeni sorun                         | Yetki filtresinden sonra yerel BM25; en fazla 3 bölüm          |
| Belirsiz kaynak                    | Bir `search_knowledge` aracı; toplam en fazla 2 model çağrısı  |
| Yetersiz kanıt veya geçersiz yanıt | Açıklama isteği veya insan desteği; yeniden üretme döngüsü yok |

Vaka belleği ilk sorun ve son üç denemeyle sınırlıdır; LLM özetleme çağrısı yapılmaz. Bağlam varsayılan 2.600 UTF-8 byte, her model çıktısı en fazla 384 tokendir. Vaka başına 18.000 raporlanan token ve çağrı öncesi muhafazakâr rezerv uygulanır. Kullanıcı başına son 24 saatte en fazla 40 model çağrısı vardır. Byte rezervi kesin tokenizer veya fatura tavanı değildir. Kullanım bilgisi eksikse vaka için yeni çağrı durur; 429 otomatik tekrar başlatmaz.

### Canlı ölçüm

[Kaydedilmiş Groq sonucunda](evidence/live-groq.json), aynı model ve çıktı sınırıyla iki sentetik talep karşılaştırıldı:

| Akış                                         | Giriş + çıkış tokenı | Model çağrısı |
| -------------------------------------------- | -------------------: | ------------: |
| Tüm yetkili runbook'ları gönderen temel akış |                1.758 |             2 |
| LeanDesk                                     |                  470 |             1 |
| MFA sorusunun önbellekten tekrarı            |                    0 |             0 |

Bu küçük örnekte **%73,3 daha az token** kullanıldı. Model `qwen/qwen3.8-27b`, tarih 17 Ekim 2026. Bu sonuç üretim çözüm oranını veya her soruda aynı tasarrufu kanıtlamaz. `npm run live` kota harcayan yeni bir ölçüm yapar; anahtarı ortamdan veya gizli yerel girişten alır. `npm run evaluate` dört sentetik arama vakasını model çağırmadan sınar.

## İkinci verim iyileştirmesi

Güncel sürüm soruyu ve son denemeyi bağlama iki kez eklemez. Kaynaklar yalnızca kimlik ve **tam bölüm metni** içeren JSON dizisi olarak gönderilir; güvenlik yönergeleri kesilmez. İkinci araç yanıtı yalnızca yeni kaynakları taşır. Büyük/küçük harf ve boşluk farkları aynı önbelleği kullanır; farklı olgular, kullanıcılar veya yetkiler birleştirilmez.

[Anahtarsız karşılaştırma](evidence/efficiency-v2.json), önceki `c946a33` sürümüne karşı aynı sentetik girdilerle:

| Ölçüm                                                 |       Önce |                     Şimdi |
| ----------------------------------------------------- | ---------: | ------------------------: |
| İlk MFA isteğinin içerik boyutu                       | 1.541 byte | 1.334 byte (%13,4 azalma) |
| Aynı sorunun üç harf/boşluk varyantında model çağrısı |          3 |                         1 |
| Araç aramalı akışın toplam içerik boyutu              | 5.860 byte |                4.079 byte |
| 800 belgede sıcak arama medyanı                       | 223,383 ms |                  1,279 ms |

Bu ölçüm taklit sağlayıcıyla **istek byte'larını ve çağrı sayısını** ölçer; yeni canlı token veya yanıt kalitesi ölçümü değildir. Arama süresi bu makinedeki yedi sıcak çalıştırmanın medyanıdır; indeks oluşturma hariçtir ve üretimde değişir. Belge başına sözcük frekansı bir kez hesaplanır; sorgu istatistikleri yalnızca yetkili belgelerden alınır. Önceki canlı %73,3 sonucu yukarıda tarihli olarak korunmuştur.

```sh
node --import tsx scripts/efficiency.ts
# Önceki sürümün yerel checkout'u varsa:
node --import tsx scripts/efficiency.ts --baseline ../leandesk-before
```

## Rust ile arama hızlandırma

BM25 araması için bağımlılıksız Rust + WebAssembly motoru eklendi. Ters indeks yalnızca sorgu terimlerinin geçtiği kayıtları puanlar ve ilk üç sonucu seçer; her sorguda yeni süreç başlatılmaz. Türkçe normalizasyonu ortak TypeScript katmanında kalır. Tenant/scope filtresi Rust içinde de uygulanır; IDF yalnızca yetkili belgelerden hesaplanır.

`SUPPORT_SEARCH_BACKEND=auto` varsayılanında 64 ve üzeri bölüm Rust kullanır; küçük tabanlar TypeScript kullanır. `rust` Rust'ı zorunlu tutar ve eksik/bozuk/eski derlemede hata verir. `typescript` karşılaştırma veya geri dönüş içindir. `auto` Rust yüklenemezse TypeScript'e döner. Aktif motor `/healthz` yanıtındaki `searchBackend` alanında görünür.

Depodaki `native/search.wasm` hazır derlemedir; normal kullanım için Rust kurulumu gerekmez. Derlemeyi değiştirmek için [Rust'ın WASM hedefini](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html) kurun:

```sh
rustup target add wasm32-unknown-unknown
npm run build:rust
npm test
npm run bench:rust
```

Kaynak ve WASM SHA-256 değerleri `native/manifest.json` ile doğrulanır. Modül host import'u içermez; dosya, ağ veya shell yetkisi verilmez. CI hem yayımlanan derlemeyi hem kaynaklardan yeniden derlenen Rust yolunu test eder.

[18 Ekim 2026 ölçümü](evidence/rust-search.json), gerçek Rust WASM ile önceki TypeScript motorunu aynı sentetik belgeler ve sorgularla karşılaştırır:

| Belge  | TypeScript sıcak arama | Rust sıcak arama | Hızlanma |
| ------ | ---------------------: | ---------------: | -------: |
| 800    |              0,1354 ms |        0,0309 ms |    4,38× |
| 8.000  |              6,1920 ms |        0,3923 ms |   15,78× |
| 20.000 |             17,2058 ms |        0,6878 ms |   25,02× |

Değerler beş sorguluk 15 sıcak çalıştırmanın medyanıdır; JS/WASM geçişi, yetki denetimi ve sonuç eşlemesi dahildir. Aynı sonuç sıralaması doğrulandı. Bu makinedeki sentetik arama ölçümüdür; token veya uçtan uca ajan yanıt süresi ölçümü değildir. Kazanç yalnızca dilden değil, ters indeks ve sınırlı sonuç seçimi algoritmasından da gelir. İlk indeks kurma maliyeti artar: 20.000 belgede TypeScript 583 ms, Rust 743 ms; sık sorguda amorti edilir.

## Yönetici paneli

![LeanDesk Control — gerçek yerel doğrulama ekranı](admin/preview.png)

`npm start` veya derlenmiş eve sunucusunda **`/admin`** adresini açın. Panel aynı SQLite verilerini kullanır; token kullanımı, çözüm yolları, yedi günlük talep grafiği, arama motoru, kanal yapılandırması ve destek kuyruğunu gösterir. Panel veya kaynak arama testi Groq çağırmaz.

Yönetici anahtarını destek API token'ından ayrı üretin. `.env` dosyasında örnek yapılandırma:

```dotenv
SUPPORT_ADMIN_IDENTITIES_JSON=[{"id":"ops","tenant":"demo","token":"REPLACE_WITH_A_SEPARATE_RANDOM_64_HEX_TOKEN"}]
```

Anahtar en az 32 karakter olmalıdır; örnekteki değeri kullanmayın. Rastgele anahtarı yerelde `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` ile oluşturabilirsiniz. Anahtarı paneldeki giriş alanına girin. Tarayıcıda HttpOnly, SameSite=Strict oturum çerezi tutulur; anahtar localStorage'a yazılmaz. Oturum sekiz saat sonra veya sunucu yeniden başlatılınca biter. Birden fazla şirket için ayrı yönetici tanımları kullanın.

HTTPS reverse proxy arkasında `SUPPORT_ADMIN_ORIGIN=https://YOUR_HOST` ve `SUPPORT_ADMIN_SECURE_COOKIE=true` ayarlayın. Panel ile API aynı origin'de sunulur; yazma işlemleri Origin ve CSRF denetiminden geçer. Başarısız girişler süreç genelinde 10 deneme/dakika ile sınırlandırılır. Bu pilot, kurumsal SSO/MFA yerine geçmez.

Panel kontrolleri:

- **Model duraklat / sürdür:** yalnızca yöneticinin şirketinde yeni Groq çağrılarını engeller. Başlamış bir çağrı tamamlanabilir; hazır çözümler, önbellek ve kayıt taslakları çalışır.
- **Önbelleği temizle:** yalnızca şirketin güncel kimlik eşlemelerine ait yanıt önbelleğini temizler. Sonraki talepler tekrar model harcayabilir.
- **Kayıt çöz / tekrar aç:** kullanıcının önceden onayladığı yerel kayıtların durumunu değiştirir. Yönetici, kullanıcı taslağını onun adına onaylayamaz.
- **Kaynak kontrolü:** şirketin belgelerini listeler ve model çağırmadan ilk üç arama sonucunu gösterir.
- **İşlem geçmişi:** giriş, çıkış ve değişiklikleri şirket kapsamında kaydeder.

Metrikler son 24 saati; grafik günleri UTC'ye göre son yedi günü kapsar. Talep sayısına kayıt komutları da dahildir. Eksik sağlayıcı token raporları ayrıca işaretlenir; tahmini para maliyeti gösterilmez. Panel en güncel 50 kaydı ve 30 yönetici işlemini listeler. Eski veya artık eşlenmeyen kullanıcıların verileri yönetici görünümüne otomatik katılmaz. Önceki sürümden gelen sahip bilgisi olmayan önbellek satırları toplu temizlenmez; kendi TTL'leri uygulanır.

## Telegram ve WhatsApp

Telegram eve'nin yerel kanalıyla, WhatsApp Chat SDK adaptörüyle aynı çekirdeğe bağlanır. İmza/secret denetimleri test edilir. Gerçek platform hesabıyla uçtan uca teslimat henüz doğrulanmadı.

Kanal değişkenlerini `.env` içine koyup:

```sh
npm run build
npm run serve
```

Tek Node.js 24 süreci, kalıcı disk ve HTTPS reverse proxy kullanın. `npm start` yalnızca API'yi sunar; webhook'lar eve sunucusundadır. Varsayılan eve model oturumu kapalıdır.

**Telegram:** BotFather ile bot oluşturun. `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, rastgele `TELEGRAM_WEBHOOK_SECRET_TOKEN` ayarlayın. [setWebhook](https://core.telegram.org/bots/api#setwebhook) adresini `https://YOUR_HOST/eve/v1/telegram`, `secret_token` değerini aynı secret yapın. Yalnızca özel insan metinleri işlenir.

**WhatsApp:** Meta Business / Cloud API kurulumu gerekir. `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN` ayarlayın. [Webhook kurulumunda](https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components) callback `https://YOUR_HOST/eve/v1/whatsapp` olur. Adaptör GET challenge ve POST imzasını doğrular. Meta'nın mesaj politikaları ve müşteri hizmeti penceresi geçerlidir.

Sunucu tarafı eşleme örneği; `subject` değerlerini gerçek platform kimlikleriyle değiştirip tek satırlık `SUPPORT_IDENTITIES_JSON` olarak kaydedin:

```json
[
  {
    "channel": "api",
    "subject": "YOUR_RANDOM_API_TOKEN",
    "id": "employee-1",
    "tenant": "demo",
    "scopes": ["it"]
  },
  {
    "channel": "telegram",
    "subject": "123456789",
    "id": "employee-1",
    "tenant": "demo",
    "scopes": ["it"]
  },
  {
    "channel": "whatsapp",
    "subject": "905551112233",
    "id": "employee-1",
    "tenant": "demo",
    "scopes": ["it"]
  }
]
```

Aynı `id`, `tenant`, `scopes` açıkça eşlenirse kanallar aktif vakayı paylaşır. Görünen ad veya mesajdaki şirket adı yetki vermez. Tanımsız kimlikler işlenmez.

## Bilgi ve destek kayıtları

`knowledge/runbooks.json` onaylı adımları, bölümleri, tenant, scope ve sürümü içerir. Gerçek belgelerinizi bu şemaya göre düzenleyin. Arama sözcüksel BM25'tir; embedding, PDF yükleme veya web tarama içermez. İçerik değişince önbellek sürümü değişir. Kaynak kimliği doğrulaması anlamsal doğruluğu tek başına kanıtlamaz.

- `/ticket`: sorun ve denemelerden yerel taslak oluşturur.
- `/confirm <id>`: yalnızca sahibi 30 dakika içinde onaylarsa yerel kuyruğa alır.
- `/resolved` veya `çözüldü`: aktif vakayı temizler.

Jira, Zendesk ve e-posta teslimi henüz uygulanmadı. Yerel kuyruk dış sisteme gönderilmiş gibi sunulmaz.

## Doğrulama ve sınırlar

Günlük çağrı bütçesi, geçmiş kullanım JSON'larını her istekte JavaScript'e taşımak yerine SQLite'taki sayısal çağrı alanı ve yalnızca pozitif çağrıları içeren indeks üzerinden hesaplanır. Kayan 24 saat sınırı ve kullanıcı izolasyonu korunur. Eski veritabanları açılırken tek seferlik, işlemsel bir geçiş uygulanır; ham kullanım kayıtları saklanır.

`npm run bench:budget` aynı sonucu veren iki sorguyu 50 bin sentetik kayıt üzerinde karşılaştırır. Node 24 ölçümünde medyan süre **22,6922 ms → 0,0034 ms** oldu. Örnek çoğunlukla model çağırmayan yerel olaylar içerir; beş ısınma ve 15 tekrar kullanılır. Ölçüm yalnızca bellekteki bütçe sorgusunu kapsar; geçiş, yazma, Groq gecikmesi ve toplam yanıt süresini kapsamaz. Ek model çağrısı yapılmaz. [Ölçüm dosyası](evidence/budget-performance.json), [tekrar çalıştırılabilir betik](scripts/bench-budget.ts).

```sh
npm run typecheck
npm test
npm run evaluate
npm run build
npm audit --audit-level=high
```

60 test; yetki izolasyonu, bütçe, eski veritabanı geçişi, kayan zaman sınırı, araç sınırı, sahte kaynak, tekrar teslim, kanal eşlemesi, onay ve adaptör imzalarını kapsar. Groq birim testleri taklittir; canlı sonuç ayrı kanıt dosyasındadır. GitHub Actions anahtarsız kontrolleri çalıştırır.

Bu sürüm tek sunuculu bir pilottur. Kurumsal SSO, dağıtık kilitleme, fiziksel veri silme, dış ticket göndericisi ve gerçek şirket değerlendirmesi üretime geçiş öncesi gereklidir. SQLite kalıcı disk ister. [Mimari](ARCHITECTURE.md) ve [güvenlik](SECURITY.md) sınırları açıklar.

## Geliştirme kaydı

**Codex 6.1 Sol ile geliştirildi.** Hedef; incelenebilir kod, tekrarlanabilir testler ve sınırlandırılmış model harcamasıdır.
