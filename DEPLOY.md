# راهنمای دیپلوی OpenBridge روی سرور شخصی (VPS)

این پروژه با Docker دیپلوی می‌شه: یک کانتینر Postgres، یک Redis، یک بک‌اند NestJS و یک nginx که هم فرانت رو سرو می‌کنه هم درخواست‌های API/سوکت رو proxy می‌کنه. همه‌چیز با یک اسکریپت (`deploy.sh`) بالا میاد.

## پیش‌نیاز

- یک VPS با لینوکس (ترجیحاً Ubuntu 22.04 یا 24.04) — حداقل **۱ گیگ رم و ۱ هسته** کافیه (اسکریپت خودش swap می‌سازه).
- دسترسی SSH با کاربر root یا کاربری که `sudo` داره.
- ریپوی گیت‌هاب پروژه باید **push شده و آپدیت** باشه (اسکریپت مستقیماً از گیت‌هاب کلون می‌کنه).

## مرحله ۱ — پوش کردن کد

روی سیستم خودت:

```bash
git add -A
git commit -m "..."
git push origin main
```

## مرحله ۲ — اتصال به سرور

```bash
ssh root@IP_SERVER
```

(اگه کاربر root نیست: `ssh user@IP_SERVER` و بعد جلوی دستورات لازمه `sudo` بزنی — خود اسکریپت این رو خودکار تشخیص می‌ده.)

## مرحله ۳ — اجرای اسکریپت دیپلوی

یک دستور، همه‌چیز رو خودش انجام می‌ده:

```bash
curl -fsSL https://raw.githubusercontent.com/hoseinrza/OpenBridge/main/deploy.sh | bash
```

این اسکریپت به ترتیب:

1. اگه swap نداری، ۲ گیگ swapfile می‌سازه (لازمه چون build کردن روی ۱ گیگ رم بدون swap کرش می‌کنه).
2. Docker و Docker Compose رو نصب می‌کنه (اگه نصب نیست).
3. ریپو رو توی `/opt/openbridge` کلون می‌کنه.
4. فایل `.env` رو با یک پسورد دیتابیس و JWT secret **رندوم** می‌سازه (فقط دفعه‌ی اول — دفعات بعد دست نمی‌زنه بهش).
5. ایمیج‌ها رو build و کانتینرها رو بالا می‌آره (`docker compose up -d --build`).
6. یک cron job هر ۵ دقیقه نصب می‌کنه که چک می‌کنه کامیت جدیدی روی گیت‌هاب هست یا نه — اگه بود، خودکار pull و rebuild می‌کنه.

بعد از تمومش دیدن، آدرس سایت رو چاپ می‌کنه — چیزی شبیه `http://IP_SERVER/`.

> اولین اجرا چون باید ایمیج‌های Docker رو build کنه ممکنه چند دقیقه (روی ۱ هسته حدود ۵-۱۰ دقیقه) طول بکشه — نگران نباش.

## بعد از دیپلوی

### چک کردن وضعیت

```bash
cd /opt/openbridge
docker compose ps
```

باید ۵ سرویس رو `Up`/`healthy` ببینی: `postgres`, `redis`, `api`, `web`, `livekit`.
سلامت `api`، `web` و `livekit` از healthcheck واقعی میاد؛ می‌تونی مستقیم هم چکش کنی:

```bash
curl http://localhost/api/health      # {"status":"ok",...}
docker compose exec -T livekit wget -q -O- http://127.0.0.1:7880/   # OK
```

### دیدن لاگ‌ها

```bash
docker compose logs -f api      # لاگ بک‌اند
docker compose logs -f web      # لاگ nginx
docker compose logs -f livekit  # لاگ سرور رسانه
```

### تماس تصویری/صوتی (LiveKit)

تماس‌ها روی همان سرور و با کانتینر `livekit` اجرا می‌شن. سه چیز باید درست باشد:

1. **پورت‌ها:** علاوه بر پورت وب، `7881/tcp` و `7882/udp` باید در فایروال
   سرور و Security Group ابری باز باشند. اگر UDP بسته باشد تماس ممکن است
   وصل نشود یا فقط با TCP (کندتر) کار کند. پورت `7880` عمومی نیست و نباید باز شود.
2. **آدرس عمومی:** `LIVEKIT_URL` در `.env` همان آدرسی است که مرورگر/گوشی
   می‌گیرد. پیش‌فرض اسکریپت `ws://IP/livekit` است. اگر دامنه و HTTPS گذاشتی،
   آن را به `wss://example.com/livekit` تغییر بده؛ وگرنه مرورگر روی صفحهٔ HTTPS
   اتصال `ws://` را مسدود می‌کند. `LIVEKIT_API_URL` فقط داخلی است و
   `http://livekit:7880` می‌ماند.
