import {
  BadRequestException, Controller, ForbiddenException, Get, NotFoundException,
  Param, Post, Query, Request, Res, ServiceUnavailableException, UploadedFile,
  UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { randomUUID } from 'crypto';
import { open, unlink } from 'fs/promises';
import { extname, join, normalize } from 'path';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { verifyFileSignature } from './file-urls';
import { UploadScanner } from './upload-scanner';

const UPLOAD_DIR = join(process.cwd(), 'uploads');
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_UPLOADS_PER_HOUR = 60;

// MIME type -> allowed extensions. Anything not listed is rejected. SVG and
// HTML are deliberately excluded because they can carry active content.
const ALLOWED_TYPES: Record<string, string[]> = {
  'image/png':  ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/gif':  ['.gif'],
  'image/webp': ['.webp'],
  'application/pdf': ['.pdf'],
  'text/plain': ['.txt'],
  'application/msword': ['.doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.ms-excel': ['.xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.ms-powerpoint': ['.ppt'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
  'application/zip': ['.zip'],
  'audio/mpeg': ['.mp3'],
  'audio/mp4': ['.m4a'],
  'audio/ogg': ['.ogg'],
  'audio/wav': ['.wav'],
  'audio/webm': ['.weba'],
  'video/mp4': ['.mp4'],
  'video/webm': ['.webm'],
  'video/quicktime': ['.mov'],
};

const EXT_TO_MIME = new Map(
  Object.entries(ALLOWED_TYPES).flatMap(([mime, extensions]) => extensions.map(ext => [ext, mime])),
);

const IMAGE_CHECKS: Record<string, (head: Buffer) => boolean> = {
  'image/png':  head => head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': head => head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff,
  'image/gif':  head => ['GIF87a', 'GIF89a'].includes(head.subarray(0, 6).toString('ascii')),
  'image/webp': head => head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP',
};

async function contentMatchesType(path: string, mimetype: string): Promise<boolean> {
  const check = IMAGE_CHECKS[mimetype];
  if (!check) return true;

  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(12);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return bytesRead === head.length && check(head);
  } finally {
    await handle.close().catch(() => {});
  }
}

@Controller('uploads')
export class UploadsController {
  private uploadBuckets = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly scanner: UploadScanner) {}

  private assertUploadRate(userId: string) {
    const now = Date.now();
    const bucket = this.uploadBuckets.get(userId);
    if (!bucket || bucket.resetAt <= now) {
      this.uploadBuckets.set(userId, { count: 1, resetAt: now + 60 * 60 * 1000 });
      return;
    }
    if (bucket.count >= MAX_UPLOADS_PER_HOUR) {
      throw new BadRequestException('تعداد آپلودهای شما در این ساعت بیش از حد مجاز است');
    }
    bucket.count += 1;
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: UPLOAD_DIR,
        filename:    (_, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`),
      }),
      limits: { fileSize: MAX_FILE_SIZE, files: 1 },
      fileFilter: (_, file, cb) => {
        const extension = extname(file.originalname).toLowerCase();
        const allowed = ALLOWED_TYPES[file.mimetype];
        if (!allowed || !allowed.includes(extension)) {
          return cb(new BadRequestException('نوع فایل مجاز نیست'), false);
        }
        cb(null, true);
      },
    }),
  )
  async upload(@Request() req, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('فایل ارسال نشد');
    try {
      this.assertUploadRate(req.user.id);
    } catch (err) {
      await unlink(file.path).catch(() => {});
      throw err;
    }

    const validContent = await contentMatchesType(file.path, file.mimetype).catch(() => false);
    if (!validContent) {
      await unlink(file.path).catch(() => {});
      throw new BadRequestException('محتوای فایل با نوع آن مطابقت ندارد');
    }

    let scan;
    try {
      scan = await this.scanner.scan(file.path);
    } catch {
      await unlink(file.path).catch(() => {});
      throw new ServiceUnavailableException('اسکن امنیتی فایل در حال حاضر در دسترس نیست');
    }
    if (!scan.clean) {
      await unlink(file.path).catch(() => {});
      throw new BadRequestException('فایل آلوده است');
    }

    return {
      url:  `/uploads/${file.filename}`,
      name: file.originalname,
      size: file.size,
      type: file.mimetype.startsWith('image/') ? 'IMAGE'
        : file.mimetype.startsWith('audio/') ? 'AUDIO'
        : file.mimetype.startsWith('video/') ? 'VIDEO'
        : 'FILE',
    };
  }

  // Signed URLs are the credential here: the database/API only hands them to
  // authorized conversation participants, and they expire after a short TTL.
  @Get(':filename')
  download(
    @Param('filename') filename: string,
    @Query('exp') expiresAt: string,
    @Query('sig') signature: string,
    @Res() res: Response,
  ) {
    const safeName = normalize(filename);
    if (safeName !== filename || safeName.includes('..')) {
      throw new BadRequestException('نام فایل نامعتبر است');
    }
    if (!verifyFileSignature(filename, expiresAt, signature)) {
      throw new ForbiddenException('لینک فایل معتبر یا منقضی شده است');
    }

    const mime = EXT_TO_MIME.get(extname(filename).toLowerCase());
    if (!mime) throw new NotFoundException('فایل پیدا نشد');

    res.setHeader('Content-Type', mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader(
      'Content-Disposition',
      mime.startsWith('image/') ? 'inline' : `attachment; filename="${filename}"`,
    );
    return res.sendFile(join(UPLOAD_DIR, filename), err => {
      if (err && !res.headersSent) res.status(404).json({ message: 'فایل پیدا نشد' });
    });
  }
}
