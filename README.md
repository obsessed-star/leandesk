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

```sh
npm run typecheck
npm test
npm run evaluate
npm run build
npm audit --audit-level=high
```

Testler yetki izolasyonu, bütçe, araç sınırı, sahte kaynak, tekrar teslim, kanal eşlemesi, onay ve adaptör imzalarını kapsar. Groq birim testleri taklittir; canlı sonuç ayrı kanıt dosyasındadır. GitHub Actions anahtarsız kontrolleri çalıştırır.

Bu sürüm tek sunuculu bir pilottur. Kurumsal SSO, dağıtık kilitleme, fiziksel veri silme, dış ticket göndericisi ve gerçek şirket değerlendirmesi üretime geçiş öncesi gereklidir. SQLite kalıcı disk ister. [Mimari](ARCHITECTURE.md) ve [güvenlik](SECURITY.md) sınırları açıklar.

## Geliştirme kaydı

**Codex 6.1 Sol ile geliştirildi.** Hedef; incelenebilir kod, tekrarlanabilir testler ve sınırlandırılmış model harcamasıdır.