3. **کلیدها:** `deploy.sh` در نصب تازه `LIVEKIT_API_KEY` و
   `LIVEKIT_API_SECRET` را می‌سازد. روی نصب قدیمی که این دو خط را ندارد،
   یک بار `bash deploy.sh` را اجرا کن تا به `.env` اضافه شوند (یا خودت دو مقدار
   تصادفی بگذار). کلید/secret فقط در بک‌اند است و هیچ‌وقت به باندل وب یا اپ
   نمی‌رود.

سلامت و عیب‌یابی:

```bash
docker compose ps livekit
docker compose logs --tail=80 livekit
```

اگر کانتینر بالا نیامد، اول پورت/کلیدها را چک کن. nginx مسیر `/livekit/` را
به همین کانتینر proxy می‌کند و اگر LiveKit پایین باشد فقط تماس خطا می‌دهد؛
چت و بقیهٔ برنامه باید کار کنند.

> **منابع:** ۱ گیگ رم برای یک تماس ۱:۱ کوچک معمولاً کافی است، اما یک تماس
> گروهی ویدیویی یا چند تماس هم‌زمان به ۲ هسته / ۴ گیگ و پهنای باند بیشتر
> نیاز دارد. LiveKit ترنسکد نمی‌کند؛ پهنای باند خروجی با تعداد بیننده‌ها
> بالا می‌رود.

**TURN برای شبکه‌های محدود:** اگر کاربران پشت NAT سخت (بعضی شبکه‌های شرکتی
یا اپراتوری) نمی‌توانند وصل شوند، بلوک `turn` را در `LIVEKIT_CONFIG` داخل
`docker-compose.yml` باز کن. به یک دامنهٔ عمومی، گواهی TLS و پورت‌های
`5349/tcp` و `3478/udp` نیاز دارد و باید در همان دامنه گواهی معتبر داشته باشد.
برای اکثر کاربران خانگی، STUN/UDP پیش‌فرض کافی است.

### آپدیت دستی (بدون منتظر موندن ۵ دقیقه‌ی cron)

**از این به بعد به‌جای `git pull` + `up --build` از خود اسکریپت استفاده کن**، چون
مراحل کامل را می‌روند (تأیید سبز بودن CI، بکاپ، build، جابه‌جایی کانتینرها،
چک سلامت و در صورت شکست بازگشت به کامیت قبلی):

```bash
cd /opt/openbridge
bash deploy.sh --redeploy                     # تازه‌ترین کامیت روی main
bash deploy.sh --redeploy --ref <sha>         # یک کامیت مشخص
bash deploy.sh --redeploy --skip-ci-check     # بدون درگاه CI (اختیاری)
```

هر اجرا لاگش در `deploy.log` می‌مونه. بکاپ‌های دیتابیس در `backups/` نگه داشته
می‌شن (۵ تا آخر؛ با `BACKUP_KEEP=10` عوضش کن). اگه سالم‌نبودن یک کامیت ثابت بشه،
SHA آن در `.deploy-failed-sha` نوشته می‌شه و cron تا حرکت کردن `main` دیگر سراغش
نمی‌ره — برای لغو این قفل، فایل را پاک کن.

### برگرداندن دیتابیس از بکاپ

```bash
gunzip -c backups/openbridge-<timestamp>.sql.gz | docker compose exec -T postgres psql -U openbridge -d openbridge
```

> باکس‌های ۱ گیگ گاهی برای بوت اول (که `prisma db push` را اجرا می‌کنه) به بیشتر
> از ۲۴۰ ثانیه نیاز دارن: `HEALTH_DEADLINE=420 bash deploy.sh --redeploy`.

### ری‌استارت

```bash
docker compose restart
```

## پایپلاین CI/CD

### CI — `.github/workflows/ci.yml`

پایپلاین مرحله‌به‌مرحله‌ست؛ هر مرحله فقط با سبز بودن مرحلهٔ قبلی اجرا می‌شه تا
جاهای آهسته زودتر از موعد شروع نکنن:

| مرحله | جاب | چی را ثابت می‌کنه |
|-------|-----|-------------------|
| ۱ · ایستا | `web-lint`, `backend-check` | ESLint تمیز · اسکیمای Prisma معتبر · TypeScript کامپایل می‌شه |
| ۲ · تست | `backend-e2e` | ۱۶ تست امنیتی روی PostgreSQL واقعی |
| ۲ب · ممیزی | `dependencies` | یافته‌های `npm audit` (فقط گزارش، جلوگیری نمی‌کنه) |
| ۳ · خروجی | `web-build`, `mobile-bundle` | بیلد Vite · باندل Hermes اکسپو |
| ۴ · مسیر انتشار | `deploy-dry-run` | هر دو ایمیج Docker ساخته می‌شن، `docker compose up` فرانت را سرو می‌کنه، `/api/health` **از پشت nginx** جواب می‌ده و دست‌دهی Socket.IO برقراره |
| — | `ci-gate` | تنها چکی که لازم است در branch protection اجباری بشه |

