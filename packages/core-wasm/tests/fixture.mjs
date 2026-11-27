import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

function chunk(name, data) {
  const bytes = Buffer.alloc(12 + data.length);
  bytes.writeUInt32BE(data.length);
  bytes.write(name, 4);
  data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}

function png(width, height, seed, stress) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const stride = 1 + 3 * width;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    let index = y * stride;
    pixels[index++] = stress ? 0 : 1;
    let red = 0;
    let green = 0;
    let blue = 0;
    for (let x = 0; x < width; x++) {
      const texture = ((x ^ (y * 13)) + ((x * y) >>> 9)) & 31;
      const r = (seed * 29 + (x >>> 4) + (stress ? texture : texture >>> 3)) & 255;
      const g = (seed * 37 + (y >>> 4) + (stress ? texture : texture >>> 3)) & 255;
      const b = ((x >>> 5) ^ (y >>> 5) ^ (stress ? texture * 5 : texture >>> 3)) & 255;
      pixels[index++] = r - red;
      pixels[index++] = g - green;
      pixels[index++] = b - blue;
      if (!stress) {
        red = r;
        green = g;
        blue = b;
      }
    }
  }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const scmSettings = {
  layoutMode: 'scm',
  scmTemplate: { paper: 'a4', card: 'standard', variant: 'default', marks: 3 },
  bleedMm: 0.5,
  calibrationPage: false,
};

export function prepareFixture(dir, count, width, height, stress = false) {
  const entries = Array.from({ length: count }, (_, index) => {
    const id = `card-${index + 1}`;
    const imageUrl = `${id}.png`;
    writeFileSync(join(dir, imageUrl), png(width, height, index, stress));
    return {
      id,
      quantity: 1,
      zone: 'main',
      card: {
        id,
        oracleId: id,
        name: `Test card ${index + 1}`,
        faces: [{ id, provider: 'scryfall', imageUrl, thumbnailUrl: imageUrl }],
      },
    };
  });
  const deck = { id: 'fixture', name: 'WASM fixture', format: '', revision: 1, createdAt: '', updatedAt: '', entries };
  writeFileSync(join(dir, 'deck.json'), JSON.stringify(deck));
}

export function loadFixture(dir) {
  const deckJson = readFileSync(join(dir, 'deck.json'), 'utf8');
  const images = new Map(
    JSON.parse(deckJson).entries.map(({ card: { faces: [{ imageUrl }] } }) => [
      imageUrl,
      readFileSync(join(dir, imageUrl)),
    ]),
  );
  return { deckJson, images };
}
