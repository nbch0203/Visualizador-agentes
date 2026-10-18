import fs from 'node:fs/promises';

// Lee un archivo JSONL de forma incremental, devolviendo solo las líneas completas nuevas.
export class FileTail {
  private offset = -1;
  private partial: Buffer = Buffer.alloc(0);
  size = 0;
  mtimeMs = 0;

  constructor(readonly file: string, private initialBytes: number) {}

  async read(size: number): Promise<string[]> {
    if (this.offset === -1) {
      this.offset = Math.max(0, size - this.initialBytes);
      this.partial = Buffer.alloc(0);
      if (this.offset > 0) {
        // Empezamos a mitad de archivo: descartar la primera línea (incompleta).
        const lines = await this.readRange(this.offset, size);
        lines.shift();
        return lines;
      }
    }
    if (size < this.offset) {
      // El archivo se truncó o reescribió.
      this.offset = 0;
      this.partial = Buffer.alloc(0);
    }
    if (size === this.offset) return [];
    return this.readRange(this.offset, size);
  }

  private async readRange(start: number, end: number): Promise<string[]> {
    const fh = await fs.open(this.file, 'r');
    try {
      const len = end - start;
      const buf = Buffer.alloc(len);
      let read = 0;
      while (read < len) {
        const { bytesRead } = await fh.read(buf, read, len - read, start + read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      this.offset = start + read;
      // Cortar en el último salto de línea para no romper caracteres multibyte.
      const lastNl = buf.lastIndexOf(0x0a, read - 1);
      if (lastNl === -1) {
        this.partial = Buffer.concat([this.partial, buf.subarray(0, read)]);
        return [];
      }
      const text = Buffer.concat([this.partial, buf.subarray(0, lastNl)]).toString('utf8');
      this.partial = Buffer.from(buf.subarray(lastNl + 1, read));
      return text.split('\n');
    } finally {
      await fh.close();
    }
  }
}
