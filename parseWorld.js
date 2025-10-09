const zlib = require("node:zlib");
const { promisify } = require("node:util");
const nbt = require("nbt");

const unzip = promisify(zlib.unzip);
const deflate = promisify(zlib.deflate);

const Vector = require("./Vector.js");

/**
 * Extracts block arrays from a region (.mca) file.
 *
 * @param {Uint8Array} r - Region file byte buffer
 * @param {[[[string]]]} blocks - Array to write to
 * @param {number} rx - Region file X coordinate
 * @param {number} rz - Region file Z coordinate
 * @param {[Vector, Vector]} bounds - Relative boundaries of "blocks" array
 *
 * @return {[[[string]]]} Contents of `blocks` after modification
 */
async function regionToBlocks (r, blocks, rx, rz, bounds) {

  const [X_MIN, Y_MIN, Z_MIN] = bounds[0].toArray();
  const [X_MAX, Y_MAX, Z_MAX] = bounds[1].toArray();

  for (let i = 0; i < 1024; i ++) {

    const _x = rx * 32 + Math.floor(i % 32);
    const _z = rz * 32 + Math.floor(i / 32);

    if (_x < Math.floor(X_MIN / 16)) continue;
    if (_x >= X_MAX / 16) continue;
    if (_z < Math.floor(Z_MIN / 16)) continue;
    if (_z >= Z_MAX / 16) continue;

    const offset = (r[i * 4] << 16) + (r[i * 4 + 1] << 8) + r[i * 4 + 2];
    const sectors = r[i * 4 + 3];

    const length = (r[offset * 4096] << 24) + (r[offset * 4096 + 1] << 16) + (r[offset * 4096 + 2] << 8) + r[offset * 4096 + 3];
    const compression = r[offset * 4096 + 4];

    console.log(`Reading (${_x} ${_z})`, "Offset:", offset, "Length:", length, "Sectors:", sectors, "Compression:", compression);

    const compressedData = r.slice(offset * 4096 + 5, offset * 4096 + 5 + length);
    const data = await unzip(compressedData);

    const json = await new Promise(function (resolve, reject) {
      nbt.parse(data, (err, res) => resolve(res));
    });

    for (const section of json.value.sections.value.value) {
      if (!("block_states" in section)) continue;
      if (!("data" in section.block_states.value)) continue;

      const palette = section.block_states.value.palette.value.value.map(c => c["Name"].value.split("minecraft:")[1]);
      const longs = section.block_states.value.data.value;

      const _y = section["Y"].value;
      if (_y < Math.floor(Y_MIN / 16)) continue;
      if (_y >= Y_MAX / 16) continue;

      for (let j = 0; j < longs.length; j ++) {
        for (let k = 0; k < 16; k ++) {

          const shift = k < 8 ? (28 - k * 4) : (28 - (k - 8) * 4);
          const id = (longs[j][k < 8 ? 0 : 1] >> shift) & 0b1111;

          const x = _x * 16 + k;
          const y = _y * 16 + Math.floor(j / 16);
          const z = _z * 16 + Math.floor(j % 16);

          if (
            x < X_MIN || x >= X_MAX ||
            y < Y_MIN || y >= Y_MAX ||
            z < Z_MIN || z >= Z_MAX
          ) continue;

          blocks[x - X_MIN][y - Y_MIN][z - Z_MIN] = palette[id];

        }
      }

    }

  }

  return blocks;

}

/**
 * Applies the given block array to a region file.
 *
 * @param {[[[string]]]} blocks - 3D (X, Y, Z) array of block name strings
 * @param {Uint8Array} r - Region file byte buffer
 * @param {number} rx - Region file X coordinate
 * @param {number} rz - Region file Z coordinate
 * @param {[Vector, Vector]} bounds - Relative boundaries of "blocks" array
 *
 * @return {Uint8Array} Contents of `r` after modification
 */
