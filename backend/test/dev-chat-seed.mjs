// Dev-only seeder: wipes the local database and fills it with accounts that
// carry randomised chat history. It refuses to run against anything but a
// localhost Postgres, and nothing here is reachable from the app itself.
import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import bcrypt from 'bcrypt';
import { randomBytes, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const BACKEND = join(fileURLToPath(new URL('.', import.meta.url)), '..');
config({ path: join(BACKEND, '.env') });

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const LOCAL = /^postgresql:\/\/[^@]*@(localhost|127\.0\.0\.1):\d+\//.test(DATABASE_URL);
if (!LOCAL || process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to run: this seeder only touches a localhost database');
}

const prisma = new PrismaClient();
const UPLOAD_DIR = join(BACKEND, 'uploads');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const pick = (list) => list[randInt(0, list.length - 1)];
const chance = (p) => Math.random() < p;
// Recent messages plus a receipt delay could otherwise land in the future.
const clamp = (ms) => new Date(Math.min(ms, Date.now()));

function shuffled(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randInt(0, i);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// The naive-UTC form the API itself uses when it writes "updatedAt" by hand:
// a Date bound into raw SQL would be formatted in the machine's local zone.
const stamp = (date) => date.toISOString().replace('T', ' ').replace('Z', '');

// ── attachments ───────────────────────────────────────────────────────────
// A chat list preview has to be able to say «عکس», so the seeded attachments
// are real files in the uploads directory rather than dangling paths.

const CRC = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes) {
  let c = ~0;
  for (const b of bytes) c = (c >>> 8) ^ CRC[(c ^ b) & 0xff];
  return ~c >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, sum]);
}

function encodePng(width, height, pixel) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      row[1 + x * 3] = r;
      row[2 + x * 3] = g;
      row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PAINTINGS = [
  {
    name: 'آسمان.png',
    width: 640,
    height: 400,
    pixel: (x, y) => {
      const t = y / 400;
      const sun = Math.hypot(x - 470, y - 96) < 46 ? 120 : 0;
      return [Math.min(255, 30 + sun + 120 * t), Math.min(255, 70 + sun + 100 * t), Math.max(70, 200 - 90 * t)];
    },
  },
  {
    name: 'نقشه-رنگ.png',
    width: 480,
    height: 480,
    pixel: (x, y) => [
      90 + 140 * Math.abs(Math.sin(x / 57)),
      70 + 150 * Math.abs(Math.sin(y / 43)),
      120 + 110 * Math.abs(Math.sin((x + y) / 91)),
    ],
  },
  {
    name: 'غروب.png',
    width: 560,
    height: 340,
    pixel: (x, y) => {
      const band = y > 220 ? (y - 220) / 120 : 0;
      return [200 - 60 * band, 90 + 40 * Math.sin(x / 80) - 40 * band, 60 + 90 * (y / 340)];
    },
  },
];

const NOTES = [
  'یادداشت-جلسه.txt',
  'چکیده-پروژه.txt',
  'لیست-کارها.txt',
];

function writeAttachment(definition, buffer) {
  mkdirSync(UPLOAD_DIR, { recursive: true });
  const extension = definition.name.slice(definition.name.lastIndexOf('.'));
  const filename = `${randomUUID()}${extension}`;
  writeFileSync(join(UPLOAD_DIR, filename), buffer);
  return {
    fileUrl:  `/uploads/${filename}`,
    fileName: definition.name,
    fileSize: buffer.length,
  };
}

// ── accounts ──────────────────────────────────────────────────────────────

const SELF = {
  firstName: 'امیرحسین',
  lastName:  'رزازاده',
  username:  'amir1382re',
  phone:     '09121111111',
  status:    'ONLINE',
};

