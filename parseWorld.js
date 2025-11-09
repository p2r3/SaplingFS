const fs = require("node:fs/promises");
const zlib = require("node:zlib");
const { promisify } = require("node:util");
const crypto = require("node:crypto");
const nbt = require("nbt");

const unzip = promisify(zlib.unzip);
const deflate = promisify(zlib.deflate);

const Vector = require("./Vector.js");

// Helpers for normalizing block identifiers with optional state properties
function normalizeBlockName (name) {
  if (!name) return "";
  const parts = name.split(":");
  return parts.length > 1 ? parts[parts.length - 1] : parts[0];
}

function parseBlockString (block) {
  let name = block || "air";
  const properties = {};

  const bracketIndex = name.indexOf("[");
  if (bracketIndex !== -1 && name.endsWith("]")) {
    const propsPart = name.slice(bracketIndex + 1, -1);
    name = name.slice(0, bracketIndex);
    if (propsPart.length > 0) {
      for (const pair of propsPart.split(",")) {
        const [key, value] = pair.split("=");
        if (!key) continue;
        properties[key.trim()] = (value ?? "").trim();
      }
    }
  }

  name = normalizeBlockName(name.trim());

  return { name, properties };
}

function stringifyBlock (name, properties = {}) {
  const normalized = normalizeBlockName(name);
  const entries = Object.entries(properties);
  if (entries.length === 0) return normalized;

  entries.sort((a, b) => a[0].localeCompare(b[0]));
  const props = entries.map(([key, value]) => `${key}=${value}`).join(",");
  return `${normalized}[${props}]`;
}

/**
 * Extracts block arrays from a region (.mca) file.
 *
 * @param {Uint8Array} r - Region file byte buffer
 * @param {[[[string]]]} blocks - Array to write to
 * @param {number} rx - Region file X coordinate
 * @param {number} rz - Region file Z coordinate
 * @param {[Vector, Vector]} bounds - Relative boundaries of "blocks" array
 * @param {BigInt|null} [expectHash=null] - Expected hash for first chunk
 *                      If value matches, function exits early with `null`
 *
 * @return {BigInt|null} First chunk hash on success, null otherwise
 */