async function blocksToRegion (blocks, r, rx, rz, bounds) {

  const [X_MIN, Y_MIN, Z_MIN] = bounds[0].toArray();
  const [X_MAX, Y_MAX, Z_MAX] = bounds[1].toArray();

  for (let i = 0; i < 1024; i ++) {

    const _x = rx * 32 + Math.floor(i % 32);
    const _z = rz * 32 + Math.floor(i / 32);

    if (_x < Math.floor(X_MIN / 16)) continue;
    if (_x >= X_MAX / 16) continue;
    if (_z < Math.floor(Z_MIN / 16)) continue;
    if (_z >= Z_MAX / 16) continue;

    const offset = (r[i * 4] << 16) + (r[i * 4 + 1] << 8) + r[i * 4 + 2];
    const sectors = r[i * 4 + 3];

    const length = (r[offset * 4096] << 24) + (r[offset * 4096 + 1] << 16) + (r[offset * 4096 + 2] << 8) + r[offset * 4096 + 3];
    const compressedData = r.slice(offset * 4096 + 5, offset * 4096 + 5 + length);
    const data = await unzip(compressedData);

    const json = await new Promise(function (resolve, reject) {
      nbt.parse(data, (err, res) => resolve(res));
    });

    for (const section of json.value.sections.value.value) {

      const ids = [];
      const palette = ["air"];

      const _y = section["Y"].value;

      for (let y = _y * 16; y < _y * 16 + 16; y ++) {
        for (let z = _z * 16; z < _z * 16 + 16; z ++) {
          for (let x = _x * 16; x < _x * 16 + 16; x ++) {

            let block = "air";

            if (
              x >= X_MIN && x < X_MAX &&
              y >= Y_MIN && y < Y_MAX &&
              z >= Z_MIN && z < Z_MAX
            ) {
              block = blocks[x - X_MIN][y - Y_MIN][z - Z_MIN];
            }

            if (!palette.includes(block)) {
              palette.push(block);
            }
            ids.push(palette.indexOf(block));

          }
        }
      }

      const longs = [];
      for (let j = 0; j < ids.length; j += 16) {
        longs.push([
          (ids[j + 15] << 28) + (ids[j + 14] << 24) + (ids[j + 13] << 20) + (ids[j + 12] << 16) + (ids[j + 11] << 12) + (ids[j + 10] << 8) + (ids[j + 9] << 4) + (ids[j + 8]),
          (ids[j + 7] << 28) + (ids[j + 6] << 24) + (ids[j + 5] << 20) + (ids[j + 4] << 16) + (ids[j + 3] << 12) + (ids[j + 2] << 8) + (ids[j + 1] << 4) + (ids[j + 0]),
        ]);
      }

      section.block_states = {
        type: "compound",
        value: {
          data: {
            type: "longArray",
            value: longs
          },
          palette: {
            type: "list",
            value: {
              type: "compound",
              value: palette.map(name => ({
                Name: {
                  type: "string",
                  value: "minecraft:" + name
                }
              }))
            }
          },
        }
      };

      if (palette.length === 1) {
        delete section.block_states.value.data;
      }

    }

    const output = nbt.writeUncompressed(json);
    const compressed = await deflate(output);

    const newLength = compressed.length;
    if (newLength + 5 > 4096) {
      console.warn(`Warning: Chunk (${_x} ${_z}) exceeds available space. Expect a missing chunk.`);
      continue;
    }

    r.set(compressed, offset * 4096 + 5);

    // Encode chunk data length
    r[offset * 4096 + 3] = newLength & 0xFF;
    r[offset * 4096 + 2] = (newLength >> 8) & 0xFF;
    r[offset * 4096 + 1] = (newLength >> 16) & 0xFF;
    r[offset * 4096 + 0] = (newLength >> 24) & 0xFF;
    // Set compression to zlib
    r[offset * 4096 + 4] = 2;

  }

  return r;

}

const regionFileCache = {};

/**
 * Runs a function for each relevant region file.
 *
 * @param {string} worldPath - Path to the Minecraft world directory
 * @param {function} callback - Function to call, passed a region byte buffer and its coordinates
 * @param {[Vector, Vector]} bounds - Relative boundaries of "blocks" array
 */
async function forRegion (worldPath, callback, bounds) {

  const [X_MIN, Y_MIN, Z_MIN] = bounds[0].toArray();
  const [X_MAX, Y_MAX, Z_MAX] = bounds[1].toArray();

  for (let rx = Math.floor(X_MIN / (16 * 32)); rx < Math.ceil(X_MAX / (16 * 32)); rx ++) {
    for (let rz = Math.floor(Z_MIN / (16 * 32)); rz < Math.ceil(Z_MAX / (16 * 32)); rz ++) {

      const mcaFile = `r.${rx}.${rz}.mca`;
      let region;

      if (mcaFile in regionFileCache) {
        region = regionFileCache[mcaFile];
      } else {
        region = await Bun.file(`${worldPath}/region/r.${rx}.${rz}.mca`).bytes();
        regionFileCache[mcaFile] = region;
      }

      await callback(region, rx, rz);

    }
  }

}

module.exports = {
  regionToBlocks,
  blocksToRegion,
  forRegion,
  regionFileCache
};