const PEERS = [
  { firstName: 'سارا',   lastName: 'محمدی',    username: 'sara_mohamadi',   status: 'ONLINE',  bio: 'طراح رابط کاربری' },
  { firstName: 'نیما',   lastName: 'کریمی',    username: 'nima_karimi',     status: 'AWAY',    bio: 'بک‌اند و زیرساخت' },
  { firstName: 'مریم',   lastName: 'احمدی',    username: 'maryam_ahmadi',   status: 'OFFLINE', bio: 'تحلیلگر داده' },
  { firstName: 'کیوان',  lastName: 'رستمی',    username: 'keivan_rostami',  status: 'ONLINE',  bio: 'عکاسی و گرافیک' },
  { firstName: 'الهام',  lastName: 'نوروزی',   username: 'elham_nevorzi',   status: 'OFFLINE', bio: 'پشتیبانی مشتری' },
  { firstName: 'پویا',   lastName: 'صادقی',    username: 'pooya_sadeghi',   status: 'AWAY',    bio: 'موبایل' },
  { firstName: 'شیدا',   lastName: 'کاظمی',    username: 'shida_kazemi',    status: 'OFFLINE', bio: 'تست و کیفیت' },
  { firstName: 'بهروز',  lastName: 'جعفری',    username: 'bahrooz_jafari',  status: 'ONLINE',  bio: 'مدیر محصول' },
  { firstName: 'نازنین', lastName: 'شریفی',    username: 'nazanin_sharifi', status: 'OFFLINE', bio: 'محتوا و کپی‌رایتر' },
];

const TEXTS = [
  'سلام، خوبی؟',
  'امروز وقتت آزاده برای یک تماس کوتاه؟',
  'پیشنهادت منطقی به می‌رسه، با همون ادامه می‌دیم',
  'فایل رو فرستادم، هر وقت دیدی خبر بده',
  'دستت درد نکنه، خیلی کمک کرد 🙏',
  'یه نکته‌ی ریز هست که باید قبل از انتشار ببینیش',
  'من الان سر میزم، بعداً با دقت جواب می‌دم',
  'طرح جدید رو پسندیدم، رنگ‌ها خیلی بهتر شده',
  'گفتگوی قبلی رو مرور کردم، خلاصه‌شو می‌فرستم',
  'اگه موافق باشی جلسه رو بذاریم برای اول هفته',
  'باگ ورود از موبایل حل شد ✅',
  'نسخه‌ی جدید روی تست سریع‌تر به می‌رسه',
  'چیزی که فرستادی رو بازخوانی کردم، کامله',
  'منظورت رو فهمیدم، درستش می‌کنم',
  'لازم نیست نگران باشی، کنترلش کردم',
  'عکس‌های جلسه رو ضمیمه می‌کنم',
  'یادداشت‌ها رو مرتب کردم، امشب می‌فرستم',
  'به نظرم این مسیر طولانی‌تر از حرفه، کوتاه‌ترش کنیم',
  'ممنون که گفتی، حواسم هست',
  'فردا صبح در دسترس‌ام',
  'همه‌چی آماده‌ی انتشاره، منتظر تأیید توام',
  'این عددی که گفتی با گزارش هم نمی‌خونه',
  'یه دور تازه تست می‌کنیم، بعد تصمیم می‌گیریم',
  'خیلی تمیز شده، آفرین',
  'مبحث رو باز گذاشتم برای بعد از ظهر',
  'نقشه‌ی راه رو دیدم، بخش آخر نیاز به توضیح داره',
];

const REPLY_TEXTS = [
  'باشه 👌',
  'چشم، انجام می‌دم',
  'الان نگاه می‌کنم',
  'ممنون، خبر می‌دم',
  'موافقم',
  'دقیقاً همین',
  'بعداً کامل‌تر توضیح می‌دم',
  'یه ثانیه، پیداش می‌کنم',
  'آره درسته',
  'باشه ولی با یک تغییر کوچیک',
];

const EMOJIS = ['👍', '❤️', '😂', '😮', '😢'];