async function regionToBlocks (r, blocks, rx, rz, bounds, expectHash = null) {

  let firstChunkHash = null;

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

    const compressedData = r.slice(offset * 4096 + 5, offset * 4096 + 5 + length);

    if (firstChunkHash === null) {
      firstChunkHash = Bun.hash(compressedData);
      if (expectHash !== null && firstChunkHash === expectHash) return null;
    }

    let data;
    try {
      data = await unzip(compressedData);
    } catch (e) {
      console.warn(`Warning: Chunk (${_x} ${_z}) in r.${rx}.${rz} has likely been corrupted`);
      console.warn(e);
      return null;
    }

    const json = await new Promise(function (resolve, reject) {
      nbt.parse(data, (err, res) => resolve(res));
    });

    for (const section of json.value.sections.value.value) {
      if (!("block_states" in section)) continue;

  const _y = section["Y"].value;
  // Preserve block state properties when reading palette entries
  const palette = section.block_states.value.palette.value.value.map(function (entry) {
        const props = {};
        if ("Properties" in entry) {
          const values = entry.Properties.value;
          for (const key in values) {
            props[key] = values[key].value;
          }
        }
        return stringifyBlock(entry["Name"].value, props);
      });

      // If no block data is present, infer from palette
      if (!("data" in section.block_states.value)) {
        for (let j = 0; j < 16; j ++) {
          for (let k = 0; k < 16; k ++) {
            for (let l = 15; l >= 0; l --) {

              const x = _x * 16 + l;
              const y = _y * 16 + j;
              const z = _z * 16 + k;

              if (
                x < X_MIN || x >= X_MAX ||
                y < Y_MIN || y >= Y_MAX ||
                z < Z_MIN || z >= Z_MAX
              ) continue;

              blocks[x - X_MIN][y - Y_MIN][z - Z_MIN] = palette[0];

            }
          }
        }
        continue;
      }

      const longs = section.block_states.value.data.value;

      if (_y < Math.floor(Y_MIN / 16)) continue;
      if (_y >= Y_MAX / 16) continue;

      for (let j = 0; j < longs.length; j ++) {
        for (let k = 0; k < 16; k ++) {

          const shift = k < 8 ? (28 - k * 4) : (28 - (k - 8) * 4);
          const id = (longs[j][k < 8 ? 0 : 1] >> shift) & 0b1111;

          const x = _x * 16 + 15 - k;
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

  return firstChunkHash;

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

    let data;
    try {
      data = await unzip(compressedData);
    } catch (e) {
      console.warn(`Warning: Chunk (${_x} ${_z}) in r.${rx}.${rz} has likely been corrupted`);
      console.warn(e);
      continue;
    }

    const json = await new Promise(function (resolve, reject) {
      nbt.parse(data, (err, res) => resolve(res));
    });

    for (const section of json.value.sections.value.value) {

      const ids = [];
      const palette = [];

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

            const parsed = parseBlockString(block);
            const normalizedBlock = stringifyBlock(parsed.name, parsed.properties);

            if (!palette.includes(normalizedBlock)) {
              palette.push(normalizedBlock);
            }
            ids.push(palette.indexOf(normalizedBlock));

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
          palette: {
            type: "list",
            value: {
              type: "compound",
              // Preserve block state properties when rebuilding the palette
              value: palette.map(blockSpec => {
                const { name, properties } = parseBlockString(blockSpec);
                const paletteEntry = {
                  Name: {
                    type: "string",
                    value: "minecraft:" + name
                  }
                };
                const propEntries = Object.entries(properties);
                if (propEntries.length > 0) {
                  const propValue = {};
                  for (const [key, value] of propEntries) {
                    propValue[key] = {
                      type: "string",
                      value
                    };
                  }
                  paletteEntry.Properties = {
                    type: "compound",
                    value: propValue
                  };
                }
                return paletteEntry;
              })
            }
          },
        }
      };

      if (palette.length > 1) {
        section.block_states.value.data = {
          type: "longArray",
          value: longs
        };
      }

      section["SkyLight"] = {
        type: "byteArray",
        value: (new Array(2048)).fill(-1)
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
 * Fills the region file cache with all available region files.
 *
 * @param {string} worldPath - Path to the Minecraft world directory
 */
async function fillRegionFileCache (worldPath) {
  const files = await fs.readdir(`${worldPath}/region`);
  for (const file of files) {
    if (file.startsWith("r.") && file.endsWith(".mca")) {
      const path = `${worldPath}/region/${file}`;
      const region = await Bun.file(path).bytes();
      const checksum = Bun.hash(region);
      regionFileCache[file] = { bytes: region, checksum };
    }
  }
}

/**
 * Runs a function for each relevant region file.
 *
 * @param {string} worldPath - Path to the Minecraft world directory
 * @param {function} callback - Function to call, passed a region byte buffer and its coordinates
 * @param {[Vector, Vector]} bounds - Absolute block boundaries intersecting relevant regions
 */
async function forRegion (worldPath, callback, bounds) {

  const [X_MIN, Y_MIN, Z_MIN] = bounds[0].toArray();
  const [X_MAX, Y_MAX, Z_MAX] = bounds[1].toArray();

  for (let rx = Math.floor(X_MIN / (16 * 32)); rx < Math.ceil(X_MAX / (16 * 32)); rx ++) {
    for (let rz = Math.floor(Z_MIN / (16 * 32)); rz < Math.ceil(Z_MAX / (16 * 32)); rz ++) {

      const mcaFile = `r.${rx}.${rz}.mca`;
      const path = `${worldPath}/region/${mcaFile}`;

      const bytes = await Bun.file(path).bytes();
      const checksum = Bun.hash(bytes);

      if (regionFileCache[mcaFile]?.checksum !== checksum) {
        regionFileCache[mcaFile] = { bytes, checksum };
      }

      await callback(regionFileCache[mcaFile], rx, rz);

    }
  }

}

module.exports = {
  regionToBlocks,
  blocksToRegion,
  forRegion,
  regionFileCache,
  fillRegionFileCache
};
