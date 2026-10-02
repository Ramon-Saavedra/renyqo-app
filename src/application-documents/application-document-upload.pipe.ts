import {
  BadRequestException,
  FileTypeValidator,
  Injectable,
  PipeTransform,
} from '@nestjs/common';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';

export const documentUploadOptions: MulterOptions = {
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1,
    fields: 0,
    parts: 2,
    fieldNameSize: 50,
    headerPairs: 20,
  },
  fileFilter: (_request, file, callback) =>
    callback(
      ['application/pdf', 'image/jpeg', 'image/png'].includes(file.mimetype)
        ? null
        : new BadRequestException('PDF, JPEG or PNG required'),
      true,
    ),
};

@Injectable()
export class ApplicationDocumentUploadPipe implements PipeTransform<
  Express.Multer.File | undefined,
  Promise<Express.Multer.File>
> {
  async transform(
    file: Express.Multer.File | undefined,
  ): Promise<Express.Multer.File> {
    if (!file?.buffer?.length || file.buffer.length > 10 * 1024 * 1024)
      throw new BadRequestException(
        'A nonempty document up to 10 MiB is required',
      );
    const data = file.buffer;
    const pdf =
      /^%PDF-\d\.\d/.test(data.subarray(0, 8).toString('ascii')) &&
      data.subarray(-1024).includes(Buffer.from('%%EOF'));
    const png =
      data.length >= 33 &&
      data
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      data.subarray(-8).equals(Buffer.from([73, 69, 78, 68, 174, 66, 96, 130]));
    const jpeg =
      data.length >= 4 &&
      data[0] === 255 &&
      data[1] === 216 &&
      data[data.length - 2] === 255 &&
      data[data.length - 1] === 217;
    if (
      !(
        (file.mimetype === 'application/pdf' && pdf) ||
        (file.mimetype === 'image/png' && png) ||
        (file.mimetype === 'image/jpeg' && jpeg)
      )
    )
      throw new BadRequestException('Document content does not match its type');
    if (
      !(await new FileTypeValidator({ fileType: file.mimetype }).isValid(file))
    )
      throw new BadRequestException('Document content does not match its type');
    return file;
  }
}