const GROUP_PLANS = [
  { name: 'تیم محصول',        size: 5, tail: 'peer-text' },
  { name: 'دورهمی آخر هفته',  size: 4, tail: 'mine-text' },
  { name: 'طراحی و گرافیک',    size: 3, tail: 'image' },
  { name: 'هماهنگی پشتیبانی',  size: 4, tail: 'empty' },
];

// The chat list is what is being tested, so the newest message of each of the
// signed-in account's own chats is chosen to cover every preview shape.
const DIRECT_TAILS = [
  'peer-text',
  'mine-text',
  'image',
  'file',
  'deleted-tail',
  'empty',
  'peer-text',
  'image',
  'file',
];

// ── build ─────────────────────────────────────────────────────────────────

async function wipe() {
  await prisma.$executeRawUnsafe(`TRUNCATE
    "users", "conversations", "conversation_participants", "messages",
    "message_reads", "reactions", "e2ee_envelopes", "encrypted_blobs",
    "devices", "key_packages", "sessions", "otp_codes"
  CASCADE`);
}

async function createUser({ firstName, lastName, username, phone, status, bio }) {
  return prisma.user.create({
    data: {
      firstName,
      lastName,
      displayName: `${firstName} ${lastName}`.trim(),
      username,
      phone,
      status: status ?? 'OFFLINE',
      bio:    bio ?? null,
      // These accounts sign in with an OTP only; the column keeps an
      // unguessable value so nothing can authenticate through it.
      password: await bcrypt.hash(randomBytes(32).toString('base64url'), 10),
    },
  });
}

const imageAttachments = [];
const fileAttachments = [];

function seedAttachments() {
  for (const painting of PAINTINGS) {
    imageAttachments.push(
      writeAttachment(painting, encodePng(painting.width, painting.height, painting.pixel)),
    );
  }
  for (const name of NOTES) {
    const body = Buffer.from(
      `${name.replace('.txt', '')}\n\n` +
      `${pick(TEXTS)}\n${pick(TEXTS)}\n${pick(TEXTS)}\n`,
      'utf8',
    );
    fileAttachments.push(writeAttachment({ name }, body));
  }
}

function makeHistory(memberIds, viewerId) {
  const count = randInt(4, 22);
  let at = Date.now() - Math.floor(rand(0.02, 9.4) * DAY);
  const messages = [];
  let speaker = pick(memberIds);
  let turn = randInt(1, 3);

  for (let i = 0; i < count; i += 1) {
    const roll = Math.random();
    const message = {
      senderId:  speaker,
      createdAt: new Date(at),
      type:      'TEXT',
      // Replies keep coming from the other side, so a thread never reads like
      // one person talking to themselves.
      text:      speaker === viewerId ? pick(TEXTS) : pick(TEXTS.concat(REPLY_TEXTS)),
      fileUrl:   null,
      fileName:  null,
      fileSize:  null,
      editedAt:  chance(0.08) ? clamp(at + randInt(2, 30) * MIN) : null,
      deletedAt: null,
    };
    if (roll > 0.94) {
      Object.assign(message, pick(imageAttachments), { type: 'IMAGE', text: null });
    } else if (roll > 0.9) {
      Object.assign(message, pick(fileAttachments), { type: 'FILE', text: null });
    }
    messages.push(message);

    turn -= 1;
    if (turn <= 0) {
      speaker = pick(memberIds.filter((id) => id !== speaker)) ?? speaker;
      turn = randInt(1, 3);
    }
    // A burst of messages, then the conversation goes quiet for hours or days.
    at -= chance(0.25) ? randInt(3, 26) * (DAY / 24) : randInt(2, 75) * MIN;
  }

  return messages.reverse();
}

