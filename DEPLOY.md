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

باید ۴ تا سرویس رو `Up`/`healthy` ببینی: `postgres`, `redis`, `api`, `web`.

### دیدن لاگ‌ها

```bash
docker compose logs -f api      # لاگ بک‌اند
docker compose logs -f web      # لاگ nginx
```

### آپدیت دستی (بدون منتظر موندن ۵ دقیقه‌ی cron)

```bash
cd /opt/openbridge
git pull
docker compose up -d --build
```

### ری‌استارت

```bash
docker compose restart
```

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
