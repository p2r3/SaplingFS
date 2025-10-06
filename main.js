const zlib = require("node:zlib");
const { promisify } = require("node:util");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const nbt = require("nbt");

const unzip = promisify(zlib.unzip);
const deflate = promisify(zlib.deflate);

// Coordinate range for block changes
// Lower bound is inclusive, upper bound is exclusive
const X_MIN = -16, X_MAX = 32;
const Y_MIN = -64, Y_MAX = 128;
const Z_MIN = -16, Z_MAX = 32;

// Calculate midpoint of allocated area
const X_MID = Math.floor((X_MIN + X_MAX) / 2);
const Y_MID = Math.floor((Y_MIN + Y_MAX) / 2);
const Z_MID = Math.floor((Z_MIN + Z_MAX) / 2);

const blocks = [];
for (let x = 0; x < X_MAX - X_MIN; x ++) {
  blocks[x] = [];
  for (let y = 0; y < Y_MAX - Y_MIN; y ++) {
    blocks[x][y] = [];
    for (let z = 0; z < Z_MAX - Z_MIN; z ++) {
      blocks[x][y][z] = "air";
    }
  }
}

/**
 * Extracts block arrays from a region (.mca) file.
 *
 * @param {Uint8Array} r - Region file byte buffer
 * @param {[[[string]]]} blocks - Array to write to
 * @param {number} rx - Region file X coordinate
 * @param {number} rz - Region file Z coordinate
 *
 * @return {[[[string]]]} Contents of `blocks` after modification
 */
async function regionToBlocks (r, blocks, rx, rz) {

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
 *
 * @return {Uint8Array} Contents of `r` after modification
 */
async function blocksToRegion (blocks, r, rx, rz) {

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

/**
 * Runs a function for each relevant region file.
 *
 * @param {function} callback - Function to call, passed a region byte buffer and its coordinates
 */
async function forRegion (callback) {
  for (let rx = Math.floor(X_MIN / (16 * 32)); rx < Math.ceil(X_MAX / (16 * 32)); rx ++) {
    for (let rz = Math.floor(Z_MIN / (16 * 32)); rz < Math.ceil(Z_MAX / (16 * 32)); rz ++) {
      const region = await Bun.file(`${worldPath}/region/r.${rx}.${rz}.mca`).bytes();
      await callback(region, rx, rz);
    }
  }
}

const worldName = process.argv[2];
if (!worldName) {
  console.error("No world name provided.");
  process.exit();
}
const worldPath = `${os.homedir()}/.minecraft/saves/${worldName}`;

// Load region data into block array
// await forRegion (async function (region, rx, rz) {
//   await regionToBlocks(region, blocks, rx, rz);
// });

const separationDepth = 3;

function buildFileList (currentPath, list = [], depth = 0) {
  try {

    const items = fs.readdirSync(currentPath, { withFileTypes: true });

    for (const item of items) {
      const itemPath = path.join(currentPath, item.name);
      if (!item.isDirectory()) continue;
      if (item.name.includes("cache")) continue;
      buildFileList(itemPath, list, depth + 1);
    }

    for (const item of items) {
      const itemPath = path.join(currentPath, item.name);
      if (!item.isFile()) continue;
      const size = fs.statSync(itemPath).size;
      if (size === 0) continue;
      const pathParts = currentPath.split(path.sep);
      const parent = pathParts.length > separationDepth ? pathParts[separationDepth] : null;

      list.push({
        name: item.name,
        size: size,
        depth: depth,
        parent: parent
      });
    }

  } catch (error) {
    console.warn("Failed to read directory:", currentPath);
  }
  return list;
}

const fileList = buildFileList("/home/p2r3/").slice(0, 10000);

await Bun.write("list.json", JSON.stringify(fileList));

let nodes = [[X_MID, Y_MIN, Z_MID]];

const mapping = [];
const visited = new Set();

const palette = [
  "lime_wool",
  "orange_wool",
  "yellow_wool",
  "light_blue_wool",
  "pink_wool"
];
let paletteIndex = 0;

while (fileList.length > 0 && nodes.length > 0) {

  let [x, y, z] = nodes.shift();

  if (
    x < X_MIN || x >= X_MAX ||
    y < Y_MIN || y >= Y_MAX ||
    z < Z_MIN || z >= Z_MAX
  ) continue;

  const key = `${x},${y},${z}`;
  if (visited.has(key)) continue;
  visited.add(key);

  const file = fileList.shift();
  mapping.push({ x, y, z, file });

  blocks[x - X_MIN][y - Y_MIN][z - Z_MIN] = palette[paletteIndex];

  if (mapping.length > 1 && mapping[mapping.length - 2].file.parent !== file.parent) {
    console.log(file.parent);
    nodes = [];
    y = Y_MIN;
    paletteIndex ++;
  }

  if (Math.random() < 0.05) nodes.push([x, y + 1, z]);

  do {
    nodes.push([x - 1, y, z]);
    nodes.push([x + 1, y, z]);
    nodes.push([x, y, z - 1]);
    nodes.push([x, y, z + 1]);
    if (Math.random() > 0.5) x += Math.random() > 0.5 ? -1 : 1;
    else z += Math.random() > 0.5 ? -1 : 1;
  } while (nodes.length === 0);

}

// Write block data to region files
await forRegion (async function (region, rx, rz) {
  await blocksToRegion(blocks, region, rx, rz);
  await Bun.write(`${worldPath}/region/r.${rx}.${rz}.mca`, region);
});