در تنظیمات ریپو، به‌جای تک‌تک جاب‌ها، فقط `CI gate` را required کن؛ این‌طور می‌تونی
لیست جاب‌ها را بدون شکستن قانون تغییر بدی.

### CD — `.github/workflows/deploy.yml`

این ورک‌فلو بعد از سبز شدن CI روی `main` (و همچنین با اجرا دستی) از طریق SSH به
سرور می‌ره و `bash deploy.sh --redeploy --ref <sha>` را اجرا می‌کنه — یعنی دقیقاً
همان کامیتی که CI تست کرده، نه چیزی که بعداً روی main جا گرفته. تا وقتی فعالش
نکنی، هیچ کاری با سرور ندارد:

1. در **Settings → Secrets and variables → Actions** یک variable به اسم
   `DEPLOY_ENABLED` با مقدار `true` بساز.
2. سیکرت‌های `SSH_HOST`، `SSH_USER` و `SSH_KEY` را تنظیم کن (اختیاری:
   `SSH_PORT`، `SSH_KNOWN_HOSTS`، و variable به اسم `APP_DIR` که پیش‌فرض
   `/opt/openbridge` است).
3. `SSH_KNOWN_HOSTS` را بگذار تا به‌جای اعتماد اولین تماس (keyscan) کلید میزبان
   قفل بشه: `ssh-keyscan -p 22 IP_SERVER` روی سیستم خودت و خروجی‌اش را در همان
   سیکرت ذخیره کن.

اگر سیکرت‌ها نباشند job **skip** می‌شه (فایل نمی‌شه) و مسیر جایگزین همان cron
پنج‌دقیقه‌ای است که `deploy.sh` نصب می‌کنه؛ آن cron هم قبل از انتشار وضعیت CI را
از API گیت‌هاب می‌پرسه (برای ریپوی عمومی بدون توکن کار می‌کنه) و اگر نپرسه فقط
هشدار می‌ده — پس دروازهٔ اصلی همان `deploy.yml` است.

وضعیت مشاهده‌شده (۲۰۲۶-۱۰-۲۱): CI روی GitHub Actions اجرا شده و سبز است —
شامل مرحلهٔ ساخت ایمیج‌های Docker و smoke test همان compose. ولی `deploy.yml`
همیشه `skipped` است چون `DEPLOY_ENABLED` روی `true` نیست و سکرت‌های SSH وجود
ندارند. پس تا وقتی سرور و سکرت‌ها آماده نشوند، هیچ دیپلوی Production انجام
نمی‌شود. تنها بخشی که هنوز روی VPS واقعی آزمایش نشده، همان redeploy/rollback
اسکریپت است؛ مسیر Docker/compose/nginx/socket در `deploy-dry-run` واقعاً اجرا
می‌شود.

## دامنه و HTTPS (اختیاری)

اگه یک دامنه داری و می‌خوای با `https://` بالا بیاد:

1. رکورد A دامنه رو به IP سرور بزن.
2. Certbot نصب کن و روی همون nginx کانتینر گواهی بگیر، یا ساده‌تر: یک nginx دیگه (یا Caddy) جلوی این استک به‌عنوان reverse proxy با SSL خودکار بذاری. اگه بخوای این بخش رو هم برات آماده کنم (مثلاً اضافه‌کردن سرویس Caddy به `docker-compose.yml` که خودش Let's Encrypt می‌گیره)، بگو تا اضافه‌ش کنم.

## مشکلات رایج

**پورت ۸۰ اشغاله** (مثلاً یک nginx دیگه از قبل روی سرور هست):
توی `.env` مقدار `WEB_PORT` رو عوض کن (مثلاً `WEB_PORT=8080`) و دوباره `docker compose up -d --build` بزن.

**دیتابیس بالا نمیاد / کانتینر api ری‌استارت می‌شه**:
```bash
docker compose logs postgres
docker compose logs api
```
معمولاً یا `.env` درست ساخته نشده یا رم کم آورده — `free -h` بزن ببین swap فعاله.

**می‌خوام دیتابیس رو کامل پاک کنم و از صفر شروع کنم**:
```bash
docker compose down -v   # با -v ولوم‌ها (دیتای دیتابیس) هم پاک می‌شن — دقت کن!
docker compose up -d --build
```