function applyTail(messages, tail, memberIds, viewerId) {
  if (tail === 'deleted-tail' && messages.length > 1) {
    messages[messages.length - 1].deletedAt = new Date();
    return messages;
  }
  if (tail === 'image' && messages.length) {
    Object.assign(messages[messages.length - 1], pick(imageAttachments), { type: 'IMAGE', text: null });
    return messages;
  }
  if (tail === 'file' && messages.length) {
    Object.assign(messages[messages.length - 1], pick(fileAttachments), { type: 'FILE', text: null });
    return messages;
  }
  if (tail === 'mine-text' && messages.length && viewerId) {
    const last = messages[messages.length - 1];
    last.senderId = viewerId;
    last.text = pick(TEXTS);
    last.type = 'TEXT';
    last.fileUrl = null;
    last.fileName = null;
    last.fileSize = null;
    return messages;
  }
  if (tail === 'peer-text' && messages.length && viewerId) {
    const last = messages[messages.length - 1];
    last.senderId = pick(memberIds.filter((id) => id !== viewerId)) ?? last.senderId;
    last.text = pick(TEXTS);
    last.type = 'TEXT';
    last.fileUrl = null;
    last.fileName = null;
    last.fileSize = null;
    return messages;
  }
  return messages;
}

const reads = [];
const reactionRows = [];

// Read receipts do two jobs at once: they light up the ticks on my own
// messages, and the rows they leave out are what makes an unread badge.
function planReads(messages, memberIds) {
  const unreadTails = new Map(memberIds.map((id) => [id, randInt(0, 4)]));
  messages.forEach((message, index) => {
    if (message.deletedAt) return;
    const fromEnd = messages.length - 1 - index;
    for (const userId of memberIds) {
      if (userId === message.senderId) continue;
      // The newest few messages of a chat stay unacknowledged for a member,
      // which is what their badge then counts.
      if (fromEnd < unreadTails.get(userId)) continue;
      reads.push({
        messageId: message.id,
        userId,
        readAt:    clamp(message.createdAt.getTime() + randInt(1, 90) * MIN),
      });
    }
  });
}

function planReactions(messages, memberIds) {
  const live = messages.filter((m) => !m.deletedAt);
  if (!live.length || !chance(0.55)) return;
  const used = new Set();
  for (const message of shuffled(live).slice(0, randInt(1, 3))) {
    const userId = pick(memberIds.filter((id) => id !== message.senderId)) ?? memberIds[0];
    const key = `${userId}|${message.id}`;
    if (used.has(key)) continue;
    used.add(key);
    reactionRows.push({
      messageId: message.id,
      userId,
      emoji:     pick(EMOJIS),
      createdAt: clamp(message.createdAt.getTime() + randInt(1, 120) * MIN),
    });
  }
}

async function seedConversation({ isGroup, name, members, ownerId, viewerId, tail }) {
  const memberIds = members.map((u) => u.id);
  const conversation = await prisma.conversation.create({
    data: {
      isGroup,
      name:  isGroup ? name : null,
      participants: {
        create: memberIds.map((userId) => ({
          userId,
          role: userId === ownerId ? 'OWNER' : 'MEMBER',
        })),
      },
    },
  });

  const empty = tail === 'empty';
  let messages = [];

  if (!empty) {
    messages = applyTail(makeHistory(memberIds, viewerId), tail, memberIds, viewerId);
    await prisma.message.createMany({ data: messages.map((m) => ({ ...m, conversationId: conversation.id })) });
    // createMany returns no rows, and the receipts and reactions need message
    // ids, so read back what was just written — the plan's timestamps ascend in
    // the same order the query returns.
    const rows = await prisma.message.findMany({
      where:   { conversationId: conversation.id },
      orderBy: { createdAt: 'asc' },
      select:  { id: true, senderId: true, createdAt: true, deletedAt: true },
    });
    planReads(rows, memberIds);
    planReactions(rows, memberIds);
  }

  const last = empty ? Date.now() - randInt(1, 9) * DAY : messages[messages.length - 1].createdAt.getTime();
  const born = empty ? last - randInt(2, 20) * DAY : messages[0].createdAt.getTime() - randInt(1, 20) * DAY;
  await prisma.$executeRaw`UPDATE conversations
    SET "createdAt" = ${stamp(new Date(born))}::timestamp,
        "updatedAt" = ${stamp(new Date(last))}::timestamp
    WHERE id = ${conversation.id}`;
}

// ── run ───────────────────────────────────────────────────────────────────

seedAttachments();
await wipe();

const self = await createUser(SELF);
// 09 + nine digits, the only shape the sign-in screen accepts.
const peers = [];
for (const peer of PEERS) {
  peers.push(await createUser({ ...peer, phone: `09121111${String(peers.length + 1).padStart(3, '0')}` }));
}

// One chat per peer, and each one gets a different newest message, so every
// preview shape the sidebar knows how to draw appears at least once.
const tails = shuffled(DIRECT_TAILS);
for (let i = 0; i < peers.length; i += 1) {
  await seedConversation({
    isGroup:  false,
    members:  [self, peers[i]],
    ownerId:  self.id,
    viewerId: self.id,
    tail:     tails[i % tails.length],
  });
}

// Peers talk to each other too, so signing in as any seeded account lands on
// a list that is not empty.
for (let i = 0; i < peers.length; i += 1) {
  for (let j = i + 1; j < peers.length; j += 1) {
    if (!chance(0.4)) continue;
    await seedConversation({
      isGroup:  false,
      members:  [peers[i], peers[j]],
      ownerId:  peers[i].id,
      viewerId: peers[i].id,
      tail:     pick(['peer-text', 'mine-text', 'image', 'file', 'random', 'deleted-tail']),
    });
  }
}

for (const plan of GROUP_PLANS) {
  const others = shuffled(peers).slice(0, plan.size - 1);
  await seedConversation({
    isGroup:  true,
    name:     plan.name,
    members:  [self, ...others],
    ownerId:  self.id,
    viewerId: self.id,
    tail:     plan.tail,
  });
}

// A group the signed-in account is not in, so the "start a new chat" search
// and the member list both have something real to show.
await seedConversation({
  isGroup:  true,
  name:     'دور هم‌دستان',
  members:  shuffled(peers).slice(0, 4),
  ownerId:  peers[0].id,
  viewerId: peers[0].id,
  tail:     'peer-text',
});

if (reads.length) await prisma.messageRead.createMany({ data: reads, skipDuplicates: true });
if (reactionRows.length) await prisma.reaction.createMany({ data: reactionRows, skipDuplicates: true });

const report = await prisma.conversation.findMany({
  where:   { participants: { some: { userId: self.id } } },
  orderBy: { updatedAt: 'desc' },
  include: {
    participants: { where: { userId: { not: self.id } }, include: { user: { select: { displayName: true } } } },
    messages: {
      where:   { deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take:    1,
      select:  { type: true, text: true, fileName: true, senderId: true },
    },
  },
});

const unread = await prisma.message.count({
  where: {
    conversationId: { in: report.map((c) => c.id) },
    senderId:       { not: self.id },
    reads:          { none: { userId: self.id } },
  },
});

console.log(`users: ${(await prisma.user.count())}  conversations: ${report.length} of ${await prisma.conversation.count()}  messages: ${await prisma.message.count()}  reactions: ${reactionRows.length}  unread-for-me: ${unread}`);
console.log(`\nsign in as ${SELF.phone}  (@${SELF.username}) — the OTP test code is shown on the sign-in screen`);
console.log(`peers: ${peers.map((p) => `${p.phone} (@${p.username})`).join(', ')}`);
console.log('\nyour chat list, newest first:');
for (const chat of report) {
  const last = chat.messages[0];
  const preview = !last
    ? 'بدون پیام'
    : `${last.type.toLowerCase()} · ${(last.fileName ?? last.text ?? '').slice(0, 34)}${last.senderId === self.id ? ' (از من)' : ''}`;
  const name = chat.isGroup ? chat.name : chat.participants[0]?.user.displayName;
  console.log(`  ${chat.updatedAt.toISOString().slice(0, 16).replace('T', ' ')}  ${name}  ·  ${preview}`);
}

await prisma.$disconnect();
